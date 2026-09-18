import z from 'zod';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { generateSecret, generateURI, verify as verifyTotp } from 'otplib';
import { dbSessions, dbUsers } from '../core/authDb';
import { createQrLogin } from '../core/auth';
import { ObjectId } from '../core/database';
import { env } from '../core/env';
import { ValidationError } from '../core/errors';
import type { UserInfo } from '../core/types';
import {
  dbAdminActions,
  dbCalls,
  dbChannelComments,
  dbChannelPosts,
  dbChannels,
  dbChats,
  dbDrafts,
  dbFamilyLinks,
  dbMessageBookmarks,
  dbMessages,
  dbProfiles,
  dbPushSubscriptions,
  dbReminders,
  dbScheduledMessages,
  dbSettings,
  dbSharedNotes,
  dbStories,
  dbStoryViews,
  dbUserBlocks,
  type SettingsDocument,
} from './db';
import { findProfileByUserId, phoneSetupPending, requireUser, requireVerifiedProfile } from './profile';
import PDFDocument from 'pdfkit';

export const defaultSettings = (userId: string): SettingsDocument => ({
  userId, themeId: 0, fontSize: 15, font: 'system', autoTheme: false,
  dnd: false, dndFrom: '23:00', dndTo: '08:00', autoDnd: false, timeZone: 'UTC', autoDndUpdatedAt: null, quietCareEnabled: false, quietCareDays: 3, quietCareNotifiedAt: null, previews: true, mutedChats: [], blacklist: [],
  safeMode: false, familyProtection: false, contentFilter: 'all', updatedAt: new Date(),
  findByPhone: 'contacts', callPermission: 'contacts', invitePermission: 'all', phoneVisibility: 'contacts',
  privacyAlways: {}, privacyNever: {},
  totpEnabled: false, totpSecretEncrypted: null, totpPendingSecretEncrypted: null,
  pinEnabled: false, pinSalt: null, pinHash: null,
  webauthnAppEnabled: false, webauthnAccountEnabled: false, newDeviceApprovalEnabled: false,
  decoyEnabled: false, decoyUserId: null, decoySalt: null, decoyHash: null,
});

const settingsKey = () => createHash('sha256').update(process.env.SESSION_SECRET ?? 'wyre-development-secret').digest();
const TOTP_ATTEMPTS = 5;
const PIN_ATTEMPTS = 5;
const scrypt = promisify(scryptCallback);
const pinSchema = z.string().regex(/^\d{4}$/, 'PIN должен состоять из 4 цифр');
function encryptSecret(value: string) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', settingsKey(), iv); const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`; }
function decryptSecret(value: string) { const [ivRaw, tagRaw, dataRaw] = value.split('.'); const decipher = createDecipheriv('aes-256-gcm', settingsKey(), Buffer.from(ivRaw, 'base64url')); decipher.setAuthTag(Buffer.from(tagRaw, 'base64url')); return Buffer.concat([decipher.update(Buffer.from(dataRaw, 'base64url')), decipher.final()]).toString('utf8'); }

async function derivePinHash(pin: string, salt: string) {
  return Buffer.from(await scrypt(`${pin}:${env.SESSION_SECRET}`, salt, 64) as Buffer).toString('base64url');
}

