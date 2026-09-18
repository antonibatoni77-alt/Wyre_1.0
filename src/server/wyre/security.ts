import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import z from 'zod';

import { dbSessions } from '../core/authDb';
import { ObjectId } from '../core/database';
import { env } from '../core/env';
import { ValidationError } from '../core/errors';
import type { UserInfo } from '../core/types';
import {
  dbSettings,
  dbWebAuthnChallenges,
  dbWebAuthnCredentials,
  type SettingsDocument,
} from './db';
import { defaultSettings } from './settings';
import { findProfileByUserId, phoneSetupPending, requireUser, requireVerifiedProfile } from './profile';

const CHALLENGE_TTL_MS = 5 * 60_000;
const scopeSchema = z.enum(['app', 'account']);
const rpID = env.WEBAUTHN_RP_ID || new URL(env.SITE_URL).hostname;
const expectedOrigin = (env.WEBAUTHN_ORIGIN || new URL(env.SITE_URL).origin).replace(/\/$/, '');

async function saveChallenge(value: {
  userId: string;
  sessionTokenHash: string;
  kind: 'registration' | 'authentication';
  scope: 'app' | 'account' | null;
  challenge: string;
}) {
  await dbWebAuthnChallenges.deleteMany({ sessionTokenHash: value.sessionTokenHash, kind: value.kind });
  const now = new Date();
  await dbWebAuthnChallenges.insertOne({
    ...value,
    createdAt: now,
    expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
  });
}

async function consumeChallenge(userId: string, sessionTokenHash: string, kind: 'registration' | 'authentication') {
  const challenge = await dbWebAuthnChallenges.findOne({
    userId,
    sessionTokenHash,
    kind,
    expiresAt: { $gt: new Date() },
  });
  if (!challenge) throw new ValidationError('Запрос WebAuthn истёк. Начните подтверждение заново.', 'WEBAUTHN_CHALLENGE_EXPIRED');
  await dbWebAuthnChallenges.deleteOne({ _id: challenge._id });
  return challenge;
}

async function writeSettings(userId: string, update: Partial<SettingsDocument>) {
  const current = await dbSettings.findOne({ userId });
  if (current) {
    await dbSettings.updateOne({ _id: current._id }, { $set: { ...update, updatedAt: new Date() } });
  } else {
    await dbSettings.insertOne({ ...defaultSettings(userId), ...update, updatedAt: new Date() });
  }
}

async function setScopeEnabled(
  profile: Awaited<ReturnType<typeof requireVerifiedProfile>>,
  sessionTokenHash: string,
  scope: 'app' | 'account',
  enabled: boolean,
) {
  if (enabled && await dbWebAuthnCredentials.countDocuments({ userId: profile.userId.toString() }) === 0) {
    throw new ValidationError('Сначала добавьте биометрию устройства', 'WEBAUTHN_CREDENTIAL_REQUIRED');
  }

  if (enabled) {
    if (scope === 'app') {
      await dbSessions.updateMany({ userId: profile.userId }, { $set: { appLockEnabled: true, webauthnAppVerified: false } });
      await dbSessions.updateOne({ userId: profile.userId, tokenHash: sessionTokenHash }, { $set: { webauthnAppVerified: true } });
      await writeSettings(profile.userId.toString(), { webauthnAppEnabled: true });
    } else {
      await dbSessions.updateMany({ userId: profile.userId }, { $set: { webauthnAccountVerified: false } });
      await dbSessions.updateOne({ userId: profile.userId, tokenHash: sessionTokenHash }, { $set: { webauthnAccountVerified: true } });
      await writeSettings(profile.userId.toString(), { webauthnAccountEnabled: true });
    }
    return;
  }

  if (scope === 'app') {
    await writeSettings(profile.userId.toString(), { webauthnAppEnabled: false });
    await dbSessions.updateMany({ userId: profile.userId }, { $set: { appLockEnabled: false, webauthnAppVerified: false } });
  } else {
    await writeSettings(profile.userId.toString(), { webauthnAccountEnabled: false });
    await dbSessions.updateMany({ userId: profile.userId }, { $set: { webauthnAccountVerified: false } });
  }
}

