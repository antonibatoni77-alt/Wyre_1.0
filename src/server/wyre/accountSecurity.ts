import z from 'zod';

import { dbSessions, dbUsers } from '../core/authDb';
import { hashPassword, passwordSchema, verifyPassword } from '../core/auth';
import { ObjectId } from '../core/database';
import { ValidationError } from '../core/errors';
import type { UserInfo } from '../core/types';
import {
  dbDrafts,
  dbMessageBookmarks,
  dbMessages,
  dbProfiles,
  dbReminders,
  dbScheduledMessages,
  dbSettings,
  dbUserBlocks,
  type SettingsDocument,
} from './db';
import { defaultSettings } from './settings';
import { requireVerifiedProfile } from './profile';

const ADDITIONAL_PASSWORD_ATTEMPTS = 5;

/**
 * Secret material that must never be imported from a user-supplied file.
 * Non-secret security flags are simply ignored by the whitelist below.
 */
const FORBIDDEN_SETTINGS_FIELDS = [
  'totpSecretEncrypted',
  'totpPendingSecretEncrypted',
  'pinSalt',
  'pinHash',
  'additionalPasswordVerifier',
  'decoyUserId',
  'decoySalt',
  'decoyHash',
] as const;

const restorableSettingsSchema = z.object({
  themeId: z.number().int().min(0).max(19).optional(),
  fontSize: z.number().int().min(12).max(20).optional(),
  font: z.enum(['system', 'rounded', 'mono']).optional(),
  autoTheme: z.boolean().optional(),
  dnd: z.boolean().optional(),
  dndFrom: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  dndTo: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  autoDnd: z.boolean().optional(),
  timeZone: z.string().max(100).optional(),
  previews: z.boolean().optional(),
  safeMode: z.boolean().optional(),
  contentFilter: z.enum(['all', 'contacts', 'none']).optional(),
  findByPhone: z.enum(['all', 'contacts', 'nobody']).optional(),
  callPermission: z.enum(['all', 'contacts', 'nobody']).optional(),
  invitePermission: z.enum(['all', 'contacts', 'nobody']).optional(),
  phoneVisibility: z.enum(['all', 'contacts', 'nobody']).optional(),
});

const backupSchema = z.object({
  schema: z.literal('wyre-export-v2'),
  profile: z.object({
    id: z.string(),
    email: z.string().email(),
    bio: z.string().max(200).optional(),
  }),
  settings: z.record(z.string(), z.unknown()).optional(),
  drafts: z.array(z.object({ chatId: z.string(), text: z.string().max(4000) })).max(1000).optional(),
  bookmarks: z.array(z.object({ messageId: z.string() })).max(2000).optional(),
  reminders: z.array(z.object({
    chatId: z.string(),
    messageId: z.string(),
    text: z.string().min(1).max(300),
    remindAt: z.coerce.date(),
  })).max(1000).optional(),
  scheduledMessages: z.array(z.object({
    chatId: z.string(),
    topicId: z.string().nullish(),
    text: z.string().min(1).max(4000),
    scheduledAt: z.coerce.date(),
  })).max(500).optional(),
  userBlocks: z.array(z.object({ blockerId: z.string(), blockedId: z.string() })).max(500).optional(),
});

async function writeSettings(userId: string, update: Partial<SettingsDocument>) {
  const current = await dbSettings.findOne({ userId });
  if (current) await dbSettings.updateOne({ _id: current._id }, { $set: { ...update, updatedAt: new Date() } });
  else await dbSettings.insertOne({ ...defaultSettings(userId), ...update, updatedAt: new Date() });
}

async function memberChatIds(userId: string) {
  const { dbChats } = await import('./db');
  const chats = await dbChats.fetch({ memberIds: userId });
  return new Set(chats.map((chat) => chat._id.toString()));
}