async function verifyPin(pin: string, salt: string, expectedHash: string) {
  const actual = Buffer.from(await derivePinHash(pin, salt), 'base64url');
  const expected = Buffer.from(expectedHash, 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function publicSettings(settings: SettingsDocument & { _id?: unknown }) {
  const {
    _id: _documentId,
    totpSecretEncrypted: _totpSecret,
    totpPendingSecretEncrypted: _totpPendingSecret,
    pinSalt: _pinSalt,
    pinHash: _pinHash,
    decoyUserId: _decoyUserId,
    decoySalt: _decoySalt,
    decoyHash: _decoyHash,
    ...safe
  } = settings;
  return safe;
}

function deviceName(userAgent: string) {
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Chrome\//.test(userAgent) ? 'Chrome' : /Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : 'Браузер';
  const platform = /Windows/i.test(userAgent) ? 'Windows' : /Android/i.test(userAgent) ? 'Android' : /iPhone|iPad/i.test(userAgent) ? 'iOS' : /Mac OS/i.test(userAgent) ? 'macOS' : 'Устройство';
  return `${platform} · ${browser}`;
}

export const settingsQueries = {
  settings: async (_args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user); const userId = profile.userId.toString();
    return publicSettings((await dbSettings.findOne({ userId })) ?? defaultSettings(userId));
  },
  activeSessions: async (_args: unknown, { user, sessionTokenHash }: { user: UserInfo | null; sessionTokenHash?: string }) => {
    const profile = await requireVerifiedProfile(user);
    const sessions = await dbSessions.fetch({ userId: profile.userId, expiresAt: { $gt: new Date() } }, { sort: { lastActiveAt: -1 } });
    return sessions.map((session) => ({
      id: session._id.toString(), device: deviceName(session.userAgent ?? ''), network: session.ip ? `IP ${session.ip}` : 'Сеть не определена',
      lastActive: session.lastActiveAt ?? session.createdAt, current: session.tokenHash === sessionTokenHash,
      approved: session.deviceApproved !== false,
      createdAt: session.createdAt, expiresAt: session.expiresAt,
    }));
  },
  storageUsage: async (_args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user); const userId = profile.userId.toString();
    const chats = await dbChats.fetch({ memberIds: userId }); const chatIds = chats.map((chat) => chat._id.toString());
    const [messages, stories] = await Promise.all([dbMessages.fetch({ chatId: { $in: chatIds }, authorId: userId, filePath: { $ne: null } }), dbStories.fetch({ authorId: userId })]);
    const usage = await storedFilesUsage([...messages.map((message) => message.filePath).filter((value): value is string => Boolean(value)), ...stories.map((story) => story.filePath)]);
    return { ...usage, limitMb: env.MAX_UPLOAD_MB };
  },
  totpStatus: async (_args: unknown, { user }: { user: UserInfo | null }) => { const profile = await requireVerifiedProfile(user); const settings = await dbSettings.findOne({ userId: profile.userId.toString() }); return { enabled: Boolean(settings?.totpEnabled) }; },
  pinStatus: async (_args: unknown, { user }: { user: UserInfo | null }) => { const profile = await requireVerifiedProfile(user); const settings = await dbSettings.findOne({ userId: profile.userId.toString() }); return { enabled: Boolean(settings?.pinEnabled) }; },
  blockedUsers: async (_args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user); const userId = profile.userId.toString();
    const blocks = await dbUserBlocks.fetch({ blockerId: userId }, { sort: { createdAt: -1 } });
    const ids = blocks.map((block) => block.blockedId).filter(ObjectId.isValid).map((id) => new ObjectId(id));
    const profiles = ids.length ? await dbProfiles.fetch({ userId: { $in: ids } }) : [];
    const byId = new Map(profiles.map((entry) => [entry.userId.toString(), entry]));
    return blocks.map((block) => ({ userId: block.blockedId, name: byId.get(block.blockedId)?.name ?? 'Пользователь', username: byId.get(block.blockedId)?.username ?? '' }));
  },
};

function localHour(date: Date, timeZone: string) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(date));
}

export async function processAutoDnd() {
  const staleBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const settings = await dbSettings.fetch({ autoDnd: true, $or: [{ autoDndUpdatedAt: null }, { autoDndUpdatedAt: { $exists: false } }, { autoDndUpdatedAt: { $lte: staleBefore } }] }, { limit: 100 });
  for (const item of settings) {
    const messages = await dbMessages.fetch({ authorId: item.userId, createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } }, { sort: { createdAt: -1 }, limit: 5000 });
    const hours = Array.from({ length: 24 }, () => 0);
    for (const message of messages) hours[localHour(message.createdAt, item.timeZone ?? 'UTC')] += 1;
    let start = 23;
    let minimum = Number.POSITIVE_INFINITY;
    for (let candidate = 0; candidate < 24; candidate += 1) {
      const activity = Array.from({ length: 8 }, (_, offset) => hours[(candidate + offset) % 24]).reduce((sum, value) => sum + value, 0);
      if (activity < minimum) { minimum = activity; start = candidate; }
    }
    const formatHour = (hour: number) => `${String(hour % 24).padStart(2, '0')}:00`;
    await dbSettings.updateOne({ _id: item._id, autoDnd: true }, { $set: { dnd: true, dndFrom: formatHour(start), dndTo: formatHour(start + 8), autoDndUpdatedAt: new Date() } });
  }
}

