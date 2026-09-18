import { createHash, randomBytes } from 'node:crypto';
import z from 'zod';

import { ObjectId } from '../core/database';
import { env } from '../core/env';
import { ValidationError } from '../core/errors';
import type { UserInfo } from '../core/types';
import { dbChats, dbFamilyInvites, dbFamilyLinks, dbProfiles, dbQuietCareAlerts, dbSettings, dbUserBlocks, type SettingsDocument } from './db';
import { defaultSettings } from './settings';
import { areContacts, requireVerifiedProfile } from './profile';

const INVITE_TTL_MS = 15 * 60_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function codeHash(code: string) {
  return createHash('sha256').update(`${env.SESSION_SECRET}:family:${code}`).digest('hex');
}

function makeCode() {
  const bytes = randomBytes(8);
  return Array.from(bytes, (value) => CODE_ALPHABET[value % CODE_ALPHABET.length]).join('');
}

async function writeSettings(userId: string, update: Partial<SettingsDocument>) {
  const current = await dbSettings.findOne({ userId });
  if (current) await dbSettings.updateOne({ _id: current._id }, { $set: { ...update, updatedAt: new Date() } });
  else await dbSettings.insertOne({ ...defaultSettings(userId), ...update, updatedAt: new Date() });
}

async function publicFamilyProfile(userId: string) {
  if (!ObjectId.isValid(userId)) return null;
  const profile = await dbProfiles.findOne({ userId: new ObjectId(userId) });
  if (!profile || profile.isDecoy) return null;
  const settings = await dbSettings.findOne({ userId });
  return {
    userId,
    name: profile.name,
    username: profile.username,
    initials: profile.initials,
    colors: [profile.colors[0], profile.colors[1]],
    protectionEnabled: Boolean(settings?.familyProtection),
  };
}

export const familyQueries = {
  /**
   * "Quiet care": a soft heads-up for close contacts when someone has not been
   * online for a while. It is opt-in by the subject, never reveals precise
   * activity and is only visible to people the subject already talks to.
   */
  quietCareAlerts: async (_args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const recipientId = profile.userId.toString();
    const alerts = await dbQuietCareAlerts.fetch({ recipientId, dismissedAt: null }, { sort: { createdAt: -1 }, limit: 20 });
    const results = [];
    for (const alert of alerts) {
      const subject = await publicFamilyProfile(alert.subjectId);
      if (!subject) continue;
      results.push({
        id: alert._id.toString(),
        userId: alert.subjectId,
        name: subject.name,
        username: subject.username,
        initials: subject.initials,
        colors: subject.colors,
        days: alert.days,
        // Only the day count is exposed, never the exact last-seen timestamp.
        createdAt: alert.createdAt.toISOString(),
      });
    }
    return results;
  },

  quietCareSettings: async (_args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const settings = await dbSettings.findOne({ userId: profile.userId.toString() });
    return { enabled: Boolean(settings?.quietCareEnabled), days: settings?.quietCareDays ?? 3 };
  },

  familyStatus: async (_args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const userId = profile.userId.toString();
    const [guardianLinks, childLinks] = await Promise.all([
      dbFamilyLinks.fetch({ childId: userId }, { sort: { createdAt: 1 } }),
      dbFamilyLinks.fetch({ guardianId: userId }, { sort: { createdAt: 1 } }),
    ]);
    const guardians = (await Promise.all(guardianLinks.map((link) => publicFamilyProfile(link.guardianId)))).filter(Boolean);
    const children = (await Promise.all(childLinks.map((link) => publicFamilyProfile(link.childId)))).filter(Boolean);
    return { guardians, children, managed: guardians.length > 0 };
  },
};

