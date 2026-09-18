import z from 'zod';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { ObjectId } from '../core/database';
import { env } from '../core/env';
import { ValidationError } from '../core/errors';
import { LiveData } from '../core/liveData';
import { dbSessions } from '../core/authDb';
import type { UserInfo } from '../core/types';

import { WYRE_AI_SERVICE_USER_ID, WYRE_SERVICE_USER_ID, dbCallControlEvents, dbCallInvites, dbCalls, dbCallSignals, dbChats, dbProfiles } from './db';
import { sendFcmToUser } from './fcm';
import { initialsFrom, paletteFor, requireNotBlocked, requirePrivacyAction, requireVerifiedProfile } from './profile';

/** P2P mesh gets expensive fast — 4 participants is the hard product limit. */
export const MAX_CALL_PARTICIPANTS = 4;
/** An unanswered call stops ringing after this long. */
const RING_TIMEOUT_MS = 60 * 1000;
/** Joined clients ping every ~10s; miss this window and we assume they crashed. */
const STALE_PING_MS = 45 * 1000;
const CALL_INVITE_TTL_MS = 30 * 60 * 1000;

/**
 * Remote-control pointer/key events are delivered straight to the target's
 * sockets through this emitter. Writing them to MongoDB stays as a durable
 * backup, but the inserts are silent: a global broadcast per mouse move would
 * flood every connected client with refetches.
 */
type CallControlEmit = (payload: { id: string; type: string; x: number | null; y: number | null; button: number | null; key: string | null }, targetUserId: string) => void;
let callControlEmitter: CallControlEmit | null = null;
export function setCallControlEmitter(emit: CallControlEmit) {
  callControlEmitter = emit;
}

type CallDoc = NonNullable<Awaited<ReturnType<typeof dbCalls.findOne>>>;
type ProfileDoc = NonNullable<Awaited<ReturnType<typeof dbProfiles.findOne>>>;

function participantOf(call: CallDoc, userId: string) {
  return (call.participants ?? []).find((p) => p.userId === userId);
}

function joinedIds(call: CallDoc) {
  return (call.participants ?? []).filter((p) => p.state === 'joined').map((p) => p.userId);
}

async function requireJoinedCall(callId: string, userId: string) {
  const call = await requireCallMembership(callId, userId);
  if (call.status !== 'active' || participantOf(call, userId)?.state !== 'joined') throw new ValidationError('Сначала подключитесь к звонку');
  return call;
}

function inviteTokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function remoteControlCode(callId: string, userId: string) {
  const digest = createHmac('sha256', env.SESSION_SECRET).update(`remote-control:${callId}:${userId}`).digest();
  return String(digest.readUInt32BE(0) % 100_000_000).padStart(8, '0');
}

/** Device (browser/app install) behind the caller's current session, if any. */
async function sessionDeviceId(tokenHash: string | undefined): Promise<string | null> {
  if (!tokenHash) return null;
  const session = await dbSessions.findOne({ tokenHash });
  return session?.deviceId ? session.deviceId.toString() : null;
}

async function endCall(callId: ObjectId, reason: 'hangup' | 'declined' | 'missed' | 'stale' | 'failed') {
  await dbCalls.updateOne(
    { _id: callId, status: { $ne: 'ended' } },
    { $set: { status: 'ended', endedAt: new Date(), endReason: reason } }
  );
}

/**
 * Lazily garbage-collects a call that nobody is really in any more:
 * unanswered ringing calls, and active calls whose participants stopped
 * pinging (closed tab / lost device). Returns null when the call is dead.
 */
async function reapIfDead(call: CallDoc): Promise<CallDoc | null> {
  const now = Date.now();

  if (call.status === 'ringing') {
    if (now - new Date(call.createdAt).getTime() > RING_TIMEOUT_MS) {
      await endCall(call._id, 'missed');
      return null;
    }
    return call;
  }

  if (call.status === 'active') {
    const isAlive = (p: CallDoc['participants'][number]) =>
      Boolean(p.lastPingAt) && now - new Date(p.lastPingAt as Date).getTime() < STALE_PING_MS;

    const stale = (call.participants ?? []).filter((p) => p.state === 'joined' && !isAlive(p));
    if (stale.length === 0) return call;

    // Drop the clients that vanished without hanging up (crashed tab, dead
    // device) rather than keeping ghost tiles on everyone else's screen.
    const participants = (call.participants ?? []).map((p) =>
      p.state === 'joined' && !isAlive(p) ? { ...p, state: 'left' as const, leftAt: new Date(now) } : p
    );
    const remaining = participants.filter((p) => p.state === 'joined' || p.state === 'invited');
    if (remaining.length < 2) {
      await endCall(call._id, 'stale');
      return null;
    }
    await dbCalls.updateOne({ _id: call._id }, { $set: { participants } });
    return { ...call, participants } as CallDoc;
  }

  return null;
}