export const settingsMutations = {
  setDecoyCode: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const { code } = z.object({ code: pinSchema }).parse(args);
    const userId = profile.userId.toString();
    const settings = await dbSettings.findOne({ userId });
    if (!settings?.pinEnabled || !settings.pinSalt || !settings.pinHash) throw new ValidationError('Сначала включите основной PIN-код');
    if (await verifyPin(code, settings.pinSalt, settings.pinHash)) throw new ValidationError('Decoy-код должен отличаться от основного PIN');
    let decoyUserId = settings.decoyUserId;
    if (!decoyUserId || !ObjectId.isValid(decoyUserId) || !await dbProfiles.findOne({ userId: new ObjectId(decoyUserId), isDecoy: true })) {
      const now = new Date();
      const internalEmail = `decoy-${randomBytes(12).toString('hex')}@internal.wyre.invalid`;
      const username = `wyre_${randomBytes(6).toString('hex')}`;
      const inserted = await dbUsers.insertOne({ email: internalEmail, createdAt: now, lastLoginAt: now });
      const decoyUserObjectId = inserted.insertedId;
      decoyUserId = decoyUserObjectId.toString();
      await dbProfiles.insertOne({
        userId: decoyUserObjectId,
        email: internalEmail,
        name: profile.name,
        username,
        usernameLower: username,
        usernameHistory: [],
        bio: '',
        phone: null,
        colors: [...profile.colors],
        initials: profile.initials,
        badge: null,
        role: 'user',
        warnings: [],
        pendingChallenge: false,
        phoneOnboardingPending: false,
        challengeAttempts: 0,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
        presenceVisibility: 'nobody',
        presenceAlways: [],
        presenceNever: [],
        isDecoy: true,
      });
      await dbSettings.insertOne(defaultSettings(decoyUserId));
    }
    const salt = randomBytes(16).toString('base64url');
    const decoyHash = await derivePinHash(code, salt);
    await dbSettings.updateOne({ _id: settings._id }, { $set: { decoyEnabled: true, decoyUserId, decoySalt: salt, decoyHash, updatedAt: new Date() } });
    return { enabled: true };
  },
  disableDecoy: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const { code } = z.object({ code: pinSchema }).parse(args);
    const settings = await dbSettings.findOne({ userId: profile.userId.toString() });
    if (!settings?.decoyEnabled || !settings.decoySalt || !settings.decoyHash) return { enabled: false };
    if (!await verifyPin(code, settings.decoySalt, settings.decoyHash)) throw new ValidationError('Неверный decoy-код', 'INVALID_DECOY_CODE');
    await dbSettings.updateOne({ _id: settings._id }, { $set: { decoyEnabled: false, decoySalt: null, decoyHash: null, updatedAt: new Date() } });
    return { enabled: false };
  },
  setPin: async (args: unknown, { user, sessionTokenHash }: { user: UserInfo | null; sessionTokenHash?: string }) => {
    const profile = await requireVerifiedProfile(user);
    if (!sessionTokenHash) throw new ValidationError('Сессия не найдена');
    const { pin } = z.object({ pin: pinSchema }).parse(args);
    const userId = profile.userId.toString();
    const salt = randomBytes(16).toString('base64url');
    const pinHash = await derivePinHash(pin, salt);
    await dbSessions.updateMany({ userId: profile.userId }, { $set: { pinVerified: false, pinAttempts: 0 } });
    await dbSessions.updateOne({ tokenHash: sessionTokenHash, userId: profile.userId }, { $set: { pinVerified: true, pinAttempts: 0 } });
    const current = await dbSettings.findOne({ userId });
    if (current) {
      await dbSettings.updateOne({ _id: current._id }, { $set: { pinEnabled: true, pinSalt: salt, pinHash, updatedAt: new Date() } });
    } else {
      await dbSettings.insertOne({ ...defaultSettings(userId), pinEnabled: true, pinSalt: salt, pinHash, updatedAt: new Date() });
    }
    return { enabled: true };
  },
  disablePin: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const { pin } = z.object({ pin: pinSchema }).parse(args);
    const userId = profile.userId.toString();
    const settings = await dbSettings.findOne({ userId });
    if (!settings?.pinEnabled || !settings.pinSalt || !settings.pinHash) return { enabled: false };
    if (!await verifyPin(pin, settings.pinSalt, settings.pinHash)) throw new ValidationError('Неверный PIN-код', 'INVALID_PIN');
    await dbSettings.updateOne({ _id: settings._id }, { $set: {
      pinEnabled: false,
      pinSalt: null,
      pinHash: null,
      decoyEnabled: false,
      decoySalt: null,
      decoyHash: null,
      updatedAt: new Date(),
    } });
    await dbSessions.updateMany({ userId: profile.userId }, { $set: { pinVerified: false, pinAttempts: 0 } });
    return { enabled: false };
  },
  verifyPinLogin: async (args: unknown, { user, sessionTokenHash }: { user: UserInfo | null; sessionTokenHash?: string }) => {
    const authUser = requireUser(user);
    if (!sessionTokenHash) throw new ValidationError('Сессия не найдена');
    const { pin } = z.object({ pin: pinSchema }).parse(args);
    const profile = await findProfileByUserId(authUser.id);
    if (!profile || profile.pendingChallenge || phoneSetupPending(profile)) throw new ValidationError('Сначала завершите подтверждение аккаунта');
    const settings = await dbSettings.findOne({ userId: authUser.id });
    if (settings?.totpEnabled && !authUser.totpVerified) throw new ValidationError('Сначала подтвердите двухфакторную аутентификацию', 'TOTP_REQUIRED');
    if (!settings?.pinEnabled || !settings.pinSalt || !settings.pinHash) throw new ValidationError('PIN-код не включён');
    const session = await dbSessions.findOne({ tokenHash: sessionTokenHash, userId: profile.userId, expiresAt: { $gt: new Date() } });
    if (!session) throw new ValidationError('Сессия не найдена');
    const [pinMatches, decoyMatches] = await Promise.all([
      verifyPin(pin, settings.pinSalt, settings.pinHash),
      settings.decoyEnabled && settings.decoySalt && settings.decoyHash
        ? verifyPin(pin, settings.decoySalt, settings.decoyHash)
        : Promise.resolve(false),
    ]);
    if (decoyMatches && settings.decoyUserId && ObjectId.isValid(settings.decoyUserId)) {
      const decoyUserId = new ObjectId(settings.decoyUserId);
      const decoyProfile = await dbProfiles.findOne({ userId: decoyUserId, isDecoy: true });
      if (!decoyProfile) throw new ValidationError('Decoy-аккаунт недоступен');
      await dbSessions.updateOne({ _id: session._id }, { $set: {
        userId: decoyUserId,
        totpVerified: true,
        pinVerified: true,
        webauthnAccountVerified: true,
        webauthnAppVerified: true,
        appLockEnabled: false,
        deviceApproved: true,
        pinAttempts: 0,
      } });
      return { done: true };
    }
    if (!pinMatches) {
      const attempts = (session.pinAttempts ?? 0) + 1;
      if (attempts >= PIN_ATTEMPTS) {
        await dbSessions.deleteOne({ _id: session._id });
        throw new ValidationError('Слишком много неудачных попыток. Начните вход заново.', 'PIN_LOCKED');
      }
      await dbSessions.updateOne({ _id: session._id }, { $set: { pinAttempts: attempts } });
      throw new ValidationError('Неверный PIN-код', 'INVALID_PIN');
    }
    await dbSessions.updateOne({ _id: session._id }, { $set: { pinVerified: true, pinAttempts: 0 } });
    return { done: true };
  },
  blockUser: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user); const blockerId = profile.userId.toString();
    const { userId: blockedId } = z.object({ userId: z.string().refine(ObjectId.isValid) }).parse(args);
    if (blockedId === blockerId || !await dbProfiles.findOne({ userId: new ObjectId(blockedId) })) throw new ValidationError('Пользователь не найден');
    await dbUserBlocks.updateOne({ blockerId, blockedId }, { $setOnInsert: { blockerId, blockedId, createdAt: new Date() } }, { upsert: true });
    return { blocked: true };
  },
  unblockUser: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user); const blockerId = profile.userId.toString();
    const { userId: blockedId } = z.object({ userId: z.string() }).parse(args);
    await dbUserBlocks.deleteOne({ blockerId, blockedId }); return { blocked: false };
  },
  beginTotp: async (_args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user); const userId = profile.userId.toString(); const secret = generateSecret();
    await dbSettings.updateOne({ userId }, { $set: { ...(await dbSettings.findOne({ userId }) ?? defaultSettings(userId)), totpPendingSecretEncrypted: encryptSecret(secret), updatedAt: new Date() } }, { upsert: true });
    return { uri: generateURI({ issuer: 'Wyre', label: profile.email, secret }), secretHint: `${secret.slice(0, 4)}…${secret.slice(-4)}` };
  },
  confirmTotp: async (args: unknown, { user, sessionTokenHash }: { user: UserInfo | null; sessionTokenHash?: string }) => {
    const profile = await requireVerifiedProfile(user); const userId = profile.userId.toString(); const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(args); const settings = await dbSettings.findOne({ userId });
    if (!settings?.totpPendingSecretEncrypted) throw new ValidationError('Сначала запросите настройку 2FA');
    const secret = decryptSecret(settings.totpPendingSecretEncrypted); const result = await verifyTotp({ secret, token: code }); if (!result.valid) throw new ValidationError('Неверный код приложения-аутентификатора');
    await dbSettings.updateOne({ userId }, { $set: { totpEnabled: true, totpSecretEncrypted: settings.totpPendingSecretEncrypted, totpPendingSecretEncrypted: null, updatedAt: new Date() } }); if (sessionTokenHash) await dbSessions.updateOne({ tokenHash: sessionTokenHash, userId: profile.userId }, { $set: { totpVerified: true } }); return { enabled: true };
  },
  verifyTotpLogin: async (args: unknown, { user, sessionTokenHash }: { user: UserInfo | null; sessionTokenHash?: string }) => {
    if (!user || !sessionTokenHash) throw new ValidationError('Сессия не найдена');
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(args);
    const settings = await dbSettings.findOne({ userId: user.id });
    if (!settings?.totpEnabled || !settings.totpSecretEncrypted) throw new ValidationError('2FA не включена');
    const session = await dbSessions.findOne({ tokenHash: sessionTokenHash, userId: new ObjectId(user.id), expiresAt: { $gt: new Date() } });
    if (!session) throw new ValidationError('Сессия не найдена');
    if ((session.totpAttempts ?? 0) >= TOTP_ATTEMPTS) {
      await dbSessions.deleteOne({ _id: session._id });
      throw new ValidationError('Слишком много неудачных попыток. Начните вход заново.', 'TOTP_LOCKED');
    }
    const result = await verifyTotp({ secret: decryptSecret(settings.totpSecretEncrypted), token: code });
    if (!result.valid) {
      const attempts = (session.totpAttempts ?? 0) + 1;
      if (attempts >= TOTP_ATTEMPTS) {
        await dbSessions.deleteOne({ _id: session._id });
        throw new ValidationError('Слишком много неудачных попыток. Начните вход заново.', 'TOTP_LOCKED');
      }
      await dbSessions.updateOne({ _id: session._id }, { $set: { totpAttempts: attempts } });
      throw new ValidationError('Неверный код приложения-аутентификатора', 'INVALID_TOTP');
    }
    await dbSessions.updateOne({ _id: session._id }, { $set: { totpVerified: true, totpAttempts: 0 } });
    return { done: true };
  },
  disableTotp: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user); const userId = profile.userId.toString(); const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(args); const settings = await dbSettings.findOne({ userId });
    if (!settings?.totpEnabled || !settings.totpSecretEncrypted) return { enabled: false };
    const result = await verifyTotp({ secret: decryptSecret(settings.totpSecretEncrypted), token: code }); if (!result.valid) throw new ValidationError('Неверный код приложения-аутентификатора');
    await dbSettings.updateOne({ userId }, { $set: { totpEnabled: false, totpSecretEncrypted: null, updatedAt: new Date() } }); return { enabled: false };
  },
  createQrLogin: async (_args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    return createQrLogin(profile.userId);
  },
  updateSettings: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user); const userId = profile.userId.toString();
    const value = z.object({
      themeId: z.number().int().min(0).max(19).optional(), fontSize: z.number().int().min(12).max(20).optional(), font: z.enum(['system', 'rounded', 'mono']).optional(), autoTheme: z.boolean().optional(),
      dnd: z.boolean().optional(), dndFrom: z.string().regex(/^\d{2}:\d{2}$/).optional(), dndTo: z.string().regex(/^\d{2}:\d{2}$/).optional(), autoDnd: z.boolean().optional(), timeZone: z.string().max(100).refine((value) => { try { Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Некорректный часовой пояс').optional(), previews: z.boolean().optional(),
      mutedChats: z.array(z.string()).max(500).optional(), blacklist: z.array(z.string()).max(500).optional(), safeMode: z.boolean().optional(), familyProtection: z.boolean().optional(), contentFilter: z.enum(['all', 'contacts', 'none']).optional(),
      findByPhone: z.enum(['all', 'contacts', 'nobody']).optional(), callPermission: z.enum(['all', 'contacts', 'nobody']).optional(), invitePermission: z.enum(['all', 'contacts', 'nobody']).optional(), phoneVisibility: z.enum(['all', 'contacts', 'nobody']).optional(),
      privacyAlways: z.partialRecord(z.enum(['find', 'call', 'invite', 'phone']), z.array(z.string().refine(ObjectId.isValid)).max(200)).optional(),
      privacyNever: z.partialRecord(z.enum(['find', 'call', 'invite', 'phone']), z.array(z.string().refine(ObjectId.isValid)).max(200)).optional(),
    }).parse(args);
    const current = (await dbSettings.findOne({ userId })) ?? defaultSettings(userId);
    const allowedValue = { ...value };
    if (current.familyProtection && await dbFamilyLinks.findOne({ childId: userId })) {
      delete allowedValue.familyProtection;
      delete allowedValue.safeMode;
      delete allowedValue.contentFilter;
      delete allowedValue.findByPhone;
      delete allowedValue.callPermission;
      delete allowedValue.invitePermission;
      delete allowedValue.phoneVisibility;
      delete allowedValue.privacyAlways;
      delete allowedValue.privacyNever;
    }
    const next = { ...current, ...allowedValue, userId, updatedAt: new Date() };
    await dbSettings.updateOne({ userId }, { $set: next }, { upsert: true });
    return publicSettings(next);
  },
  revokeSession: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user); const { sessionId } = z.object({ sessionId: z.string() }).parse(args);
    if (!ObjectId.isValid(sessionId)) throw new ValidationError('Сессия не найдена');
    const session = await dbSessions.findOne({ _id: new ObjectId(sessionId), userId: profile.userId });
    const result = await dbSessions.deleteOne({ _id: new ObjectId(sessionId), userId: profile.userId });
    if (!result.deletedCount) throw new ValidationError('Сессия не найдена');
    // A revoked device must stop receiving push notifications immediately.
    if (session) await dbPushSubscriptions.deleteMany({ userId: profile.userId.toString(), sessionTokenHash: session.tokenHash });
    return { revoked: true };
  },
  revokeOtherSessions: async (_args: unknown, { user, sessionTokenHash }: { user: UserInfo | null; sessionTokenHash?: string }) => {
    const profile = await requireVerifiedProfile(user);
    if (!sessionTokenHash) throw new ValidationError('Текущая сессия не определена');
    const result = await dbSessions.deleteMany({ userId: profile.userId, tokenHash: { $ne: sessionTokenHash } });
    await dbPushSubscriptions.deleteMany({ userId: profile.userId.toString(), sessionTokenHash: { $ne: sessionTokenHash } });
    return { revoked: result.deletedCount };
  },
};

