import { ObjectId, Store } from '../core/database';

/**
 * Fixed identities of the two system accounts. They have profiles and direct
 * chats with every user, but never log in and never hold sessions.
 */
export const WYRE_SERVICE_USER_ID = '100000000000000000000001';
export const WYRE_AI_SERVICE_USER_ID = '100000000000000000000002';

export interface ProfileDocument {
  userId: ObjectId;
  email: string;
  name: string;
  username: string;
  usernameLower: string;
  usernameHistory: { username: string; changedAt: Date }[];
  bio: string;
  phone: string | null;
  colors: string[];
  initials: string;
  avatarPath?: string | null;
  avatarMimeType?: string | null;
  badge: 'dev' | 'official' | null;
  role: 'user' | 'moderator' | 'admin' | 'owner';
  warnings: { reason: string; issuedAt: Date; issuedBy: string; expiresAt?: Date | null }[];
  bannedUntil?: Date | null;
  banReason?: string | null;
  pendingChallenge: boolean;
  /** New registrations must explicitly bind a phone or choose to skip. */
  phoneOnboardingPending?: boolean;
  challengeAttempts: number;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date;
  presenceVisibility?: 'all' | 'contacts' | 'nobody';
  presenceAlways?: string[];
  presenceNever?: string[];
  /** True only for the system accounts (Wyre support / Wyre AI). */
  isService?: boolean;
  isDecoy?: boolean;
}

export interface ChatMemberState {
  userId: string;
  unread: number;
  unreadMentions?: number;
  pinned: boolean;
  muted: boolean;
  notificationMode?: 'all' | 'mentions' | 'none';
  mutedUntil?: Date | null;
  lastReadAt: Date;
  typingAt: Date | null;
  activity?: 'typing' | 'recording_voice' | 'recording_video' | null;
  activityAt?: Date | null;
  role?: 'owner' | 'admin' | 'member';
  hiddenAt?: Date | null;
  folders?: ('work' | 'family')[];
  topicReads?: Record<string, Date>;
  aiSummaryAt?: Date | null;
  aiSummaryAtByTopic?: Record<string, Date>;
}

export interface ChatDocument {
  kind: 'direct' | 'group';
  pairKey: string | null;
  title: string | null;
  description?: string;
  memberIds: string[];
  createdBy: string;
  createdAt: Date;
  lastMessageAt: Date;
  lastMessageText: string;
  lastMessageAuthorId: string | null;
  members: ChatMemberState[];
  avatarPath?: string | null;
  avatarMimeType?: string | null;
  autoDeleteAfterDays?: number | null;
}

export interface CallParticipant {
  userId: string;
  state: 'invited' | 'joined' | 'left' | 'declined';
  joinedAt: Date | null;
  leftAt: Date | null;
  lastPingAt: Date | null;
  /** Device that accepted the call — other devices of the account stay idle. */
  joinedDeviceId?: string | null;
}

export interface CallDocument {
  chatId: string;
  kind: 'audio' | 'video';
  initiatorId: string;
  status: 'ringing' | 'active' | 'ended';
  memberIds: string[];
  participants: CallParticipant[];
  createdAt: Date;
  endedAt: Date | null;
  endReason: 'hangup' | 'declined' | 'missed' | 'stale' | 'failed' | null;
  watchParty?: {
    url: string;
    playing: boolean;
    position: number;
    updatedAt: Date;
    updatedBy: string;
  } | null;
  whiteboard?: {
    strokes: {
      id: string;
      userId: string;
      color: string;
      points: { x: number; y: number }[];
      createdAt: Date;
    }[];
    updatedAt: Date;
  } | null;
  remoteControl?: {
    sessionId: string;
    controllerId: string;
    targetId: string;
    status: 'pending' | 'active' | 'declined' | 'ended';
    requestedAt: Date;
    respondedAt: Date | null;
    endedAt: Date | null;
  } | null;
}

export interface CallSignalDocument {
  callId: string;
  fromUserId: string;
  toUserId: string;
  type: 'offer' | 'answer' | 'ice';
  payload: string;
  createdAt: Date;
}