/** ISO timestamp of the moment the second participant joined, or null. */
function startedAtOf(call: CallDoc): string | null {
  const times = (call.participants ?? [])
    .filter((p) => p.state === 'joined' && p.joinedAt)
    .map((p) => new Date(p.joinedAt as Date).getTime())
    .sort((a, b) => a - b);
  return times.length >= 2 ? new Date(times[1]).toISOString() : null;
}

async function serializeCall(call: CallDoc, viewerId: string, viewerDeviceId?: string | null) {
  const profiles = await dbProfiles.fetch({
    userId: { $in: (call.memberIds ?? []).map((id) => new ObjectId(id)) },
  });
  const byId = new Map<string, ProfileDoc>(profiles.map((p) => [p.userId.toString(), p]));

  const chat = ObjectId.isValid(call.chatId) ? await dbChats.findOne({ _id: new ObjectId(call.chatId) }) : null;
  const isGroup = chat?.kind === 'group';

  const participants = (call.participants ?? []).map((p) => {
    const profile = byId.get(p.userId);
    return {
      userId: p.userId,
      state: p.state,
      name: profile?.name ?? 'Участник',
      username: profile?.username ?? '',
      initials: profile?.initials ?? '??',
      colors: [profile?.colors?.[0] ?? '#8b5cf6', profile?.colors?.[1] ?? '#2563eb'] as [string, string],
      badge: profile?.badge ?? undefined,
      warnings: (profile?.warnings ?? []).map((warning) => ({ reason: warning.reason, date: new Date(warning.issuedAt).toLocaleDateString('ru-RU') })),
    };
  });

  const mine = participantOf(call, viewerId);
  const initiator = byId.get(call.initiatorId);

  // Multi-device: only the device that actually accepted shows the call UI.
  // Old calls without the field keep the previous behaviour on every device.
  const joinedByThisDevice = mine?.state === 'joined'
    ? !mine.joinedDeviceId || !viewerDeviceId || mine.joinedDeviceId === viewerDeviceId
    : false;

  const title = isGroup
    ? chat?.title ?? 'Групповой звонок'
    : participants.find((p) => p.userId !== viewerId)?.name ?? 'Звонок';

  return {
    callId: call._id.toString(),
    chatId: call.chatId,
    kind: call.kind,
    status: call.status,
    group: isGroup,
    title,
    initials: isGroup ? initialsFrom(title) : participants.find((p) => p.userId !== viewerId)?.initials ?? '??',
    colors: isGroup
      ? paletteFor(call.chatId)
      : participants.find((p) => p.userId !== viewerId)?.colors ?? (['#8b5cf6', '#2563eb'] as [string, string]),
    badge: isGroup ? undefined : participants.find((p) => p.userId !== viewerId)?.badge,
    warnings: isGroup ? [] : participants.find((p) => p.userId !== viewerId)?.warnings ?? [],
    initiatorId: call.initiatorId,
    initiatorName: initiator?.name ?? 'Кто-то',
    isInitiator: call.initiatorId === viewerId,
    myState: mine?.state ?? 'invited',
    /** False on the devices of the same account that did not accept the call. */
    joinedByThisDevice,
    // The call "starts" when the *second* person joins — before that the
    // initiator is just listening to the ringback, and the timer must not run.
    startedAt: startedAtOf(call),
    participants,
    /** Peers this client should hold a RTCPeerConnection with, right now. */
    peers: joinedIds(call).filter((id) => id !== viewerId),
    remoteControlCode: remoteControlCode(call._id.toString(), viewerId),
    remoteControl: call.remoteControl ? {
      sessionId: call.remoteControl.sessionId,
      status: call.remoteControl.status,
      controllerId: call.remoteControl.controllerId,
      targetId: call.remoteControl.targetId,
      isController: call.remoteControl.controllerId === viewerId,
      isTarget: call.remoteControl.targetId === viewerId,
      controllerName: participants.find((participant) => participant.userId === call.remoteControl?.controllerId)?.name ?? 'Участник',
      targetName: participants.find((participant) => participant.userId === call.remoteControl?.targetId)?.name ?? 'Участник',
    } : null,
  };
}