function exportDocument<T extends { _id: ObjectId }>(document: T) {
  const { _id, ...data } = document;
  return { id: _id.toString(), ...data };
}

async function storedFilesUsage(filePaths: string[]) {
  const root = path.resolve(process.cwd(), env.UPLOAD_DIR);
  const sizes = await Promise.all([...new Set(filePaths)].map(async (filePath) => {
    const resolved = path.resolve(root, filePath);
    if (!resolved.startsWith(`${root}${path.sep}`)) return 0;
    try { return (await stat(resolved)).size; } catch { return 0; }
  }));
  return { bytes: sizes.reduce((total, size) => total + size, 0), fileCount: sizes.filter((size) => size > 0).length };
}

export async function buildExport(user: UserInfo | null, format: 'json' | 'txt' | 'pdf') {
  const profile = await requireVerifiedProfile(user);
  const userId = profile.userId.toString();
  const [account, settings, sessions, chats, calls, bookmarks, drafts, scheduledMessages, reminders, stories, adminActions, channels, userBlocks] = await Promise.all([
    dbUsers.findOne({ _id: profile.userId }),
    dbSettings.findOne({ userId }),
    dbSessions.fetch({ userId: profile.userId }, { sort: { createdAt: 1 } }),
    dbChats.fetch({ memberIds: userId }, { sort: { lastMessageAt: -1 } }),
    dbCalls.fetch({ memberIds: userId }, { sort: { createdAt: 1 } }),
    dbMessageBookmarks.fetch({ userId }, { sort: { createdAt: 1 } }),
    dbDrafts.fetch({ userId }, { sort: { updatedAt: 1 } }),
    dbScheduledMessages.fetch({ userId }, { sort: { scheduledAt: 1 } }),
    dbReminders.fetch({ userId }, { sort: { remindAt: 1 } }),
    dbStories.fetch({ authorId: userId }, { sort: { createdAt: 1 } }),
    dbAdminActions.fetch({ $or: [{ actorId: userId }, { targetId: userId }] }, { sort: { createdAt: 1 } }),
    dbChannels.fetch({ $or: [{ ownerId: userId }, { subscriberIds: userId }] }, { sort: { createdAt: 1 } }),
    dbUserBlocks.fetch({ $or: [{ blockerId: userId }, { blockedId: userId }] }, { sort: { createdAt: 1 } }),
  ]);
  const chatIds = chats.map((chat) => chat._id.toString());
  const channelIds = channels.map((channel) => channel._id.toString());
  const storyIds = stories.map((story) => story._id.toString());
  const memberIds = [...new Set(chats.flatMap((chat) => chat.memberIds))];
  const [messages, sharedNotes, storyViews, channelPosts, channelComments, members] = await Promise.all([
    dbMessages.fetch({ chatId: { $in: chatIds } }, { sort: { createdAt: 1 } }),
    dbSharedNotes.fetch({ chatId: { $in: chatIds } }, { sort: { updatedAt: 1 } }),
    dbStoryViews.fetch({ $or: [{ storyId: { $in: storyIds } }, { viewerId: userId }] }, { sort: { viewedAt: 1 } }),
    dbChannelPosts.fetch({ channelId: { $in: channelIds } }, { sort: { createdAt: 1 } }),
    dbChannelComments.fetch({ channelId: { $in: channelIds } }, { sort: { createdAt: 1 } }),
    dbProfiles.fetch({ userId: { $in: memberIds.filter(ObjectId.isValid).map((id) => new ObjectId(id)) } }),
  ]);
  const safeSettings = settings ? exportDocument(settings) : defaultSettings(userId);
  delete (safeSettings as Partial<SettingsDocument>).totpSecretEncrypted;
  delete (safeSettings as Partial<SettingsDocument>).totpPendingSecretEncrypted;
  delete (safeSettings as Partial<SettingsDocument>).pinSalt;
  delete (safeSettings as Partial<SettingsDocument>).pinHash;
  delete (safeSettings as Partial<SettingsDocument>).additionalPasswordVerifier;
  delete (safeSettings as Partial<SettingsDocument>).decoyUserId;
  delete (safeSettings as Partial<SettingsDocument>).decoySalt;
  delete (safeSettings as Partial<SettingsDocument>).decoyHash;
  const safeSessions = sessions.map(({ _id, tokenHash: _tokenHash, ...session }) => ({ id: _id.toString(), ...session }));
  const attachments = [
    ...messages.filter((message) => message.filePath).map((message) => ({ ownerType: 'message', ownerId: message._id.toString(), path: message.filePath, name: message.fileName, size: message.fileSize, mimeType: message.mimeType })),
    ...stories.map((story) => ({ ownerType: 'story', ownerId: story._id.toString(), path: story.filePath, name: null, size: null, mimeType: story.mimeType })),
  ];
  const payload = {
    schema: 'wyre-export-v2',
    exportedAt: new Date().toISOString(),
    account: account ? { email: account.email, yandexLinked: Boolean(account.yandexId), createdAt: account.createdAt, lastLoginAt: account.lastLoginAt } : null,
    profile: { id: userId, email: profile.email, name: profile.name, username: profile.username, usernameHistory: profile.usernameHistory, bio: profile.bio, phone: profile.phone, badge: profile.badge, role: profile.role, warnings: profile.warnings, createdAt: profile.createdAt, updatedAt: profile.updatedAt, lastSeenAt: profile.lastSeenAt, presenceVisibility: profile.presenceVisibility, presenceAlways: profile.presenceAlways, presenceNever: profile.presenceNever },
    settings: safeSettings,
    sessions: safeSessions,
    contacts: members.map((member) => ({ id: member.userId.toString(), name: member.name, username: member.username })),
    chats: chats.map(exportDocument), messages: messages.map(exportDocument), bookmarks: bookmarks.map(exportDocument), drafts: drafts.map(exportDocument), scheduledMessages: scheduledMessages.map(exportDocument), reminders: reminders.map(exportDocument), sharedNotes: sharedNotes.map(exportDocument),
    stories: stories.map(exportDocument), storyViews: storyViews.map(exportDocument), calls: calls.map(exportDocument),
    channels: channels.map(exportDocument), channelPosts: channelPosts.map(exportDocument), channelComments: channelComments.map(exportDocument),
    moderationHistory: adminActions.map(exportDocument), userBlocks: userBlocks.map(exportDocument), attachments,
  };
  if (format === 'json') return { contentType: 'application/json; charset=utf-8', extension: 'json', body: JSON.stringify(payload, null, 2) };
  if (format === 'txt') {
    const lines = [`Wyre export: ${payload.exportedAt}`, `Профиль: ${profile.name} (@${profile.username})`, ''];
    for (const chat of payload.chats) {
      lines.push(`=== ${chat.title ?? chat.kind} (${chat.id}) ===`);
      for (const message of payload.messages.filter((item) => item.chatId === chat.id)) lines.push(`[${new Date(message.createdAt).toLocaleString('ru-RU')}] ${message.authorId === userId ? 'Вы' : message.authorId}: ${message.text}`);
      lines.push('');
    }
    return { contentType: 'text/plain; charset=utf-8', extension: 'txt', body: lines.join('\n') };
  }
  const document = new PDFDocument({ margin: 48 });
  const fontFile = [env.PDF_FONT_FILE, 'C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf'].find((candidate) => candidate && existsSync(candidate));
  if (fontFile) document.font(fontFile);
  const chunks: Buffer[] = [];
  const body = await new Promise<Buffer>((resolve) => { document.on('data', (chunk) => chunks.push(Buffer.from(chunk))); document.on('end', () => resolve(Buffer.concat(chunks))); document.fontSize(18).text('Wyre export'); document.moveDown().fontSize(10).text(`Profile: ${profile.name} (@${profile.username})`); for (const chat of payload.chats) { document.moveDown().fontSize(13).text(chat.title ?? chat.kind); for (const message of payload.messages.filter((item) => item.chatId === chat.id)) document.fontSize(9).text(`[${new Date(message.createdAt).toISOString()}] ${message.authorId === userId ? 'You' : message.authorId}: ${message.text}`); } document.end(); });
  return { contentType: 'application/pdf', extension: 'pdf', body };
}
