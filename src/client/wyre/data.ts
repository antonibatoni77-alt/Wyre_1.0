// Centralized mock data & shared types for the Wyre prototype.

export type BadgeKind = "dev" | "official";
export type Presence = "online" | "typing" | "recording_voice" | "recording_video" | "talking" | "recent" | "offline";
export type Folder = "all" | "work" | "family";
export type Section = "chats" | "contacts" | "settings" | "account";
export type ModalKind = "group" | "channel" | null;
export type PickerKind = "emoji" | "attachment" | null;
export type MessageStatus = "sent" | "delivered" | "read";
export type MessageKind =
  | "text"
  | "sticker"
  | "voice"
  | "video"
  | "file"
  | "html"
  | "link"
  | "contact"
  | "location"
  | "poll"
  | "actions";

export interface Warning {
  id: number;
  reason: string;
  date: string;
}

export interface Chat {
  id: string;
  peerId?: string;
  username?: string;
  name: string;
  initials: string;
  avatarUrl?: string | null;
  status: string;
  last: string;
  time: string;
  unread: number;
  unreadMentions?: number;
  badge?: BadgeKind;
  /** True for direct chats with the official Wyre / Wyre AI accounts. */
  service?: boolean;
  colors: [string, string];
  folders: Folder[];
  presence: Presence;
  pinned?: boolean;
  muted?: boolean;
  notificationMode?: "all" | "mentions" | "none";
  mutedUntil?: string | null;
  warnings: Warning[];
  hasStory?: boolean;
  storyViewed?: boolean;
  group?: boolean;
  members?: number;
  autoDeleteAfterDays?: number | null;
}

export interface LinkPreview {
  url?: string;
  title: string;
  description: string;
  domain: string;
  colors: [string, string];
}

export interface ChatMessage {
  id: string;
  topicId?: string;
  edited?: boolean;
  replyToText?: string;
  replyToKind?: MessageKind;
  voiceThreadRootId?: string;
  transcription?: string;
  translation?: string;
  liveLocation?: { expiresAt: string; updatedAt: string; stopped: boolean };
  folderTransfer?: { status: "pending" | "accepted" | "completed" | "declined"; canRespond: boolean; respondedAt?: string };
  mine: boolean;
  text: string;
  time: string;
  date?: string;
  reaction?: string;
  kind?: MessageKind;
  /** Telegram-style inline buttons on server-authored messages. */
  actions?: { id: string; label: string }[];
  usedActionId?: string;
  status?: MessageStatus;
  statusAt?: string;
  scheduledAt?: string;
  pinned?: boolean;
  link?: LinkPreview;
  linkSafety?: { level: "low" | "medium" | "high"; reason: string; checkedAt: string };
  fileName?: string;
  fileSize?: string;
  fileUrl?: string;
  mimeType?: string;
  /** Duration in whole seconds — set for voice/video messages. */
  duration?: number;
  forwardedFromName?: string;
  bookmarked?: boolean;
  selfDestructSeconds?: number;
  deleteAt?: string;
  mentioned?: boolean;
  /** Local-only flag for an optimistic bubble that is still being sent. */
  pending?: boolean;
  poll?: {
    question: string;
    options: {
      id: string;
      text: string;
      votes: number;
      selected: boolean;
    }[];
    totalVotes: number;
    quiz: boolean;
    correctOptionId?: string;
    closed: boolean;
    canClose: boolean;
  };
}

export interface ChatTopic {
  id: string;
  title: string;
  closed: boolean;
  unread: number;
  last: string;
  updatedAt: string;
  canManage: boolean;
}

export interface Contact {
  name: string;
  initials: string;
  online: boolean;
  badge?: BadgeKind;
  colors: [string, string];
}

export interface Story {
  id: string;
  authorId: string;
  name: string;
  initials: string;
  colors: [string, string];
  caption: string;
  mediaUrl: string;
  mimeType: string;
  createdAt: string;
  expiresAt: string;
}

export interface Theme {
  id: number;
  name: string;
  bg: string;
  surface: string;
  accent1: string;
  accent2: string;
  premium: boolean;
}