async function currentCallFor(viewerId: string, viewerDeviceId?: string | null) {
  const calls = await dbCalls.fetch(
    { memberIds: viewerId, status: { $in: ['ringing', 'active'] } },
    { sort: { createdAt: -1 }, limit: 5 }
  );

  for (const call of calls) {
    const mine = participantOf(call, viewerId);
    // Ignore calls this user already walked away from.
    if (mine && (mine.state === 'left' || mine.state === 'declined')) continue;
    const alive = await reapIfDead(call);
    if (alive) return serializeCall(alive, viewerId, viewerDeviceId);
  }
  return null;
}

export type CallState = Awaited<ReturnType<typeof serializeCall>>;

async function requireCallMembership(callId: string, userId: string) {
  if (!ObjectId.isValid(callId)) throw new ValidationError('Звонок не найден');
  const call = await dbCalls.findOne({ _id: new ObjectId(callId) });
  if (!call || !(call.memberIds ?? []).includes(userId)) throw new ValidationError('Звонок не найден');
  return call;
}

/**
 * Marks one participant as joined without rewriting the whole `participants`
 * array, so two people accepting at the same moment cannot drop each other.
 * `deviceId` records WHICH device accepted, so the account's other devices
 * stop showing the call screen.
 */
async function markParticipantJoined(callId: ObjectId, userId: string, now: Date, deviceId?: string | null) {
  const result = await dbCalls.updateOne(
    { _id: callId, status: { $in: ['ringing', 'active'] }, participants: { $elemMatch: { userId, state: 'invited' } } },
    {
      $set: {
        status: 'active',
        'participants.$[self].state': 'joined',
        'participants.$[self].leftAt': null,
        'participants.$[self].lastPingAt': now,
        'participants.$[self].joinedDeviceId': deviceId ?? null,
      },
    },
    { arrayFilters: [{ 'self.userId': userId }] },
  );
  if (!result.matchedCount) throw new ValidationError('Звонок уже завершён или вы уже вышли из него');
  // `joinedAt` must survive a rejoin, so it is only set when still empty.
  await dbCalls.updateOne(
    { _id: callId },
    { $set: { 'participants.$[fresh].joinedAt': now } },
    { arrayFilters: [{ 'fresh.userId': userId, 'fresh.joinedAt': null }] },
  );
}

