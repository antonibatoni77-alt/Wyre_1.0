import z from 'zod';
import { ObjectId } from '../core/database';
import { ValidationError } from '../core/errors';
import type { UserInfo } from '../core/types';

import {
  WYRE_AI_SERVICE_USER_ID,
  WYRE_SERVICE_USER_ID,
  dbChats,
  dbMessages,
  dbProfiles,
  dbSettings,
} from './db';
import { applyIncomingMessage } from './chats';
import { queueMessageNotifications } from './notifications';
import { logAction, requireStaff } from './moderation';
import { initialsFrom, paletteFor, requireVerifiedProfile } from './profile';
import { defaultSettings } from './settings';

type ChatDoc = NonNullable<Awaited<ReturnType<typeof dbChats.findOne>>>;
type MessageDoc = NonNullable<Awaited<ReturnType<typeof dbMessages.findOne>>>;

export const AI_CONSENT_TEXT =
  'Wyre AI может читать ваши сообщения и голосовые сообщения (в расшифровке), учитывать ваши контакты и профиль, чтобы отвечать точнее и помогать лично вам. Данные используются только для вашего персонального опыта. Дать согласие?';
export const AI_CONSENT_ACCEPTED_TEXT = 'Вы улучшили ваш персональный AI.';
export const AI_CONSENT_DECLINED_TEXT = 'Хорошо — я продолжу помогать, но без учёта переписки и контактов.';
export const AI_GREETING_TEXT = 'Привет, я Wyre AI — твой персональный помощник. Спроси всё что угодно, я помогу тебе.';

export function isServiceUserId(userId: string | null | undefined) {
  return userId === WYRE_SERVICE_USER_ID || userId === WYRE_AI_SERVICE_USER_ID;
}

function servicePairKey(userId: string, serviceUserId: string) {
  return [userId, serviceUserId].sort().join(':');
}

interface ServiceSpec {
  userId: string;
  email: string;
  name: string;
  username: string;
  bio: string;
}

const SERVICES: ServiceSpec[] = [
  {
    userId: WYRE_SERVICE_USER_ID,
    email: 'wyre-service@wyre.local',
    name: 'Wyre',
    username: 'wyre',
    bio: 'Официальный аккаунт Wyre: поддержка и уведомления.',
  },
  {
    userId: WYRE_AI_SERVICE_USER_ID,
    email: 'wyre-ai-service@wyre.local',
    name: 'Wyre AI',
    username: 'wyre_ai',
    bio: 'Персональный AI-помощник Wyre.',
  },
];

/**
 * Idempotently creates the two system profiles. They carry the official badge,
 * never appear in people search and cannot be called.
 */
export async function ensureServiceAccounts() {
  for (const spec of SERVICES) {
    const userId = new ObjectId(spec.userId);
    const existing = await dbProfiles.findOne({ userId });
    if (existing) {
      const refresh: Record<string, unknown> = {};
      if (existing.name !== spec.name) refresh.name = spec.name;
      if (existing.badge !== 'official') refresh.badge = 'official';
      if (!existing.isService) refresh.isService = true;
      if (existing.usernameLower !== spec.username) refresh.usernameLower = spec.username;
      if (Object.keys(refresh).length) {
        refresh.updatedAt = new Date();
        await dbProfiles.updateOne({ _id: existing._id }, { $set: refresh });
      }
      continue;
    }
    const now = new Date();
    try {
      await dbProfiles.insertOne({
        userId,
        email: spec.email,
        name: spec.name,
        username: spec.username,
        usernameLower: spec.username,
        usernameHistory: [],
        bio: spec.bio,
        phone: null,
        colors: paletteFor(spec.username),
        initials: initialsFrom(spec.name),
        badge: 'official',
        role: 'user',
        warnings: [],
        presenceVisibility: 'nobody',
        presenceAlways: [],
        presenceNever: [],
        pendingChallenge: false,
        phoneOnboardingPending: false,
        challengeAttempts: 0,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
        isService: true,
      });
    } catch {
      // Lost a concurrent create against the unique userId index — nothing to do.
    }
  }
}