export interface Session {
  id: number;
  device: string;
  location: string;
  lastActive: string;
  current?: boolean;
}

export interface AdminWarning {
  reason: string;
  issuedAt: string;
  expiresAt: string | null;
}

export interface AdminUser {
  id: string;
  name: string;
  username: string;
  initials: string;
  colors: [string, string];
  warnings: number;
  warningReasons?: string[];
  warningDetails?: AdminWarning[];
  role: "user" | "moderator" | "admin" | "owner";
  badge?: BadgeKind;
  banned?: boolean;
  bannedUntil?: string | null;
  banReason?: string | null;
}

export interface AdminLog {
  id: string;
  actor: string;
  action: string;
  time: string;
}

export interface SupportThread {
  chatId: string;
  userId: string;
  name: string;
  username: string;
  initials: string;
  colors: [string, string];
  last: string;
  lastMessageAt: string;
  fromSupport: boolean;
  unread: number;
}

export interface SupportMessage {
  id: string;
  fromSupport: boolean;
  text: string;
  createdAt: string;
}

export const contacts: Contact[] = [
  { name: "Лера Воронова", initials: "ЛВ", online: true, badge: "dev", colors: ["#8b5cf6", "#4338ca"] },
  { name: "Михаил Орлов", initials: "МО", online: true, colors: ["#f59e0b", "#ef4444"] },
  { name: "Аня Соколова", initials: "АС", online: false, colors: ["#14b8a6", "#0f766e"] },
  { name: "Макс Рубин", initials: "МР", online: false, colors: ["#ec4899", "#7c3aed"] },
  { name: "Игорь Крылов", initials: "ИК", online: true, colors: ["#f59e0b", "#dc2626"] },
  { name: "Ксения Реброва", initials: "КР", online: false, colors: ["#22d3ee", "#0369a1"] },
];

export const themes: Theme[] = [
  { id: 0, name: "Midnight", bg: "#080a12", surface: "#111525", accent1: "#8b5cf6", accent2: "#2563eb", premium: false },
  { id: 1, name: "Graphite", bg: "#101113", surface: "#1b1d20", accent1: "#a3a3a3", accent2: "#52525b", premium: false },
  { id: 2, name: "Ocean", bg: "#06151b", surface: "#0b2932", accent1: "#06b6d4", accent2: "#0369a1", premium: false },
  { id: 3, name: "Forest", bg: "#07140e", surface: "#10271b", accent1: "#22c55e", accent2: "#15803d", premium: false },
  { id: 4, name: "Berry", bg: "#170812", surface: "#2b1225", accent1: "#ec4899", accent2: "#9333ea", premium: false },
  { id: 5, name: "Ember", bg: "#180b07", surface: "#301610", accent1: "#f97316", accent2: "#dc2626", premium: false },
  { id: 6, name: "Arctic", bg: "#0a121d", surface: "#142338", accent1: "#38bdf8", accent2: "#6366f1", premium: false },
  { id: 7, name: "Plum", bg: "#12091c", surface: "#25143b", accent1: "#c084fc", accent2: "#7c3aed", premium: false },
  { id: 8, name: "Moss", bg: "#11140a", surface: "#252c14", accent1: "#a3e635", accent2: "#4d7c0f", premium: false },
  { id: 9, name: "Rose", bg: "#180d11", surface: "#301820", accent1: "#fb7185", accent2: "#be123c", premium: false },
  { id: 10, name: "Aurora", bg: "#050d16", surface: "#0b2030", accent1: "#2dd4bf", accent2: "#7c3aed", premium: true },
  { id: 11, name: "Iris", bg: "#0e0719", surface: "#261139", accent1: "#e879f9", accent2: "#4f46e5", premium: true },
  { id: 12, name: "Solar", bg: "#170d04", surface: "#33200d", accent1: "#facc15", accent2: "#f97316", premium: true },
  { id: 13, name: "Nebula", bg: "#080516", surface: "#171033", accent1: "#a78bfa", accent2: "#06b6d4", premium: true },
  { id: 14, name: "Flame", bg: "#160607", surface: "#330e18", accent1: "#fb7185", accent2: "#7c3aed", premium: true },
  { id: 15, name: "Lagoon", bg: "#031314", surface: "#092d2b", accent1: "#2dd4bf", accent2: "#0ea5e9", premium: true },
  { id: 16, name: "Pulse", bg: "#110711", surface: "#2e112d", accent1: "#f472b6", accent2: "#8b5cf6", premium: true },
  { id: 17, name: "Voltage", bg: "#0d1004", surface: "#242b09", accent1: "#bef264", accent2: "#14b8a6", premium: true },
  { id: 18, name: "Cosmos", bg: "#050818", surface: "#101a3b", accent1: "#60a5fa", accent2: "#a855f7", premium: true },
  { id: 19, name: "Silk", bg: "#15090e", surface: "#321622", accent1: "#f9a8d4", accent2: "#c026d3", premium: true },
];