export const callQueries = {
  /**
   * The caller's single current call (ringing or active), pushed live.
   * Mounted once at the app root so an incoming call rings from anywhere.
   */
  callState: async (_args: unknown, { user, sessionTokenHash }: { user: UserInfo | null; sessionTokenHash?: string }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const viewerDeviceId = await sessionDeviceId(sessionTokenHash);

    return new LiveData({
      fetch: async () => currentCallFor(viewerId, viewerDeviceId),
      watch: ({ publish }) => {
        const stream = dbCalls.watch();
        stream.on('change', () => publish());
        return () => stream.close();
      },
    });
  },

  /** Inbox of WebRTC signaling envelopes addressed to the caller. */
  callSignals: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { callId } = z.object({ callId: z.string() }).parse(args);
    await requireCallMembership(callId, viewerId);

    return new LiveData({
      fetch: async () => {
        const signals = await dbCallSignals.fetch(
          { callId, toUserId: viewerId },
          { sort: { createdAt: 1 }, limit: 400 }
        );
        return signals.map((signal) => ({
          id: signal._id.toString(),
          from: signal.fromUserId,
          type: signal.type,
          payload: signal.payload,
        }));
      },
      watch: ({ publish }) => {
        const stream = dbCallSignals.watch([
          { $match: { 'fullDocument.callId': callId, 'fullDocument.toUserId': viewerId } },
        ]);
        stream.on('change', () => publish());
        return () => stream.close();
      },
    });
  },

  remoteControlEvents: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { callId } = z.object({ callId: z.string() }).parse(args);
    const call = await requireJoinedCall(callId, viewerId);
    if (call.remoteControl?.status !== 'active' || call.remoteControl.targetId !== viewerId) throw new ValidationError('Активный сеанс управления не найден');
    const sessionId = call.remoteControl.sessionId;
    return new LiveData({
      fetch: async () => {
        const events = await dbCallControlEvents.fetch({ callId, sessionId, targetId: viewerId }, { sort: { createdAt: 1 }, limit: 200 });
        return events.map((event) => ({ id: event._id.toString(), type: event.type, x: event.x, y: event.y, button: event.button, key: event.key }));
      },
      watch: ({ publish }) => {
        const stream = dbCallControlEvents.watch([{ $match: { 'fullDocument.callId': callId, 'fullDocument.sessionId': sessionId, 'fullDocument.targetId': viewerId } }]);
        stream.on('change', () => publish());
        return () => stream.close();
      },
    });
  },

  /**
   * ICE server list. Google's public STUN always works; TURN is only returned
   * once the three `wyre.turnServer*` configs are filled in (see
   * CONFIG_REFERENCE.md) and is what makes calls survive symmetric NAT.
   */
  iceServers: async (_args: unknown, { user }: { user: UserInfo | null }) => {
    await requireVerifiedProfile(user);

    const iceServers: { urls: string | string[]; username?: string; credential?: string }[] = [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    ];

    const turnUrl = env.TURN_SERVER_URL.trim();
    const turnUsername = env.TURN_SERVER_USERNAME.trim();
    const turnCredential = env.TURN_SERVER_CREDENTIAL.trim();

    if (turnUrl) {
      iceServers.push({
        urls: turnUrl.split(',').map((part) => part.trim()).filter(Boolean),
        ...(turnUsername ? { username: turnUsername } : {}),
        ...(turnCredential ? { credential: turnCredential } : {}),
      });
    }

    return { iceServers, hasTurn: Boolean(turnUrl) };
  },
};

