import z from 'zod';
import { dbSessions, dbUsers } from '../core/authDb';
import { ObjectId } from '../core/database';
import { AppError, AuthError, ValidationError } from '../core/errors';
import { getFileUrl } from '../core/storage';
import type { UserInfo } from '../core/types';

import { dbChats, dbProfiles, dbSettings, dbUserBlocks } from './db';

const AVATAR_PALETTES: [string, string][] = [
  ['#8b5cf6', '#4338ca'],
  ['#2563eb', '#22d3ee'],
  ['#ec4899', '#7c3aed'],
  ['#f59e0b', '#ef4444'],
  ['#14b8a6', '#0f766e'],
  ['#f472b6', '#be185d'],
  ['#22d3ee', '#0369a1'],
  ['#a3e635', '#4d7c0f'],
];

export const usernameSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^@+/, ''))
  .pipe(
    z
      .string()
      .min(3, 'Username должен содержать минимум 3 символа')
      .max(32, 'Username не может быть длиннее 32 символов')
      .regex(/^[a-zA-Z0-9_]+$/, 'Только латинские буквы, цифры и подчёркивание')
  );

export const nameSchema = z
  .string()
  .trim()
  .min(1, 'Укажите имя')
  .max(64, 'Имя не может быть длиннее 64 символов');

export function normalizePhone(phone: string) {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('8') ? `7${digits.slice(1)}` : digits;
}