export interface MessageDocument {
  chatId: string;
  topicId?: string | null;
  authorId: string;
  text: string;
  kind: 'text' | 'sticker' | 'voice' | 'video' | 'file' | 'html' | 'link' | 'contact' | 'location' | 'poll' | 'actions';
  /** Telegram-style inline buttons; set only by the server for system messages. */
  actions?: { id: string; label: string }[] | null;
  usedActionId?: string | null;
  fileName: string | null;
  fileSize: string | null;
  filePath: string | null;
  mimeType: string | null;
  duration: number | null;
  reaction: string | null;
  pinned: boolean;
  editedAt: Date | null;
  replyToId: string | null;
  replyToText: string | null;
  replyToKind?: MessageDocument['kind'] | null;
  voiceThreadRootId?: string | null;
  transcription?: string | null;
  transcribedAt?: Date | null;
  translations?: Record<string, string>;
  voiceTranslations?: Record<string, { text: string; filePath: string; createdAt: Date }>;
  liveLocation?: {
    expiresAt: Date;
    updatedAt: Date;
    stoppedAt: Date | null;
  } | null;
  folderTransfer?: {
    targetUserId: string;
    status: 'pending' | 'accepted' | 'completed' | 'declined';
    requestedAt: Date;
    respondedAt: Date | null;
  } | null;
  readBy: string[];
  readAt?: Record<string, Date>;
  deliveredTo: string[];
  createdAt: Date;
  forwardedFromId?: string | null;
  forwardedFromName?: string | null;
  selfDestructSeconds?: number | null;
  deleteAt?: Date | null;
  notificationQueuedAt?: Date | null;
  linkPreview?: {
    url: string;
    title: string;
    description: string;
    domain: string;
    colors: [string, string];
  } | null;
  linkSafety?: {
    level: 'low' | 'medium' | 'high';
    reason: string;
    checkedAt: Date;
  } | null;
  poll?: {
    question: string;
    options: {
      id: string;
      text: string;
      voterIds: string[];
    }[];
    quiz: boolean;
    correctOptionId: string | null;
    closedAt: Date | null;
  } | null;
}

export interface CallControlEventDocument {
  callId: string;
  sessionId: string;
  controllerId: string;
  targetId: string;
  type: 'pointer_move' | 'pointer_down' | 'pointer_up' | 'key_down';
  x: number | null;
  y: number | null;
  button: number | null;
  key: string | null;
  createdAt: Date;
}

export interface TopicDocument {
  chatId: string;
  title: string;
  titleLower: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}