export const callMutations = {
  requestRemoteControl: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { callId, code } = z.object({ callId: z.string(), code: z.string().regex(/^\d{8}$/) }).parse(args);
    const call = await requireJoinedCall(callId, viewerId);
    if (call.remoteControl && ['pending', 'active'].includes(call.remoteControl.status)) throw new ValidationError('В звонке уже есть запрос управления');
    const target = (call.participants ?? []).find((participant) => participant.userId !== viewerId && participant.state === 'joined' && remoteControlCode(callId, participant.userId) === code);
    if (!target) throw new ValidationError('Код участника не найден');
    const now = new Date();
    const remoteControl = { sessionId: new ObjectId().toString(), controllerId: viewerId, targetId: target.userId, status: 'pending' as const, requestedAt: now, respondedAt: null, endedAt: null };
    const result = await dbCalls.updateOne({ _id: call._id, status: 'active', 'remoteControl.status': { $nin: ['pending', 'active'] } }, { $set: { remoteControl } });
    if (!result.matchedCount) throw new ValidationError('В звонке уже есть запрос управления');
    return { requested: true };
  },

  respondRemoteControl: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { callId, accept } = z.object({ callId: z.string(), accept: z.boolean() }).parse(args);
    const call = await requireJoinedCall(callId, viewerId);
    if (call.remoteControl?.status !== 'pending' || call.remoteControl.targetId !== viewerId) throw new ValidationError('Запрос управления не найден');
    const now = new Date();
    const status = accept ? 'active' as const : 'declined' as const;
    const result = await dbCalls.updateOne({ _id: call._id, 'remoteControl.sessionId': call.remoteControl.sessionId, 'remoteControl.status': 'pending' }, { $set: { 'remoteControl.status': status, 'remoteControl.respondedAt': now, 'remoteControl.endedAt': accept ? null : now } });
    if (!result.matchedCount) throw new ValidationError('Запрос управления уже обработан');
    return { status };
  },

  stopRemoteControl: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { callId } = z.object({ callId: z.string() }).parse(args);
    const call = await requireJoinedCall(callId, viewerId);
    const control = call.remoteControl;
    if (!control || !['pending', 'active'].includes(control.status) || ![control.controllerId, control.targetId].includes(viewerId)) throw new ValidationError('Активный сеанс управления не найден');
    const result = await dbCalls.updateOne({ _id: call._id, 'remoteControl.sessionId': control.sessionId, 'remoteControl.status': { $in: ['pending', 'active'] } }, { $set: { 'remoteControl.status': 'ended', 'remoteControl.endedAt': new Date() } });
    if (!result.matchedCount) throw new ValidationError('Сеанс управления уже завершён');
    await dbCallControlEvents.deleteMany({ callId, sessionId: control.sessionId });
    return { stopped: true };
  },

  sendRemoteControlEvent: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const input = z.object({
      callId: z.string(),
      type: z.enum(['pointer_move', 'pointer_down', 'pointer_up', 'key_down']),
      x: z.number().min(0).max(1).nullish(),
      y: z.number().min(0).max(1).nullish(),
      button: z.number().int().min(0).max(2).nullish(),
      key: z.string().min(1).max(32).nullish(),
    }).parse(args);
    const call = await requireJoinedCall(input.callId, viewerId);
    const control = call.remoteControl;
    if (control?.status !== 'active' || control.controllerId !== viewerId) throw new ValidationError('Нет разрешения на управление');
    if (input.type.startsWith('pointer_') && (input.x == null || input.y == null)) throw new ValidationError('Не указана позиция указателя');
    if (input.type === 'key_down' && !input.key) throw new ValidationError('Не указана клавиша');
    if (await dbCallControlEvents.countDocuments({ callId: input.callId, controllerId: viewerId, createdAt: { $gt: new Date(Date.now() - 1000) } }) >= 120) throw new ValidationError('Слишком много команд управления');
    const { insertedId } = await dbCallControlEvents.insertOneSilent({ callId: input.callId, sessionId: control.sessionId, controllerId: viewerId, targetId: control.targetId, type: input.type, x: input.x ?? null, y: input.y ?? null, button: input.button ?? null, key: input.key ?? null, createdAt: new Date() });
    const event = { id: insertedId.toString(), type: input.type, x: input.x ?? null, y: input.y ?? null, button: input.button ?? null, key: input.key ?? null };
    callControlEmitter?.(event, control.targetId);
    return { eventId: event.id };
  },

  createCallInvite: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { callId } = z.object({ callId: z.string() }).parse(args);
    const call = await requireCallMembership(callId, viewerId);
    if (call.status === 'ended') throw new ValidationError('Звонок уже завершён');
    const chat = ObjectId.isValid(call.chatId) ? await dbChats.findOne({ _id: new ObjectId(call.chatId) }) : null;
    if (chat?.kind !== 'group') throw new ValidationError('Ссылка доступна только для группового звонка');
    if (participantOf(call, viewerId)?.state !== 'joined') throw new ValidationError('Сначала присоединитесь к звонку');

    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    await dbCallInvites.deleteMany({ callId });
    await dbCallInvites.insertOne({
      callId,
      tokenHash: inviteTokenHash(token),
      createdBy: viewerId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + CALL_INVITE_TTL_MS),
    });
    const url = new URL(env.SITE_URL);
    url.searchParams.set('callInvite', token);
    return { url: url.toString(), expiresAt: new Date(now.getTime() + CALL_INVITE_TTL_MS).toISOString() };
  },

  joinCallInvite: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { token } = z.object({ token: z.string().min(20).max(200) }).parse(args);
    const invite = await dbCallInvites.findOne({ tokenHash: inviteTokenHash(token), expiresAt: { $gt: new Date() } });
    if (!invite || !ObjectId.isValid(invite.callId)) throw new ValidationError('Ссылка недействительна или истекла');
    const call = await dbCalls.findOne({ _id: new ObjectId(invite.callId) });
    if (!call || call.status === 'ended') throw new ValidationError('Звонок уже завершён');
    await requireNotBlocked(viewerId, call.initiatorId);

    const existing = participantOf(call, viewerId);
    if (existing) {
      if (existing.state !== 'joined') {
        const participants = call.participants.map((participant) => participant.userId === viewerId
          ? { ...participant, state: 'invited' as const, leftAt: null }
          : participant);
        await dbCalls.updateOne({ _id: call._id, status: { $ne: 'ended' } }, { $set: { participants } });
      }
      return { callId: call._id.toString() };
    }

    const result = await dbCalls.updateOne(
      { _id: call._id, status: { $ne: 'ended' }, memberIds: { $ne: viewerId }, 'memberIds.3': { $exists: false } },
      {
        $push: {
          memberIds: viewerId,
          participants: { userId: viewerId, state: 'invited', joinedAt: null, leftAt: null, lastPingAt: null },
        },
        $set: { status: call.status === 'ringing' ? 'ringing' : 'active' },
      },
    );
    if (!result.modifiedCount) throw new ValidationError('В звонке уже максимум участников');
    return { callId: call._id.toString() };
  },

  /** Rings every other member of the chat (mesh-capped at 4 people). */
  startCall: async (args: unknown, { user, sessionTokenHash }: { user: UserInfo | null; sessionTokenHash?: string }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { chatId, kind } = z
      .object({ chatId: z.string(), kind: z.enum(['audio', 'video']).default('video') })
      .parse(args);

    if (!ObjectId.isValid(chatId)) throw new ValidationError('Чат не найден');
    const chat = await dbChats.findOne({ _id: new ObjectId(chatId) });
    if (!chat || !(chat.memberIds ?? []).includes(viewerId)) throw new ValidationError('Чат не найден');
    if ((chat.memberIds ?? []).some((id) => id === WYRE_SERVICE_USER_ID || id === WYRE_AI_SERVICE_USER_ID)) {
      throw new ValidationError('Сервисные аккаунты не поддерживают звонки');
    }
    if (chat.kind === 'direct') {
      const peerId = chat.memberIds.find((id) => id !== viewerId);
      if (peerId) await requireNotBlocked(viewerId, peerId);
    }

    const memberIds = chat.memberIds ?? [];
    for (const targetId of memberIds.filter((id) => id !== viewerId)) await requirePrivacyAction(targetId, viewerId, 'call');
    if (memberIds.length < 2) throw new ValidationError('Некому звонить');
    if (memberIds.length > MAX_CALL_PARTICIPANTS) {
      throw new ValidationError(`В звонке может быть не больше ${MAX_CALL_PARTICIPANTS} участников`);
    }

    // Reuse a call that is already up in this chat instead of starting a second one.
    const [existing] = await dbCalls.fetch(
      { chatId, status: { $in: ['ringing', 'active'] } },
      { sort: { createdAt: -1 }, limit: 1 }
    );
    const deviceId = await sessionDeviceId(sessionTokenHash);
    if (existing && (await reapIfDead(existing))) {
      await markParticipantJoined(existing._id, viewerId, new Date(), deviceId);
      return { callId: existing._id.toString() };
    }

    const now = new Date();
    const { insertedId } = await dbCalls.insertOne({
      chatId,
      kind,
      initiatorId: viewerId,
      status: 'ringing',
      memberIds,
      participants: memberIds.map((userId) => ({
        userId,
        state: userId === viewerId ? ('joined' as const) : ('invited' as const),
        joinedAt: userId === viewerId ? now : null,
        leftAt: null,
        lastPingAt: userId === viewerId ? now : null,
        joinedDeviceId: userId === viewerId ? deviceId : null,
      })),
      createdAt: now,
      endedAt: null,
      endReason: null,
    });

    // Background ring on Android installs (FCM). Fire-and-forget: the in-app
    // overlay and web push stay the primary paths.
    const initiatorProfile = await dbProfiles.findOne({ userId: new ObjectId(viewerId) });
    for (const targetId of memberIds.filter((id) => id !== viewerId)) {
      void sendFcmToUser(targetId, {
        type: 'call',
        callId: insertedId.toString(),
        chatId,
        kind,
        title: chat.kind === 'group' ? chat.title ?? 'Групповой звонок' : initiatorProfile?.name ?? 'Входящий звонок',
        body: kind === 'video' ? 'Входящий видеозвонок' : 'Входящий звонок',
      }).catch(() => undefined);
    }

    return { callId: insertedId.toString() };
  },

  acceptCall: async (args: unknown, { user, sessionTokenHash }: { user: UserInfo | null; sessionTokenHash?: string }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { callId } = z.object({ callId: z.string() }).parse(args);
    const call = await requireCallMembership(callId, viewerId);
    if (call.status === 'ended') throw new ValidationError('Звонок уже завершён');
    if (participantOf(call, viewerId)?.state !== 'invited') throw new ValidationError('Звонок уже обработан');

    const joined = joinedIds(call);
    if (!joined.includes(viewerId) && joined.length >= MAX_CALL_PARTICIPANTS) {
      throw new ValidationError('В звонке уже максимум участников');
    }

    const now = new Date();
    await markParticipantJoined(call._id, viewerId, now, await sessionDeviceId(sessionTokenHash));
    return { ok: true };
  },

  declineCall: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { callId } = z.object({ callId: z.string() }).parse(args);
    const call = await requireCallMembership(callId, viewerId);

    const now = new Date();
    const participants = (call.participants ?? []).map((p) =>
      p.userId === viewerId ? { ...p, state: 'declined' as const, leftAt: now, lastPingAt: null } : p
    );
    await dbCalls.updateOne({ _id: call._id }, { $set: { participants } });

    const stillIn = participants.filter((p) => p.state === 'joined' || p.state === 'invited');
    if (stillIn.length < 2) {
      await endCall(call._id, 'declined');
    }
    return { ok: true };
  },

  /** Hang up: leaves the mesh, and ends the call when fewer than 2 remain. */
  leaveCall: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { callId } = z.object({ callId: z.string() }).parse(args);
    const call = await requireCallMembership(callId, viewerId);

    const now = new Date();
    const participants = (call.participants ?? []).map((p) =>
      p.userId === viewerId ? { ...p, state: 'left' as const, leftAt: now, lastPingAt: null } : p
    );
    await dbCalls.updateOne({ _id: call._id }, { $set: { participants } });

    const remaining = participants.filter((p) => p.state === 'joined' || p.state === 'invited');
    if (remaining.length < 2) {
      await endCall(call._id, 'hangup');
      await dbCallSignals.deleteMany({ callId });
    }
    return { ok: true };
  },

  /** Liveness beacon from every joined client (~10s). Silent: pings must not
   * trigger a global refetch storm on every client twice a minute. */
  pingCall: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { callId } = z.object({ callId: z.string() }).parse(args);
    const call = await requireCallMembership(callId, viewerId);
    if (call.status === 'ended') return { ended: true };

    const now = new Date();
    await dbCalls.updateOneSilent(
      { _id: call._id },
      { $set: { 'participants.$[self].lastPingAt': now } },
      { arrayFilters: [{ 'self.userId': viewerId }] },
    );
    await dbProfiles.updateOneSilent({ userId: new ObjectId(viewerId) }, { $set: { lastSeenAt: now } });
    return { ended: false };
  },

  /** Relays one SDP / ICE envelope to a single peer in the same call. */
  sendCallSignal: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { callId, toUserId, type, payload } = z
      .object({
        callId: z.string(),
        toUserId: z.string(),
        type: z.enum(['offer', 'answer', 'ice']),
        payload: z.string().max(64 * 1024),
      })
      .parse(args);

    const call = await requireCallMembership(callId, viewerId);
    if (call.status === 'ended') return { ok: false };
    if (viewerId === toUserId || participantOf(call, viewerId)?.state !== 'joined' || participantOf(call, toUserId)?.state !== 'joined') {
      throw new ValidationError('Участник не подключён к звонку');
    }

    await dbCallSignals.insertOne({
      callId,
      fromUserId: viewerId,
      toUserId,
      type,
      payload,
      createdAt: new Date(),
    });
    return { ok: true };
  },

  /** Drops already-consumed envelopes so the live inbox stays small. */
  ackCallSignals: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { signalIds } = z.object({ signalIds: z.array(z.string()).max(200) }).parse(args);

    const ids = signalIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
    if (ids.length === 0) return { ok: true };
    await dbCallSignals.deleteMany({ _id: { $in: ids }, toUserId: viewerId });
    return { ok: true };
  },
};

/**
 * Scheduled sweep that retires dead calls even when nobody else triggers a
 * refetch (pings are silent now, so a crashed client no longer causes one).
 */
export async function processStaleCalls() {
  const calls = await dbCalls.fetch({ status: { $in: ['ringing', 'active'] } }, { limit: 50 });
  for (const call of calls) await reapIfDead(call);
}
