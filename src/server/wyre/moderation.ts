import z from 'zod';
import { dbDeviceAccounts, dbDevices, dbSessions, dbUsers } from '../core/authDb';
import { ObjectId } from '../core/database';
import { AppError, ValidationError } from '../core/errors';
import { deleteStoredFile } from '../core/storage';
import type { UserInfo } from '../core/types';

import {
  dbAdminActions,
  dbCallInvites,
  dbCallSignals,
  dbCalls,
  dbChannelComments,
  dbChannelPosts,
  dbChannels,
  dbChats,
  dbDrafts,
  dbFamilyInvites,
  dbFamilyLinks,
  dbMessageBookmarks,
  dbMessages,
  dbNotificationJobs,
  dbProfiles,
  dbPushSubscriptions,
  dbQuietCareAlerts,
  dbReminders,
  dbScheduledMessages,
  dbSettings,
  dbSharedNotes,
  dbStories,
  dbStoryViews,
  dbTopics,
  dbUserBlocks,
  dbWebAuthnCredentials,
  dbYandexLinkRequests,
} from './db';
import { activeWarnings, requireVerifiedProfile } from './profile';

type ProfileDoc = NonNullable<Awaited<ReturnType<typeof dbProfiles.findOne>>>;
type StaffRole = ProfileDoc['role'];

const roleRank: Record<StaffRole, number> = { user: 0, moderator: 1, admin: 2, owner: 3 };

/** Ten years in minutes — the ceiling for any ban or warning duration. */
const MAX_DURATION_MINUTES = 5_256_000;

const durationSchema = z.number().positive().max(MAX_DURATION_MINUTES).nullable();

export async function requireStaff(user: UserInfo | null, minimum: Exclude<StaffRole, 'user'> = 'moderator') {
  const actor = await requireVerifiedProfile(user);
  if (roleRank[actor.role] < roleRank[minimum]) {
    throw new AppError('Недостаточно прав для этого действия', 403, 'FORBIDDEN');
  }
  return actor;
}

async function targetProfile(targetId: string) {
  if (!ObjectId.isValid(targetId)) throw new ValidationError('Пользователь не найден');
  const target = await dbProfiles.findOne({ _id: new ObjectId(targetId) });
  if (!target) throw new ValidationError('Пользователь не найден');
  return target;
}

function assertCanTarget(actor: ProfileDoc, target: ProfileDoc) {
  if (target.role === 'owner' || roleRank[actor.role] <= roleRank[target.role]) {
    throw new AppError('Нельзя применить действие к пользователю с равными или более высокими правами', 403, 'FORBIDDEN');
  }
}

export async function logAction(actor: ProfileDoc, target: ProfileDoc, action: string, details: string) {
  await dbAdminActions.insertOne({
    actorId: actor._id.toString(),
    actorName: actor.name,
    targetId: target._id.toString(),
    targetName: target.name,
    action,
    details,
    createdAt: new Date(),
  });
}