export function initialsFrom(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function paletteFor(seed: string): [string, string] {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTES[hash % AVATAR_PALETTES.length];
}

export function requireUser(user: UserInfo | null) {
  if (!user) throw new AuthError('Требуется вход в аккаунт');
  return user;
}

type ProfileDoc = NonNullable<Awaited<ReturnType<typeof dbProfiles.findOne>>>;

/** A timed warning stops counting the moment its expiry passes; null means permanent. */
export function warningActive(warning: { expiresAt?: Date | null }, now = Date.now()) {
  return !warning.expiresAt || new Date(warning.expiresAt).getTime() > now;
}

export function activeWarnings(profile: ProfileDoc) {
  return (profile.warnings ?? []).filter((warning) => warningActive(warning));
}

export function serializeProfile(profile: ProfileDoc) {
  return {
    id: profile._id.toString(),
    name: profile.name,
    username: profile.username,
    usernameHistory: (profile.usernameHistory ?? []).map((entry) => ({
      username: entry.username,
      changedAt: entry.changedAt,
    })),
    email: profile.email,
    bio: profile.bio ?? '',
    phone: profile.phone ?? null,
    colors: [profile.colors[0], profile.colors[1]] as [string, string],
    initials: profile.initials,
    badge: profile.badge ?? null,
    role: profile.role,
    warnings: activeWarnings(profile).map((warning) => ({
      reason: warning.reason,
      issuedAt: warning.issuedAt,
    })),
    presenceVisibility: profile.presenceVisibility ?? 'contacts',
    presenceAlways: profile.presenceAlways ?? [],
    presenceNever: profile.presenceNever ?? [],
  };
}

export async function avatarUrlOf(profile: { avatarPath?: string | null; avatarMimeType?: string | null }) {
  if (!profile.avatarPath) return null;
  try {
    return (await getFileUrl(profile.avatarPath, profile.avatarMimeType ?? 'image/jpeg')).url;
  } catch {
    return null;
  }
}

export async function serializeProfileWithAvatar(profile: ProfileDoc) {
  return { ...serializeProfile(profile), avatarUrl: await avatarUrlOf(profile) };
}

export async function findProfileByUserId(userId: string) {
  return dbProfiles.findOne({ userId: new ObjectId(userId) });
}

export async function primaryEmail(userId: string) {
  const authUser = await dbUsers.findOne({ _id: new ObjectId(userId) });
  return (authUser?.email ?? '').toLowerCase();
}

export async function blockedUserIds(userId: string) {
  const blocks = await dbUserBlocks.fetch({ $or: [{ blockerId: userId }, { blockedId: userId }] });
  return new Set(blocks.map((block) => block.blockerId === userId ? block.blockedId : block.blockerId));
}

export async function requireNotBlocked(firstUserId: string, secondUserId: string) {
  const block = await dbUserBlocks.findOne({ $or: [
    { blockerId: firstUserId, blockedId: secondUserId },
    { blockerId: secondUserId, blockedId: firstUserId },
  ] });
  if (block) throw new AppError('Действие недоступно из-за блокировки пользователя', 403, 'USER_BLOCKED');
}

export type PrivacyAction = 'find' | 'call' | 'invite' | 'phone';

export async function areContacts(firstUserId: string, secondUserId: string) {
  return Boolean(await dbChats.findOne({ kind: 'direct', pairKey: [firstUserId, secondUserId].sort().join(':') }));
}

export async function privacyActionAllowed(targetUserId: string, actorUserId: string, action: PrivacyAction) {
  if (targetUserId === actorUserId) return true;
  const settings = await dbSettings.findOne({ userId: targetUserId });
  if ((settings?.privacyNever?.[action] ?? []).includes(actorUserId)) return false;
  if ((settings?.privacyAlways?.[action] ?? []).includes(actorUserId)) return true;
  const field = action === 'find' ? 'findByPhone' : action === 'call' ? 'callPermission' : action === 'invite' ? 'invitePermission' : 'phoneVisibility';
  let rule = settings?.[field] ?? (action === 'invite' ? 'all' : 'contacts');
  if ((settings?.safeMode || settings?.familyProtection) && rule === 'all') rule = 'contacts';
  if (rule === 'all') return true;
  if (rule === 'nobody') return false;
  return areContacts(targetUserId, actorUserId);
}

export async function requirePrivacyAction(targetUserId: string, actorUserId: string, action: PrivacyAction) {
  if (!await privacyActionAllowed(targetUserId, actorUserId, action)) {
    const message = action === 'call' ? 'Пользователь ограничил входящие звонки' : action === 'invite' ? 'Пользователь ограничил приглашения в чаты' : 'Действие запрещено настройками приватности';
    throw new AppError(message, 403, 'PRIVACY_RESTRICTED');
  }
}

export async function requireContentAllowed(targetUserId: string, actorUserId: string) {
  const settings = await dbSettings.findOne({ userId: targetUserId });
  let rule = settings?.contentFilter ?? 'all';
  if ((settings?.safeMode || settings?.familyProtection) && rule === 'all') rule = 'contacts';
  const allowed = rule === 'all' || (rule === 'contacts' && await areContacts(targetUserId, actorUserId));
  if (!allowed) throw new AppError('Пользователь ограничил входящий контент', 403, 'CONTENT_RESTRICTED');
}

/**
 * Server-side gate for every Wyre data endpoint: the caller must be logged in,
 * have a completed profile, and have passed the secondary login challenge.
 */
export async function requireVerifiedProfile(user: UserInfo | null) {
  const authUser = requireUser(user);
  const profile = await findProfileByUserId(authUser.id);
  if (!profile) throw new AuthError('Профиль не завершён');
  if (profile.pendingChallenge) throw new AuthError('Требуется подтверждение входа');
  if (phoneSetupPending(profile)) throw new AuthError('Завершите регистрацию: укажите номер или пропустите шаг');
  const settings = await dbSettings.findOne({ userId: profile.userId.toString() });
  if (settings?.totpEnabled && !authUser.totpVerified) throw new AppError('Введите код двухфакторной аутентификации', 403, 'TOTP_REQUIRED');
  if (settings?.pinEnabled && !authUser.pinVerified) throw new AppError('Введите PIN-код', 403, 'PIN_REQUIRED');
  if (settings?.additionalPasswordVerifier && !authUser.additionalPasswordVerified) throw new AppError('Введите дополнительный пароль', 403, 'ADDITIONAL_PASSWORD_REQUIRED');
  if ((settings?.webauthnAccountEnabled && !authUser.webauthnAccountVerified) || (settings?.webauthnAppEnabled && !authUser.webauthnAppVerified)) {
    throw new AppError('Подтвердите вход биометрией устройства', 403, 'WEBAUTHN_REQUIRED');
  }
  if (settings?.newDeviceApprovalEnabled && !authUser.deviceApproved) {
    throw new AppError('Вход ожидает подтверждения на доверенном устройстве', 403, 'DEVICE_APPROVAL_REQUIRED');
  }
  if (profile.bannedUntil && new Date(profile.bannedUntil).getTime() > Date.now()) {
    const permanent = new Date(profile.bannedUntil).getFullYear() >= 9999;
    throw new AppError(
      permanent
        ? `Аккаунт заблокирован. Причина: ${profile.banReason ?? 'не указана'}`
        : `Аккаунт заблокирован до ${new Date(profile.bannedUntil).toLocaleString('ru-RU')}. Причина: ${profile.banReason ?? 'не указана'}`,
      403,
      'ACCOUNT_BANNED',
    );
  }
  return profile;
}

export function phoneSetupPending(profile: ProfileDoc) {
  // Profiles created before this flag existed did not record the user's
  // decision, so phone-less legacy profiles are offered the step once.
  return profile.phoneOnboardingPending ?? profile.phone === null;
}

/** Called from the `onAfterLogin` auth hook — see src/server/app.ts. */
export async function markLoginChallengePending(userId: string) {
  await dbProfiles.updateOne(
    { userId: new ObjectId(userId) },
    { $set: { pendingChallenge: true, challengeAttempts: 0, updatedAt: new Date() } }
  );
}

export const MAX_CHALLENGE_ATTEMPTS = 5;

export async function registerFailedAttempt(profile: ProfileDoc) {
  const attempts = (profile.challengeAttempts ?? 0) + 1;
  await dbProfiles.updateOne(
    { _id: profile._id },
    { $set: { challengeAttempts: attempts, updatedAt: new Date() } }
  );
  if (attempts >= MAX_CHALLENGE_ATTEMPTS) {
    await dbSessions.deleteMany({ userId: profile.userId });
    throw new ValidationError('Слишком много неудачных попыток. Начните вход заново.');
  }
}