function registrationResponse(value: unknown) {
  return z.object({ id: z.string().min(1), response: z.unknown() }).passthrough().parse(value) as unknown as RegistrationResponseJSON;
}

function authenticationResponse(value: unknown) {
  return z.object({ id: z.string().min(1), response: z.unknown() }).passthrough().parse(value) as unknown as AuthenticationResponseJSON;
}

export const securityQueries = {
  webauthnStatus: async (_args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const userId = profile.userId.toString();
    const [settings, credentials] = await Promise.all([
      dbSettings.findOne({ userId }),
      dbWebAuthnCredentials.fetch({ userId }, { sort: { createdAt: -1 } }),
    ]);
    return {
      appEnabled: Boolean(settings?.webauthnAppEnabled),
      accountEnabled: Boolean(settings?.webauthnAccountEnabled),
      credentials: credentials.map((credential) => ({
        id: credential._id.toString(),
        name: credential.name,
        createdAt: credential.createdAt,
        lastUsedAt: credential.lastUsedAt,
        backedUp: credential.backedUp,
      })),
      appLockMinutes: env.WEBAUTHN_APP_LOCK_MINUTES,
    };
  },
  pendingDeviceApprovals: async (_args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const sessions = await dbSessions.fetch({
      userId: profile.userId,
      deviceApproved: false,
      expiresAt: { $gt: new Date() },
    }, { sort: { createdAt: -1 } });
    return sessions.map((session) => ({
      id: session._id.toString(),
      userAgent: session.userAgent ?? 'Неизвестное устройство',
      ip: session.ip ?? null,
      createdAt: session.createdAt,
    }));
  },
};

