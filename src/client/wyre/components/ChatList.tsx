import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { wyreLiveQuery, wyreMutation, wyreQuery } from "../../lib/api";
import { AnimatePresence, motion } from "motion/react";
import {
  Archive,
  FolderOpen,
  Laptop,
  ImagePlus,
  MoreHorizontal,
  Pin,
  Radio,
  Search,
  Trash2,
  TriangleAlert,
  UserPlus,
  Users,
  VolumeX,
  X,
} from "lucide-react";
import { cn } from "../utils/cn";
import type { Chat, Folder, ModalKind, Story } from "../data";
import type { Person } from "../types";
import { Avatar, GlassButton, SegmentedControl, UserBadge } from "./Glass";
import { Brand } from "./Brand";
import { collapseVariants, layoutIds, popVariants } from "../utils/motion";
import { StoriesLayer } from "./Stories";

function TopMenu({
  open,
  onClose,
  onModal,
  onCreateStory,
}: {
  open: boolean;
  onClose: () => void;
  onModal: (kind: ModalKind) => void;
  onCreateStory: () => void;
}) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <button aria-label="Закрыть меню" className="fixed inset-0 z-30" onClick={onClose} />
          <motion.div {...popVariants} className="glass-menu absolute right-0 top-12 z-[80] w-[min(16rem,calc(100vw-1.5rem))]">
            <button
              onClick={() => {
                onCreateStory();
                onClose();
              }}
              className="menu-row"
            >
              <ImagePlus size={18} />
              <span>Создать историю</span>
            </button>
            <button
              onClick={() => {
                onModal("group");
                onClose();
              }}
              className="menu-row"
            >
              <Users size={18} />
              <span>Создать группу</span>
            </button>
            <button
              onClick={() => {
                onModal("channel");
                onClose();
              }}
              className="menu-row"
            >
              <Radio size={18} />
              <span>Создать канал</span>
            </button>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function WarningPopover({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  return (
    <>
      <button aria-label="Закрыть" className="fixed inset-0 z-40" onClick={onClose} />
      <motion.div {...popVariants} className="glass-menu absolute right-3 top-full z-50 mt-2 w-64 p-3">
        <p className="mb-2 flex items-center gap-2 px-1 text-xs font-semibold text-amber-400">
          <TriangleAlert size={13} /> Предупреждения ({chat.warnings.length}/2)
        </p>
        {chat.warnings.map((warning) => (
          <div key={warning.id} className="rounded-xl px-2 py-2 text-xs hover:bg-white/5">
            <p className="text-[var(--text)]">{warning.reason}</p>
            <p className="mt-0.5 text-[10px] text-[var(--muted)]">{warning.date}</p>
          </div>
        ))}
      </motion.div>
    </>
  );
}

function SwipeableChatRow({
  chat,
  open,
  onToggleOpen,
  onOpenChat,
  onOpenProfile,
  onWarningToggle,
  warningOpen,
  onPin,
  onMute,
  onDelete,
  onFolders,
}: {
  chat: Chat;
  open: boolean;
  onToggleOpen: (open: boolean) => void;
  onOpenChat: (chat: Chat) => void;
  onOpenProfile: (userId: string) => void;
  onWarningToggle: () => void;
  warningOpen: boolean;
  onPin: () => void;
  onMute: () => void;
  onDelete: () => void;
  onFolders: () => void;
}) {
  return (
    <div className="chat-swipe-wrap relative">
      <div className="chat-swipe-actions">
        <button onClick={onPin} style={{ background: "linear-gradient(135deg,#f59e0b,#d97706)" }} title={chat.pinned ? "Открепить" : "Закрепить"}>
          <Pin size={16} />
        </button>
        <button onClick={onMute} style={{ background: "linear-gradient(135deg,#64748b,#334155)" }} title={chat.muted ? "Включить уведомления" : "Без звука"}>
          {chat.muted ? <VolumeX size={16} /> : <Archive size={16} />}
        </button>
        <button onClick={onFolders} style={{ background: "linear-gradient(135deg,#38bdf8,#2563eb)" }} title="Изменить папку">
          <FolderOpen size={16} />
        </button>
        <button onClick={onDelete} style={{ background: "linear-gradient(135deg,#f87171,#dc2626)" }} title={chat.group ? "Выйти из группы" : "Удалить чат"}>
          <Trash2 size={16} />
        </button>
      </div>
      <motion.div
        drag="x"
        dragConstraints={{ left: -200, right: 0 }}
        dragElastic={0.06}
        animate={{ x: open ? -200 : 0 }}
        transition={{ type: "spring", stiffness: 500, damping: 40 }}
        onDragEnd={(_, info) => onToggleOpen(info.offset.x < -60)}
        onClick={() => {
          if (!open) onOpenChat(chat);
          else onToggleOpen(false);
        }}
        whileTap={{ scale: 0.99 }}
        className="chat-row cursor-pointer touch-pan-y"
      >
        <button type="button" className="shrink-0" disabled={!chat.peerId} onClick={(event) => { event.stopPropagation(); if (chat.peerId) onOpenProfile(chat.peerId); }} aria-label={`Открыть профиль ${chat.name}`}>
          <Avatar
            initials={chat.initials}
            colors={chat.colors}
            avatarUrl={chat.avatarUrl}
            presence={chat.presence === "offline" ? undefined : chat.presence}
            ring={chat.hasStory ? (chat.storyViewed ? "seen" : "unseen") : "none"}
          />
        </button>
        <div className="min-w-0 flex-1 text-left">
          <button type="button" disabled={!chat.peerId} onClick={(event) => { event.stopPropagation(); if (chat.peerId) onOpenProfile(chat.peerId); }} className="flex items-center gap-1.5 text-left">
            <span className="truncate text-sm font-semibold">{chat.name}</span>
            <UserBadge kind={chat.badge} />
            {chat.pinned && <Pin size={11} className="text-[var(--muted)]" />}
          </button>
          <p className={cn("mt-1 truncate text-xs", ["typing", "recording_voice", "recording_video", "talking"].includes(chat.presence) ? "font-medium text-[var(--accent1)]" : "text-[var(--muted)]")}>
            {["typing", "recording_voice", "recording_video", "talking"].includes(chat.presence) ? chat.status : chat.last}
          </p>
        </div>
        <div className="relative flex h-11 shrink-0 flex-col items-end justify-between">
          <div className="flex items-center gap-1.5">
            {chat.warnings.length > 0 && (
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  onWarningToggle();
                }}
                className="warning-chip"
                title="Предупреждения"
              >
                {chat.warnings.length}
              </button>
            )}
            <span className="text-[10px] text-[var(--muted)]">{chat.time}</span>
          </div>
          {chat.unread > 0 && (
            <span className="grid h-5 min-w-5 place-items-center rounded-full bg-gradient-to-br from-[var(--accent1)] to-[var(--accent2)] px-1 text-[10px] font-bold text-white" title={chat.unreadMentions ? `Упоминаний: ${chat.unreadMentions}` : undefined}>
              {chat.unreadMentions ? `@${chat.unread}` : chat.unread}
            </span>
          )}
          <AnimatePresence>{warningOpen && <WarningPopover chat={chat} onClose={onWarningToggle} />}</AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}