export const moderationQueries = {
  adminUsers: async (args: unknown, { user }: { user: UserInfo | null }) => {
    await requireStaff(user);
    const { query } = z.object({ query: z.string().trim().max(100).default('') }).parse(args);
    const normalized = query.toLowerCase();
    const profiles = await dbProfiles.fetch({ isDecoy: { $ne: true }, isService: { $ne: true } }, { sort: { createdAt: 1 }, limit: 200 });
    return profiles
      .filter((profile) => !normalized || `${profile.name} ${profile.username} ${profile.email}`.toLowerCase().includes(normalized))
      .map((profile) => {
        const warnings = activeWarnings(profile);
        return {
          id: profile._id.toString(),
          name: profile.name,
          username: `@${profile.username}`,
          initials: profile.initials,
          colors: [profile.colors[0], profile.colors[1]],
          warnings: warnings.length,
          warningReasons: warnings.map((warning) => warning.reason),
          warningDetails: warnings.map((warning) => ({
            reason: warning.reason,
            issuedAt: warning.issuedAt,
            expiresAt: warning.expiresAt ?? null,
          })),
          role: profile.role,
          badge: profile.badge ?? undefined,
          banned: Boolean(profile.bannedUntil && new Date(profile.bannedUntil).getTime() > Date.now()),
          bannedUntil: profile.bannedUntil ?? null,
          banReason: profile.banReason ?? null,
        };
      });
  },

  adminLog: async (_args: unknown, { user }: { user: UserInfo | null }) => {
    await requireStaff(user);
    const entries = await dbAdminActions.fetch({}, { sort: { createdAt: -1 }, limit: 200 });
    return entries.map((entry) => ({
      id: entry._id.toString(),
      actor: entry.actorName,
      action: `${entry.action}: ${entry.targetName}${entry.details ? ` · ${entry.details}` : ''}`,
      time: new Date(entry.createdAt).toLocaleString('ru-RU'),
    }));
  },

  /**
   * Device inspection for staff. Only coarse metadata is exposed: the opaque
   * device cookie and raw fingerprint material never leave the server.
   */
  adminUserDevices: async (args: unknown, { user }: { user: UserInfo | null }) => {
    await requireStaff(user);
    const { targetId } = z.object({ targetId: z.string() }).parse(args);
    const target = await targetProfile(targetId);
    const links = await dbDeviceAccounts.fetch({ userId: target.userId }, { sort: { lastSeenAt: -1 }, limit: 50 });
    const devices = links.length ? await dbDevices.fetch({ _id: { $in: links.map((link) => link.deviceId) } }) : [];
    const byId = new Map(devices.map((device) => [device._id.toString(), device]));
    return Promise.all(links.map(async (link) => {
      const device = byId.get(link.deviceId.toString());
      const accountCount = await dbDeviceAccounts.countDocuments({ deviceId: link.deviceId });
      return {
        deviceId: link.deviceId.toString(),
        platform: device?.platform ?? 'Устройство',
        browser: device?.userAgentFamily ?? 'Браузер',
        firstSeenAt: link.firstSeenAt,
        lastSeenAt: link.lastSeenAt,
        activeSessions: await dbSessions.countDocuments({ deviceId: link.deviceId, expiresAt: { $gt: new Date() } }),
        // A shared family computer is normal, so staff sees the count explicitly.
        accountCount,
        shared: accountCount > 1,
        banned: Boolean(device?.bannedUntil && new Date(device.bannedUntil).getTime() > Date.now()),
        banReason: device?.banReason ?? null,
      };
    }));
  },

  adminDeviceAccounts: async (args: unknown, { user }: { user: UserInfo | null }) => {
    await requireStaff(user, 'admin');
    const { deviceId } = z.object({ deviceId: z.string().refine(ObjectId.isValid) }).parse(args);
    const links = await dbDeviceAccounts.fetch({ deviceId: new ObjectId(deviceId) }, { sort: { lastSeenAt: -1 }, limit: 50 });
    const profiles = links.length ? await dbProfiles.fetch({ userId: { $in: links.map((link) => link.userId) } }) : [];
    const byUser = new Map(profiles.map((profile) => [profile.userId.toString(), profile]));
    return links.map((link) => {
      const profile = byUser.get(link.userId.toString());
      return {
        profileId: profile?._id.toString() ?? null,
        name: profile?.name ?? 'Пользователь',
        username: profile ? `@${profile.username}` : '',
        role: profile?.role ?? 'user',
        lastSeenAt: link.lastSeenAt,
        banned: Boolean(profile?.bannedUntil && new Date(profile.bannedUntil).getTime() > Date.now()),
      };
    });
  },
};