/** Quick reactions — the first six also fill the hover reaction bar. */
export const emojis = ["💜", "🔥", "👍", "✨", "😂", "❤️", "😮", "🎉", "👏", "🥲", "😍", "🙌"];

/** Full picker catalogue grouped by category (Unicode emoji, Telegram-style breadth). */
export const emojiCategories: { name: string; icon: string; emojis: string[] }[] = [
  {
    name: "Смайлы",
    icon: "😀",
    emojis: ["😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "🥲", "😊", "😇", "🙂", "🙃", "😉", "😌", "😍", "🥰", "😘", "😗", "😙", "😚", "😋", "😛", "😝", "😜", "🤪", "🤨", "🧐", "🤓", "😎", "🥸", "🤩", "🥳", "😏", "😒", "😞", "😔", "😟", "😕", "🙁", "😣", "😖", "😫", "😩", "🥺", "😢", "😭", "😤", "😠", "😡", "🤬", "🤯", "😳", "🥵", "🥶", "😱", "😨", "😰", "😥", "😓", "🤗", "🤔", "🫡", "🤭", "🤫", "🤥", "😶", "😐", "😑", "😬", "🙄", "😯", "😦", "😧", "😮", "😲", "🥱", "😴", "🤤", "😪", "😵", "🤐", "🥴", "🤢", "🤮", "🤧", "😷", "🤒", "🤕", "🤑", "🤠", "😈", "👻", "🤖", "💩", "🤡", "💀"],
  },
  {
    name: "Жесты",
    icon: "👍",
    emojis: ["👋", "🤚", "🖐️", "✋", "🖖", "👌", "🤌", "🤏", "✌️", "🤞", "🫰", "🤟", "🤘", "🤙", "👈", "👉", "👆", "👇", "☝️", "👍", "👎", "✊", "👊", "🤛", "🤜", "👏", "🙌", "👐", "🤲", "🤝", "🙏", "✍️", "💅", "🤳", "💪", "🦾", "👀", "👅", "👄", "🫶", "🫵", "🫱", "🫲"],
  },
  {
    name: "Сердца",
    icon: "❤️",
    emojis: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💔", "❣️", "💕", "💞", "💓", "💗", "💖", "💘", "💝", "💟", "♥️", "💌", "💋", "👩‍❤️‍👨", "👨‍❤️‍👨", "👩‍❤️‍👩", "💐", "🌹", "🥀", "🌷", "🌸", "🌺", "🌻", "🌼", "💠"],
  },
  {
    name: "Животные",
    icon: "🐼",
    emojis: ["🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🙈", "🙉", "🙊", "🐔", "🐧", "🐦", "🐤", "🦆", "🦅", "🦉", "🦇", "🐺", "🐗", "🐴", "🦄", "🐝", "🐛", "🦋", "🐌", "🐞", "🐜", "🕷️", "🦂", "🐢", "🐍", "🦎", "🐙", "🦑", "🦐", "🦞", "🦀", "🐡", "🐠", "🐟", "🐬", "🐳", "🐋", "🦈", "🐊", "🐅", "🦓", "🦍", "🐘", "🦛", "🐪", "🦒", "🦘", "🐃", "🐄", "🐎", "🐖", "🐏", "🐑", "🦙", "🐐", "🦌", "🐕", "🐩", "🐈", "🐓", "🦃", "🦚", "🦜", "🦢", "🕊️", "🐇", "🦝", "🦨", "🦡", "🦦", "🦥", "🐿️", "🦔"],
  },
  {
    name: "Еда",
    icon: "🍕",
    emojis: ["🍏", "🍎", "🍐", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🫐", "🍈", "🍒", "🍑", "🥭", "🍍", "🥥", "🥝", "🍅", "🍆", "🥑", "🥦", "🥬", "🥒", "🌶️", "🌽", "🥕", "🧄", "🧅", "🥔", "🍠", "🥐", "🥯", "🍞", "🥖", "🥨", "🧀", "🥚", "🍳", "🧈", "🥞", "🧇", "🥓", "🥩", "🍗", "🍖", "🌭", "🍔", "🍟", "🍕", "🥪", "🥙", "🧆", "🌮", "🌯", "🥗", "🥘", "🍝", "🍜", "🍲", "🍛", "🍣", "🍱", "🥟", "🍤", "🍙", "🍚", "🍘", "🍥", "🥠", "🥮", "🍢", "🍡", "🍧", "🍨", "🍦", "🥧", "🧁", "🍰", "🎂", "🍮", "🍭", "🍬", "🍫", "🍿", "🍩", "🍪", "🌰", "🥜", "🍯", "🥛", "🍼", "☕", "🍵", "🧃", "🥤", "🍺", "🍻", "🥂", "🍷", "🥃", "🍸", "🍹", "🍾"],
  },
  {
    name: "Активности",
    icon: "⚽",
    emojis: ["⚽", "🏀", "🏈", "⚾", "🥎", "🎾", "🏐", "🏉", "🥏", "🎱", "🪀", "🏓", "🏸", "🏒", "🏑", "🥍", "🏏", "🥅", "⛳", "🪁", "🏹", "🎣", "🤿", "🥊", "🥋", "🎽", "🛹", "🛷", "⛸️", "🥌", "🎿", "⛷️", "🏂", "🏋️", "🤼", "🤸", "⛹️", "🤺", "🤾", "🏌️", "🏇", "🧘", "🏄", "🏊", "🤽", "🚣", "🧗", "🚵", "🚴", "🏆", "🥇", "🥈", "🥉", "🏅", "🎖️", "🏵️", "🎫", "🎟️", "🎪", "🤹", "🎭", "🎨", "🎬", "🎤", "🎧", "🎼", "🎹", "🥁", "🎷", "🎺", "🎸", "🪕", "🎻", "🎲", "♟️", "🎯", "🎳", "🎮", "🎰", "🧩", "🎉", "🎊", "🎈"],
  },
  {
    name: "Путешествия",
    icon: "✈️",
    emojis: ["🚗", "🚕", "🚙", "🚌", "🚎", "🏎️", "🚓", "🚑", "🚒", "🚐", "🚚", "🚛", "🚜", "🛴", "🚲", "🛵", "🏍️", "🚨", "🚔", "🚍", "🚘", "🚖", "🚡", "🚠", "🚟", "🚃", "🚋", "🚞", "🚝", "🚄", "🚅", "🚈", "🚂", "🚆", "🚇", "🚊", "🚉", "✈️", "🛫", "🛬", "🛩️", "💺", "🛰️", "🚀", "🛸", "🚁", "🛶", "⛵", "🚤", "🛥️", "🛳️", "⛴️", "🚢", "⚓", "⛽", "🚧", "🚦", "🚥", "🗺️", "🗽", "🗼", "🏰", "🏯", "🏟️", "🎡", "🎢", "🎠", "⛲", "⛱️", "🏖️", "🏝️", "🏜️", "🌋", "⛰️", "🏔️", "🗻", "🏕️", "⛺", "🏠", "🏡", "🏘️", "🏗️", "🏭", "🏢", "🏬", "🏥", "🏦", "🏨", "🏪", "🏫", "💒", "🏛️", "⛪", "🕌", "🕍", "🛕"],
  },
  {
    name: "Предметы",
    icon: "📱",
    emojis: ["⌚", "📱", "💻", "⌨️", "🖥️", "🖨️", "🖱️", "💽", "💾", "💿", "📀", "📼", "📷", "📸", "📹", "🎥", "📞", "☎️", "📟", "📠", "📺", "📻", "🎙️", "⏱️", "⏲️", "⏰", "🕰️", "⌛", "⏳", "📡", "🔋", "🔌", "💡", "🔦", "🕯️", "🧯", "🛢️", "💸", "💵", "💴", "💶", "💷", "🪙", "💰", "💳", "💎", "⚖️", "🧰", "🔧", "🔨", "⚒️", "🛠️", "⛏️", "🔩", "⚙️", "🧲", "💣", "🧨", "🪓", "🔪", "🗡️", "⚔️", "🛡️", "🏺", "🔮", "📿", "🧿", "⚗️", "🔭", "🔬", "💊", "💉", "🧬", "🦠", "🧫", "🧪", "🌡️", "🧹", "🧺", "🧻", "🚽", "🚰", "🚿", "🛁", "🛀", "🧼", "🪒", "🧽", "🧴", "🛎️", "🔑", "🗝️", "🚪", "🪑", "🛋️", "🛏️", "🧸", "🖼️", "🛍️", "🛒", "🎁", "🎈", "🎏", "🎀", "🎊", "🏮", "🎐", "🧧", "✉️", "📩", "📨", "📧", "💌", "📤", "📥", "📦", "🏷️", "📪", "📫", "📬", "📭", "📮", "📝", "✏️", "🖊️", "🖋️", "🖌️", "🖍️", "📓", "📔", "📒", "📕", "📗", "📘", "📙", "📚", "📖", "🔖", "🧷", "🔗", "📎", "🖇️", "📐", "📏", "🧮", "📌", "📍", "✂️", "🗂️", "📁", "📂", "🗃️", "📅", "📆", "🗓️", "📇", "📈", "📉", "📊", "📋"],
  },
  {
    name: "Символы",
    icon: "✨",
    emojis: ["✅", "❌", "❓", "❗", "⁉️", "💯", "🔥", "✨", "⭐", "🌟", "💫", "⚡", "☄️", "💥", "🔔", "🔕", "🎵", "🎶", "✳️", "❇️", "™️", "©️", "®️", "🔟", "🆗", "🆕", "🆙", "🆒", "🆓", "🆖", "🚹", "🚺", "🚼", "♿", "🚫", "🚭", "⚠️", "🚸", "⛔", "♻️", "⚜️", "🔱", "📛", "🔰", "⭕", "❕", "〽️", "🔅", "🔆", "〰️", "➰", "➿", "✔️", "☑️", "🔴", "🟠", "🟡", "🟢", "🔵", "🟣", "⚫", "⚪", "🟤", "🔺", "🔻", "🔸", "🔹", "🔶", "🔷"],
  },
];

/** Animated "GIF" tab — looping animated emoji, no external GIF provider needed. */
export const gifs = ["🌀", "🎆", "🌊", "🛸", "🎇", "🌈", "⚡", "💫", "🔥", "❤️‍🔥", "🎊", "🎈", "🌟", "💥", "☂️", "❄️", "🌸", "🍀", "🌻", "🫧", "💜", "✨", "🎃", "🎄"];

export const stickerPacks: Record<string, string[]> = {
  Mellow: ["🪩", "🫧", "🪐", "🦋", "🌙", "🎧", "🍃", "🐚", "🕯️", "🫖", "🧸", "🪴"],
  Motion: ["✨", "🔥", "💫", "⚡", "🎉", "💜", "💥", "🌟", "🎈", "🎊", "🏆", "🔔"],
  Fauna: ["🐼", "🦊", "🐧", "🐳", "🐝", "🦉", "🐨", "🦁", "🐢", "🦄", "🐙", "🦋"],
  Love: ["😍", "🥰", "😘", "💋", "💘", "💝", "🤗", "😊", "💐", "🌹", "❤️‍🔥", "💍"],
  Party: ["🥳", "🎂", "🎁", "🍾", "🪅", "🎯", "🎺", "🪩", "🍰", "🍹", "🎆", "👑"],
  Family: ["🏡", "🍲", "☕", "🫂", "👶", "🐶", "🐱", "📺", "🛋️", "🧩", "📷", "🚗"],
};