export interface CallInviteDocument {
  callId: string;
  tokenHash: string;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface MessageBookmarkDocument {
  userId: string;
  messageId: string;
  createdAt: Date;
}

export interface DraftDocument {
  userId: string;
  chatId: string;
  text: string;
  updatedAt: Date;
}

export interface ScheduledMessageDocument {
  userId: string;
  chatId: string;
  topicId?: string | null;
  text: string;
  scheduledAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoryDocument {
  authorId: string;
  caption: string;
  filePath: string;
  mimeType: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface StoryViewDocument {
  storyId: string;
  viewerId: string;
  viewedAt: Date;
  expiresAt: Date;
}

export interface AdminActionDocument {
  actorId: string;
  actorName: string;
  targetId: string;
  targetName: string;
  action: string;
  details: string;
  createdAt: Date;
}

export interface SettingsDocument {
  userId: string;
  themeId: number;
  fontSize: number;
  font: 'system' | 'rounded' | 'mono';
  autoTheme: boolean;
  dnd: boolean;
  dndFrom: string;
  dndTo: string;
  autoDnd?: boolean;
  timeZone?: string;
  autoDndUpdatedAt?: Date | null;
  quietCareEnabled?: boolean;
  quietCareDays?: number;
  quietCareNotifiedAt?: Date | null;
  previews: boolean;
  mutedChats: string[];
  blacklist: string[];
  safeMode: boolean;
  familyProtection: boolean;
  contentFilter: 'all' | 'contacts' | 'none';
  findByPhone: 'all' | 'contacts' | 'nobody';
  callPermission: 'all' | 'contacts' | 'nobody';
  invitePermission: 'all' | 'contacts' | 'nobody';
  phoneVisibility: 'all' | 'contacts' | 'nobody';
  privacyAlways: Partial<Record<'find' | 'call' | 'invite' | 'phone', string[]>>;
  privacyNever: Partial<Record<'find' | 'call' | 'invite' | 'phone', string[]>>;
  totpEnabled?: boolean;
  totpSecretEncrypted?: string | null;
  totpPendingSecretEncrypted?: string | null;
  pinEnabled?: boolean;
  pinSalt?: string | null;
  pinHash?: string | null;
  additionalPasswordVerifier?: string | null;
  webauthnAppEnabled?: boolean;
  webauthnAccountEnabled?: boolean;
  newDeviceApprovalEnabled?: boolean;
  /** Consent state for the personal Wyre AI assistant chat. */
  aiAssistantConsent?: 'accepted' | 'declined' | null;
  aiAssistantConsentAt?: Date | null;
  decoyEnabled?: boolean;
  decoyUserId?: string | null;
  decoySalt?: string | null;
  decoyHash?: string | null;
  updatedAt: Date;
}

export interface ReminderDocument {
  userId: string;
  chatId: string;
  messageId: string;
  text: string;
  remindAt: Date;
  status: 'pending' | 'done';
  notifiedAt: Date | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface SharedNoteDocument {
  chatId: string;
  content: string;
  version: number;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface QuietCareAlertDocument {
  subjectId: string;
  recipientId: string;
  lastSeenAt: Date;
  days: number;
  createdAt: Date;
  dismissedAt: Date | null;
}

export interface PushSubscriptionDocument {
  userId: string;
  sessionTokenHash: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string;
  createdAt: Date;
  lastSuccessAt: Date | null;
  failureCount: number;
}

export interface NotificationJobDocument {
  eventType: 'message';
  eventId: string;
  recipientId: string;
  chatId: string;
  title: string;
  body: string;
  url: string;
  createdAt: Date;
  nextAttemptAt: Date;
  attempts: number;
  deliveredAt: Date | null;
  lastError: string | null;
}

export interface YandexLinkRequestDocument {
  userId: ObjectId;
  sessionTokenHash: string;
  stateHash: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface WebAuthnCredentialDocument {
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface WebAuthnChallengeDocument {
  userId: string;
  sessionTokenHash: string;
  kind: 'registration' | 'authentication';
  scope: 'app' | 'account' | null;
  challenge: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface FamilyInviteDocument {
  guardianId: string;
  codeHash: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface FamilyLinkDocument {
  guardianId: string;
  childId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserBlockDocument {
  blockerId: string;
  blockedId: string;
  createdAt: Date;
}

export interface ChannelDocument {
  ownerId: string;
  title: string;
  description: string;
  subscriberIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ChannelPostDocument {
  channelId: string;
  authorId: string;
  text: string;
  createdAt: Date;
  editedAt: Date | null;
  viewedBy: string[];
  reactions: Record<string, string[]>;
}

export interface ChannelCommentDocument {
  channelId: string;
  postId: string;
  authorId: string;
  text: string;
  createdAt: Date;
  editedAt: Date | null;
}

export const dbProfiles = new Store<ProfileDocument>('wyreProfiles', [
  { key: { userId: 1 }, unique: true },
  { key: { usernameLower: 1 }, unique: true },
  { key: { email: 1 }, unique: true, name: 'email_unique_v2' },
]);

export const dbChats = new Store<ChatDocument>('wyreChats', [
  { key: { memberIds: 1, lastMessageAt: -1 } },
  {
    key: { pairKey: 1 },
    unique: true,
    name: 'pairKey_unique_direct_v2',
    partialFilterExpression: { pairKey: { $type: 'string' } },
  },
]);

export const dbCalls = new Store<CallDocument>('wyreCalls', [
  { key: { memberIds: 1, status: 1, createdAt: -1 } },
  { key: { chatId: 1, createdAt: -1 } },
]);

export const dbCallSignals = new Store<CallSignalDocument>('wyreCallSignals', [
  { key: { callId: 1, toUserId: 1, createdAt: 1 } },
  { key: { createdAt: 1 }, expireAfterSeconds: 300 },
]);

export const dbMessages = new Store<MessageDocument>('wyreMessages', [
  { key: { chatId: 1, createdAt: 1 } },
  { key: { chatId: 1, topicId: 1, createdAt: 1 } },
  { key: { chatId: 1, _id: 1 } },
  { key: { deleteAt: 1 }, expireAfterSeconds: 0 },
]);

export const dbMessageBookmarks = new Store<MessageBookmarkDocument>('wyreMessageBookmarks', [
  { key: { userId: 1, messageId: 1 }, unique: true },
  { key: { userId: 1, createdAt: -1 } },
]);

export const dbDrafts = new Store<DraftDocument>('wyreDrafts', [
  { key: { userId: 1, chatId: 1 }, unique: true },
  { key: { userId: 1, updatedAt: -1 } },
]);

export const dbScheduledMessages = new Store<ScheduledMessageDocument>('wyreScheduledMessages', [
  { key: { scheduledAt: 1 } },
  { key: { userId: 1, chatId: 1, scheduledAt: 1 } },
]);

export const dbStories = new Store<StoryDocument>('wyreStories', [
  { key: { authorId: 1, createdAt: -1 } },
  { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
]);

export const dbStoryViews = new Store<StoryViewDocument>('wyreStoryViews', [
  { key: { storyId: 1, viewerId: 1 }, unique: true },
  { key: { viewerId: 1, viewedAt: -1 } },
  { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
]);

export const dbAdminActions = new Store<AdminActionDocument>('wyreAdminActions', [
  { key: { createdAt: -1 } },
  { key: { actorId: 1, createdAt: -1 } },
  { key: { targetId: 1, createdAt: -1 } },
]);

export const dbSettings = new Store<SettingsDocument>('wyreSettings', [
  { key: { userId: 1 }, unique: true },
]);

export const dbReminders = new Store<ReminderDocument>('wyreReminders', [
  { key: { userId: 1, chatId: 1, status: 1, remindAt: 1 } },
  { key: { userId: 1, messageId: 1 }, unique: true },
]);

export const dbSharedNotes = new Store<SharedNoteDocument>('wyreSharedNotes', [
  { key: { chatId: 1 }, unique: true },
]);

export const dbCallControlEvents = new Store<CallControlEventDocument>('wyreCallControlEvents', [
  { key: { callId: 1, targetId: 1, createdAt: 1 } },
  { key: { createdAt: 1 }, expireAfterSeconds: 30 },
]);

export const dbTopics = new Store<TopicDocument>('wyreTopics', [
  { key: { chatId: 1, createdAt: 1 } },
  { key: { chatId: 1, titleLower: 1 }, unique: true },
]);

export const dbCallInvites = new Store<CallInviteDocument>('wyreCallInvites', [
  { key: { tokenHash: 1 }, unique: true },
  { key: { callId: 1, createdAt: -1 } },
  { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
]);

export const dbWebAuthnCredentials = new Store<WebAuthnCredentialDocument>('wyreWebAuthnCredentials', [
  { key: { credentialId: 1 }, unique: true },
  { key: { userId: 1, createdAt: -1 } },
]);

export const dbWebAuthnChallenges = new Store<WebAuthnChallengeDocument>('wyreWebAuthnChallenges', [
  { key: { sessionTokenHash: 1, kind: 1 }, unique: true },
  { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
]);

export const dbQuietCareAlerts = new Store<QuietCareAlertDocument>('wyreQuietCareAlerts', [
  { key: { subjectId: 1, recipientId: 1 }, unique: true },
  { key: { recipientId: 1, createdAt: -1 } },
]);

export const dbPushSubscriptions = new Store<PushSubscriptionDocument>('wyrePushSubscriptions', [
  { key: { endpoint: 1 }, unique: true },
  { key: { userId: 1, createdAt: -1 } },
  { key: { sessionTokenHash: 1 } },
]);

export interface FcmTokenDocument {
  userId: string;
  token: string;
  platform: string;
  updatedAt: Date;
}

/** One FCM token per Android install; refreshed by the app on every start. */
export const dbFcmTokens = new Store<FcmTokenDocument>('wyreFcmTokens', [
  { key: { token: 1 }, unique: true },
  { key: { userId: 1, updatedAt: -1 } },
]);

export interface PushActionTokenDocument {
  tokenHash: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Opaque tokens that let the Android notification buttons act on behalf of a
 * user (mark read / reply / accept call) without holding the session cookie.
 * Only SHA-256 hashes are stored; 30-day TTL, revocable by deleting the row.
 */
export const dbPushActionTokens = new Store<PushActionTokenDocument>('wyrePushActionTokens', [
  { key: { tokenHash: 1 }, unique: true },
  { key: { userId: 1, createdAt: -1 } },
  { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
]);

export const dbNotificationJobs = new Store<NotificationJobDocument>('wyreNotificationJobs', [
  { key: { eventType: 1, eventId: 1, recipientId: 1 }, unique: true },
  { key: { deliveredAt: 1, nextAttemptAt: 1 } },
]);

export const dbYandexLinkRequests = new Store<YandexLinkRequestDocument>('wyreYandexLinkRequests', [
  { key: { stateHash: 1 }, unique: true },
  { key: { userId: 1, createdAt: -1 } },
  { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
]);

export const dbFamilyInvites = new Store<FamilyInviteDocument>('wyreFamilyInvites', [
  { key: { codeHash: 1 }, unique: true },
  { key: { guardianId: 1, createdAt: -1 } },
  { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
]);

export const dbFamilyLinks = new Store<FamilyLinkDocument>('wyreFamilyLinks', [
  { key: { guardianId: 1, childId: 1 }, unique: true },
  { key: { childId: 1, createdAt: 1 } },
]);

export const dbUserBlocks = new Store<UserBlockDocument>('wyreUserBlocks', [
  { key: { blockerId: 1, blockedId: 1 }, unique: true },
  { key: { blockedId: 1, blockerId: 1 } },
]);

export const dbChannels = new Store<ChannelDocument>('wyreChannels', [
  { key: { ownerId: 1, updatedAt: -1 } },
  { key: { subscriberIds: 1, updatedAt: -1 } },
]);

export const dbChannelPosts = new Store<ChannelPostDocument>('wyreChannelPosts', [
  { key: { channelId: 1, createdAt: -1 } },
]);

export const dbChannelComments = new Store<ChannelCommentDocument>('wyreChannelComments', [
  { key: { postId: 1, createdAt: 1 } },
  { key: { channelId: 1, createdAt: -1 } },
]);