export const moderationMutations = {
  issueWarning: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const actor = await requireStaff(user);
    const { targetId, reason, durationMinutes } = z
      .object({ targetId: z.string(), reason: z.string().trim().min(3).max(500), durationMinutes: durationSchema.default(null) })
      .parse(args);
    const target = await targetProfile(targetId);
    assertCanTarget(actor, target);
    const warnings = activeWarnings(target);
    if (warnings.length >= 2) throw new ValidationError('У пользователя уже два активных предупреждения');
    const warning = {
      reason,
      issuedAt: new Date(),
      issuedBy: actor._id.toString(),
      expiresAt: durationMinutes ? new Date(Date.now() + durationMinutes * 60_000) : null,
    };
    await dbProfiles.updateOne({ _id: target._id }, { $push: { warnings: warning }, $set: { updatedAt: new Date() } });
    await logAction(actor, target, 'Предупреждение', durationMinutes ? `${reason} · срок: ${formatDuration(durationMinutes)}` : reason);
    return { warnings: warnings.length + 1, expiresAt: warning.expiresAt };
  },

  removeWarning: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const actor = await requireStaff(user);
    const { targetId, issuedAt } = z.object({ targetId: z.string(), issuedAt: z.string() }).parse(args);
    const target = await targetProfile(targetId);
    assertCanTarget(actor, target);
    const warning = (target.warnings ?? []).find((entry) => new Date(entry.issuedAt).toISOString() === issuedAt);
    if (!warning) throw new ValidationError('Предупреждение не найдено или уже снято');
    await dbProfiles.updateOne(
      { _id: target._id },
      { $pull: { warnings: { issuedAt: new Date(warning.issuedAt), issuedBy: warning.issuedBy } }, $set: { updatedAt: new Date() } },
    );
    await logAction(actor, target, 'Снято предупреждение', warning.reason);
    return { warnings: (target.warnings ?? []).length - 1 };
  },

  setUserBadge: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const actor = await requireStaff(user, 'admin');
    const { targetId, badge } = z.object({ targetId: z.string(), badge: z.enum(['dev', 'official']).nullable() }).parse(args);
    const target = await targetProfile(targetId);
    assertCanTarget(actor, target);
    await dbProfiles.updateOne({ _id: target._id }, { $set: { badge, updatedAt: new Date() } });
    await logAction(actor, target, 'Изменён бейдж', badge ?? 'снят');
    return { badge };
  },

  setUserRole: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const actor = await requireStaff(user, 'owner');
    const { targetId, role } = z.object({ targetId: z.string(), role: z.enum(['user', 'moderator', 'admin']) }).parse(args);
    const target = await targetProfile(targetId);
    if (target.role === 'owner') throw new AppError('Роль владельца задаётся только через OWNER_EMAIL', 403, 'FORBIDDEN');
    await dbProfiles.updateOne({ _id: target._id }, { $set: { role, updatedAt: new Date() } });
    await logAction(actor, target, 'Изменена роль', role);
    return { role };
  },

  banUser: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const actor = await requireStaff(user);
    const { targetId, reason, durationMinutes, cascadeDevices } = z
      .object({ targetId: z.string(), reason: z.string().trim().min(3).max(500), durationMinutes: durationSchema.default(null), cascadeDevices: z.boolean().default(false) })
      .parse(args);
    if (durationMinutes === null && roleRank[actor.role] < roleRank.admin) {
      throw new AppError('Постоянная блокировка доступна только администратору', 403, 'FORBIDDEN');
    }
    if (cascadeDevices && roleRank[actor.role] < roleRank.admin) {
      throw new AppError('Каскадная блокировка устройств доступна только администратору', 403, 'FORBIDDEN');
    }
    const target = await targetProfile(targetId);
    assertCanTarget(actor, target);
    const bannedUntil = durationMinutes === null ? new Date('9999-12-31T23:59:59.999Z') : new Date(Date.now() + durationMinutes * 60_000);
    await dbProfiles.updateOne({ _id: target._id }, { $set: { bannedUntil, banReason: reason, updatedAt: new Date() } });
    await dbSessions.deleteMany({ userId: target.userId });
    await dbPushSubscriptions.deleteMany({ userId: target.userId.toString() });
    let bannedDevices = 0;
    if (cascadeDevices) {
      // Cascade covers every device the account has actually used, and each
      // device ban also revokes that device's other sessions.
      const links = await dbDeviceAccounts.fetch({ userId: target.userId }, { limit: 100 });
      for (const link of links) {
        await dbDevices.updateOne({ _id: link.deviceId }, { $set: { bannedUntil, banReason: reason, bannedBy: actor._id.toString() } });
        await dbSessions.deleteMany({ deviceId: link.deviceId });
        bannedDevices += 1;
      }
    }
    const logDetails = durationMinutes === null
      ? (cascadeDevices ? `${reason} · устройств: ${bannedDevices}` : reason)
      : (cascadeDevices ? `${reason} · срок: ${formatDuration(durationMinutes)} · устройств: ${bannedDevices}` : `${reason} · срок: ${formatDuration(durationMinutes)}`);
    await logAction(actor, target, durationMinutes === null ? 'Постоянная блокировка' : 'Временная блокировка', logDetails);
    return { bannedUntil, bannedDevices };
  },

  banDevice: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const actor = await requireStaff(user, 'admin');
    const { deviceId, targetId, reason, durationMinutes } = z.object({
      deviceId: z.string().refine(ObjectId.isValid),
      targetId: z.string(),
      reason: z.string().trim().min(3).max(500),
      durationMinutes: durationSchema.default(null),
    }).parse(args);
    const target = await targetProfile(targetId);
    assertCanTarget(actor, target);
    const device = await dbDevices.findOne({ _id: new ObjectId(deviceId) });
    if (!device) throw new ValidationError('Устройство не найдено');
    const link = await dbDeviceAccounts.findOne({ deviceId: device._id, userId: target.userId });
    if (!link) throw new ValidationError('Это устройство не связано с пользователем');
    const bannedUntil = durationMinutes === null ? new Date('9999-12-31T23:59:59.999Z') : new Date(Date.now() + durationMinutes * 60_000);
    await dbDevices.updateOne({ _id: device._id }, { $set: { bannedUntil, banReason: reason, bannedBy: actor._id.toString() } });
    await dbSessions.deleteMany({ deviceId: device._id });
    await logAction(actor, target, 'Блокировка устройства', durationMinutes === null ? reason : `${reason} · срок: ${formatDuration(durationMinutes)}`);
    return { banned: true, bannedUntil };
  },

  unbanDevice: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const actor = await requireStaff(user, 'admin');
    const { deviceId, targetId } = z.object({ deviceId: z.string().refine(ObjectId.isValid), targetId: z.string() }).parse(args);
    const target = await targetProfile(targetId);
    const device = await dbDevices.findOne({ _id: new ObjectId(deviceId) });
    if (!device) throw new ValidationError('Устройство не найдено');
    await dbDevices.updateOne({ _id: device._id }, { $set: { bannedUntil: null, banReason: null, bannedBy: null } });
    await logAction(actor, target, 'Разблокировка устройства', '');
    return { banned: false };
  },

  unbanUser: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const actor = await requireStaff(user, 'admin');
    const { targetId } = z.object({ targetId: z.string() }).parse(args);
    const target = await targetProfile(targetId);
    assertCanTarget(actor, target);
    await dbProfiles.updateOne({ _id: target._id }, { $set: { bannedUntil: null, banReason: null, updatedAt: new Date() } });
    await logAction(actor, target, 'Блокировка снята', '');
    return { banned: false };
  },

  /**
   * Full account deletion by staff. Every row owned by the user is removed,
   * direct chats die together with their history, and in groups only the
   * membership goes (the group itself keeps living without them). The action
   * is logged before the profile disappears.
   */
  deleteUserAccount: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const actor = await requireStaff(user, 'admin');
    const { targetId, reason } = z
      .object({ targetId: z.string(), reason: z.string().trim().min(3).max(500) })
      .parse(args);
    const target = await targetProfile(targetId);
    assertCanTarget(actor, target);
    if (target.isService) throw new ValidationError('Сервисные аккаунты удалить нельзя');

    const userId = target.userId;
    const userIdString = userId.toString();
    await logAction(actor, target, 'Удаление аккаунта', reason);

    const chats = await dbChats.fetch({ memberIds: userIdString }, { limit: 500 });
    for (const chat of chats) {
      const chatId = chat._id.toString();
      if (chat.kind === 'direct') {
        await dbMessages.deleteMany({ chatId });
        await dbTopics.deleteMany({ chatId });
        await dbSharedNotes.deleteMany({ chatId });
        await dbCalls.deleteMany({ chatId });
        await dbCallSignals.deleteMany({ chatId });
        await dbCallInvites.deleteMany({ chatId });
        await dbChats.deleteOne({ _id: chat._id });
      } else {
        await dbChats.updateOne({ _id: chat._id }, { $pull: { memberIds: userIdString, members: { userId: userIdString } } });
      }
    }

    // Personal rows and content authored by the deleted account.
    await dbMessages.deleteMany({ authorId: userIdString });
    await dbMessageBookmarks.deleteMany({ userId: userIdString });
    await dbDrafts.deleteMany({ userId: userIdString });
    await dbScheduledMessages.deleteMany({ userId: userIdString });
    await dbReminders.deleteMany({ userId: userIdString });
    await dbSettings.deleteMany({ userId: userIdString });
    await dbWebAuthnCredentials.deleteMany({ userId: userIdString });
    await dbStoryViews.deleteMany({ viewerId: userIdString });
    const ownStories = await dbStories.fetch({ authorId: userIdString }, { limit: 500 });
    for (const story of ownStories) {
      await dbStoryViews.deleteMany({ storyId: story._id.toString() });
      await dbStories.deleteOne({ _id: story._id });
    }
    await dbUserBlocks.deleteMany({ $or: [{ blockerId: userIdString }, { blockedId: userIdString }] });
    await dbFamilyInvites.deleteMany({ guardianId: userIdString });
    await dbFamilyLinks.deleteMany({ $or: [{ guardianId: userIdString }, { childId: userIdString }] });
    await dbQuietCareAlerts.deleteMany({ $or: [{ subjectId: userIdString }, { recipientId: userIdString }] });
    await dbNotificationJobs.deleteMany({ recipientId: userIdString });
    await dbYandexLinkRequests.deleteMany({ userId });

    // Channels: subscriptions are pulled, owned channels die with their posts.
    await dbChannels.updateMany({ subscriberIds: userIdString }, { $pull: { subscriberIds: userIdString } });
    const ownedChannels = await dbChannels.fetch({ ownerId: userIdString }, { limit: 50 });
    for (const channel of ownedChannels) {
      const channelId = channel._id.toString();
      await dbChannelPosts.deleteMany({ channelId });
      await dbChannelComments.deleteMany({ channelId });
      await dbChannels.deleteOne({ _id: channel._id });
    }
    await dbChannelPosts.deleteMany({ authorId: userIdString });
    await dbChannelComments.deleteMany({ authorId: userIdString });

    // Auth identity last: sessions, push, devices, the user record itself.
    await dbSessions.deleteMany({ userId });
    await dbPushSubscriptions.deleteMany({ userId: userIdString });
    await dbDeviceAccounts.deleteMany({ userId });
    await dbUsers.deleteOne({ _id: userId });
    if (target.avatarPath) await deleteStoredFile(target.avatarPath).catch(() => undefined);
    await dbProfiles.deleteOne({ _id: target._id });

    return { deleted: true };
  },
};

export function formatDuration(durationMinutes: number) {
  const days = Math.floor(durationMinutes / 1440);
  const hours = Math.floor((durationMinutes % 1440) / 60);
  const minutes = Math.round(durationMinutes % 60);
  const parts: string[] = [];
  if (days) parts.push(`${days} д`);
  if (hours) parts.push(`${hours} ч`);
  if (minutes || !parts.length) parts.push(`${minutes} мин`);
  return parts.join(' ');
}

/**
 * Timed warnings are additionally swept by the scheduler so the stored list
 * matches what every lazy reader already computes.
 */
export async function processExpiredWarnings() {
  const now = new Date();
  await dbProfiles.updateMany(
    { warnings: { $elemMatch: { expiresAt: { $ne: null, $lte: now } } } },
    { $pull: { warnings: { expiresAt: { $ne: null, $lte: now } } } },
  );
}