/** Inserts a message authored by a system account through the common pipeline. */
export async function postServiceMessage(
  chat: ChatDoc,
  authorId: string,
  text: string,
  options: { actions?: { id: string; label: string }[]; attachment?: { filePath: string; mimeType: string; fileName: string; fileSize?: string } } = {},
) {
  const now = new Date();
  const message: Omit<MessageDoc, '_id'> = {
    chatId: chat._id.toString(),
    topicId: null,
    authorId,
    text,
    kind: options.actions ? 'actions' : options.attachment ? 'file' : 'text',
    actions: options.actions ?? null,
    usedActionId: null,
    fileName: options.attachment?.fileName ?? null,
    fileSize: options.attachment?.fileSize ?? null,
    filePath: options.attachment?.filePath ?? null,
    mimeType: options.attachment?.mimeType ?? null,
    duration: null,
    reaction: null,
    pinned: false,
    editedAt: null,
    replyToId: null,
    replyToText: null,
    replyToKind: null,
    voiceThreadRootId: null,
    readBy: [authorId],
    readAt: { [authorId]: now },
    deliveredTo: [authorId],
    createdAt: now,
    selfDestructSeconds: null,
    deleteAt: null,
    linkPreview: null,
    folderTransfer: null,
    notificationQueuedAt: now,
  };
  const { insertedId } = await dbMessages.insertOne(message);
  const preview = text.slice(0, 140);
  await applyIncomingMessage(chat, authorId, preview, now, new Set());
  void queueMessageNotifications(chat, insertedId, message, preview, new Set())
    .catch((error) => console.error('Ошибка постановки уведомления сервиса:', error));
  return insertedId;
}

async function ensureServiceChatWith(userId: string, spec: ServiceSpec) {
  const pairKey = servicePairKey(userId, spec.userId);
  const existing = await dbChats.findOne({ pairKey });
  if (existing) return existing;

  const now = new Date();
  const emptyState = (memberUserId: string) => ({
    userId: memberUserId,
    unread: 0,
    pinned: false,
    muted: false,
    lastReadAt: now,
    typingAt: null,
  });
  try {
    const { insertedId } = await dbChats.insertOne({
      kind: 'direct',
      pairKey,
      title: null,
      memberIds: [userId, spec.userId],
      createdBy: spec.userId,
      createdAt: now,
      lastMessageAt: now,
      lastMessageText: '',
      lastMessageAuthorId: null,
      members: [emptyState(userId), emptyState(spec.userId)],
    });
    const chat = await dbChats.requireOne({ _id: insertedId });
    if (spec.userId === WYRE_SERVICE_USER_ID) {
      await postServiceMessage(chat, WYRE_SERVICE_USER_ID,
        'Привет! Это официальный аккаунт Wyre. Сюда приходят важные уведомления, и здесь можно задать вопрос поддержке — ответ придёт прямо в этот чат.');
    } else {
      await postServiceMessage(chat, WYRE_AI_SERVICE_USER_ID, AI_CONSENT_TEXT, {
        actions: [
          { id: 'ai-consent:accept', label: 'Принять' },
          { id: 'ai-consent:decline', label: 'Отказаться' },
        ],
      });
    }
    return chat;
  } catch {
    // Lost the race against a concurrent create — reuse the winner.
    return dbChats.requireOne({ pairKey });
  }
}

const serviceChatsReady = new Set<string>();

/** Guarantees the Wyre and Wyre AI direct chats exist for a real (non-decoy) user. */
export async function ensureServiceChats(userId: string) {
  if (!ObjectId.isValid(userId) || serviceChatsReady.has(userId)) return;
  for (const spec of SERVICES) await ensureServiceChatWith(userId, spec);
  serviceChatsReady.add(userId);
}

export async function aiConsentOf(userId: string) {
  const settings = await dbSettings.findOne({ userId });
  return settings?.aiAssistantConsent ?? null;
}

export async function setAiConsent(userId: string, accepted: boolean) {
  const existing = await dbSettings.findOne({ userId });
  if (!existing) {
    await dbSettings.insertOne({
      ...defaultSettings(userId),
      aiAssistantConsent: accepted ? 'accepted' : 'declined',
      aiAssistantConsentAt: new Date(),
    });
    return;
  }
  await dbSettings.updateOne(
    { userId },
    { $set: { aiAssistantConsent: accepted ? 'accepted' : 'declined', aiAssistantConsentAt: new Date(), updatedAt: new Date() } },
  );
}