/**
 * Restores only entities the account itself owns. Shared history authored by
 * other members, moderation records and authentication secrets are never
 * imported, so a backup file cannot be used to forge conversations or
 * escalate account security state.
 */
async function applyRestore(userId: string, profileId: ObjectId, payload: z.infer<typeof backupSchema>, dryRun: boolean) {
  const chatIds = await memberChatIds(userId);
  const summary = {
    profile: 0,
    settings: 0,
    drafts: 0,
    bookmarks: 0,
    reminders: 0,
    scheduledMessages: 0,
    userBlocks: 0,
    skipped: [] as string[],
  };

  const settingsInput = payload.settings ?? {};
  for (const field of FORBIDDEN_SETTINGS_FIELDS) {
    const value = (settingsInput as Record<string, unknown>)[field];
    if (value !== undefined && value !== null) throw new ValidationError('Резервная копия содержит настройки безопасности и не может быть восстановлена', 'BACKUP_CONTAINS_SECRETS');
  }
  const settings = restorableSettingsSchema.parse(settingsInput);
  if (Object.keys(settings).length) summary.settings = 1;
  if (settings.timeZone) {
    try { Intl.DateTimeFormat('en', { timeZone: settings.timeZone }); }
    catch { throw new ValidationError('Некорректный часовой пояс в резервной копии'); }
  }

  if (typeof payload.profile.bio === 'string') summary.profile = 1;

  const drafts = (payload.drafts ?? []).filter((draft) => chatIds.has(draft.chatId));
  summary.drafts = drafts.length;
  if ((payload.drafts ?? []).length !== drafts.length) summary.skipped.push('drafts');

  const bookmarkIds: ObjectId[] = [];
  for (const bookmark of payload.bookmarks ?? []) {
    if (!ObjectId.isValid(bookmark.messageId)) continue;
    const message = await dbMessages.findOne({ _id: new ObjectId(bookmark.messageId) });
    if (message && chatIds.has(message.chatId)) bookmarkIds.push(message._id);
  }
  summary.bookmarks = bookmarkIds.length;
  if ((payload.bookmarks ?? []).length !== bookmarkIds.length) summary.skipped.push('bookmarks');

  const reminders = (payload.reminders ?? []).filter((reminder) =>
    chatIds.has(reminder.chatId)
    && ObjectId.isValid(reminder.messageId)
    && reminder.remindAt.getTime() > Date.now()
    && reminder.remindAt.getTime() <= Date.now() + 366 * 24 * 60 * 60 * 1000);
  summary.reminders = reminders.length;
  if ((payload.reminders ?? []).length !== reminders.length) summary.skipped.push('reminders');

  const scheduled = (payload.scheduledMessages ?? []).filter((item) =>
    chatIds.has(item.chatId)
    && item.scheduledAt.getTime() > Date.now() + 60 * 60 * 1000
    && item.scheduledAt.getTime() <= Date.now() + 366 * 24 * 60 * 60 * 1000);
  summary.scheduledMessages = scheduled.length;
  if ((payload.scheduledMessages ?? []).length !== scheduled.length) summary.skipped.push('scheduledMessages');

  const blocks: string[] = [];
  for (const block of payload.userBlocks ?? []) {
    if (block.blockerId !== payload.profile.id || !ObjectId.isValid(block.blockedId) || block.blockedId === userId) continue;
    if (await dbProfiles.findOne({ userId: new ObjectId(block.blockedId) })) blocks.push(block.blockedId);
  }
  summary.userBlocks = blocks.length;
  if ((payload.userBlocks ?? []).length !== blocks.length) summary.skipped.push('userBlocks');

  if (dryRun) return summary;

  if (summary.profile) await dbProfiles.updateOne({ _id: profileId }, { $set: { bio: payload.profile.bio ?? '', updatedAt: new Date() } });
  if (summary.settings) await writeSettings(userId, settings as Partial<SettingsDocument>);

  const now = new Date();
  for (const draft of drafts) {
    await dbDrafts.updateOne({ userId, chatId: draft.chatId }, { $set: { userId, chatId: draft.chatId, text: draft.text, updatedAt: now } }, { upsert: true });
  }
  for (const messageId of bookmarkIds) {
    await dbMessageBookmarks.updateOne(
      { userId, messageId: messageId.toString() },
      { $setOnInsert: { userId, messageId: messageId.toString(), createdAt: now } },
      { upsert: true },
    );
  }
  for (const reminder of reminders) {
    await dbReminders.updateOne(
      { userId, messageId: reminder.messageId },
      { $set: { userId, chatId: reminder.chatId, messageId: reminder.messageId, text: reminder.text, remindAt: reminder.remindAt, status: 'pending', notifiedAt: null, completedAt: null }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
  }
  for (const item of scheduled) {
    const existing = await dbScheduledMessages.findOne({ userId, chatId: item.chatId, text: item.text, scheduledAt: item.scheduledAt });
    if (!existing) await dbScheduledMessages.insertOne({ userId, chatId: item.chatId, topicId: item.topicId ?? null, text: item.text, scheduledAt: item.scheduledAt, createdAt: now, updatedAt: now });
  }
  for (const blockedId of blocks) {
    await dbUserBlocks.updateOne({ blockerId: userId, blockedId }, { $setOnInsert: { blockerId: userId, blockedId, createdAt: now } }, { upsert: true });
  }
  return summary;
}

export const accountSecurityQueries = {
  accountAuthStatus: async (_args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const [account, settings] = await Promise.all([
      dbUsers.findOne({ _id: profile.userId }),
      dbSettings.findOne({ userId: profile.userId.toString() }),
    ]);
    return {
      email: profile.email,
      loginPasswordEnabled: Boolean(account?.loginPasswordVerifier),
      additionalPasswordEnabled: Boolean(settings?.additionalPasswordVerifier),
      yandexLinked: Boolean(account?.yandexId),
      // OTP by email always remains available, so unlinking never locks the account out.
      canUnlinkYandex: Boolean(account?.yandexId),
    };
  },
};

export const accountSecurityMutations = {
  setLoginPassword: async (args: unknown, { user, sessionTokenHash }: { user: UserInfo | null; sessionTokenHash?: string }) => {
    const profile = await requireVerifiedProfile(user);
    const { password } = z.object({ password: passwordSchema() }).parse(args);
    await dbUsers.updateOne({ _id: profile.userId }, { $set: { loginPasswordVerifier: await hashPassword(password), loginPasswordFailedAttempts: 0, loginPasswordLockedUntil: null } });
    // A new password must invalidate every other session.
    if (sessionTokenHash) await dbSessions.deleteMany({ userId: profile.userId, tokenHash: { $ne: sessionTokenHash } });
    return { enabled: true };
  },

  disableLoginPassword: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const { password } = z.object({ password: passwordSchema() }).parse(args);
    const account = await dbUsers.findOne({ _id: profile.userId });
    if (!account?.loginPasswordVerifier) return { enabled: false };
    if (!await verifyPassword(password, account.loginPasswordVerifier)) throw new ValidationError('Неверный пароль', 'INVALID_PASSWORD');
    await dbUsers.updateOne({ _id: profile.userId }, { $set: { loginPasswordVerifier: null, loginPasswordFailedAttempts: 0, loginPasswordLockedUntil: null } });
    return { enabled: false };
  },

  setAdditionalPassword: async (args: unknown, { user, sessionTokenHash }: { user: UserInfo | null; sessionTokenHash?: string }) => {
    const profile = await requireVerifiedProfile(user);
    if (!sessionTokenHash) throw new ValidationError('Сессия не найдена');
    const { password } = z.object({ password: passwordSchema() }).parse(args);
    await writeSettings(profile.userId.toString(), { additionalPasswordVerifier: await hashPassword(password) });
    await dbSessions.updateMany({ userId: profile.userId }, { $set: { additionalPasswordVerified: false, additionalPasswordAttempts: 0 } });
    await dbSessions.updateOne({ tokenHash: sessionTokenHash, userId: profile.userId }, { $set: { additionalPasswordVerified: true, additionalPasswordAttempts: 0 } });
    return { enabled: true };
  },

  disableAdditionalPassword: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const { password } = z.object({ password: passwordSchema() }).parse(args);
    const settings = await dbSettings.findOne({ userId: profile.userId.toString() });
    if (!settings?.additionalPasswordVerifier) return { enabled: false };
    if (!await verifyPassword(password, settings.additionalPasswordVerifier)) throw new ValidationError('Неверный дополнительный пароль', 'INVALID_ADDITIONAL_PASSWORD');
    await dbSettings.updateOne({ _id: settings._id }, { $set: { additionalPasswordVerifier: null, updatedAt: new Date() } });
    await dbSessions.updateMany({ userId: profile.userId }, { $set: { additionalPasswordVerified: false, additionalPasswordAttempts: 0 } });
    return { enabled: false };
  },

  verifyAdditionalPasswordLogin: async (args: unknown, { user, sessionTokenHash }: { user: UserInfo | null; sessionTokenHash?: string }) => {
    if (!user || !sessionTokenHash) throw new ValidationError('Сессия не найдена');
    const { password } = z.object({ password: passwordSchema() }).parse(args);
    const settings = await dbSettings.findOne({ userId: user.id });
    if (!settings?.additionalPasswordVerifier) throw new ValidationError('Дополнительный пароль не включён');
    const session = await dbSessions.findOne({ tokenHash: sessionTokenHash, userId: new ObjectId(user.id), expiresAt: { $gt: new Date() } });
    if (!session) throw new ValidationError('Сессия не найдена');
    if (!await verifyPassword(password, settings.additionalPasswordVerifier)) {
      const attempts = (session.additionalPasswordAttempts ?? 0) + 1;
      if (attempts >= ADDITIONAL_PASSWORD_ATTEMPTS) {
        await dbSessions.deleteOne({ _id: session._id });
        throw new ValidationError('Слишком много неудачных попыток. Начните вход заново.', 'ADDITIONAL_PASSWORD_LOCKED');
      }
      await dbSessions.updateOne({ _id: session._id }, { $set: { additionalPasswordAttempts: attempts } });
      throw new ValidationError('Неверный дополнительный пароль', 'INVALID_ADDITIONAL_PASSWORD');
    }
    await dbSessions.updateOne({ _id: session._id }, { $set: { additionalPasswordVerified: true, additionalPasswordAttempts: 0 } });
    return { done: true };
  },

  unlinkYandex: async (_args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const account = await dbUsers.findOne({ _id: profile.userId });
    if (!account?.yandexId) return { linked: false };
    await dbUsers.native().updateOne({ _id: profile.userId }, { $unset: { yandexId: '' } });
    dbUsers.changed();
    return { linked: false };
  },

  validateBackup: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const { backup } = z.object({ backup: z.unknown() }).parse(args);
    const payload = backupSchema.parse(backup);
    if (payload.profile.email.trim().toLowerCase() !== profile.email) throw new ValidationError('Резервная копия принадлежит другому аккаунту', 'BACKUP_ACCOUNT_MISMATCH');
    return { valid: true, plan: await applyRestore(profile.userId.toString(), profile._id, payload, true) };
  },

  restoreBackup: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const { backup } = z.object({ backup: z.unknown() }).parse(args);
    const payload = backupSchema.parse(backup);
    if (payload.profile.email.trim().toLowerCase() !== profile.email) throw new ValidationError('Резервная копия принадлежит другому аккаунту', 'BACKUP_ACCOUNT_MISMATCH');
    return { restored: true, applied: await applyRestore(profile.userId.toString(), profile._id, payload, false) };
  },
};