export const securityMutations = {
  beginWebAuthnRegistration: async (args: unknown, { user, sessionTokenHash }: { user: UserInfo | null; sessionTokenHash?: string }) => {
    const profile = await requireVerifiedProfile(user);
    if (!sessionTokenHash) throw new ValidationError('Сессия не найдена');
    const { scope } = z.object({ scope: scopeSchema }).parse(args);
    const existing = await dbWebAuthnCredentials.fetch({ userId: profile.userId.toString() });
    const options = await generateRegistrationOptions({
      rpName: 'Wyre',
      rpID,
      userID: new TextEncoder().encode(profile.userId.toString()),
      userName: profile.email,
      userDisplayName: profile.name,
      attestationType: 'none',
      excludeCredentials: existing.map((credential) => ({
        id: credential.credentialId,
        transports: credential.transports as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'preferred',
        userVerification: 'required',
      },
      preferredAuthenticatorType: 'localDevice',
    });
    await saveChallenge({ userId: profile.userId.toString(), sessionTokenHash, kind: 'registration', scope, challenge: options.challenge });
    return options;
  },
  finishWebAuthnRegistration: async (args: unknown, { user, sessionTokenHash }: { user: UserInfo | null; sessionTokenHash?: string }) => {
    const profile = await requireVerifiedProfile(user);
    if (!sessionTokenHash) throw new ValidationError('Сессия не найдена');
    const { response: responseValue } = z.object({ response: z.unknown() }).parse(args);
    const challenge = await consumeChallenge(profile.userId.toString(), sessionTokenHash, 'registration');
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: registrationResponse(responseValue),
        expectedChallenge: challenge.challenge,
        expectedOrigin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
    } catch {
      throw new ValidationError('Не удалось проверить биометрию устройства', 'INVALID_WEBAUTHN_RESPONSE');
    }
    if (!verification.verified || !verification.registrationInfo || !challenge.scope) {
      throw new ValidationError('Не удалось проверить биометрию устройства', 'INVALID_WEBAUTHN_RESPONSE');
    }
    const credential = verification.registrationInfo.credential;
    const occupied = await dbWebAuthnCredentials.findOne({ credentialId: credential.id });
    if (occupied && occupied.userId !== profile.userId.toString()) {
      throw new ValidationError('Этот ключ уже привязан к другому аккаунту', 'WEBAUTHN_CREDENTIAL_TAKEN');
    }
    await dbWebAuthnCredentials.updateOne(
      { credentialId: credential.id },
      { $set: {
        userId: profile.userId.toString(),
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports ?? [],
        deviceType: verification.registrationInfo.credentialDeviceType,
        backedUp: verification.registrationInfo.credentialBackedUp,
        name: 'Биометрия устройства',
        createdAt: occupied?.createdAt ?? new Date(),
        lastUsedAt: null,
      } },
      { upsert: true },
    );
    await setScopeEnabled(profile, sessionTokenHash, challenge.scope, true);
    return { verified: true };
  },
  setWebAuthnScope: async (args: unknown, { user, sessionTokenHash }: { user: UserInfo | null; sessionTokenHash?: string }) => {
    const profile = await requireVerifiedProfile(user);
    if (!sessionTokenHash) throw new ValidationError('Сессия не найдена');
    const { scope, enabled } = z.object({ scope: scopeSchema, enabled: z.boolean() }).parse(args);
    await setScopeEnabled(profile, sessionTokenHash, scope, enabled);
    return { scope, enabled };
  },
  beginWebAuthnAuthentication: async (_args: unknown, { user, sessionTokenHash }: { user: UserInfo | null; sessionTokenHash?: string }) => {
    const authUser = requireUser(user);
    if (!sessionTokenHash) throw new ValidationError('Сессия не найдена');
    const profile = await findProfileByUserId(authUser.id);
    if (!profile || profile.pendingChallenge || phoneSetupPending(profile)) throw new ValidationError('Сначала завершите подтверждение аккаунта');
    const settings = await dbSettings.findOne({ userId: authUser.id });
    if (settings?.totpEnabled && !authUser.totpVerified) throw new ValidationError('Сначала подтвердите двухфакторную аутентификацию', 'TOTP_REQUIRED');
    if (settings?.pinEnabled && !authUser.pinVerified) throw new ValidationError('Сначала введите PIN-код', 'PIN_REQUIRED');
    const credentials = await dbWebAuthnCredentials.fetch({ userId: authUser.id });
    if (!credentials.length || (!settings?.webauthnAppEnabled && !settings?.webauthnAccountEnabled)) {
      throw new ValidationError('Биометрия устройства не включена', 'WEBAUTHN_NOT_ENABLED');
    }
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      allowCredentials: credentials.map((credential) => ({
        id: credential.credentialId,
        transports: credential.transports as AuthenticatorTransportFuture[],
      })),
    });
    await saveChallenge({ userId: authUser.id, sessionTokenHash, kind: 'authentication', scope: null, challenge: options.challenge });
    return options;
  },
  finishWebAuthnAuthentication: async (args: unknown, { user, sessionTokenHash }: { user: UserInfo | null; sessionTokenHash?: string }) => {
    const authUser = requireUser(user);
    if (!sessionTokenHash) throw new ValidationError('Сессия не найдена');
    const { response: responseValue } = z.object({ response: z.unknown() }).parse(args);
    const response = authenticationResponse(responseValue);
    const challenge = await consumeChallenge(authUser.id, sessionTokenHash, 'authentication');
    const credential = await dbWebAuthnCredentials.findOne({ userId: authUser.id, credentialId: response.id });
    if (!credential) throw new ValidationError('Ключ устройства не найден', 'WEBAUTHN_CREDENTIAL_NOT_FOUND');
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: credential.credentialId,
          publicKey: Buffer.from(credential.publicKey, 'base64url'),
          counter: credential.counter,
          transports: credential.transports as AuthenticatorTransportFuture[],
        },
      });
    } catch {
      throw new ValidationError('Биометрическое подтверждение отклонено', 'INVALID_WEBAUTHN_RESPONSE');
    }
    if (!verification.verified) throw new ValidationError('Биометрическое подтверждение отклонено', 'INVALID_WEBAUTHN_RESPONSE');
    await dbWebAuthnCredentials.updateOne({ _id: credential._id }, { $set: {
      counter: verification.authenticationInfo.newCounter,
      deviceType: verification.authenticationInfo.credentialDeviceType,
      backedUp: verification.authenticationInfo.credentialBackedUp,
      lastUsedAt: new Date(),
    } });
    const settings = await dbSettings.findOne({ userId: authUser.id });
    await dbSessions.updateOne({ tokenHash: sessionTokenHash, userId: new ObjectId(authUser.id) }, { $set: {
      webauthnAccountVerified: Boolean(settings?.webauthnAccountEnabled),
      webauthnAppVerified: Boolean(settings?.webauthnAppEnabled),
      appLockEnabled: Boolean(settings?.webauthnAppEnabled),
    } });
    return { done: true };
  },
  /**
   * Android-shell unlock: the WebView cannot run WebAuthn, so the native shell
   * performs the device-lock confirmation (fingerprint / face / PIN through the
   * system keyguard) and then calls this. It only flips the pending
   * verification flags on the caller's own session — the same trust level as
   * an unlocked device, nothing more.
   */
  verifyNativeAppUnlock: async (_args: unknown, { user, sessionTokenHash }: { user: UserInfo | null; sessionTokenHash?: string }) => {
    const authUser = requireUser(user);
    if (!sessionTokenHash) throw new ValidationError('Сессия не найдена');
    const settings = await dbSettings.findOne({ userId: authUser.id });
    await dbSessions.updateOne({ tokenHash: sessionTokenHash, userId: new ObjectId(authUser.id) }, { $set: {
      webauthnAccountVerified: Boolean(settings?.webauthnAccountEnabled),
      webauthnAppVerified: Boolean(settings?.webauthnAppEnabled),
      appLockEnabled: Boolean(settings?.webauthnAppEnabled),
    } });
    return { done: true };
  },
  removeWebAuthnCredential: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const { credentialId } = z.object({ credentialId: z.string() }).parse(args);
    if (!ObjectId.isValid(credentialId)) throw new ValidationError('Ключ устройства не найден');
    const credential = await dbWebAuthnCredentials.findOne({ _id: new ObjectId(credentialId), userId: profile.userId.toString() });
    if (!credential) throw new ValidationError('Ключ устройства не найден');
    await dbWebAuthnCredentials.deleteOne({ _id: credential._id });
    if (await dbWebAuthnCredentials.countDocuments({ userId: profile.userId.toString() }) === 0) {
      await writeSettings(profile.userId.toString(), { webauthnAppEnabled: false, webauthnAccountEnabled: false });
      await dbSessions.updateMany({ userId: profile.userId }, { $set: {
        appLockEnabled: false,
        webauthnAppVerified: false,
        webauthnAccountVerified: false,
      } });
    }
    return { removed: true };
  },
  setNewDeviceApproval: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(args);
    await dbSessions.updateMany({ userId: profile.userId }, { $set: { deviceApproved: true } });
    await writeSettings(profile.userId.toString(), { newDeviceApprovalEnabled: enabled });
    return { enabled };
  },
  approveDeviceSession: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const { sessionId } = z.object({ sessionId: z.string() }).parse(args);
    if (!ObjectId.isValid(sessionId)) throw new ValidationError('Сессия не найдена');
    const result = await dbSessions.updateOne({ _id: new ObjectId(sessionId), userId: profile.userId, deviceApproved: false }, { $set: { deviceApproved: true } });
    if (!result.matchedCount) throw new ValidationError('Сессия не найдена');
    return { approved: true };
  },
  denyDeviceSession: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const { sessionId } = z.object({ sessionId: z.string() }).parse(args);
    if (!ObjectId.isValid(sessionId)) throw new ValidationError('Сессия не найдена');
    await dbSessions.deleteOne({ _id: new ObjectId(sessionId), userId: profile.userId, deviceApproved: false });
    return { denied: true };
  },
};
