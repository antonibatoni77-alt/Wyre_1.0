import z from 'zod';
import { ObjectId } from '../core/database';
import { env } from '../core/env';
import { ValidationError } from '../core/errors';
import { LiveData } from '../core/liveData';
import { deleteStoredFile, getFileUrl, getUploadUrl, MAX_FILE_BYTES, storedFileExists } from '../core/storage';
import type { UserInfo } from '../core/types';

import { WYRE_AI_SERVICE_USER_ID, WYRE_SERVICE_USER_ID, dbCalls, dbCallSignals, dbChats, dbDrafts, dbMessageBookmarks, dbMessages, dbProfiles, dbReminders, dbScheduledMessages, dbSharedNotes, dbTopics, type ChatMemberState } from './db';
import { avatarUrlOf, blockedUserIds, initialsFrom, paletteFor, privacyActionAllowed, requireContentAllowed, requireNotBlocked, requirePrivacyAction, requireVerifiedProfile, warningActive } from './profile';
import { assessLinkRisk, semanticMessageIds, suggestContextReminder, suggestShortReplies, summarizeConversation, transcribeStoredAudio, translateText } from './ai';
import { queueMessageNotifications } from './notifications';

/** A user is considered online when they were seen within this window. */
const ONLINE_WINDOW_MS = 90 * 1000;
const RECENT_WINDOW_MS = 30 * 60 * 1000;
/** Typing indicator expiry — clients refresh it while the composer is active. */
const TYPING_WINDOW_MS = 6 * 1000;
const MIN_SCHEDULE_DELAY_MS = 60 * 60 * 1000;
const MAX_SCHEDULE_DELAY_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_SELF_DESTRUCT_SECONDS = 7 * 24 * 60 * 60;
const AUTO_DELETE_DAY_OPTIONS = [1, 7, 30, 90, 365] as const;

const MESSAGE_KINDS = ['text', 'sticker', 'voice', 'video', 'file', 'html', 'link', 'contact', 'location', 'poll', 'actions'] as const;

type ChatDoc = NonNullable<Awaited<ReturnType<typeof dbChats.findOne>>>;
type MessageDoc = NonNullable<Awaited<ReturnType<typeof dbMessages.findOne>>>;
type ProfileDoc = NonNullable<Awaited<ReturnType<typeof dbProfiles.findOne>>>;
type TopicDoc = NonNullable<Awaited<ReturnType<typeof dbTopics.findOne>>>;

function pairKeyFor(a: string, b: string) {
  return [a, b].sort().join(':');
}

function formatTime(date: Date) {
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function formatListTime(date: Date) {
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return formatTime(date);

  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (date.toDateString() === yesterday.toDateString()) return 'вчера';

  if (now.getTime() - date.getTime() < 7 * 24 * 60 * 60 * 1000) {
    return date.toLocaleDateString('ru-RU', { weekday: 'short' });
  }
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

function formatDayLabel(date: Date) {
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return 'сегодня';
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (date.toDateString() === yesterday.toDateString()) return 'вчера';
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function presenceOf(profile: ProfileDoc | undefined, member: ChatMemberState | null | undefined, talking = false) {
  const activityAt = member?.activityAt ?? member?.typingAt;
  if (activityAt && Date.now() - new Date(activityAt).getTime() < TYPING_WINDOW_MS) {
    if (member?.activity === 'recording_voice') return 'recording_voice' as const;
    if (member?.activity === 'recording_video') return 'recording_video' as const;
    return 'typing' as const;
  }
  if (talking) return 'talking' as const;
  if (!profile?.lastSeenAt) return 'offline' as const;
  const delta = Date.now() - new Date(profile.lastSeenAt).getTime();
  if (delta < ONLINE_WINDOW_MS) return 'online' as const;
  if (delta < RECENT_WINDOW_MS) return 'recent' as const;
  return 'offline' as const;
}

function statusTextOf(presence: string, profile: ProfileDoc | undefined) {
  if (presence === 'online') return 'в сети';
  if (presence === 'typing') return 'печатает…';
  if (presence === 'recording_voice') return 'записывает голосовое…';
  if (presence === 'recording_video') return 'записывает видеосообщение…';
  if (presence === 'talking') return 'разговаривает';
  if (presence === 'recent') return 'был(а) недавно';
  if (!profile?.lastSeenAt) return 'не в сети';
  return `был(а) ${formatListTime(new Date(profile.lastSeenAt))}`;
}

function presenceAllowed(profile: ProfileDoc | undefined, viewerId: string, isContact: boolean) {
  if (!profile) return false;
  if ((profile.presenceNever ?? []).includes(viewerId)) return false;
  if ((profile.presenceAlways ?? []).includes(viewerId)) return true;
  const visibility = profile.presenceVisibility ?? 'contacts';
  return visibility === 'all' || (visibility === 'contacts' && isContact);
}

function publicWarnings(profile: ProfileDoc | undefined) {
  return (profile?.warnings ?? [])
    .filter((warning) => warningActive(warning))
    .map((warning, index) => ({
      id: index,
      reason: warning.reason,
      date: new Date(warning.issuedAt).toLocaleDateString('ru-RU'),
    }));
}

function memberStateOf(chat: ChatDoc, userId: string) {
  return (chat.members ?? []).find((member) => member.userId === userId);
}

/** Maps a chat document into the exact `Chat` shape the UI already renders. */
async function serializeChat(chat: ChatDoc, viewerId: string, profiles: Map<string, ProfileDoc>, talkingIds = new Set<string>()) {
  const mine = memberStateOf(chat, viewerId);
  const notificationMode = mine?.notificationMode ?? (mine?.muted ? 'none' : 'all');
  const mutedUntil = mine?.mutedUntil ? new Date(mine.mutedUntil) : null;
  const temporarilyMuted = Boolean(mutedUntil && mutedUntil.getTime() > Date.now());

  if (chat.kind === 'group') {
    const memberIds = chat.memberIds ?? [];
    const activityOther = memberIds
      .filter((id) => id !== viewerId)
      .map((id) => ({ id, state: memberStateOf(chat, id) }))
      .find(({ state }) => state?.activityAt && Date.now() - new Date(state.activityAt).getTime() < TYPING_WINDOW_MS);
    const groupMember = activityOther ? profiles.get(activityOther.id) : undefined;
    const groupPresence = activityOther && presenceAllowed(groupMember, viewerId, true)
      ? presenceOf(groupMember, activityOther.state)
      : memberIds.some((id) => id !== viewerId && talkingIds.has(id) && presenceAllowed(profiles.get(id), viewerId, true))
        ? ('talking' as const)
        : ('offline' as const);
    const name = chat.title ?? 'Группа';

    return {
      id: chat._id.toString(),
      peerId: undefined,
      name,
      username: '',
      initials: initialsFrom(name),
      avatarUrl: await avatarUrlOf(chat),
      status: groupPresence === 'offline' ? `${memberIds.length} участников` : statusTextOf(groupPresence, undefined),
      last: chat.lastMessageText || 'Нет сообщений',
      time: formatListTime(new Date(chat.lastMessageAt)),
      unread: mine?.unread ?? 0,
      unreadMentions: mine?.unreadMentions ?? 0,
      badge: undefined,
      colors: paletteFor(chat._id.toString()),
      folders: ['all', ...(mine?.folders ?? [])] as ('all' | 'work' | 'family')[],
      presence: groupPresence,
      pinned: mine?.pinned ?? false,
      muted: notificationMode === 'none' || temporarilyMuted,
      notificationMode,
      mutedUntil,
      autoDeleteAfterDays: chat.autoDeleteAfterDays ?? null,
      warnings: [] as { id: number; reason: string; date: string }[],
      group: true,
      members: memberIds.length,
    };
  }

  const otherId = (chat.memberIds ?? []).find((id) => id !== viewerId) ?? viewerId;
  const other = profiles.get(otherId);
  const theirs = memberStateOf(chat, otherId);
  const visible = presenceAllowed(other, viewerId, true);
  const presence = visible ? presenceOf(other, theirs, talkingIds.has(otherId)) : ('offline' as const);

  return {
    id: chat._id.toString(),
    peerId: otherId,
    name: chat.title ?? other?.name ?? 'Без имени',
    username: other?.username ?? '',
    initials: other?.initials ?? '??',
    avatarUrl: other ? await avatarUrlOf(other) : null,
    status: visible ? statusTextOf(presence, other) : 'статус скрыт',
    last: chat.lastMessageText || 'Нет сообщений',
    time: formatListTime(new Date(chat.lastMessageAt)),
    unread: mine?.unread ?? 0,
    unreadMentions: mine?.unreadMentions ?? 0,
    badge: other?.badge ?? undefined,
    service: Boolean(other?.isService),
    colors: [other?.colors?.[0] ?? '#8b5cf6', other?.colors?.[1] ?? '#2563eb'] as [string, string],
    folders: ['all', ...(mine?.folders ?? [])] as ('all' | 'work' | 'family')[],
    presence,
    pinned: mine?.pinned ?? false,
    muted: notificationMode === 'none' || temporarilyMuted,
    notificationMode,
    mutedUntil,
    autoDeleteAfterDays: chat.autoDeleteAfterDays ?? null,
    warnings: publicWarnings(other),
    group: false,
  };
}

async function serializeMessage(message: MessageDoc, viewerId: string, viewerUsername: string, memberCount: number, previous?: MessageDoc, bookmarked = false, canManagePoll = false) {
  const createdAt = new Date(message.createdAt);
  const mine = message.authorId === viewerId;
  const readers = (message.readBy ?? []).filter((id) => id !== message.authorId);
  const delivered = (message.deliveredTo ?? []).filter((id) => id !== message.authorId);

  let status: 'sent' | 'delivered' | 'read' | undefined;
  if (mine) {
    if (readers.length >= memberCount - 1) status = 'read';
    else if (delivered.length > 0) status = 'delivered';
    else status = 'sent';
  }
  const statusAt = status === 'read'
    ? readers.map((id) => message.readAt?.[id]).filter((date): date is Date => Boolean(date)).sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0]
    : createdAt;

  const previousDay = previous ? new Date(previous.createdAt).toDateString() : null;
  const showDate = previousDay !== createdAt.toDateString();

  let fileUrl: string | undefined;
  if (message.filePath) {
    try {
      const result = await getFileUrl(message.filePath, message.mimeType ?? 'application/octet-stream');
      fileUrl = result.url;
    } catch {
      fileUrl = undefined;
    }
  }
  const poll = message.poll
    ? (() => {
        const viewerVoted = message.poll.options.some((option) => option.voterIds.includes(viewerId));
        const canRevealAnswer = viewerVoted || Boolean(message.poll?.closedAt);
        return {
          question: message.poll.question,
          options: message.poll.options.map((option) => ({
            id: option.id,
            text: option.text,
            votes: option.voterIds.length,
            selected: option.voterIds.includes(viewerId),
          })),
          totalVotes: message.poll.options.reduce((total, option) => total + option.voterIds.length, 0),
          quiz: message.poll.quiz,
          correctOptionId: canRevealAnswer ? message.poll.correctOptionId ?? undefined : undefined,
          closed: Boolean(message.poll.closedAt),
          canClose: !message.poll.closedAt && (mine || canManagePoll),
        };
      })()
    : undefined;

  return {
    id: message._id.toString(),
    topicId: message.topicId ?? undefined,
    mine,
    text: message.text,
    time: formatTime(createdAt),
    date: showDate ? formatDayLabel(createdAt) : undefined,
    reaction: message.reaction ?? undefined,
    kind: message.kind,
    actions: message.actions?.map((action) => ({ id: action.id, label: action.label })) ?? undefined,
    usedActionId: message.usedActionId ?? undefined,
    status,
    statusAt: statusAt ? new Date(statusAt).toISOString() : undefined,
    pinned: message.pinned || undefined,
    fileName: message.fileName ?? undefined,
    fileSize: message.fileSize ?? undefined,
    fileUrl,
    mimeType: message.mimeType ?? undefined,
    duration: message.duration ?? undefined,
    edited: Boolean(message.editedAt),
    replyToText: message.replyToText ?? undefined,
    replyToKind: message.replyToKind ?? undefined,
    voiceThreadRootId: message.voiceThreadRootId ?? undefined,
    transcription: message.transcription ?? undefined,
    translation: message.translations?.ru ?? undefined,
    liveLocation: message.liveLocation ? {
      expiresAt: message.liveLocation.expiresAt.toISOString(),
      updatedAt: message.liveLocation.updatedAt.toISOString(),
      stopped: Boolean(message.liveLocation.stoppedAt) || message.liveLocation.expiresAt.getTime() <= Date.now(),
    } : undefined,
    folderTransfer: message.folderTransfer ? {
      status: message.folderTransfer.status,
      canRespond: message.folderTransfer.targetUserId === viewerId,
      respondedAt: message.folderTransfer.respondedAt?.toISOString(),
    } : undefined,
    forwardedFromName: message.forwardedFromName ?? undefined,
    bookmarked: bookmarked || undefined,
    selfDestructSeconds: message.selfDestructSeconds ?? undefined,
    deleteAt: message.deleteAt?.toISOString(),
    mentioned: new RegExp(`(^|[^a-zA-Z0-9_])@${viewerUsername}(?![a-zA-Z0-9_])`, 'i').test(message.text),
    link: message.linkPreview ?? undefined,
    linkSafety: message.linkSafety ? { level: message.linkSafety.level, reason: message.linkSafety.reason, checkedAt: message.linkSafety.checkedAt.toISOString() } : undefined,
    poll,
  };
}

async function loadProfiles(userIds: string[]) {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Map<string, ProfileDoc>();
  const docs = await dbProfiles.fetch({ userId: { $in: unique.map((id) => new ObjectId(id)) } });
  return new Map(docs.map((doc) => [doc.userId.toString(), doc]));
}

async function touchLastSeen(userId: string) {
  await dbProfiles.updateOneSilent({ userId: new ObjectId(userId) }, { $set: { lastSeenAt: new Date() } });
}

async function activeTalkingIds() {
  const calls = await dbCalls.fetch({ status: 'active' }, { sort: { createdAt: -1 }, limit: 200 });
  return new Set(
    calls.flatMap((call) => (call.participants ?? []).filter((participant) => participant.state === 'joined').map((participant) => participant.userId)),
  );
}

/** Loads a chat the caller is actually a member of, or throws. */
async function requireMembership(chatId: string, userId: string) {
  if (!ObjectId.isValid(chatId)) throw new ValidationError('Чат не найден');
  const chat = await dbChats.findOne({ _id: new ObjectId(chatId) });
  if (!chat || !(chat.memberIds ?? []).includes(userId)) {
    throw new ValidationError('Чат не найден');
  }
  return chat;
}

function groupRole(chat: ChatDoc, userId: string) {
  if (chat.createdBy === userId) return 'owner' as const;
  return memberStateOf(chat, userId)?.role ?? 'member';
}

function requireGroupManager(chat: ChatDoc, userId: string) {
  if (chat.kind !== 'group') throw new ValidationError('Настройки участников доступны только в группе');
  const role = groupRole(chat, userId);
  if (role !== 'owner' && role !== 'admin') throw new ValidationError('Недостаточно прав для управления группой');
  return role;
}

function previewOf(kind: (typeof MESSAGE_KINDS)[number], text: string) {
  switch (kind) {
    case 'sticker':
      return text;
    case 'voice':
      return '🎤 Голосовое сообщение';
    case 'video':
      return '📹 Видеосообщение';
    case 'file':
      return '📎 Файл';
    case 'contact':
      return '👤 Контакт';
    case 'location':
      return '📍 Геопозиция';
    case 'poll':
      return `📊 Опрос: ${text}`;
    default:
      return text;
  }
}

async function requireTopic(chat: ChatDoc, topicId: string, allowClosed = false): Promise<TopicDoc> {
  if (chat.kind !== 'group' || !ObjectId.isValid(topicId)) throw new ValidationError('Тема не найдена');
  const topic = await dbTopics.findOne({ _id: new ObjectId(topicId), chatId: chat._id.toString() });
  if (!topic) throw new ValidationError('Тема не найдена');
  if (topic.closedAt && !allowClosed) throw new ValidationError('Тема закрыта для новых сообщений');
  return topic;
}

async function removeGroupMembership(chat: ChatDoc, userId: string) {
  let createdBy = chat.createdBy;
  let members = chat.members.filter((member) => member.userId !== userId);
  const memberIds = chat.memberIds.filter((id) => id !== userId);
  if (memberIds.length === 0) {
    const [messages, calls] = await Promise.all([
      dbMessages.fetch({ chatId: chat._id.toString() }),
      dbCalls.fetch({ chatId: chat._id.toString() }),
    ]);
    await Promise.all([
      messages.length ? dbMessageBookmarks.deleteMany({ messageId: { $in: messages.map((message) => message._id.toString()) } }) : Promise.resolve(),
      dbDrafts.deleteMany({ chatId: chat._id.toString() }),
      dbScheduledMessages.deleteMany({ chatId: chat._id.toString() }),
      dbReminders.deleteMany({ chatId: chat._id.toString() }),
      dbSharedNotes.deleteMany({ chatId: chat._id.toString() }),
      dbTopics.deleteMany({ chatId: chat._id.toString() }),
      calls.length ? dbCallSignals.deleteMany({ callId: { $in: calls.map((call) => call._id.toString()) } }) : Promise.resolve(),
      dbCalls.deleteMany({ chatId: chat._id.toString() }),
      dbMessages.deleteMany({ chatId: chat._id.toString() }),
    ]);
    await dbChats.deleteOne({ _id: chat._id });
    return { deleted: true, left: true };
  }
  if (createdBy === userId) {
    const successor = members.find((member) => member.role === 'admin') ?? members[0];
    createdBy = successor.userId;
    members = members.map((member) => member.userId === createdBy ? { ...member, role: 'owner' as const } : member);
  }
  await dbChats.updateOne({ _id: chat._id }, { $set: { createdBy, memberIds, members } });
  return { deleted: false, left: true };
}

async function requireDirectPeerAllowed(chat: ChatDoc, userId: string) {
  if (chat.kind !== 'direct') return;
  const peerId = chat.memberIds.find((id) => id !== userId);
  // The official accounts must stay reachable; blocking them is ignored.
  if (peerId && peerId !== WYRE_SERVICE_USER_ID && peerId !== WYRE_AI_SERVICE_USER_ID) await requireNotBlocked(userId, peerId);
}

/**
 * The assistant module is wired in from index.ts to keep the module graph
 * acyclic: chats.ts must not import assistant.ts directly.
 */
type AiReplyTrigger = (chat: ChatDoc, userId: string) => void;
let aiReplyTrigger: AiReplyTrigger | null = null;
export function registerAiReplyTrigger(trigger: AiReplyTrigger) {
  aiReplyTrigger = trigger;
}

function parseMessagePayload(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError('Некорректные данные сообщения');
  }
}

function firstUrl(text: string) {
  const match = text.match(/https?:\/\/[^\s<>]+/i);
  if (!match) return null;
  return match[0].replace(/[),.!?]+$/, '');
}