export const familyMutations = {
  setQuietCare: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const { enabled, days } = z.object({ enabled: z.boolean(), days: z.number().int().min(1).max(30).default(3) }).parse(args);
    const userId = profile.userId.toString();
    await writeSettings(userId, { quietCareEnabled: enabled, quietCareDays: days, ...(enabled ? {} : { quietCareNotifiedAt: null }) });
    if (!enabled) await dbQuietCareAlerts.deleteMany({ subjectId: userId });
    return { enabled, days };
  },

  dismissQuietCareAlert: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const { alertId } = z.object({ alertId: z.string().refine(ObjectId.isValid) }).parse(args);
    const result = await dbQuietCareAlerts.updateOne(
      { _id: new ObjectId(alertId), recipientId: profile.userId.toString(), dismissedAt: null },
      { $set: { dismissedAt: new Date() } },
    );
    if (!result.matchedCount) throw new ValidationError('Напоминание не найдено');
    return { dismissed: true };
  },

  createFamilyInvite: async (_args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    if (profile.isDecoy) throw new ValidationError('Decoy-аккаунт нельзя использовать для семейной связи');
    const guardianId = profile.userId.toString();
    await dbFamilyInvites.deleteMany({ guardianId });
    const code = makeCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
    await dbFamilyInvites.insertOne({ guardianId, codeHash: codeHash(code), createdAt: now, expiresAt });
    return { code, expiresAt };
  },
  acceptFamilyInvite: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    if (profile.isDecoy) throw new ValidationError('Decoy-аккаунт нельзя добавлять в семью');
    const { code } = z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z2-9]{8}$/) }).parse(args);
    const invite = await dbFamilyInvites.native().findOneAndDelete({ codeHash: codeHash(code), expiresAt: { $gt: new Date() } });
    if (!invite) throw new ValidationError('Код приглашения недействителен или истёк');
    dbFamilyInvites.changed();
    const childId = profile.userId.toString();
    if (invite.guardianId === childId) throw new ValidationError('Нельзя принять собственное приглашение');
    const guardian = await publicFamilyProfile(invite.guardianId);
    if (!guardian) throw new ValidationError('Аккаунт пригласившего не найден');
    if (await dbFamilyLinks.findOne({ guardianId: childId, childId: invite.guardianId })) throw new ValidationError('Нельзя создать встречную семейную связь');
    if (await dbFamilyLinks.countDocuments({ childId }) >= 2) throw new ValidationError('К аккаунту уже привязано два взрослых');
    const now = new Date();
    await dbFamilyLinks.updateOne(
      { guardianId: invite.guardianId, childId },
      { $setOnInsert: { guardianId: invite.guardianId, childId, createdAt: now, updatedAt: now } },
      { upsert: true },
    );
    await writeSettings(childId, {
      familyProtection: true,
      safeMode: true,
      findByPhone: 'contacts',
      callPermission: 'contacts',
      invitePermission: 'contacts',
      phoneVisibility: 'contacts',
      contentFilter: 'contacts',
    });
    return { accepted: true, guardian };
  },
  setChildProtection: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const value = z.object({
      childId: z.string().refine(ObjectId.isValid),
      enabled: z.boolean(),
      callPermission: z.enum(['contacts', 'nobody']).optional(),
      invitePermission: z.enum(['contacts', 'nobody']).optional(),
      findByPhone: z.enum(['contacts', 'nobody']).optional(),
      phoneVisibility: z.enum(['contacts', 'nobody']).optional(),
      contentFilter: z.enum(['contacts', 'none']).optional(),
    }).parse(args);
    const guardianId = profile.userId.toString();
    if (!await dbFamilyLinks.findOne({ guardianId, childId: value.childId })) throw new ValidationError('Семейная связь не найдена');
    const { childId, enabled, ...policy } = value;
    await writeSettings(childId, { ...policy, familyProtection: enabled, ...(enabled ? { safeMode: true } : {}) });
    return { updated: true };
  },
  removeFamilyLink: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const { userId: otherId } = z.object({ userId: z.string().refine(ObjectId.isValid) }).parse(args);
    const userId = profile.userId.toString();
    const link = await dbFamilyLinks.findOne({ $or: [
      { guardianId: userId, childId: otherId },
      { guardianId: otherId, childId: userId },
    ] });
    if (!link) throw new ValidationError('Семейная связь не найдена');
    await dbFamilyLinks.deleteOne({ _id: link._id });
    if (await dbFamilyLinks.countDocuments({ childId: link.childId }) === 0) await writeSettings(link.childId, { familyProtection: false });
    return { removed: true };
  },
};

/**
 * Scheduler for quiet care. Only the subject can opt in, alerts go to guardians
 * and existing direct contacts, and a single alert per pair is created until it
 * is dismissed or the person comes back online.
 */
export async function processQuietCare() {
  const candidates = await dbSettings.fetch({ quietCareEnabled: true }, { limit: 200 });
  for (const settings of candidates) {
    if (!ObjectId.isValid(settings.userId)) continue;
    const subject = await dbProfiles.findOne({ userId: new ObjectId(settings.userId) });
    if (!subject || subject.isDecoy) continue;
    const days = settings.quietCareDays ?? 3;
    const threshold = Date.now() - days * 24 * 60 * 60 * 1000;
    const lastSeenAt = subject.lastSeenAt ? new Date(subject.lastSeenAt) : subject.createdAt;

    if (lastSeenAt.getTime() > threshold) {
      // The person is back: clear pending alerts so nobody keeps worrying.
      await dbQuietCareAlerts.deleteMany({ subjectId: settings.userId });
      if (settings.quietCareNotifiedAt) await dbSettings.updateOne({ _id: settings._id }, { $set: { quietCareNotifiedAt: null } });
      continue;
    }

    const links = await dbFamilyLinks.fetch({ $or: [{ childId: settings.userId }, { guardianId: settings.userId }] }, { limit: 50 });
    const recipients = new Set(links.map((link) => link.childId === settings.userId ? link.guardianId : link.childId));
    const contacts = await dbChats.fetch({ kind: 'direct', memberIds: settings.userId }, { limit: 100 });
    for (const chat of contacts) {
      const peerId = (chat.memberIds ?? []).find((id) => id !== settings.userId);
      if (peerId) recipients.add(peerId);
    }

    const now = new Date();
    for (const recipientId of recipients) {
      if (recipientId === settings.userId) continue;
      const blocked = await dbUserBlocks.findOne({ $or: [
        { blockerId: recipientId, blockedId: settings.userId },
        { blockerId: settings.userId, blockedId: recipientId },
      ] });
      if (blocked) continue;
      if (!links.some((link) => link.guardianId === recipientId || link.childId === recipientId) && !await areContacts(settings.userId, recipientId)) continue;
      await dbQuietCareAlerts.updateOne(
        { subjectId: settings.userId, recipientId },
        { $set: { lastSeenAt, days }, $setOnInsert: { subjectId: settings.userId, recipientId, createdAt: now, dismissedAt: null } },
        { upsert: true },
      );
    }
    await dbSettings.updateOne({ _id: settings._id }, { $set: { quietCareNotifiedAt: now } });
  }
}
