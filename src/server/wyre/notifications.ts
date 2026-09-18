import z from 'zod';
import webpush from 'web-push';

import { dbSessions } from '../core/authDb';
import { ObjectId } from '../core/database';
import { env } from '../core/env';
import { ValidationError } from '../core/errors';
import type { UserInfo } from '../core/types';
import {
  dbChats,
  dbMessages,
  dbNotificationJobs,
  dbProfiles,
  dbPushSubscriptions,
  dbSettings,
} from './db';
import { fcmConfigured, sendFcmToUser } from './fcm';
import { requireVerifiedProfile } from './profile';

type ChatDoc = NonNullable<Awaited<ReturnType<typeof dbChats.findOne>>>;
type MessageDoc = Omit<NonNullable<Awaited<ReturnType<typeof dbMessages.findOne>>>, '_id'>;

const MAX_ATTEMPTS = 5;
let configured = false;

export function pushConfigured() {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

/** Any delivery channel available: the queue works with Web Push, FCM or both. */
function anyPushConfigured() {
  return pushConfigured() || fcmConfigured();
}

function ensureConfigured() {
  if (!pushConfigured()) throw new ValidationError('Push-уведомления не настроены администратором', 'PUSH_NOT_CONFIGURED');
  if (!configured) {
    webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    configured = true;
  }
}

function minutesLocalHour(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

function insideDndWindow(now: Date, timeZone: string, from: string, to: string) {
  const [fromHour, fromMinute] = from.split(':').map(Number);
  const [toHour, toMinute] = to.split(':').map(Number);
  const current = minutesLocalHour(now, timeZone);
  const start = fromHour * 60 + fromMinute;
  const end = toHour * 60 + toMinute;
  return start <= end ? current >= start && current < end : current >= start || current < end;
}

/**
 * Server-side delivery policy. The client never decides whether a recipient
 * should be notified, so muted chats, mention-only mode and DND cannot be
 * bypassed by a crafted request.
 */
async function eligibleRecipients(chat: ChatDoc, message: MessageDoc, mentionedIds: Set<string>) {
  const now = new Date();
  const recipients: { userId: string; preview: boolean }[] = [];
  for (const member of chat.members ?? []) {
    if (member.userId === message.authorId) continue;
    const mode = member.notificationMode ?? (member.muted ? 'none' : 'all');
    if (mode === 'none') continue;
    if (member.mutedUntil && new Date(member.mutedUntil).getTime() > now.getTime()) continue;
    if (mode === 'mentions' && !mentionedIds.has(member.userId)) continue;
    const settings = await dbSettings.findOne({ userId: member.userId });
    if (settings?.dnd && insideDndWindow(now, settings.timeZone ?? 'UTC', settings.dndFrom, settings.dndTo)) continue;
    recipients.push({ userId: member.userId, preview: settings?.previews !== false });
  }
  return recipients;
}

/** Queues one idempotent job per eligible recipient of a newly stored message. */
export async function queueMessageNotifications(chat: ChatDoc, messageId: ObjectId, message: MessageDoc, preview: string, mentionedIds: Set<string>) {
  if (!anyPushConfigured()) return;
  const recipients = await eligibleRecipients(chat, message, mentionedIds);
  if (!recipients.length) return;
  const author = await dbProfiles.findOne({ userId: new ObjectId(message.authorId) });
  const chatTitle = chat.kind === 'group' ? chat.title ?? 'Группа' : author?.name ?? 'Wyre';
  const now = new Date();
  for (const recipient of recipients) {
    await dbNotificationJobs.updateOne(
      { eventType: 'message', eventId: messageId.toString(), recipientId: recipient.userId },
      {
        $setOnInsert: {
          eventType: 'message',
          eventId: messageId.toString(),
          recipientId: recipient.userId,
          chatId: chat._id.toString(),
          title: chat.kind === 'group' ? `${chatTitle} · ${author?.name ?? 'Участник'}` : chatTitle,
          body: recipient.preview ? preview.slice(0, 180) : 'Новое сообщение',
          url: `/?chat=${chat._id.toString()}&message=${messageId.toString()}`,
          createdAt: now,
          nextAttemptAt: now,
          attempts: 0,
          deliveredAt: null,
          lastError: null,
        },
      },
      { upsert: true },
    );
  }
}

/** Claims due jobs atomically so two server instances cannot double-send. */
export async function processNotificationJobs() {
  if (!anyPushConfigured()) return;
  if (pushConfigured()) ensureConfigured();
  const now = new Date();
  const due = await dbNotificationJobs.fetch({ deliveredAt: null, nextAttemptAt: { $lte: now } }, { sort: { nextAttemptAt: 1 }, limit: 50 });
  for (const candidate of due) {
    const claimed = await dbNotificationJobs.native().findOneAndUpdate(
      { _id: candidate._id, deliveredAt: null, nextAttemptAt: { $lte: new Date() } },
      { $set: { nextAttemptAt: new Date(Date.now() + 60_000) }, $inc: { attempts: 1 } },
      { returnDocument: 'after' },
    );
    if (!claimed) continue;

    const subscriptions = pushConfigured() ? await dbPushSubscriptions.fetch({ userId: claimed.recipientId }) : [];
    const payload = JSON.stringify({ title: claimed.title, body: claimed.body, url: claimed.url, chatId: claimed.chatId, tag: `wyre-chat-${claimed.chatId}` });
    let delivered = false;
    let lastError: string | null = null;
    for (const subscription of subscriptions) {
      try {
        await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload, { TTL: 3600 });
        await dbPushSubscriptions.updateOneSilent({ _id: subscription._id }, { $set: { lastSuccessAt: new Date(), failureCount: 0 } });
        delivered = true;
      } catch (error) {
        const status = typeof error === 'object' && error && 'statusCode' in error ? Number((error as { statusCode: unknown }).statusCode) : 0;
        lastError = `${status || 'unknown'}`;
        // 404/410 mean the browser dropped the subscription permanently.
        if (status === 404 || status === 410) await dbPushSubscriptions.deleteOne({ _id: subscription._id });
        else await dbPushSubscriptions.updateOneSilent({ _id: subscription._id }, { $inc: { failureCount: 1 } });
      }
    }
    // Android background delivery rides FCM data messages.
    if (fcmConfigured()) {
      try {
        await sendFcmToUser(claimed.recipientId, {
          type: 'message',
          title: claimed.title,
          body: claimed.body,
          chatId: claimed.chatId,
          eventId: claimed.eventId,
        });
        delivered = true;
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'fcm';
      }
    }
    if (delivered) await dbNotificationJobs.updateOne({ _id: claimed._id }, { $set: { deliveredAt: new Date(), lastError: null } });
    else if (claimed.attempts >= MAX_ATTEMPTS) await dbNotificationJobs.deleteOne({ _id: claimed._id });
    else await dbNotificationJobs.updateOne({ _id: claimed._id }, { $set: { lastError, nextAttemptAt: new Date(Date.now() + claimed.attempts * 60_000) } });
  }
}

/**
 * Repairs a crash between storing a message and queueing its notifications:
 * recent messages without jobs are re-queued, and duplicates are impossible
 * thanks to the unique event/recipient index.
 */
export async function reconcileMissedNotifications() {
  if (!pushConfigured()) return;
  const since = new Date(Date.now() - 10 * 60 * 1000);
  const messages = await dbMessages.fetch({ createdAt: { $gt: since }, notificationQueuedAt: { $in: [null, undefined] } }, { sort: { createdAt: 1 }, limit: 50 });
  for (const message of messages) {
    if (!ObjectId.isValid(message.chatId)) continue;
    const chat = await dbChats.findOne({ _id: new ObjectId(message.chatId) });
    if (!chat) continue;
    await queueMessageNotifications(chat, message._id, message, message.text || 'Новое сообщение', new Set());
    await dbMessages.updateOneSilent({ _id: message._id }, { $set: { notificationQueuedAt: new Date() } });
  }
}

export const notificationQueries = {
  pushStatus: async (_args: unknown, { user, sessionTokenHash }: { user: UserInfo | null; sessionTokenHash?: string }) => {
    const profile = await requireVerifiedProfile(user);
    const subscriptions = await dbPushSubscriptions.fetch({ userId: profile.userId.toString() });
    return {
      configured: pushConfigured(),
      publicKey: pushConfigured() ? env.VAPID_PUBLIC_KEY : null,
      deviceCount: subscriptions.length,
      currentDeviceSubscribed: Boolean(sessionTokenHash && subscriptions.some((item) => item.sessionTokenHash === sessionTokenHash)),
    };
  },
};

export const notificationMutations = {
  subscribePush: async (args: unknown, { user, sessionTokenHash }: { user: UserInfo | null; sessionTokenHash?: string }) => {
    const profile = await requireVerifiedProfile(user);
    if (!sessionTokenHash) throw new ValidationError('Сессия не найдена');
    ensureConfigured();
    const { endpoint, keys, userAgent } = z.object({
      endpoint: z.string().url().max(2000),
      keys: z.object({ p256dh: z.string().min(10).max(500), auth: z.string().min(5).max(500) }),
      userAgent: z.string().max(300).optional(),
    }).parse(args);
    const session = await dbSessions.findOne({ tokenHash: sessionTokenHash, userId: profile.userId, expiresAt: { $gt: new Date() } });
    if (!session) throw new ValidationError('Сессия не найдена');
    const now = new Date();
    await dbPushSubscriptions.updateOne(
      { endpoint },
      {
        $set: {
          userId: profile.userId.toString(),
          sessionTokenHash,
          endpoint,
          p256dh: keys.p256dh,
          auth: keys.auth,
          userAgent: (userAgent ?? session.userAgent ?? '').slice(0, 300),
          failureCount: 0,
        },
        $setOnInsert: { createdAt: now, lastSuccessAt: null },
      },
      { upsert: true },
    );
    return { subscribed: true };
  },

  unsubscribePush: async (args: unknown, { user, sessionTokenHash }: { user: UserInfo | null; sessionTokenHash?: string }) => {
    const profile = await requireVerifiedProfile(user);
    const { endpoint } = z.object({ endpoint: z.string().url().max(2000).optional() }).parse(args ?? {});
    const filter = endpoint
      ? { userId: profile.userId.toString(), endpoint }
      : { userId: profile.userId.toString(), ...(sessionTokenHash ? { sessionTokenHash } : {}) };
    const result = await dbPushSubscriptions.deleteMany(filter);
    return { removed: result.deletedCount };
  },
};