function htmlText(value: string) {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ').trim();
}

function metaContent(html: string, key: string) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return htmlText(match[1]).slice(0, 500);
  }
  return '';
}

function isPrivatePreviewHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const octets = host.split('.').map(Number);
  return octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31;
}

async function linkPreviewFor(text: string) {
  const rawUrl = firstUrl(text);
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const domain = url.hostname.replace(/^www\./i, '');
  const colors = paletteFor(domain);
  let title = domain;
  let description = url.pathname === '/' ? '' : url.pathname;
  try {
    if (!isPrivatePreviewHost(url.hostname)) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      const response = await fetch(url, { signal: controller.signal, redirect: 'error', headers: { 'user-agent': 'WyreLinkPreview/1.0' } });
      clearTimeout(timeout);
      const contentType = response.headers.get('content-type') ?? '';
      const contentLength = Number(response.headers.get('content-length') ?? 0);
      if (response.ok && contentType.includes('text/html') && (!contentLength || contentLength <= 512_000)) {
        const html = (await response.text()).slice(0, 512_000);
        title = metaContent(html, 'og:title') || htmlText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '') || title;
        description = metaContent(html, 'og:description') || metaContent(html, 'description') || description;
      }
    }
  } catch {
    // A preview must never prevent message delivery; the domain fallback remains useful offline.
  }
  return { url: rawUrl, title: title.slice(0, 180), description: description.slice(0, 500), domain, colors } as const;
}

function autoDeleteAt(chat: ChatDoc, createdAt: Date) {
  const days = chat.autoDeleteAfterDays;
  return days ? new Date(createdAt.getTime() + days * 24 * 60 * 60 * 1000) : null;
}

function activeMessageFilter(chatId: string) {
  return {
    chatId,
    $or: [
      { deleteAt: null },
      { deleteAt: { $exists: false } },
      { deleteAt: { $gt: new Date() } },
    ],
  };
}

function mentionedUsernames(text: string) {
  return new Set(Array.from(text.matchAll(/(^|[^a-zA-Z0-9_])@([a-zA-Z0-9_]{3,32})/g), (match) => match[2].toLowerCase()));
}

async function mentionedMemberIds(chat: ChatDoc, text: string, authorId: string) {
  const usernames = mentionedUsernames(text);
  if (!usernames.size) return new Set<string>();
  const profiles = await loadProfiles((chat.memberIds ?? []).filter((id) => id !== authorId));
  return new Set([...profiles.entries()].filter(([, profile]) => usernames.has(profile.usernameLower)).map(([id]) => id));
}

async function aiMessageContext(chat: ChatDoc, viewerId: string, topicId: string | null | undefined, limit: number, after?: Date) {
  if (topicId) await requireTopic(chat, topicId, true);
  const filter = {
    ...activeMessageFilter(chat._id.toString()),
    ...(topicId ? { topicId } : {}),
    ...(after ? { createdAt: { $gt: after } } : {}),
  };
  const newest = await dbMessages.fetch(filter, { sort: { createdAt: -1 }, limit });
  const messages = newest.reverse();
  const profiles = await loadProfiles([...new Set(messages.map((message) => message.authorId))]);
  return messages.map((message) => {
    const rawText = message.transcription || message.text || previewOf(message.kind, message.text);
    return {
      id: message._id.toString(),
      authorId: message.authorId,
      author: message.authorId === viewerId ? 'Вы' : profiles.get(message.authorId)?.name ?? 'Участник',
      text: rawText.slice(0, 800),
      createdAt: message.createdAt,
      time: message.createdAt.toISOString(),
    };
  });
}

/**
 * Updates only the caller's own entry inside `members`.
 *
 * Using a positional array filter instead of rewriting the whole array means a
 * concurrent write by another member (for example an unread increment) cannot be
 * silently reverted.
 */
/**
 * Targeted presence delivery: typing/recording indicators go straight to the
 * other chat members' sockets. A global broadcast on every composer keystroke
 * made the whole app refetch itself into lag.
 */
type PresenceEmit = (userId: string, payload: Record<string, unknown>) => void;
let presenceEmitter: PresenceEmit | null = null;
export function setPresenceEmitter(emit: PresenceEmit) {
  presenceEmitter = emit;
}

async function updateMemberState(chat: ChatDoc, userId: string, set: Record<string, unknown>, options: { silent?: boolean } = {}) {
  const prefixed = Object.fromEntries(Object.entries(set).map(([key, value]) => [`members.$[self].${key}`, value]));
  const filter = { _id: chat._id };
  const update = { $set: prefixed };
  const arrayFilters = { arrayFilters: [{ 'self.userId': userId }] };
  if (options.silent) await dbChats.updateOneSilent(filter, update, arrayFilters);
  else await dbChats.updateOne(filter, update, arrayFilters);
}

/**
 * Atomically applies "a new message arrived" to a chat.
 *
 * Per-member counters are updated with `$inc` and array filters instead of
 * rewriting the whole `members` array, so two people sending at the same time
 * cannot lose each other's unread increment.
 */
export async function applyIncomingMessage(chat: ChatDoc, authorId: string, preview: string, createdAt: Date, mentionedIds: Set<string>) {
  const mentioned = [...mentionedIds].filter((id) => id !== authorId);

  await dbChats.updateOne(
    { _id: chat._id },
    {
      $set: {
        lastMessageAt: createdAt,
        lastMessageText: preview,
        lastMessageAuthorId: authorId,
      },
      $inc: { 'members.$[recipient].unread': 1 },
    },
    { arrayFilters: [{ 'recipient.userId': { $ne: authorId } }] },
  );

  if (mentioned.length) {
    await dbChats.updateOne(
      { _id: chat._id },
      { $inc: { 'members.$[mentioned].unreadMentions': 1 } },
      { arrayFilters: [{ 'mentioned.userId': { $in: mentioned } }] },
    );
  }

  // A hidden direct chat must come back for everyone once a message arrives.
  await dbChats.updateOne({ _id: chat._id }, { $set: { 'members.$[].hiddenAt': null } });

  await dbChats.updateOne(
    { _id: chat._id },
    { $set: { 'members.$[author].unread': 0, 'members.$[author].typingAt': null, 'members.$[author].activity': null, 'members.$[author].activityAt': null } },
    { arrayFilters: [{ 'author.userId': authorId }] },
  );
}