export const serviceQueries = {
  /** Support inbox: every user's chat with the official Wyre account. */
  adminSupportThreads: async (_args: unknown, { user }: { user: UserInfo | null }) => {
    await requireStaff(user);
    const chats = await dbChats.fetch(
      { kind: 'direct', memberIds: WYRE_SERVICE_USER_ID },
      { sort: { lastMessageAt: -1 }, limit: 200 },
    );
    const peerIds = [...new Set(chats.map((chat) => (chat.memberIds ?? []).find((id) => id !== WYRE_SERVICE_USER_ID) ?? ''))];
    const profiles = peerIds.length
      ? await dbProfiles.fetch({ userId: { $in: peerIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id)) } })
      : [];
    const byUser = new Map(profiles.map((profile) => [profile.userId.toString(), profile]));
    return chats
      .map((chat) => {
        const peerId = (chat.memberIds ?? []).find((id) => id !== WYRE_SERVICE_USER_ID) ?? '';
        const peer = byUser.get(peerId);
        if (!peer) return null;
        const mine = (chat.members ?? []).find((member) => member.userId === WYRE_SERVICE_USER_ID);
        return {
          chatId: chat._id.toString(),
          userId: peerId,
          name: peer.name,
          username: `@${peer.username}`,
          initials: peer.initials,
          colors: [peer.colors[0], peer.colors[1]] as [string, string],
          last: chat.lastMessageText || 'Нет сообщений',
          lastMessageAt: chat.lastMessageAt.toISOString(),
          fromSupport: chat.lastMessageAuthorId === WYRE_SERVICE_USER_ID,
          unread: mine?.unread ?? 0,
        };
      })
      .filter((thread): thread is NonNullable<typeof thread> => thread !== null);
  },

  /** Full support conversation with one user, seen from the Wyre account side. */
  adminSupportMessages: async (args: unknown, { user }: { user: UserInfo | null }) => {
    await requireStaff(user);
    const { userId } = z.object({ userId: z.string() }).parse(args);
    if (!ObjectId.isValid(userId)) throw new ValidationError('Пользователь не найден');
    const chat = await dbChats.findOne({ pairKey: servicePairKey(userId, WYRE_SERVICE_USER_ID) });
    if (!chat) return [];
    const messages = await dbMessages.fetch({ chatId: chat._id.toString() }, { sort: { createdAt: 1 }, limit: 300 });
    return messages.map((message) => ({
      id: message._id.toString(),
      fromSupport: message.authorId === WYRE_SERVICE_USER_ID,
      text: (message.transcription || message.text || '').slice(0, 2000),
      createdAt: message.createdAt.toISOString(),
    }));
  },
};

export const serviceMutations = {
  /** Handles a tap on an inline actions message (currently the AI consent buttons). */
  invokeMessageAction: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { messageId, actionId } = z
      .object({ messageId: z.string().refine(ObjectId.isValid), actionId: z.string().min(1).max(64) })
      .parse(args);
    const message = await dbMessages.findOne({ _id: new ObjectId(messageId) });
    if (!message) throw new ValidationError('Сообщение не найдено');
    const chat = await dbChats.findOne({ _id: new ObjectId(message.chatId) });
    if (!chat || !(chat.memberIds ?? []).includes(viewerId)) throw new ValidationError('Сообщение не найдено');
    if (message.kind !== 'actions' || !message.actions?.length) throw new ValidationError('У сообщения нет кнопок');
    if (message.usedActionId) throw new ValidationError('Действие уже выполнено');
    const action = message.actions.find((entry) => entry.id === actionId);
    if (!action) throw new ValidationError('Кнопка не найдена');

    // The conditional update makes a double click resolve to a single action.
    const claimed = await dbMessages.updateOne({ _id: message._id, usedActionId: null }, { $set: { usedActionId: actionId } });
    if (!claimed.modifiedCount) throw new ValidationError('Действие уже выполнено');

    if (actionId === 'ai-consent:accept' || actionId === 'ai-consent:decline') {
      const accepted = actionId === 'ai-consent:accept';
      await setAiConsent(viewerId, accepted);
      await postServiceMessage(chat, WYRE_AI_SERVICE_USER_ID, accepted ? AI_CONSENT_ACCEPTED_TEXT : AI_CONSENT_DECLINED_TEXT);
      if (accepted) await postServiceMessage(chat, WYRE_AI_SERVICE_USER_ID, AI_GREETING_TEXT);
    }
    return { usedActionId: actionId };
  },

  /** Staff replies to a user inside their official Wyre support chat. */
  adminSendSupportMessage: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const actor = await requireStaff(user);
    const { userId, text } = z
      .object({ userId: z.string(), text: z.string().trim().min(1).max(4000) })
      .parse(args);
    if (!ObjectId.isValid(userId)) throw new ValidationError('Пользователь не найден');
    const target = await dbProfiles.findOne({ userId: new ObjectId(userId) });
    if (!target || target.isService) throw new ValidationError('Пользователь не найден');
    const chat = await ensureServiceChatWith(userId, SERVICES[0]);
    await postServiceMessage(chat, WYRE_SERVICE_USER_ID, text.trim());
    await logAction(actor, target, 'Ответ поддержки', text.trim().slice(0, 120));
    return { sent: true };
  },

  /** Sends one notification from the Wyre account into every user's support chat. */
  adminBroadcastMessage: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const actor = await requireStaff(user, 'admin');
    const { text } = z.object({ text: z.string().trim().min(1).max(2000) }).parse(args);
    const profiles = await dbProfiles.fetch({ isService: { $ne: true }, isDecoy: { $ne: true } }, { limit: 5000 });
    let sent = 0;
    for (const profile of profiles) {
      const chat = await ensureServiceChatWith(profile.userId.toString(), SERVICES[0]);
      await postServiceMessage(chat, WYRE_SERVICE_USER_ID, text.trim());
      sent += 1;
    }
    await logAction(actor, actor, 'Рассылка Wyre', `${text.trim().slice(0, 120)} · получателей: ${sent}`);
    return { sent };
  },
};