export function ChatList({
  onOpenChat,
  onOpenChannel,
  onStartChat,
  onOpenProfile,
  onModal,
  onChatDeleted,
}: {
  onOpenChat: (chat: Chat) => void;
  onOpenChannel: (channelId: string) => void;
  onStartChat: (peerId: string) => void;
  onOpenProfile: (userId: string) => void;
  onModal: (kind: ModalKind) => void;
  onChatDeleted: (chatId: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");

  const [folder, setFolder] = useState<Folder>("all");
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [warningRow, setWarningRow] = useState<string | null>(null);
  const [storiesRevealed, setStoriesRevealed] = useState(false);
  const [storyCreatorOpen, setStoryCreatorOpen] = useState(false);
  const [storyViewer, setStoryViewer] = useState<{ stories: Story[]; startIndex: number } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const pullStartY = useRef<number | null>(null);

  const { data: chats = [], isLoading } = useQuery(wyreLiveQuery<Chat[]>("wyre.listChats", {}));
  const { data: stories = [] } = useQuery(wyreLiveQuery<Story[]>("wyre.listStories", {}));
  const { data: channels = [] } = useQuery(wyreLiveQuery<{ id: string; title: string; description: string; initials: string; colors: [string, string]; subscribers: number; subscribed: boolean }[]>("wyre.listChannels", {}));
  const { data: discoveredChannels = [] } = useQuery({ ...wyreQuery<{ id: string; title: string; description: string; initials: string; colors: [string, string]; subscribers: number; subscribed: boolean }[]>("wyre.discoverChannels", { query }), enabled: query.trim().length > 0 });
  const { data: people = [] } = useQuery({
    ...wyreQuery<Person[]>("wyre.searchPeople", { query }),
    enabled: query.trim().length > 0,
  });
  // Real pending approvals for a login from a new device, straight from the server.
  const { data: pendingDevices = [], refetch: refetchPendingDevices } = useQuery(
    wyreLiveQuery<{ id: string; userAgent: string; ip: string | null; createdAt: string }[]>("wyre.pendingDeviceApprovals", {}),
  );

  const { mutate: togglePin } = useMutation(wyreMutation("wyre.togglePinChat"));
  const { mutate: toggleMute } = useMutation(wyreMutation("wyre.toggleMuteChat"));
  const { mutateAsync: joinChannel } = useMutation(wyreMutation("wyre.joinChannel"));
  const { mutateAsync: deleteChat } = useMutation(wyreMutation("wyre.deleteChat"));
  const { mutate: setChatFolders } = useMutation(wyreMutation("wyre.setChatFolders"));
  const { mutateAsync: approveDeviceSession } = useMutation(wyreMutation("wyre.approveDeviceSession"));
  const { mutateAsync: denyDeviceSession } = useMutation(wyreMutation("wyre.denyDeviceSession"));

  useEffect(() => {
    if (stories.length === 0) setStoriesRevealed(false);
  }, [stories.length]);

  const filtered = useMemo(
    () =>
      chats
        .filter((chat) => chat.folders.includes(folder))
        .filter((chat) => `${chat.name} ${chat.last}`.toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned)),
    [chats, folder, query],
  );

  const knownPeers = useMemo(() => new Set(chats.map((chat) => chat.peerId)), [chats]);
  const newPeople = people.filter((person) => !knownPeers.has(person.userId));

  async function removeChat(chat: Chat) {
    const confirmed = window.confirm(chat.group
      ? `Выйти из группы «${chat.name}»?`
      : `Удалить чат с ${chat.name}? История останется у собеседника.`);
    if (!confirmed) return;
    try {
      setDeleteError(null);
      await deleteChat({ chatId: chat.id });
      setOpenRow(null);
      onChatDeleted(chat.id);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Не удалось удалить чат");
    }
  }

  function cycleChatFolders(chat: Chat) {
    const hasWork = chat.folders.includes("work");
    const hasFamily = chat.folders.includes("family");
    const folders: Exclude<Folder, "all">[] = !hasWork && !hasFamily
      ? ["work"]
      : hasWork && !hasFamily
        ? ["work", "family"]
        : hasWork && hasFamily
          ? ["family"]
          : [];
    setChatFolders({ chatId: chat.id, folders });
    setOpenRow(null);
  }

  return (
    <section
      className="chat-list-panel"
      onPointerDown={(event) => {
        pullStartY.current = event.clientY;
      }}
      onPointerUp={(event) => {
        if (pullStartY.current === null) return;
        const distance = event.clientY - pullStartY.current;
        pullStartY.current = null;
        if (distance > 65 && stories.length > 0) setStoriesRevealed(true);
        if (distance < -65) setStoriesRevealed(false);
      }}
      onPointerCancel={() => {
        pullStartY.current = null;
      }}
      onWheel={(event) => {
        if (event.deltaY < -45 && stories.length > 0) setStoriesRevealed(true);
        if (event.deltaY > 65 && storiesRevealed) setStoriesRevealed(false);
      }}
    >
      <header className="relative flex h-20 items-center justify-between px-5">
        <Brand compact />
        <div className="relative flex shrink-0">
          <GlassButton onClick={() => setMenuOpen((value) => !value)} title="Меню">
            <MoreHorizontal size={20} />
          </GlassButton>
          <TopMenu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            onModal={onModal}
            onCreateStory={() => setStoryCreatorOpen(true)}
          />
        </div>
      </header>

      <div className="relative px-5 pb-3">
        <label className="search-box">
          <Search size={18} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск" />
          {query && (
            <button onClick={() => setQuery("")}>
              <X size={15} />
            </button>
          )}
        </label>
        <AnimatePresence>
          {query.trim() && newPeople.length > 0 && (
            <motion.div {...popVariants} className="glass-menu absolute inset-x-5 top-full z-40 mt-1 max-h-72 overflow-y-auto p-1">
              <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Люди в Wyre</p>
              {newPeople.map((person) => (
                <button
                  key={person.userId}
                  onClick={() => {
                    setQuery("");
                    onStartChat(person.userId);
                  }}
                  className="chat-row w-full text-left"
                >
                  <Avatar initials={person.initials} colors={person.colors} avatarUrl={person.avatarUrl} presence={person.online ? "online" : undefined} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-semibold">{person.name}</span>
                      <UserBadge kind={person.badge} />
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-[var(--muted)]">@{person.username}</span>
                  </span>
                  <UserPlus size={17} className="shrink-0 text-[var(--accent1)]" />
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {pendingDevices[0] && (
          <motion.div {...collapseVariants} className="overflow-hidden px-5">
            <div className="device-banner">
              <Laptop size={18} />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium">Вход с нового устройства</p>
                <p className="truncate text-[11px] text-[var(--muted)]">
                  {pendingDevices[0].userAgent}
                  {pendingDevices[0].ip ? ` · ${pendingDevices[0].ip}` : ""}
                  {` · ${new Date(pendingDevices[0].createdAt).toLocaleString("ru-RU")}`}
                </p>
              </div>
              <button
                onClick={() => void approveDeviceSession({ sessionId: pendingDevices[0].id }).then(() => refetchPendingDevices())}
                className="text-[11px] font-semibold text-emerald-400"
              >
                Разрешить
              </button>
              <button
                onClick={() => void denyDeviceSession({ sessionId: pendingDevices[0].id }).then(() => refetchPendingDevices())}
                className="text-[11px] font-semibold text-red-400"
              >
                Отклонить
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {storiesRevealed && stories.length > 0 && (
          <motion.div {...collapseVariants} className="overflow-hidden">
            <div className="stories-row">
              {stories.map((story, index) => (
                <button
                  key={story.id}
                  className="story-item"
                  onClick={() => setStoryViewer({ stories: [...stories], startIndex: index })}
                >
                  <Avatar initials={story.initials} colors={story.colors} ring="unseen" />
                  <span className="story-label">{story.name}</span>
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="folder-tabs">
        <SegmentedControl
          layoutId={layoutIds.folderIndicator}
          value={folder}
          onChange={setFolder}
          options={[
            { value: "all", label: "Все" },
            { value: "work", label: "Работа" },
            { value: "family", label: "Семья" },
          ]}
        />
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-24 md:pb-3">
        {deleteError && <p className="px-3 py-2 text-xs text-red-400">{deleteError}</p>}
        {filtered.map((chat, index) => (
          <motion.div
            key={chat.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(index, 12) * 0.035 }}
            className="mb-1"
          >
            <SwipeableChatRow
              chat={chat}
              open={openRow === chat.id}
              onToggleOpen={(next) => setOpenRow(next ? chat.id : null)}
              onOpenChat={onOpenChat}
              onOpenProfile={onOpenProfile}
              warningOpen={warningRow === chat.id}
              onWarningToggle={() => setWarningRow((value) => (value === chat.id ? null : chat.id))}
              onPin={() => {
                togglePin({ chatId: chat.id });
                setOpenRow(null);
              }}
              onMute={() => {
                toggleMute({ chatId: chat.id });
                setOpenRow(null);
              }}
              onDelete={() => void removeChat(chat)}
              onFolders={() => cycleChatFolders(chat)}
            />
          </motion.div>
        ))}

        {(query.trim() ? discoveredChannels : channels).length > 0 && <div className="mt-3"><p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Каналы</p>{(query.trim() ? discoveredChannels : channels).map((channel) => <button key={channel.id} onClick={() => void (async () => { if (!channel.subscribed) await joinChannel({ channelId: channel.id }); onOpenChannel(channel.id); })()} className="chat-row w-full cursor-pointer text-left"><Avatar initials={channel.initials} colors={channel.colors} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{channel.title}</p><p className="mt-1 truncate text-xs text-[var(--muted)]">{channel.description || `${channel.subscribers} подписчиков`}</p></div><Radio size={16} className="text-[var(--accent1)]" /></button>)}</div>}

        {!filtered.length && !newPeople.length && (
          <div className="py-16 text-center text-sm text-[var(--muted)]">
            {isLoading ? "Загружаем чаты…" : query ? "Ничего не найдено" : "Пока нет чатов. Найдите человека по имени или @username."}
          </div>
        )}
      </div>
      <StoriesLayer
        creatorOpen={storyCreatorOpen}
        onCreatorClose={() => setStoryCreatorOpen(false)}
        viewer={storyViewer}
        onViewerClose={() => setStoryViewer(null)}
      />
    </section>
  );
}