/** Claims due jobs atomically so two Wyre server instances cannot send the same item twice. */
export async function processScheduledMessages() {
  const due = await dbScheduledMessages.fetch({ scheduledAt: { $lte: new Date() } }, { sort: { scheduledAt: 1 }, limit: 100 });
  for (const candidate of due) {
    const claimed = await dbScheduledMessages.native().findOneAndDelete({
      _id: candidate._id,
      scheduledAt: { $lte: new Date() },
    });
    if (!claimed) continue;
    dbScheduledMessages.changed();

    const chat = ObjectId.isValid(claimed.chatId) ? await dbChats.findOne({ _id: new ObjectId(claimed.chatId) }) : null;
    if (!chat || !(chat.memberIds ?? []).includes(claimed.userId)) continue;
    if (claimed.topicId) {
      const topic = ObjectId.isValid(claimed.topicId) ? await dbTopics.findOne({ _id: new ObjectId(claimed.topicId), chatId: claimed.chatId }) : null;
      if (!topic || topic.closedAt) continue;
    }
    const now = new Date();
    const scheduledLinkPreview = await linkPreviewFor(claimed.text);
    const scheduledMessage: Omit<MessageDoc, '_id'> = {
      chatId: claimed.chatId,
      topicId: claimed.topicId ?? null,
      authorId: claimed.userId,
      text: claimed.text,
      kind: scheduledLinkPreview ? 'link' : 'text',
      fileName: null,
      fileSize: null,
      filePath: null,
      mimeType: null,
      duration: null,
      reaction: null,
      pinned: false,
      editedAt: null,
      replyToId: null,
      replyToText: null,
      readBy: [claimed.userId],
      readAt: { [claimed.userId]: now },
      deliveredTo: [claimed.userId],
      createdAt: now,
      forwardedFromId: null,
      forwardedFromName: null,
      selfDestructSeconds: null,
      deleteAt: autoDeleteAt(chat, now),
      linkPreview: scheduledLinkPreview,
      notificationQueuedAt: now,
    };
    const { insertedId: scheduledMessageId } = await dbMessages.insertOne(scheduledMessage);
    const mentionedIds = await mentionedMemberIds(chat, claimed.text, claimed.userId);
    await queueMessageNotifications(chat, scheduledMessageId, scheduledMessage, previewOf(scheduledMessage.kind, claimed.text), mentionedIds);
    await applyIncomingMessage(chat, claimed.userId, previewOf(scheduledMessage.kind, claimed.text), now, mentionedIds);
  }
}

export async function processDueReminders() {
  const now = new Date();
  await dbReminders.updateMany(
    { status: 'pending', notifiedAt: null, remindAt: { $lte: now } },
    { $set: { notifiedAt: now } },
  );
}

/** Removes expired messages promptly (MongoDB TTL remains the crash-safe fallback) and repairs chat previews/unread counts. */
export async function processExpiredMessages() {
  const expired = await dbMessages.fetch({ deleteAt: { $lte: new Date() } }, { sort: { deleteAt: 1 }, limit: 500 });
  if (!expired.length) return;

  const chatIds = [...new Set(expired.map((message) => message.chatId))];
  await dbMessages.deleteMany({ _id: { $in: expired.map((message) => message._id) } });

  for (const chatId of chatIds) {
    if (!ObjectId.isValid(chatId)) continue;
    const chat = await dbChats.findOne({ _id: new ObjectId(chatId) });
    if (!chat) continue;
    const [latest] = await dbMessages.fetch(activeMessageFilter(chatId), { sort: { createdAt: -1 }, limit: 1 });
    const profiles = await loadProfiles(chat.memberIds ?? []);
    const members = await Promise.all((chat.members ?? []).map(async (member) => {
      const unreadFilter = {
        ...activeMessageFilter(chatId),
        authorId: { $ne: member.userId },
        readBy: { $ne: member.userId },
      };
      const memberProfile = profiles.get(member.userId);
      return {
        ...member,
        unread: await dbMessages.countDocuments(unreadFilter),
        unreadMentions: memberProfile ? await dbMessages.countDocuments({
          ...unreadFilter,
          text: { $regex: `(^|[^a-zA-Z0-9_])@${memberProfile.usernameLower}(?![a-zA-Z0-9_])`, $options: 'i' },
        }) : 0,
      };
    }));
    await dbChats.updateOne({ _id: chat._id }, { $set: {
      lastMessageAt: latest ? new Date(latest.createdAt) : chat.createdAt,
      lastMessageText: latest ? previewOf(latest.kind, latest.text) : '',
      lastMessageAuthorId: latest?.authorId ?? null,
      members,
    } });
  }
}

export const chatQueries = {
  reminders: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId } = z.object({ chatId: z.string() }).parse(args);
    await requireMembership(chatId, viewerId);
    return new LiveData({
      fetch: async () => {
        const reminders = await dbReminders.fetch({ userId: viewerId, chatId, status: 'pending' }, { sort: { remindAt: 1 }, limit: 100 });
        return reminders.map((reminder) => ({
          id: reminder._id.toString(),
          messageId: reminder.messageId,
          text: reminder.text,
          remindAt: reminder.remindAt.toISOString(),
          due: reminder.remindAt.getTime() <= Date.now(),
        }));
      },
      watch: ({ publish }) => {
        const stream = dbReminders.watch();
        stream.on('change', () => publish());
        return () => stream.close();
      },
    });
  },

  sharedNote: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId } = z.object({ chatId: z.string() }).parse(args);
    await requireMembership(chatId, viewerId);
    return new LiveData({
      fetch: async () => {
        const note = await dbSharedNotes.findOne({ chatId });
        return note ? { content: note.content, version: note.version, updatedAt: note.updatedAt.toISOString() } : { content: '', version: 0, updatedAt: null };
      },
      watch: ({ publish }) => {
        const stream = dbSharedNotes.watch();
        stream.on('change', () => publish());
        return () => stream.close();
      },
    });
  },

  /**
   * "Memory album": every photo/video of one conversation grouped into a
   * timeline. It reuses stored attachments and membership guards, so nothing is
   * duplicated and no extra access is granted.
   */
  memoryAlbum: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId } = z.object({ chatId: z.string() }).parse(args);
    await requireMembership(chatId, viewerId);
    return new LiveData({
      fetch: async () => {
        const messages = await dbMessages.fetch({
          ...activeMessageFilter(chatId),
          filePath: { $ne: null },
          mimeType: { $regex: '^(image|video)/', $options: 'i' },
        }, { sort: { createdAt: 1 }, limit: 500 });
        const profiles = await loadProfiles([...new Set(messages.map((message) => message.authorId).filter(ObjectId.isValid))]);
        const groups = new Map<string, { period: string; label: string; items: unknown[] }>();
        for (const message of messages) {
          const created = new Date(message.createdAt);
          const period = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}`;
          const label = created.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
          const file = message.filePath ? await getFileUrl(message.filePath, message.mimeType ?? 'application/octet-stream') : null;
          const bucket = groups.get(period) ?? { period, label, items: [] };
          bucket.items.push({
            id: message._id.toString(),
            url: file?.url,
            mimeType: message.mimeType,
            fileName: message.fileName,
            caption: message.text,
            mine: message.authorId === viewerId,
            author: message.authorId === viewerId ? 'Вы' : profiles.get(message.authorId)?.name ?? 'Участник',
            createdAt: created.toISOString(),
          });
          groups.set(period, bucket);
        }
        const periods = [...groups.values()].sort((left, right) => right.period.localeCompare(left.period));
        return {
          total: messages.length,
          firstAt: messages[0]?.createdAt.toISOString() ?? null,
          lastAt: messages.at(-1)?.createdAt.toISOString() ?? null,
          periods,
        };
      },
      watch: ({ publish }) => {
        const stream = dbMessages.watch([{ $match: { 'fullDocument.chatId': chatId } }]);
        stream.on('change', () => publish());
        return () => stream.close();
      },
    });
  },

  groupMediaAlbum: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId } = z.object({ chatId: z.string() }).parse(args);
    const chat = await requireMembership(chatId, viewerId);
    if (chat.kind !== 'group') throw new ValidationError('Альбом доступен только в группе');
    return new LiveData({
      fetch: async () => {
        const messages = await dbMessages.fetch({
          chatId,
          filePath: { $ne: null },
          mimeType: { $regex: '^(image|video)/', $options: 'i' },
        }, { sort: { createdAt: -1 }, limit: 300 });
        const profiles = await loadProfiles(messages.map((message) => message.authorId).filter(ObjectId.isValid));
        return Promise.all(messages.map(async (message) => {
          const file = message.filePath ? await getFileUrl(message.filePath, message.mimeType ?? 'application/octet-stream') : null;
          return {
            id: message._id.toString(),
            url: file?.url,
            mimeType: message.mimeType,
            fileName: message.fileName,
            caption: message.text,
            author: profiles.get(message.authorId)?.name ?? 'Участник',
            createdAt: message.createdAt.toISOString(),
          };
        }));
      },
      watch: ({ publish }) => {
        const stream = dbMessages.watch([{ $match: { 'fullDocument.chatId': chatId } }]);
        stream.on('change', () => publish());
        return () => stream.close();
      },
    });
  },

  groupDetails: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId } = z.object({ chatId: z.string() }).parse(args);
    const chat = await requireMembership(chatId, viewerId);
    if (chat.kind !== 'group') throw new ValidationError('Группа не найдена');
    const profiles = await loadProfiles(chat.memberIds ?? []);
    return {
      id: chat._id.toString(), title: chat.title ?? 'Группа', description: chat.description ?? '', autoDeleteAfterDays: chat.autoDeleteAfterDays ?? null, myRole: groupRole(chat, viewerId),
      members: (chat.memberIds ?? []).map((id) => {
        const member = profiles.get(id);
        return { userId: id, name: member?.name ?? 'Пользователь', username: member?.username ?? '', initials: member?.initials ?? '??', colors: member?.colors ?? paletteFor(id), role: groupRole(chat, id) };
      }),
    };
  },

  listTopics: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId } = z.object({ chatId: z.string() }).parse(args);
    const chat = await requireMembership(chatId, viewerId);
    if (chat.kind !== 'group') throw new ValidationError('Темы доступны только в группах');

    return new LiveData({
      fetch: async () => {
        const currentChat = await requireMembership(chatId, viewerId);
        const member = memberStateOf(currentChat, viewerId);
        const topics = await dbTopics.fetch({ chatId }, { sort: { createdAt: 1 }, limit: 100 });
        return Promise.all(topics.map(async (topic) => {
          const topicId = topic._id.toString();
          const [latest] = await dbMessages.fetch({ ...activeMessageFilter(chatId), topicId }, { sort: { createdAt: -1 }, limit: 1 });
          const unread = await dbMessages.countDocuments({
            ...activeMessageFilter(chatId),
            topicId,
            authorId: { $ne: viewerId },
            readBy: { $ne: viewerId },
            createdAt: { $gt: member?.topicReads?.[topicId] ?? topic.createdAt },
          });
          return {
            id: topicId,
            title: topic.title,
            closed: Boolean(topic.closedAt),
            unread,
            last: latest ? previewOf(latest.kind, latest.text) : '',
            updatedAt: (latest?.createdAt ?? topic.updatedAt).toISOString(),
            canManage: ['owner', 'admin'].includes(groupRole(currentChat, viewerId)),
          };
        }));
      },
      watch: ({ publish }) => {
        const topicStream = dbTopics.watch();
        const messageStream = dbMessages.watch([{ $match: { 'fullDocument.chatId': chatId } }], { fullDocument: 'updateLookup' });
        const chatStream = dbChats.watch();
        topicStream.on('change', () => publish());
        messageStream.on('change', () => publish());
        chatStream.on('change', () => publish());
        return () => {
          topicStream.close();
          messageStream.close();
          chatStream.close();
        };
      },
    });
  },

  mentionCandidates: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId } = z.object({ chatId: z.string() }).parse(args);
    const chat = await requireMembership(chatId, viewerId);
    const profiles = await loadProfiles((chat.memberIds ?? []).filter((id) => id !== viewerId));
    return [...profiles.values()].map((member) => ({
      userId: member.userId.toString(),
      name: member.name,
      username: member.username,
      initials: member.initials,
      colors: [member.colors[0], member.colors[1]] as [string, string],
    }));
  },

  scheduledMessages: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId } = z.object({ chatId: z.string() }).parse(args);
    await requireMembership(chatId, viewerId);
    const items = await dbScheduledMessages.fetch({ userId: viewerId, chatId }, { sort: { scheduledAt: 1 }, limit: 100 });
    return items.map((item) => ({ id: item._id.toString(), text: item.text, scheduledAt: item.scheduledAt, topicId: item.topicId ?? undefined }));
  },

  draft: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId } = z.object({ chatId: z.string() }).parse(args);
    await requireMembership(chatId, viewerId);
    return (await dbDrafts.findOne({ userId: viewerId, chatId }))?.text ?? '';
  },

  /** Live list of the caller's conversations, ordered by recency. */
  listChats: async (_args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();

    return new LiveData({
      fetch: async () => {
        await touchLastSeen(viewerId);
        const chats = await dbChats.fetch(
          { memberIds: viewerId },
          { sort: { lastMessageAt: -1 }, limit: 200 }
        );
        const visibleChats = chats.filter((chat) => !memberStateOf(chat, viewerId)?.hiddenAt);
        const peerIds = visibleChats.flatMap((chat) => chat.memberIds ?? []);
        const [profiles, talkingIds] = await Promise.all([loadProfiles(peerIds), activeTalkingIds()]);
        return Promise.all(visibleChats.map((chat) => serializeChat(chat, viewerId, profiles, talkingIds)));
      },
      watch: ({ publish }) => {
        const chatStream = dbChats.watch();
        chatStream.on('change', () => publish());
        // Presence changes live on the profile documents.
        const profileStream = dbProfiles.watch();
        profileStream.on('change', () => publish());
        const callStream = dbCalls.watch();
        callStream.on('change', () => publish());
        return () => {
          chatStream.close();
          profileStream.close();
          callStream.close();
        };
      },
    });
  },

  /** Live message history for one chat. */
  listMessages: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId, topicId } = z.object({ chatId: z.string(), topicId: z.string().optional() }).parse(args);
    const chat = await requireMembership(chatId, viewerId);
    if (topicId) await requireTopic(chat, topicId, true);
    const memberCount = (chat.memberIds ?? []).length;

    return new LiveData({
      fetch: async () => {
        const messages = (await dbMessages.fetch(topicId ? { ...activeMessageFilter(chatId), topicId } : activeMessageFilter(chatId), { sort: { createdAt: -1, _id: -1 }, limit: 500 })).reverse();
        const bookmarks = await dbMessageBookmarks.fetch({ userId: viewerId, messageId: { $in: messages.map((message) => message._id.toString()) } });
        const bookmarked = new Set(bookmarks.map((entry) => entry.messageId));
        return Promise.all(
          messages.map((message, index) =>
            serializeMessage(
              message,
              viewerId,
              profile.usernameLower,
              memberCount,
              messages[index - 1],
              bookmarked.has(message._id.toString()),
              chat.kind === 'group' && ['owner', 'admin'].includes(groupRole(chat, viewerId)),
            )
          )
        );
      },
      watch: ({ publish }) => {
        const stream = dbMessages.watch([{ $match: { 'fullDocument.chatId': chatId } }], {
          fullDocument: 'updateLookup',
        });
        stream.on('change', () => publish());
        return () => stream.close();
      },
    });
  },

  /**
   * Server-side chat search over the whole history, including attachment names
   * and captions. Membership and topic guards are re-checked on every call.
   */
  searchMessages: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId, topicId, query } = z.object({
      chatId: z.string(),
      topicId: z.string().nullish(),
      query: z.string().trim().min(1).max(200),
    }).parse(args);
    const chat = await requireMembership(chatId, viewerId);
    if (topicId) await requireTopic(chat, topicId, true);
    const safe = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const filter = {
      ...activeMessageFilter(chatId),
      ...(topicId ? { topicId } : {}),
      $and: [{
        $or: [
          { text: { $regex: safe, $options: 'i' } },
          { fileName: { $regex: safe, $options: 'i' } },
          { transcription: { $regex: safe, $options: 'i' } },
        ],
      }],
    };
    const messages = await dbMessages.fetch(filter, { sort: { createdAt: -1 }, limit: 100 });
    const profiles = await loadProfiles([...new Set(messages.map((message) => message.authorId))]);
    return messages.map((message) => ({
      id: message._id.toString(),
      author: message.authorId === viewerId ? 'Вы' : profiles.get(message.authorId)?.name ?? 'Участник',
      text: (message.text || message.fileName || previewOf(message.kind, message.text)).slice(0, 200),
      kind: message.kind,
      time: formatTime(message.createdAt),
      date: formatDayLabel(message.createdAt),
      createdAt: message.createdAt.toISOString(),
    }));
  },

  /** Live peer header state (presence / typing) for the open chat. */
  chatPeer: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId } = z.object({ chatId: z.string() }).parse(args);
    await requireMembership(chatId, viewerId);

    return new LiveData({
      fetch: async () => {
        const chat = await dbChats.findOne({ _id: new ObjectId(chatId) });
        if (!chat) return null;
        const profiles = await loadProfiles(chat.memberIds ?? []);
        return serializeChat(chat, viewerId, profiles, await activeTalkingIds());
      },
      watch: ({ publish }) => {
        const chatStream = dbChats.watch();
        chatStream.on('change', () => publish());
        const profileStream = dbProfiles.watch();
        profileStream.on('change', () => publish());
        const callStream = dbCalls.watch();
        callStream.on('change', () => publish());
        return () => {
          chatStream.close();
          profileStream.close();
          callStream.close();
        };
      },
    });
  },

  /** Directory search across Wyre profiles by name or @username. */
  searchPeople: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { query } = z.object({ query: z.string().optional() }).parse(args ?? {});

    const trimmed = (query ?? '').trim().replace(/^@+/, '');
    const phoneQuery = trimmed.replace(/\D/g, '');
    const filter: Record<string, unknown> = { userId: { $ne: new ObjectId(viewerId) }, isDecoy: { $ne: true }, isService: { $ne: true } };
    if (phoneQuery.length >= 10) {
      filter.phone = phoneQuery.length === 11 && phoneQuery.startsWith('8') ? `7${phoneQuery.slice(1)}` : phoneQuery;
    } else if (trimmed) {
      const safe = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: { $regex: safe, $options: 'i' } },
        { usernameLower: { $regex: safe.toLowerCase() } },
      ];
    }

    const [people, blocked] = await Promise.all([dbProfiles.fetch(filter, { sort: { lastSeenAt: -1 }, limit: 80 }), blockedUserIds(viewerId)]);
    const visiblePeople = [];
    for (const person of people.filter((entry) => !blocked.has(entry.userId.toString()))) {
      if (phoneQuery.length < 10 || await privacyActionAllowed(person.userId.toString(), viewerId, 'find')) visiblePeople.push(person);
    }
    return Promise.all(visiblePeople.slice(0, 40).map(async (person) => {
      const visible = presenceAllowed(person, viewerId, false);
      const presence = visible ? presenceOf(person, undefined) : ('offline' as const);
      return {
        userId: person.userId.toString(),
        name: person.name,
        username: person.username,
        initials: person.initials,
        avatarUrl: await avatarUrlOf(person),
        colors: [person.colors[0], person.colors[1]] as [string, string],
        badge: person.badge ?? undefined,
        online: presence === 'online',
        status: visible ? statusTextOf(presence, person) : 'статус скрыт',
        warnings: publicWarnings(person),
        phone: await privacyActionAllowed(person.userId.toString(), viewerId, 'phone') ? person.phone : null,
      };
    }));
  },
  /**
   * Public profile card shown when a user is tapped anywhere in the app.
   * Privacy rules, blocks and presence visibility are all applied server-side.
   */
  userProfile: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { userId } = z.object({ userId: z.string().refine(ObjectId.isValid, 'Пользователь не найден') }).parse(args);
    if (userId === viewerId) {
      return {
        userId,
        name: profile.name,
        username: profile.username,
        initials: profile.initials,
        colors: [profile.colors[0], profile.colors[1]] as [string, string],
        avatarUrl: await avatarUrlOf(profile),
        badge: profile.badge ?? undefined,
        bio: profile.bio ?? '',
        status: 'это вы',
        presence: 'online' as const,
        warnings: publicWarnings(profile),
        phone: profile.phone,
        canMessage: false,
        canCall: false,
        isSelf: true,
      };
    }
    await requireNotBlocked(viewerId, userId);
    const person = await dbProfiles.findOne({ userId: new ObjectId(userId), isDecoy: { $ne: true } });
    if (!person) throw new ValidationError('Пользователь не найден');
    const visible = presenceAllowed(person, viewerId, false);
    const presence = visible ? presenceOf(person, undefined) : ('offline' as const);
    return {
      userId,
      name: person.name,
      username: person.username,
      initials: person.initials,
      colors: [person.colors[0], person.colors[1]] as [string, string],
      avatarUrl: await avatarUrlOf(person),
      badge: person.badge ?? undefined,
      bio: person.bio ?? '',
      status: visible ? statusTextOf(presence, person) : 'статус скрыт',
      presence,
      warnings: publicWarnings(person),
      phone: await privacyActionAllowed(userId, viewerId, 'phone') ? person.phone : null,
      canMessage: true,
      canCall: await privacyActionAllowed(userId, viewerId, 'call'),
      isSelf: false,
    };
  },
};

export const chatMutations = {
  suggestReminder: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { messageId } = z.object({ messageId: z.string() }).parse(args);
    if (!ObjectId.isValid(messageId)) throw new ValidationError('Сообщение не найдено');
    const message = await dbMessages.findOne({ _id: new ObjectId(messageId) });
    if (!message) throw new ValidationError('Сообщение не найдено');
    await requireMembership(message.chatId, viewerId);
    const suggestion = await suggestContextReminder({
      text: (message.transcription || message.text || previewOf(message.kind, message.text)).slice(0, 2000),
      createdAt: message.createdAt.toISOString(),
    }, new Date());
    return { text: suggestion.text, remindAt: suggestion.remindAt.toISOString() };
  },

  checkLinkSafety: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { messageId } = z.object({ messageId: z.string() }).parse(args);
    if (!ObjectId.isValid(messageId)) throw new ValidationError('Ссылка не найдена');
    const message = await dbMessages.findOne({ _id: new ObjectId(messageId) });
    if (!message?.linkPreview) throw new ValidationError('Ссылка не найдена');
    await requireMembership(message.chatId, viewerId);
    if (message.linkSafety) return { level: message.linkSafety.level, reason: message.linkSafety.reason, checkedAt: message.linkSafety.checkedAt.toISOString() };
    const safety = await assessLinkRisk(message.linkPreview.url, message.linkPreview.title, message.linkPreview.description);
    const checkedAt = new Date();
    await dbMessages.updateOne({ _id: message._id, linkSafety: { $in: [null, undefined] } }, { $set: { linkSafety: { ...safety, checkedAt } } });
    const stored = await dbMessages.findOne({ _id: message._id });
    const result = stored?.linkSafety ?? { ...safety, checkedAt };
    return { level: result.level, reason: result.reason, checkedAt: result.checkedAt.toISOString() };
  },

  saveReminder: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { messageId, text, remindAt } = z.object({
      messageId: z.string(),
      text: z.string().trim().min(1).max(300),
      remindAt: z.coerce.date(),
    }).parse(args);
    if (!ObjectId.isValid(messageId)) throw new ValidationError('Сообщение не найдено');
    if (remindAt.getTime() <= Date.now() || remindAt.getTime() > Date.now() + 366 * 24 * 60 * 60 * 1000) throw new ValidationError('Срок напоминания должен быть в пределах года');
    const message = await dbMessages.findOne({ _id: new ObjectId(messageId) });
    if (!message) throw new ValidationError('Сообщение не найдено');
    await requireMembership(message.chatId, viewerId);
    const now = new Date();
    const existing = await dbReminders.findOne({ userId: viewerId, messageId });
    if (existing) {
      await dbReminders.updateOne({ _id: existing._id }, { $set: { text, remindAt, status: 'pending', notifiedAt: null, completedAt: null } });
      return { reminderId: existing._id.toString() };
    }
    const { insertedId } = await dbReminders.insertOne({ userId: viewerId, chatId: message.chatId, messageId, text, remindAt, status: 'pending', notifiedAt: null, createdAt: now, completedAt: null });
    return { reminderId: insertedId.toString() };
  },

  completeReminder: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { reminderId } = z.object({ reminderId: z.string() }).parse(args);
    if (!ObjectId.isValid(reminderId)) throw new ValidationError('Напоминание не найдено');
    const result = await dbReminders.updateOne({ _id: new ObjectId(reminderId), userId: viewerId, status: 'pending' }, { $set: { status: 'done', completedAt: new Date() } });
    if (!result.matchedCount) throw new ValidationError('Напоминание не найдено');
    return { completed: true };
  },

  updateSharedNote: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId, content, expectedVersion } = z.object({ chatId: z.string(), content: z.string().max(20_000), expectedVersion: z.number().int().min(0) }).parse(args);
    await requireMembership(chatId, viewerId);
    const now = new Date();
    if (expectedVersion === 0) {
      if (await dbSharedNotes.findOne({ chatId })) throw new ValidationError('Заметка уже изменена на другом устройстве', 'VERSION_CONFLICT');
      try {
        await dbSharedNotes.insertOne({ chatId, content, version: 1, updatedBy: viewerId, createdAt: now, updatedAt: now });
        return { version: 1, updatedAt: now.toISOString() };
      } catch (error) {
        if (typeof error === 'object' && error && 'code' in error && error.code === 11000) throw new ValidationError('Заметка уже изменена на другом устройстве', 'VERSION_CONFLICT');
        throw error;
      }
    }
    const result = await dbSharedNotes.updateOne({ chatId, version: expectedVersion }, { $set: { content, version: expectedVersion + 1, updatedBy: viewerId, updatedAt: now } });
    if (!result.matchedCount) throw new ValidationError('Заметка уже изменена на другом устройстве', 'VERSION_CONFLICT');
    return { version: expectedVersion + 1, updatedAt: now.toISOString() };
  },

  updateGroup: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId, title, description } = z.object({ chatId: z.string(), title: z.string().trim().min(1).max(64), description: z.string().trim().max(500) }).parse(args);
    const chat = await requireMembership(chatId, viewerId);
    requireGroupManager(chat, viewerId);
    await dbChats.updateOne({ _id: chat._id }, { $set: { title, description } });
    return { title, description };
  },

  createTopic: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId, title } = z.object({
      chatId: z.string(),
      title: z.string().trim().min(1, 'Введите название темы').max(80, 'Название темы слишком длинное'),
    }).parse(args);
    const chat = await requireMembership(chatId, viewerId);
    requireGroupManager(chat, viewerId);
    if (await dbTopics.countDocuments({ chatId }) >= 100) throw new ValidationError('В группе может быть не больше 100 тем');
    const titleLower = title.toLocaleLowerCase('ru-RU');
    if (await dbTopics.findOne({ chatId, titleLower })) throw new ValidationError('Тема с таким названием уже существует');
    const now = new Date();
    const { insertedId } = await dbTopics.insertOne({ chatId, title, titleLower, createdBy: viewerId, createdAt: now, updatedAt: now, closedAt: null });
    return { topicId: insertedId.toString() };
  },

  renameTopic: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { topicId, title } = z.object({
      topicId: z.string(),
      title: z.string().trim().min(1, 'Введите название темы').max(80, 'Название темы слишком длинное'),
    }).parse(args);
    if (!ObjectId.isValid(topicId)) throw new ValidationError('Тема не найдена');
    const topic = await dbTopics.findOne({ _id: new ObjectId(topicId) });
    if (!topic) throw new ValidationError('Тема не найдена');
    const chat = await requireMembership(topic.chatId, viewerId);
    requireGroupManager(chat, viewerId);
    const titleLower = title.toLocaleLowerCase('ru-RU');
    const duplicate = await dbTopics.findOne({ chatId: topic.chatId, titleLower });
    if (duplicate && !duplicate._id.equals(topic._id)) throw new ValidationError('Тема с таким названием уже существует');
    await dbTopics.updateOne({ _id: topic._id }, { $set: { title, titleLower, updatedAt: new Date() } });
    return { title };
  },

  setTopicClosed: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { topicId, closed } = z.object({ topicId: z.string(), closed: z.boolean() }).parse(args);
    if (!ObjectId.isValid(topicId)) throw new ValidationError('Тема не найдена');
    const topic = await dbTopics.findOne({ _id: new ObjectId(topicId) });
    if (!topic) throw new ValidationError('Тема не найдена');
    const chat = await requireMembership(topic.chatId, viewerId);
    requireGroupManager(chat, viewerId);
    await dbTopics.updateOne({ _id: topic._id }, { $set: { closedAt: closed ? new Date() : null, updatedAt: new Date() } });
    return { closed };
  },

  addGroupMembers: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId, userIds } = z.object({ chatId: z.string(), userIds: z.array(z.string()).min(1).max(50) }).parse(args);
    const chat = await requireMembership(chatId, viewerId);
    requireGroupManager(chat, viewerId);
    const addIds = [...new Set(userIds)].filter((id) => !(chat.memberIds ?? []).includes(id));
    if (addIds.some((id) => !ObjectId.isValid(id))) throw new ValidationError('Пользователь не найден');
    const found = await dbProfiles.fetch({ userId: { $in: addIds.map((id) => new ObjectId(id)) } });
    if (found.length !== addIds.length) throw new ValidationError('Пользователь не найден');
    for (const userId of addIds) await requirePrivacyAction(userId, viewerId, 'invite');
    const now = new Date();
    // `$push`/`$addToSet` keep concurrent member changes from being lost.
    await dbChats.updateOne({ _id: chat._id }, {
      $addToSet: { memberIds: { $each: addIds } },
      $push: { members: { $each: addIds.map((userId) => ({ userId, unread: 0, unreadMentions: 0, pinned: false, muted: false, lastReadAt: now, typingAt: null, role: 'member' as const })) } },
    });
    return { added: addIds.length };
  },

  removeGroupMember: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId, userId } = z.object({ chatId: z.string(), userId: z.string() }).parse(args);
    const chat = await requireMembership(chatId, viewerId);
    const myRole = requireGroupManager(chat, viewerId);
    if (!(chat.memberIds ?? []).includes(userId) || userId === chat.createdBy) throw new ValidationError('Участника нельзя удалить');
    if (myRole !== 'owner' && groupRole(chat, userId) === 'admin') throw new ValidationError('Администратора может удалить только владелец');
    await dbChats.updateOne({ _id: chat._id }, {
      $pull: { memberIds: userId, members: { userId } },
    });
    return { removed: true };
  },

  setGroupMemberRole: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId, userId, role } = z.object({ chatId: z.string(), userId: z.string(), role: z.enum(['admin', 'member']) }).parse(args);
    const chat = await requireMembership(chatId, viewerId);
    if (groupRole(chat, viewerId) !== 'owner') throw new ValidationError('Роли может менять только владелец группы');
    if (!(chat.memberIds ?? []).includes(userId) || userId === viewerId) throw new ValidationError('Участник не найден');
    await dbChats.updateOne(
      { _id: chat._id },
      { $set: { 'members.$[target].role': role } },
      { arrayFilters: [{ 'target.userId': userId }] },
    );
    return { role };
  },

  leaveGroup: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId } = z.object({ chatId: z.string() }).parse(args);
    const chat = await requireMembership(chatId, viewerId);
    if (chat.kind !== 'group') throw new ValidationError('Группа не найдена');
    return removeGroupMembership(chat, viewerId);
  },

  deleteChat: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId } = z.object({ chatId: z.string() }).parse(args);
    const chat = await requireMembership(chatId, viewerId);
    if (chat.kind === 'group') return removeGroupMembership(chat, viewerId);
    await Promise.all([
      updateMemberState(chat, viewerId, { hiddenAt: new Date(), unread: 0, unreadMentions: 0, pinned: false }),
      dbDrafts.deleteOne({ userId: viewerId, chatId }),
      dbScheduledMessages.deleteMany({ userId: viewerId, chatId }),
    ]);
    return { deleted: false, hidden: true };
  },

  setChatFolders: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId, folders } = z.object({
      chatId: z.string(),
      folders: z.array(z.enum(['work', 'family'])).max(2),
    }).parse(args);
    const uniqueFolders = [...new Set(folders)];
    const chat = await requireMembership(chatId, viewerId);
    await updateMemberState(chat, viewerId, { folders: uniqueFolders });
    return { folders: uniqueFolders };
  },

  setChatAutoDelete: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId, days } = z.object({
      chatId: z.string(),
      days: z.number().int().nullable(),
    }).parse(args);
    if (days !== null && !(AUTO_DELETE_DAY_OPTIONS as readonly number[]).includes(days)) {
      throw new ValidationError('Выберите срок автоудаления от 1 дня до года');
    }
    const chat = await requireMembership(chatId, viewerId);
    if (chat.kind === 'group' && chat.createdBy !== viewerId) {
      throw new ValidationError('Автоудаление в группе может менять только её создатель');
    }
    await dbChats.updateOne({ _id: chat._id }, { $set: { autoDeleteAfterDays: days } });
    return { autoDeleteAfterDays: days };
  },

  scheduleMessage: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId, topicId, text, scheduledAt } = z.object({
      chatId: z.string(),
      topicId: z.string().nullish(),
      text: z.string().trim().min(1).max(4000),
      scheduledAt: z.coerce.date(),
    }).parse(args);
    const chat = await requireMembership(chatId, viewerId);
    if (topicId) await requireTopic(chat, topicId);
    if (chat.kind === 'direct') {
      const peerId = chat.memberIds.find((id) => id !== viewerId);
      if (peerId) await requireContentAllowed(peerId, viewerId);
    }
    const delay = scheduledAt.getTime() - Date.now();
    if (delay < MIN_SCHEDULE_DELAY_MS - 5000) throw new ValidationError('Запланируйте отправку минимум через час');
    if (delay > MAX_SCHEDULE_DELAY_MS) throw new ValidationError('Можно запланировать не больше чем на год вперёд');
    const now = new Date();
    const { insertedId } = await dbScheduledMessages.insertOne({ userId: viewerId, chatId, topicId: topicId ?? null, text, scheduledAt, createdAt: now, updatedAt: now });
    return { scheduledMessageId: insertedId.toString(), scheduledAt };
  },

  updateScheduledMessage: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { scheduledMessageId, text, scheduledAt } = z.object({
      scheduledMessageId: z.string(), text: z.string().trim().min(1).max(4000), scheduledAt: z.coerce.date(),
    }).parse(args);
    if (!ObjectId.isValid(scheduledMessageId)) throw new ValidationError('Запланированное сообщение не найдено');
    const delay = scheduledAt.getTime() - Date.now();
    if (delay < MIN_SCHEDULE_DELAY_MS - 5000 || delay > MAX_SCHEDULE_DELAY_MS) throw new ValidationError('Выберите время от часа до года вперёд');
    const result = await dbScheduledMessages.updateOne(
      { _id: new ObjectId(scheduledMessageId), userId: viewerId },
      { $set: { text, scheduledAt, updatedAt: new Date() } },
    );
    if (!result.matchedCount) throw new ValidationError('Запланированное сообщение не найдено');
    return { updated: true };
  },

  cancelScheduledMessage: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { scheduledMessageId } = z.object({ scheduledMessageId: z.string() }).parse(args);
    if (!ObjectId.isValid(scheduledMessageId)) throw new ValidationError('Запланированное сообщение не найдено');
    const result = await dbScheduledMessages.deleteOne({ _id: new ObjectId(scheduledMessageId), userId: viewerId });
    if (!result.deletedCount) throw new ValidationError('Запланированное сообщение не найдено');
    return { cancelled: true };
  },

  // Drafts are saved on every typing pause: silent writes keep this private
  // helper traffic from broadcasting `wyre:changed` to every connected client.
  saveDraft: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId, text } = z.object({ chatId: z.string(), text: z.string().max(4000) }).parse(args);
    await requireMembership(chatId, viewerId);
    const trimmed = text.slice(0, 4000);
    if (!trimmed.trim()) {
      await dbDrafts.deleteOneSilent({ userId: viewerId, chatId });
      return { saved: false };
    }
    await dbDrafts.updateOneSilent(
      { userId: viewerId, chatId },
      { $set: { userId: viewerId, chatId, text: trimmed, updatedAt: new Date() } },
      { upsert: true },
    );
    return { saved: true };
  },

  clearDraft: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId } = z.object({ chatId: z.string() }).parse(args);
    await requireMembership(chatId, viewerId);
    await dbDrafts.deleteOneSilent({ userId: viewerId, chatId });
    return { saved: false };
  },

  /** Opens (or reuses) the direct conversation with another Wyre user. */
  openDirectChat: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { peerId } = z.object({ peerId: z.string() }).parse(args);

    if (peerId === viewerId) throw new ValidationError('Нельзя начать чат с самим собой');
    if (!ObjectId.isValid(peerId)) throw new ValidationError('Пользователь не найден');

    const peer = await dbProfiles.findOne({ userId: new ObjectId(peerId) });
    if (!peer) throw new ValidationError('Пользователь не найден');
    await requireNotBlocked(viewerId, peerId);

    const pairKey = pairKeyFor(viewerId, peerId);
    const existing = await dbChats.findOne({ pairKey });
    if (existing) {
      await updateMemberState(existing, viewerId, { hiddenAt: null });
      return { chatId: existing._id.toString() };
    }
    await requirePrivacyAction(peerId, viewerId, 'invite');

    const now = new Date();
    const emptyState = (userId: string) => ({
      userId,
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
        memberIds: [viewerId, peerId],
        createdBy: viewerId,
        createdAt: now,
        lastMessageAt: now,
        lastMessageText: '',
        lastMessageAuthorId: null,
        members: [emptyState(viewerId), emptyState(peerId)],
      });
      return { chatId: insertedId.toString() };
    } catch {
      // Lost the race against a concurrent create — reuse the winner.
      const raced = await dbChats.requireOne({ pairKey });
      return { chatId: raced._id.toString() };
    }
  },

  /** Creates a group chat with the caller plus the given members. */
  /** Signed upload ticket for a group photo; only owners and admins may set it. */
  requestGroupAvatarUpload: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId, fileName, fileSize, contentType } = z.object({
      chatId: z.string(),
      fileName: z.string().trim().min(1).max(200),
      fileSize: z.number().int().positive().max(10 * 1024 * 1024, 'Фото группы больше 10 МБ'),
      contentType: z.string().trim().regex(/^image\/(jpeg|png|webp|gif)$/, 'Для фото группы выберите изображение'),
    }).parse(args);
    void fileSize;
    const chat = await requireMembership(chatId, viewerId);
    if (chat.kind !== 'group') throw new ValidationError('Фото доступно только для группы');
    requireGroupManager(chat, viewerId);
    const safeName = fileName.replace(/[^\w.\-]+/g, '_').slice(-100);
    const filePath = `private/wyre-avatars/group-${chatId}/${new ObjectId().toString()}-${safeName}`;
    const upload = await getUploadUrl({ filePath, contentType });
    return { url: upload.url, fields: upload.fields, filePath };
  },

  setGroupAvatar: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId, filePath, mimeType } = z.object({
      chatId: z.string(),
      filePath: z.string().nullable(),
      mimeType: z.string().regex(/^image\/(jpeg|png|webp|gif)$/).nullish(),
    }).parse(args);
    const chat = await requireMembership(chatId, viewerId);
    if (chat.kind !== 'group') throw new ValidationError('Фото доступно только для группы');
    requireGroupManager(chat, viewerId);
    if (filePath && !filePath.startsWith(`private/wyre-avatars/group-${chatId}/`)) throw new ValidationError('Некорректный файл фото');
    if (filePath && !await storedFileExists(filePath)) throw new ValidationError('Файл фото не найден');
    const previous = chat.avatarPath;
    await dbChats.updateOne({ _id: chat._id }, { $set: { avatarPath: filePath, avatarMimeType: filePath ? mimeType ?? 'image/jpeg' : null } });
    if (previous && previous !== filePath) await deleteStoredFile(previous);
    return { updated: true };
  },

  createGroup: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { title, memberIds } = z
      .object({
        title: z.string().trim().min(1, 'Укажите название группы').max(64, 'Название слишком длинное'),
        memberIds: z.array(z.string()).min(1, 'Выберите хотя бы одного участника'),
      })
      .parse(args);

    const uniqueMemberIds = [...new Set(memberIds)].filter((id) => id !== viewerId);
    if (uniqueMemberIds.length === 0) throw new ValidationError('Выберите хотя бы одного участника');
    if (uniqueMemberIds.some((id) => !ObjectId.isValid(id))) throw new ValidationError('Пользователь не найден');

    const foundProfiles = await dbProfiles.fetch({ userId: { $in: uniqueMemberIds.map((id) => new ObjectId(id)) } });
    if (foundProfiles.length !== uniqueMemberIds.length) throw new ValidationError('Пользователь не найден');
    for (const userId of uniqueMemberIds) await requirePrivacyAction(userId, viewerId, 'invite');

    const allMemberIds = [viewerId, ...uniqueMemberIds];
    const now = new Date();
    const emptyState = (userId: string) => ({
      userId,
      unread: 0,
      pinned: false,
      muted: false,
      lastReadAt: now,
      typingAt: null,
      role: (userId === viewerId ? 'owner' : 'member') as 'owner' | 'member',
    });

    const { insertedId } = await dbChats.insertOne({
      kind: 'group',
      pairKey: null,
      title: title.trim(),
      memberIds: allMemberIds,
      createdBy: viewerId,
      createdAt: now,
      lastMessageAt: now,
      lastMessageText: '',
      lastMessageAuthorId: null,
      members: allMemberIds.map(emptyState),
    });

    return { chatId: insertedId.toString() };
  },

  /** Issues a presigned upload URL for a photo/file the caller wants to send in a chat. */
  requestAttachmentUpload: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId, fileName, fileSize, contentType } = z
      .object({
        chatId: z.string(),
        fileName: z.string().trim().min(1).max(200),
        fileSize: z.number().int().positive().max(MAX_FILE_BYTES, `Файл больше ${env.MAX_UPLOAD_MB} МБ`),
        contentType: z.string().trim().min(1).max(200).refine((value) => !/[\r\n]/.test(value), 'Некорректный тип файла'),
      })
      .parse(args);
    void fileSize; // only used for Zod's max-size validation above

    await requireMembership(chatId, viewerId);

    const safeName = fileName.replace(/[^\w.\-]+/g, '_').slice(-100);
    const filePath = `private/wyre-chats/${chatId}/${new ObjectId().toString()}-${safeName}`;
    const upload = await getUploadUrl({ filePath, contentType });

    return { url: upload.url, fields: upload.fields, filePath };
  },

  sendMessage: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId, topicId, text, kind, replyToId, fileName, fileSize, filePath, mimeType, duration, selfDestructSeconds, liveLocationMinutes, requestFolderTransfer } = z
      .object({
        chatId: z.string(),
        topicId: z.string().nullish(),
        text: z.string().max(4000, 'Сообщение слишком длинное'),
        kind: z.enum(MESSAGE_KINDS).default('text'),
        replyToId: z.string().nullish(),
        fileName: z.string().nullish(),
        fileSize: z.string().nullish(),
        filePath: z.string().nullish(),
        mimeType: z.string().max(200).refine((value) => !/[\r\n]/.test(value), 'Некорректный тип файла').nullish(),
        duration: z.number().int().min(0).max(3600).nullish(),
        selfDestructSeconds: z.number().int().min(5).max(MAX_SELF_DESTRUCT_SECONDS).nullish(),
        liveLocationMinutes: z.union([z.literal(15), z.literal(60), z.literal(480)]).nullish(),
        requestFolderTransfer: z.boolean().default(false),
      })
      .refine((value) => value.text.trim().length > 0 || Boolean(value.filePath), {
        message: 'Пустое сообщение',
      })
      .parse(args);

    const chat = await requireMembership(chatId, viewerId);
    if (topicId) await requireTopic(chat, topicId);
    if (kind === 'poll') throw new ValidationError('Создайте опрос через форму опроса');
    if (kind === 'actions') throw new ValidationError('Сообщения с кнопками отправляет только Wyre');
    await requireDirectPeerAllowed(chat, viewerId);
    if (chat.kind === 'direct') {
      const peerId = chat.memberIds.find((id) => id !== viewerId);
      if (peerId) await requireContentAllowed(peerId, viewerId);
    }
    if (filePath && !filePath.startsWith(`private/wyre-chats/${chatId}/`)) {
      throw new ValidationError('Некорректное вложение');
    }
    const now = new Date();
    let storedText = text.trim();
    if (kind === 'contact') {
      const contact = z.object({ userId: z.string() }).parse(parseMessagePayload(storedText));
      if (!ObjectId.isValid(contact.userId)) throw new ValidationError('Контакт не найден');
      const contactProfile = await dbProfiles.findOne({ userId: new ObjectId(contact.userId) });
      if (!contactProfile) throw new ValidationError('Контакт не найден');
      storedText = JSON.stringify({ userId: contact.userId, name: contactProfile.name, username: contactProfile.username });
    }
    if (requestFolderTransfer && (chat.kind !== 'direct' || !filePath || kind !== 'file')) throw new ValidationError('Передача в папку доступна только для файла в личном чате');
    const folderTransferTarget = requestFolderTransfer ? chat.memberIds.find((id) => id !== viewerId) : null;
    if (kind === 'location') {
      const location = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), accuracy: z.number().min(0).max(100_000).optional() }).parse(parseMessagePayload(storedText));
      storedText = JSON.stringify(location);
    }
    if (liveLocationMinutes && kind !== 'location') throw new ValidationError('Live-геолокация доступна только для геопозиции');
    // The remote Open Graph fetch must never delay delivery: the kind is decided
    // from the URL itself and the preview snapshot is attached right after.
    const hasLink = (kind === 'text' || kind === 'link') && Boolean(firstUrl(storedText));
    const storedKind = mimeType === 'text/html' ? 'html' : hasLink && kind === 'text' ? 'link' : kind;

    let replyToText: string | null = null;
    let replyToKind: MessageDoc['kind'] | null = null;
    let voiceThreadRootId: string | null = null;
    if (replyToId && ObjectId.isValid(replyToId)) {
      const parent = await dbMessages.findOne({ _id: new ObjectId(replyToId), chatId });
      if (parent && (parent.topicId ?? null) !== (topicId ?? null)) throw new ValidationError('Ответ должен оставаться в той же теме');
      replyToText = parent ? previewOf(parent.kind, parent.text).slice(0, 140) : null;
      replyToKind = parent?.kind ?? null;
      if (storedKind === 'voice' && parent?.kind === 'voice') voiceThreadRootId = parent.voiceThreadRootId ?? parent._id.toString();
    }

    const newMessage: Omit<MessageDoc, '_id'> = {
      chatId,
      topicId: topicId ?? null,
      authorId: viewerId,
      text: storedText,
      kind: storedKind,
      fileName: fileName ?? null,
      fileSize: fileSize ?? null,
      filePath: filePath ?? null,
      mimeType: mimeType ?? null,
      duration: duration ?? null,
      reaction: null,
      pinned: false,
      editedAt: null,
      replyToId: replyToId ?? null,
      replyToText,
      replyToKind,
      voiceThreadRootId,
      readBy: [viewerId],
      readAt: { [viewerId]: now },
      deliveredTo: [viewerId],
      createdAt: now,
      selfDestructSeconds: selfDestructSeconds ?? null,
      deleteAt: selfDestructSeconds ? null : autoDeleteAt(chat, now),
      linkPreview: null,
      liveLocation: liveLocationMinutes ? { expiresAt: new Date(now.getTime() + liveLocationMinutes * 60_000), updatedAt: now, stoppedAt: null } : null,
      folderTransfer: folderTransferTarget ? { targetUserId: folderTransferTarget, status: 'pending', requestedAt: now, respondedAt: null } : null,
      notificationQueuedAt: now,
    };
    const { insertedId } = await dbMessages.insertOne(newMessage);

    const mentionedIds = await mentionedMemberIds(chat, storedText, viewerId);
    await applyIncomingMessage(chat, viewerId, previewOf(storedKind, storedText), now, mentionedIds);
    void touchLastSeen(viewerId).catch(() => undefined);

    // Slow side effects run after the sender already sees the message.
    void queueMessageNotifications(chat, insertedId, newMessage, previewOf(storedKind, storedText), mentionedIds)
      .catch((error) => console.error('Ошибка постановки уведомления:', error));
    if (hasLink) {
      void linkPreviewFor(storedText)
        .then((preview) => (preview ? dbMessages.updateOne({ _id: insertedId }, { $set: { linkPreview: preview } }) : undefined))
        .catch(() => undefined);
    }
    if (chat.kind === 'direct' && (chat.memberIds ?? []).includes(WYRE_AI_SERVICE_USER_ID)) {
      aiReplyTrigger?.(chat, viewerId);
    }

    // The sender receives the fully serialized copy so the client can swap its
    // optimistic bubble for the real message in one tick, without a flicker.
    const [previous] = await dbMessages.fetch(
      { ...activeMessageFilter(chatId), ...(topicId ? { topicId } : {}), createdAt: { $lt: now } },
      { sort: { createdAt: -1 }, limit: 1 },
    );
    const message = await serializeMessage(
      { ...newMessage, _id: insertedId },
      viewerId,
      profile.usernameLower,
      (chat.memberIds ?? []).length,
      previous ?? undefined,
      false,
      chat.kind === 'group' && ['owner', 'admin'].includes(groupRole(chat, viewerId)),
    );

    return { messageId: insertedId.toString(), message };
  },

  createPoll: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const input = z.object({
      chatId: z.string(),
      topicId: z.string().nullish(),
      question: z.string().trim().min(1, 'Введите вопрос').max(300, 'Вопрос слишком длинный'),
      options: z.array(z.string().trim().min(1, 'Заполните все варианты').max(100, 'Вариант слишком длинный')).min(2).max(10),
      quiz: z.boolean().default(false),
      correctOptionIndex: z.number().int().min(0).max(9).nullish(),
    }).parse(args);
    const normalizedOptions = input.options.map((option) => option.toLocaleLowerCase('ru-RU'));
    if (new Set(normalizedOptions).size !== normalizedOptions.length) throw new ValidationError('Варианты ответа не должны повторяться');
    if (input.quiz && (input.correctOptionIndex == null || input.correctOptionIndex >= input.options.length)) {
      throw new ValidationError('Выберите правильный ответ');
    }

    const chat = await requireMembership(input.chatId, viewerId);
    if (chat.kind !== 'group') throw new ValidationError('Опросы доступны только в группах');
    if (input.topicId) await requireTopic(chat, input.topicId);
    const now = new Date();
    const options = input.options.map((text) => ({ id: new ObjectId().toString(), text, voterIds: [] as string[] }));
    const pollMessage: Omit<MessageDoc, '_id'> = {
      chatId: input.chatId,
      topicId: input.topicId ?? null,
      authorId: viewerId,
      text: input.question,
      kind: 'poll',
      fileName: null,
      fileSize: null,
      filePath: null,
      mimeType: null,
      duration: null,
      reaction: null,
      pinned: false,
      editedAt: null,
      replyToId: null,
      replyToText: null,
      readBy: [viewerId],
      readAt: { [viewerId]: now },
      deliveredTo: [viewerId],
      createdAt: now,
      selfDestructSeconds: null,
      deleteAt: autoDeleteAt(chat, now),
      linkPreview: null,
      poll: {
        question: input.question,
        options,
        quiz: input.quiz,
        correctOptionId: input.quiz ? options[input.correctOptionIndex!].id : null,
        closedAt: null,
      },
      notificationQueuedAt: now,
    };
    const { insertedId } = await dbMessages.insertOne(pollMessage);
    const mentionedIds = await mentionedMemberIds(chat, input.question, viewerId);
    await queueMessageNotifications(chat, insertedId, pollMessage, previewOf('poll', input.question), mentionedIds);
    await applyIncomingMessage(chat, viewerId, previewOf('poll', input.question), now, mentionedIds);
    await touchLastSeen(viewerId);
    return { messageId: insertedId.toString() };
  },

  votePoll: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { messageId, optionId } = z.object({ messageId: z.string(), optionId: z.string() }).parse(args);
    if (!ObjectId.isValid(messageId)) throw new ValidationError('Опрос не найден');
    const message = await dbMessages.findOne({ _id: new ObjectId(messageId) });
    if (!message?.poll || message.kind !== 'poll') throw new ValidationError('Опрос не найден');
    await requireMembership(message.chatId, viewerId);
    if (message.poll.closedAt) throw new ValidationError('Опрос уже закрыт');
    if (!message.poll.options.some((option) => option.id === optionId)) throw new ValidationError('Вариант ответа не найден');

    const result = await dbMessages.native().updateOne(
      { _id: message._id, kind: 'poll', 'poll.closedAt': null },
      [{
        $set: {
          'poll.options': {
            $map: {
              input: '$poll.options',
              as: 'option',
              in: {
                $mergeObjects: [
                  '$$option',
                  {
                    voterIds: {
                      $cond: [
                        { $eq: ['$$option.id', optionId] },
                        {
                          $cond: [
                            { $in: [viewerId, { $ifNull: ['$$option.voterIds', []] }] },
                            { $setDifference: [{ $ifNull: ['$$option.voterIds', []] }, [viewerId]] },
                            { $setUnion: [{ $setDifference: [{ $ifNull: ['$$option.voterIds', []] }, [viewerId]] }, [viewerId]] },
                          ],
                        },
                        { $setDifference: [{ $ifNull: ['$$option.voterIds', []] }, [viewerId]] },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      }],
    );
    if (result.modifiedCount) dbMessages.changed();
    if (!result.modifiedCount) {
      const current = await dbMessages.findOne({ _id: message._id });
      if (current?.poll?.closedAt) throw new ValidationError('Опрос уже закрыт');
    }
    return { ok: true };
  },

  closePoll: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { messageId } = z.object({ messageId: z.string() }).parse(args);
    if (!ObjectId.isValid(messageId)) throw new ValidationError('Опрос не найден');
    const message = await dbMessages.findOne({ _id: new ObjectId(messageId) });
    if (!message?.poll || message.kind !== 'poll') throw new ValidationError('Опрос не найден');
    const chat = await requireMembership(message.chatId, viewerId);
    if (chat.kind !== 'group') throw new ValidationError('Опрос не найден');
    const role = groupRole(chat, viewerId);
    if (message.authorId !== viewerId && role !== 'owner' && role !== 'admin') {
      throw new ValidationError('Недостаточно прав для закрытия опроса');
    }
    await dbMessages.updateOne({ _id: message._id, 'poll.closedAt': null }, { $set: { 'poll.closedAt': new Date() } });
    return { ok: true };
  },

  forwardMessage: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { messageId, targetChatId } = z.object({ messageId: z.string(), targetChatId: z.string() }).parse(args);
    if (!ObjectId.isValid(messageId)) throw new ValidationError('Сообщение не найдено');
    const source = await dbMessages.findOne({ _id: new ObjectId(messageId) });
    if (!source) throw new ValidationError('Сообщение не найдено');
    await requireMembership(source.chatId, viewerId);
    const target = await requireMembership(targetChatId, viewerId);
    const sourceAuthor = ObjectId.isValid(source.authorId)
      ? await dbProfiles.findOne({ userId: new ObjectId(source.authorId) })
      : null;
    const now = new Date();
    const forwardedMessage: Omit<MessageDoc, '_id'> = {
      chatId: targetChatId,
      authorId: viewerId,
      text: source.text,
      kind: source.kind,
      fileName: source.fileName ?? null,
      fileSize: source.fileSize ?? null,
      filePath: source.filePath ?? null,
      mimeType: source.mimeType ?? null,
      duration: source.duration ?? null,
      reaction: null,
      pinned: false,
      editedAt: null,
      replyToId: null,
      replyToText: null,
      readBy: [viewerId],
      readAt: { [viewerId]: now },
      deliveredTo: [viewerId],
      createdAt: now,
      forwardedFromId: source._id.toString(),
      forwardedFromName: sourceAuthor?.name ?? 'Пользователь Wyre',
      selfDestructSeconds: null,
      deleteAt: autoDeleteAt(target, now),
      linkPreview: source.linkPreview ?? null,
      poll: source.poll ? {
        question: source.poll.question,
        options: source.poll.options.map((option) => ({ ...option, voterIds: [] })),
        quiz: source.poll.quiz,
        correctOptionId: source.poll.correctOptionId,
        closedAt: null,
      } : null,
      notificationQueuedAt: now,
    };
    const { insertedId } = await dbMessages.insertOne(forwardedMessage);
    const mentionedIds = await mentionedMemberIds(target, source.text, viewerId);
    await queueMessageNotifications(target, insertedId, forwardedMessage, `↪ ${previewOf(source.kind, source.text)}`, mentionedIds);
    await applyIncomingMessage(target, viewerId, `↪ ${previewOf(source.kind, source.text)}`, now, mentionedIds);
    return { messageId: insertedId.toString() };
  },

  toggleMessageBookmark: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { messageId } = z.object({ messageId: z.string() }).parse(args);
    if (!ObjectId.isValid(messageId)) throw new ValidationError('Сообщение не найдено');
    const message = await dbMessages.findOne({ _id: new ObjectId(messageId) });
    if (!message) throw new ValidationError('Сообщение не найдено');
    await requireMembership(message.chatId, viewerId);
    const existing = await dbMessageBookmarks.findOne({ userId: viewerId, messageId });
    if (existing) {
      await dbMessageBookmarks.deleteOne({ _id: existing._id });
      return { bookmarked: false };
    }
    await dbMessageBookmarks.insertOne({ userId: viewerId, messageId, createdAt: new Date() });
    return { bookmarked: true };
  },

  editMessage: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { messageId, text } = z
      .object({ messageId: z.string(), text: z.string().min(1).max(4000) })
      .parse(args);

    if (!ObjectId.isValid(messageId)) throw new ValidationError('Сообщение не найдено');
    const message = await dbMessages.findOne({ _id: new ObjectId(messageId) });
    if (!message || message.authorId !== viewerId) throw new ValidationError('Сообщение не найдено');
    if (message.kind !== 'text' && message.kind !== 'link') throw new ValidationError('Этот тип сообщения нельзя редактировать');

    await dbMessages.updateOne(
      { _id: message._id },
      { $set: { text: text.trim(), editedAt: new Date() } }
    );

    const chat = await dbChats.findOne({ _id: new ObjectId(message.chatId) });
    if (chat && chat.lastMessageAuthorId === viewerId) {
      await dbChats.updateOne({ _id: chat._id }, { $set: { lastMessageText: text.trim() } });
    }
    return { ok: true };
  },

  deleteMessage: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { messageId } = z.object({ messageId: z.string() }).parse(args);

    if (!ObjectId.isValid(messageId)) throw new ValidationError('Сообщение не найдено');
    const message = await dbMessages.findOne({ _id: new ObjectId(messageId) });
    if (!message || message.authorId !== viewerId) throw new ValidationError('Сообщение не найдено');

    await dbMessages.deleteOne({ _id: message._id });

    const [latest] = await dbMessages.fetch(activeMessageFilter(message.chatId), { sort: { createdAt: -1 }, limit: 1 });
    await dbChats.updateOne(
      { _id: new ObjectId(message.chatId) },
      {
        $set: {
          lastMessageText: latest ? previewOf(latest.kind, latest.text) : '',
          lastMessageAuthorId: latest ? latest.authorId : null,
        },
      }
    );
    return { ok: true };
  },

  reactToMessage: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { messageId, emoji } = z
      .object({ messageId: z.string(), emoji: z.string().max(8).nullable() })
      .parse(args);

    if (!ObjectId.isValid(messageId)) throw new ValidationError('Сообщение не найдено');
    const message = await dbMessages.findOne({ _id: new ObjectId(messageId) });
    if (!message) throw new ValidationError('Сообщение не найдено');
    await requireMembership(message.chatId, viewerId);

    const next = message.reaction === emoji ? null : emoji;
    await dbMessages.updateOne({ _id: message._id }, { $set: { reaction: next } });
    return { reaction: next };
  },

  pinMessage: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { messageId } = z.object({ messageId: z.string() }).parse(args);

    if (!ObjectId.isValid(messageId)) throw new ValidationError('Сообщение не найдено');
    const message = await dbMessages.findOne({ _id: new ObjectId(messageId) });
    if (!message) throw new ValidationError('Сообщение не найдено');
    await requireMembership(message.chatId, viewerId);

    const pinned = !message.pinned;
    await dbMessages.updateMany({ chatId: message.chatId, pinned: true }, { $set: { pinned: false } });
    if (pinned) await dbMessages.updateOne({ _id: message._id }, { $set: { pinned: true } });
    return { pinned };
  },

  /** Marks the whole chat as read for the caller and resets their counter. */
  markChatRead: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId, topicId } = z.object({ chatId: z.string(), topicId: z.string().optional() }).parse(args);
    const chat = await requireMembership(chatId, viewerId);
    if (topicId) await requireTopic(chat, topicId, true);

    const now = new Date();
    const selfDestructing = await dbMessages.fetch({
      chatId,
      ...(topicId ? { topicId } : {}),
      authorId: { $ne: viewerId },
      readBy: { $ne: viewerId },
      selfDestructSeconds: { $gte: 5 },
      $or: [{ deleteAt: null }, { deleteAt: { $exists: false } }],
    }, { limit: 500 });
    if (selfDestructing.length) {
      const result = await dbMessages.native().bulkWrite(selfDestructing.map((message) => ({
        updateOne: {
          filter: { _id: message._id, $or: [{ deleteAt: null }, { deleteAt: { $exists: false } }] },
          update: { $set: { deleteAt: new Date(now.getTime() + (message.selfDestructSeconds ?? 5) * 1000) } },
        },
      })));
      if (result.modifiedCount) dbMessages.changed();
    }
    await dbMessages.updateMany(
      { chatId, ...(topicId ? { topicId } : {}), authorId: { $ne: viewerId }, readBy: { $ne: viewerId } },
      { $addToSet: { readBy: viewerId, deliveredTo: viewerId }, $set: { [`readAt.${viewerId}`]: now } }
    );

    const remainingUnread = topicId ? await dbMessages.countDocuments({
      ...activeMessageFilter(chatId),
      authorId: { $ne: viewerId },
      readBy: { $ne: viewerId },
    }) : 0;
    await updateMemberState(chat, viewerId, topicId
      ? { unread: remainingUnread, lastReadAt: now, [`topicReads.${topicId}`]: now }
      : { unread: 0, unreadMentions: 0, lastReadAt: now }, { silent: true });
    await touchLastSeen(viewerId);
    return { ok: true };
  },

  /** Refreshed by the composer while the user is actively typing. */
  setTyping: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId, typing } = z.object({ chatId: z.string(), typing: z.boolean() }).parse(args);
    const chat = await requireMembership(chatId, viewerId);

    // Silent write + a targeted push to the other members: a global broadcast
    // here used to refetch every open query on every keystroke.
    await updateMemberState(chat, viewerId, {
      typingAt: typing ? new Date() : null,
      activity: typing ? 'typing' : null,
      activityAt: typing ? new Date() : null,
    }, { silent: true });
    for (const memberId of (chat.memberIds ?? []).filter((id) => id !== viewerId)) {
      presenceEmitter?.(memberId, { type: 'typing', chatId, userId: viewerId, typing });
    }
    return { ok: true };
  },

  /** Presence state used while recording a voice/video message. */
  setActivity: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId, activity } = z.object({
      chatId: z.string(),
      activity: z.enum(['typing', 'recording_voice', 'recording_video']).nullable(),
    }).parse(args);
    const chat = await requireMembership(chatId, viewerId);
    await updateMemberState(chat, viewerId, {
      activity,
      activityAt: activity ? new Date() : null,
      typingAt: activity === 'typing' ? new Date() : null,
    }, { silent: true });
    for (const memberId of (chat.memberIds ?? []).filter((id) => id !== viewerId)) {
      presenceEmitter?.(memberId, { type: 'activity', chatId, userId: viewerId, activity });
    }
    return { ok: true };
  },

  togglePinChat: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId } = z.object({ chatId: z.string() }).parse(args);
    const chat = await requireMembership(chatId, viewerId);

    await updateMemberState(chat, viewerId, { pinned: !memberStateOf(chat, viewerId)?.pinned });
    return { ok: true };
  },

  toggleMuteChat: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId } = z.object({ chatId: z.string() }).parse(args);
    const chat = await requireMembership(chatId, viewerId);

    const current = memberStateOf(chat, viewerId);
    const muted = (current?.notificationMode ?? (current?.muted ? 'none' : 'all')) !== 'none';
    await updateMemberState(chat, viewerId, { muted, notificationMode: muted ? 'none' : 'all', mutedUntil: null });
    return { ok: true };
  },

  summarizeChat: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId, topicId } = z.object({ chatId: z.string(), topicId: z.string().nullish() }).parse(args);
    const chat = await requireMembership(chatId, viewerId);
    const current = memberStateOf(chat, viewerId);
    const cursor = topicId ? current?.aiSummaryAtByTopic?.[topicId] : current?.aiSummaryAt ?? undefined;
    const context = await aiMessageContext(chat, viewerId, topicId, 100, cursor ? new Date(cursor) : undefined);
    if (!context.length) return { summary: 'Новых сообщений для суммаризации нет.', messageCount: 0 };
    const summary = await summarizeConversation(context.map(({ id, author, text, time }) => ({ id, author, text, time })));
    const summarizedAt = context.at(-1)!.createdAt;
    await updateMemberState(chat, viewerId, topicId
      ? { [`aiSummaryAtByTopic.${topicId}`]: summarizedAt }
      : { aiSummaryAt: summarizedAt });
    return { summary, messageCount: context.length };
  },

  semanticSearchMessages: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId, topicId, query } = z.object({
      chatId: z.string(),
      topicId: z.string().nullish(),
      query: z.string().trim().min(2).max(200),
    }).parse(args);
    const chat = await requireMembership(chatId, viewerId);
    const context = await aiMessageContext(chat, viewerId, topicId, 200);
    if (!context.length) return { results: [] };
    const ids = await semanticMessageIds(query, context.map(({ id, author, text, time }) => ({ id, author, text, time })));
    const byId = new Map(context.map((message) => [message.id, message]));
    return {
      results: ids.flatMap((id) => {
        const message = byId.get(id);
        return message ? [{ id, author: message.author, text: message.text, time: formatTime(message.createdAt) }] : [];
      }),
    };
  },

  suggestChatReplies: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId, topicId } = z.object({ chatId: z.string(), topicId: z.string().nullish() }).parse(args);
    const chat = await requireMembership(chatId, viewerId);
    const context = await aiMessageContext(chat, viewerId, topicId, 20);
    if (!context.length) return { replies: [] };
    const replies = await suggestShortReplies(context.map(({ author, text, time }) => ({ author, text, time })));
    return { replies };
  },

  transcribeVoiceMessage: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { messageId } = z.object({ messageId: z.string() }).parse(args);
    if (!ObjectId.isValid(messageId)) throw new ValidationError('Голосовое сообщение не найдено');
    const message = await dbMessages.findOne({ _id: new ObjectId(messageId) });
    if (!message || message.kind !== 'voice' || !message.filePath) throw new ValidationError('Голосовое сообщение не найдено');
    await requireMembership(message.chatId, viewerId);
    if (message.transcription) return { transcription: message.transcription };
    const transcription = await transcribeStoredAudio(
      message.filePath,
      message.mimeType ?? 'audio/webm',
      message.fileName ?? 'voice-message.webm',
    );
    await dbMessages.updateOne({ _id: message._id, transcription: { $in: [null, ''] } }, { $set: { transcription, transcribedAt: new Date() } });
    return { transcription };
  },

  translateMessage: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { messageId, targetLanguage } = z.object({
      messageId: z.string(),
      targetLanguage: z.string().regex(/^[a-z]{2}$/).default('ru'),
    }).parse(args);
    if (!ObjectId.isValid(messageId)) throw new ValidationError('Сообщение не найдено');
    const message = await dbMessages.findOne({ _id: new ObjectId(messageId) });
    if (!message) throw new ValidationError('Сообщение не найдено');
    await requireMembership(message.chatId, viewerId);
    const cached = message.translations?.[targetLanguage];
    if (cached) return { translation: cached, targetLanguage };
    const source = message.kind === 'voice' ? message.transcription?.trim() : message.text.trim();
    if (!source || ['contact', 'location', 'poll', 'sticker'].includes(message.kind)) throw new ValidationError('Этот тип сообщения нельзя перевести');
    const translation = await translateText(source, targetLanguage);
    await dbMessages.updateOne({ _id: message._id }, { $set: { [`translations.${targetLanguage}`]: translation } });
    return { translation, targetLanguage };
  },

  updateLiveLocation: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { messageId, latitude, longitude, accuracy } = z.object({
      messageId: z.string(),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      accuracy: z.number().min(0).max(100_000).optional(),
    }).parse(args);
    if (!ObjectId.isValid(messageId)) throw new ValidationError('Трансляция геопозиции не найдена');
    const message = await dbMessages.findOne({ _id: new ObjectId(messageId) });
    if (!message || message.kind !== 'location' || message.authorId !== viewerId || !message.liveLocation) throw new ValidationError('Трансляция геопозиции не найдена');
    await requireMembership(message.chatId, viewerId);
    if (message.liveLocation.stoppedAt || message.liveLocation.expiresAt.getTime() <= Date.now()) throw new ValidationError('Трансляция геопозиции завершена');
    const now = new Date();
    await dbMessages.updateOne({ _id: message._id, 'liveLocation.stoppedAt': null, 'liveLocation.expiresAt': { $gt: now } }, { $set: { text: JSON.stringify({ latitude, longitude, accuracy }), 'liveLocation.updatedAt': now } });
    return { updatedAt: now.toISOString() };
  },

  stopLiveLocation: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { messageId } = z.object({ messageId: z.string() }).parse(args);
    if (!ObjectId.isValid(messageId)) throw new ValidationError('Трансляция геопозиции не найдена');
    const message = await dbMessages.findOne({ _id: new ObjectId(messageId) });
    if (!message || message.kind !== 'location' || message.authorId !== viewerId || !message.liveLocation) throw new ValidationError('Трансляция геопозиции не найдена');
    await requireMembership(message.chatId, viewerId);
    await dbMessages.updateOne({ _id: message._id, 'liveLocation.stoppedAt': null }, { $set: { 'liveLocation.stoppedAt': new Date() } });
    return { stopped: true };
  },

  respondFolderTransfer: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { messageId, status } = z.object({ messageId: z.string(), status: z.enum(['accepted', 'completed', 'declined']) }).parse(args);
    if (!ObjectId.isValid(messageId)) throw new ValidationError('Запрос передачи не найден');
    const message = await dbMessages.findOne({ _id: new ObjectId(messageId) });
    if (!message?.folderTransfer || message.folderTransfer.targetUserId !== viewerId) throw new ValidationError('Запрос передачи не найден');
    await requireMembership(message.chatId, viewerId);
    const current = message.folderTransfer.status;
    if ((status === 'accepted' || status === 'declined') && current !== 'pending') throw new ValidationError('Запрос уже обработан');
    if (status === 'completed' && current !== 'accepted') throw new ValidationError('Сначала разрешите передачу');
    const result = await dbMessages.updateOne({ _id: message._id, 'folderTransfer.status': current }, { $set: { 'folderTransfer.status': status, 'folderTransfer.respondedAt': new Date() } });
    if (!result.matchedCount) throw new ValidationError('Запрос уже обработан');
    return { status };
  },
  updateChatNotifications: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId, mode, mutedUntil } = z.object({
      chatId: z.string(),
      mode: z.enum(['all', 'mentions', 'none']),
      mutedUntil: z.coerce.date().nullable().optional(),
    }).parse(args);
    const chat = await requireMembership(chatId, viewerId);
    if (mutedUntil && (mutedUntil.getTime() <= Date.now() || mutedUntil.getTime() > Date.now() + 366 * 24 * 60 * 60 * 1000)) {
      throw new ValidationError('Срок mute должен быть от минуты до года');
    }
    await updateMemberState(chat, viewerId, { notificationMode: mode, muted: mode === 'none', mutedUntil: mutedUntil ?? null });
    return { mode, mutedUntil: mutedUntil ?? null };
  },
};
