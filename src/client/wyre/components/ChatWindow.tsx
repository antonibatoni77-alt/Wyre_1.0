import {
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  AudioLines,
  Bell,
  Bookmark,
  Check,
  CheckCheck,
  Clock,
  Copy,
  Crown,
  Download,
  Edit3,
  File,
  Folder,
  Forward,
  Hash,
  Image,
  Languages,
  ListChecks,
  MapPin,
  MoreHorizontal,
  Paperclip,
  Pause,
  Phone,
  PhoneCall,
  Pin,
  Play,
  Reply,
  Search,
  Send,
  Smile,
  Sparkles,
  StickyNote,
  Trash2,
  Timer,
  User,
  UserMinus,
  UserPlus,
  Users,
  Video,
  Volume2,
  X,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { onWyrePresence, wyreLiveQuery, wyreMutation, wyreQuietMutation, wyreQuery } from "../../lib/api";
import { cn } from "../utils/cn";
import type { Chat, ChatMessage, ChatTopic, PickerKind } from "../data";
import type { Person } from "../types";
import { emojiCategories, emojis, gifs, stickerPacks } from "../data";
import { Avatar, GlassButton, PrimaryButton, UserBadge, WarningIndicator } from "./Glass";
import { MediaViewer, type MediaItem } from "./MediaViewer";
import { modalVariants, popVariants } from "../utils/motion";
import { mediaAccessError, requestMediaStream } from "../utils/mediaPermissions";
import { formatFileSize, uploadSignedFile } from "../utils/upload";

function Waveform({ active = false }: { active?: boolean }) {
  return (
    <span className="flex h-5 items-center gap-[2px]">
      {Array.from({ length: 18 }, (_, index) => (
        <motion.span
          key={index}
          animate={active ? { height: [4, 6 + ((index * 7) % 14), 4] } : undefined}
          transition={active ? { duration: 0.65, repeat: Infinity, delay: index * 0.025 } : undefined}
          className="w-[2px] rounded-full bg-current"
          style={{ height: `${4 + ((index * 5) % 13)}px` }}
        />
      ))}
    </span>
  );
}

function formatDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.round(totalSeconds || 0));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function timerLabel(seconds?: number | null) {
  if (!seconds) return "без таймера";
  if (seconds < 60) return `${seconds} с`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} мин`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} ч`;
  return `${Math.round(seconds / 86400)} дн`;
}

function messagePayload<T>(text: string) {
  try { return JSON.parse(text) as T; } catch { return null; }
}

/** Deterministic pseudo-waveform (used only if real amplitude decoding fails, e.g. no CORS). */
function fallbackPeaks(seed: string, count: number) {
  const hash = Array.from(seed).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return Array.from({ length: count }, (_, index) => 0.25 + (((hash + index * 17) % 23) / 23) * 0.75);
}

/** Real playback waveform: decodes the actual audio to amplitude peaks, with a graceful fallback. */
function VoicePlayer({ src, duration }: { src?: string; duration?: number }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [totalSeconds, setTotalSeconds] = useState(duration ?? 0);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const sampleCount = 30;

  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    (async () => {
      try {
        const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtx) throw new Error("no AudioContext");
        const ctx = new AudioCtx();
        const buffer = await (await fetch(src)).arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(buffer);
        if (cancelled) return;
        const channel = audioBuffer.getChannelData(0);
        const blockSize = Math.max(1, Math.floor(channel.length / sampleCount));
        const raw: number[] = [];
        for (let i = 0; i < sampleCount; i += 1) {
          let sum = 0;
          const start = i * blockSize;
          for (let j = 0; j < blockSize; j += 1) sum += Math.abs(channel[start + j] ?? 0);
          raw.push(sum / blockSize);
        }
        const max = Math.max(...raw, 0.0001);
        setPeaks(raw.map((value) => Math.max(0.15, value / max)));
        void ctx.close();
      } catch {
        if (!cancelled) setPeaks(fallbackPeaks(src, sampleCount));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src]);

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) audio.pause();
    else void audio.play().catch(() => undefined);
  }

  const displaySeconds = playing || progress > 0 ? Math.round(progress * totalSeconds) : totalSeconds;

  return (
    <span className="flex min-w-52 items-center gap-3">
      {src && (
        <audio
          ref={audioRef}
          src={src}
          preload="metadata"
          className="hidden"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setProgress(0);
          }}
          onLoadedMetadata={(event) => {
            const value = event.currentTarget.duration;
            if (Number.isFinite(value) && value > 0) setTotalSeconds(Math.round(value));
          }}
          onTimeUpdate={(event) => {
            const el = event.currentTarget;
            if (el.duration) setProgress(el.currentTime / el.duration);
          }}
        />
      )}
      <button
        onClick={toggle}
        disabled={!src}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/15 transition hover:bg-white/25 disabled:opacity-50"
      >
        {playing ? <Pause size={15} /> : <Volume2 size={15} />}
      </button>
      <span className="flex h-5 flex-1 items-center gap-[2px]">
        {(peaks ?? Array.from({ length: sampleCount }, () => 0.3)).map((level, index) => {
          const played = progress * sampleCount > index;
          return (
            <span
              key={index}
              className={cn("w-[2px] shrink-0 rounded-full", played ? "bg-current" : "bg-current/40")}
              style={{ height: `${4 + level * 14}px` }}
            />
          );
        })}
      </span>
      <span className="shrink-0 text-[10px] tabular-nums">{formatDuration(displaySeconds)}</span>
    </span>
  );
}

/** Circular video-message player (Telegram-style "video circle"). */
function VideoCircle({ src, duration }: { src?: string; duration?: number }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);

  function toggle() {
    const video = videoRef.current;
    if (!video) return;
    if (playing) video.pause();
    else void video.play().catch(() => undefined);
  }

  return (
    <button
      onClick={toggle}
      disabled={!src}
      className="relative block h-48 w-48 overflow-hidden rounded-full bg-black/40 disabled:opacity-60"
    >
      {src ? (
        <video
          ref={videoRef}
          src={src}
          playsInline
          className="h-full w-full object-cover"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
      ) : (
        <span className="grid h-full w-full place-items-center">
          <Video size={28} />
        </span>
      )}
      {!playing && (
        <span className="absolute inset-0 grid place-items-center bg-black/20">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-white/25 backdrop-blur">
            <Play size={20} className="fill-white" />
          </span>
        </span>
      )}
      {typeof duration === "number" && (
        <span className="absolute bottom-2 right-3 rounded-full bg-black/60 px-2 py-0.5 text-[10px]">{formatDuration(duration)}</span>
      )}
    </button>
  );
}

function StatusTicks({ status, statusAt }: { status?: ChatMessage["status"]; statusAt?: string }) {
  if (!status) return null;
  const time = statusAt ? new Date(statusAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  const label = status === "read" ? "Прочитано" : status === "delivered" ? "Доставлено" : "Отправлено";
  return (
    <span className="status-ticks" title={`${label}${time ? ` · ${time}` : ""}`}>
      {status === "sent" && <Check size={12} />}
      {status !== "sent" && <CheckCheck size={12} className={status === "read" ? "text-sky-300" : ""} />}
    </span>
  );
}

const MessageBubble = memo(function MessageBubble({
  message,
  onReact,
  onVote,
  onClosePoll,
  onInvokeAction,
  onCheckLinkSafety,
  onStopLiveLocation,
  onFolderTransferStatus,
  onViewMedia,
  onMenu,
  registerRef,
  highlighted,
  selecting,
  selected,
  onSelect,
}: {
  message: ChatMessage;
  onReact: (id: string, emoji: string) => void;
  onVote: (id: string, optionId: string) => void;
  onClosePoll: (id: string) => void;
  onInvokeAction: (id: string, actionId: string) => void;
  onCheckLinkSafety: (id: string) => Promise<{ level: "low" | "medium" | "high"; reason: string }>;
  onStopLiveLocation: (id: string) => void;
  onFolderTransferStatus: (id: string, status: "accepted" | "completed" | "declined") => Promise<unknown>;
  onViewMedia: (item: MediaItem) => void;
  onMenu: (id: string, x: number, y: number) => void;
  registerRef: (id: string, el: HTMLDivElement | null) => void;
  highlighted: boolean;
  selecting: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const [reactionsOpen, setReactionsOpen] = useState(false);
  const [fileSaveState, setFileSaveState] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);
  const [checkingLink, setCheckingLink] = useState(false);
  const pressTimer = useRef<number | null>(null);
  const contact = message.kind === "contact" ? messagePayload<{ userId: string; name: string; username: string }>(message.text) : null;
  const location = message.kind === "location" ? messagePayload<{ latitude: number; longitude: number; accuracy?: number }>(message.text) : null;
  const poll = message.kind === "poll" ? message.poll : null;

  function startPress(event: ReactPointerEvent) {
    const { clientX, clientY } = event;
    pressTimer.current = window.setTimeout(() => onMenu(message.id, clientX, clientY), 480);
  }
  function clearPress() {
    if (pressTimer.current) window.clearTimeout(pressTimer.current);
  }

  async function saveFileToFolder() {
    if (!message.fileUrl) return;
    setFileSaveState("saving");
    try {
      if (message.folderTransfer?.canRespond && message.folderTransfer.status === "pending") await onFolderTransferStatus(message.id, "accepted");
      const showDirectoryPicker = (window as unknown as { showDirectoryPicker?: () => Promise<{ getFileHandle: (name: string, options: { create: boolean }) => Promise<{ createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }> }> }> }).showDirectoryPicker;
      if (!showDirectoryPicker) {
        const download = document.createElement("a");
        download.href = message.fileUrl;
        download.download = message.fileName ?? "wyre-file";
        download.click();
        if (message.folderTransfer?.canRespond) await onFolderTransferStatus(message.id, "completed");
        setFileSaveState("done");
        return;
      }
      const directory = await showDirectoryPicker();
      const response = await fetch(message.fileUrl);
      if (!response.ok) throw new Error("download failed");
      const file = await directory.getFileHandle((message.fileName ?? "wyre-file").replace(/[\\/:*?"<>|]/g, "_"), { create: true });
      const writable = await file.createWritable();
      await writable.write(await response.blob());
      await writable.close();
      if (message.folderTransfer?.canRespond) await onFolderTransferStatus(message.id, "completed");
      setFileSaveState("done");
    } catch (error) {
      setFileSaveState(error instanceof DOMException && error.name === "AbortError" ? "idle" : "error");
    }
  }

  async function openCheckedLink() {
    if (!message.link?.url || checkingLink) return;
    setCheckingLink(true);
    try {
      const safety = message.linkSafety ?? await onCheckLinkSafety(message.id);
      if (safety.level !== "low" && !window.confirm(`Ссылка может быть опасной: ${safety.reason}\n\nВсё равно открыть?`)) return;
      setBrowserUrl(message.link.url);
    } finally {
      setCheckingLink(false);
    }
  }

  return (
    <>
      {message.date && (
        <div className="date-divider">
          <span>{message.date}</span>
        </div>
      )}
      <motion.div
        ref={(el) => registerRef(message.id, el)}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.14, ease: "easeOut" }}
        className={cn("message-wrap group", message.mine ? "justify-end" : "justify-start", message.pending && "opacity-70")}
      >
        <div className="relative max-w-[82%] sm:max-w-[68%]">
          {message.pinned && <Pin size={13} className={cn("pin-flag", message.mine ? "mine" : "theirs")} />}
          <div
            onClick={() => selecting && onSelect(message.id)}
            onPointerDown={startPress}
            onPointerUp={clearPress}
            onPointerLeave={clearPress}
            onContextMenu={(event) => {
              event.preventDefault();
              onMenu(message.id, event.clientX, event.clientY);
            }}
            className={cn(
              "message-bubble text-left transition-shadow",
              message.mine ? "message-mine" : "message-theirs",
              highlighted && "ring-2 ring-amber-400",
              selected && "ring-2 ring-[var(--accent1)]",
              message.mentioned && !message.mine && "ring-1 ring-[var(--accent1)]",
            )}
          >
            {selecting && <span className={cn("absolute -left-7 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-full border", selected ? "border-transparent bg-[var(--accent1)]" : "border-white/25 bg-black/20")}>{selected ? <Check size={12} /> : null}</span>}
            {message.forwardedFromName && <span className="mb-1.5 block text-[10px] font-semibold text-white/65">Переслано от {message.forwardedFromName}</span>}
            {message.mentioned && !message.mine && <span className="mb-1 block text-[10px] font-semibold text-[var(--accent1)]">Упоминание для вас</span>}
            {message.kind === "sticker" && <span className="block py-2 text-6xl">{message.text}</span>}
            {message.kind === "voice" && <span className="block"><VoicePlayer src={message.fileUrl} duration={message.duration} />{message.transcription ? <span className="mt-2 block rounded-xl bg-black/15 px-3 py-2 text-xs leading-5">{message.transcription}</span> : null}</span>}
            {message.kind === "video" && <VideoCircle src={message.fileUrl} duration={message.duration} />}
            {message.kind === "file" && message.fileUrl && message.mimeType?.startsWith("image/") && (
              <button
                type="button"
                onClick={(event) => { event.stopPropagation(); onViewMedia({ url: message.fileUrl!, mimeType: message.mimeType!, fileName: message.fileName ?? undefined, caption: message.text }); }}
                className="-m-1 block w-full overflow-hidden rounded-xl text-left"
              >
                <img src={message.fileUrl} alt={message.fileName ?? "Изображение"} loading="lazy" decoding="async" className="max-h-72 w-full object-cover" />
                {message.text && <span className="mt-1 block px-1 text-xs">{message.text}</span>}
              </button>
            )}
            {message.kind === "file" && message.fileUrl && message.mimeType?.startsWith("video/") && (
              <span className="block">
                <button
                  type="button"
                  onClick={(event) => { event.stopPropagation(); onViewMedia({ url: message.fileUrl!, mimeType: message.mimeType!, fileName: message.fileName ?? undefined, caption: message.text }); }}
                  className="relative block w-full overflow-hidden rounded-xl"
                >
                  <video src={message.fileUrl} muted preload="metadata" playsInline className="max-h-72 w-full rounded-xl bg-black/40 object-cover" />
                  <span className="absolute inset-0 grid place-items-center">
                    <span className="grid h-12 w-12 place-items-center rounded-full bg-white/25 backdrop-blur"><Play size={20} className="fill-white" /></span>
                  </span>
                </button>
                {message.text && <span className="mt-1 block text-xs">{message.text}</span>}
              </span>
            )}
            {message.kind === "file" && !(message.mimeType?.startsWith("image/") || message.mimeType?.startsWith("video/")) && (
              <a
                href={message.fileUrl ? `${message.fileUrl}&download=1` : undefined}
                download={message.fileName ?? undefined}
                className={cn("flex items-center gap-3", !message.fileUrl && "pointer-events-none")}
              >
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-white/15">
                  <File size={20} />
                </span>
                <span>
                  <span className="block">{message.fileName ?? message.text}</span>
                  {message.fileSize && <span className="block text-[10px] opacity-70">{message.fileSize}</span>}
                </span>
                {message.fileUrl && <Download size={14} className="ml-auto opacity-60" />}
              </a>
            )}
            {message.kind === "file" && message.fileUrl && (!message.folderTransfer || message.folderTransfer.canRespond) && message.folderTransfer?.status !== "completed" && message.folderTransfer?.status !== "declined" && <button onClick={() => void saveFileToFolder()} disabled={fileSaveState === "saving"} className="mt-2 flex items-center gap-1 text-[10px] font-semibold underline decoration-white/40 underline-offset-2 disabled:opacity-50"><Folder size={11} />{fileSaveState === "saving" ? "Сохраняем…" : fileSaveState === "done" ? "Сохранено" : fileSaveState === "error" ? "Повторить сохранение" : message.folderTransfer?.status === "pending" ? "Разрешить и выбрать папку" : "Сохранить в выбранную папку"}</button>}
            {message.folderTransfer?.canRespond && message.folderTransfer.status === "pending" && <button onClick={() => void onFolderTransferStatus(message.id, "declined")} className="mt-1 block text-[10px] text-red-300 underline decoration-red-300/40 underline-offset-2">Отклонить</button>}
            {message.folderTransfer && (!message.folderTransfer.canRespond || ["completed", "declined"].includes(message.folderTransfer.status)) && <span className="mt-2 block text-[10px] opacity-65">{message.folderTransfer.status === "pending" ? "Ожидает разрешения получателя" : message.folderTransfer.status === "accepted" ? "Получатель разрешил сохранение" : message.folderTransfer.status === "completed" ? "Файл сохранён получателем" : "Получатель отклонил запрос"}</span>}
            {message.kind === "html" && (
              <span className="block">
                {message.fileUrl ? (
                  <iframe src={message.fileUrl} sandbox="" title={message.fileName ?? "HTML-превью"} className="mb-2 h-48 w-full rounded-lg border border-white/15 bg-white" />
                ) : (
                  <span className="mb-2 block rounded-lg border border-white/15 bg-black/20 px-2 py-3 font-mono text-[10px]">&lt;/&gt; preview.html</span>
                )}
                {message.fileUrl ? (
                  <a href={message.fileUrl} download={message.fileName ?? "preview.html"} className="flex items-center gap-1 text-[11px] font-semibold underline decoration-white/40 underline-offset-2">
                    <Download size={12} /> Скачать файл
                  </a>
                ) : null}
              </span>
            )}
            {message.kind === "link" && message.link && (
              <span className="block">
                <span>{message.text}</span>
                <button onClick={() => void openCheckedLink()} disabled={checkingLink} className="link-preview-card mt-2 w-full text-left disabled:opacity-60" style={{ "--lp1": message.link.colors[0], "--lp2": message.link.colors[1] } as never}>
                  <span className="link-preview-thumb block" />
                  <span className="link-preview-body block">
                    <span className="block text-[11px] font-semibold">{message.link.title}</span>
                    {message.link.description && <span className="mt-0.5 block line-clamp-2 text-[10px] opacity-70">{message.link.description}</span>}
                    <span className="mt-0.5 block text-[10px] opacity-70">{checkingLink ? "Проверяем ссылку…" : message.linkSafety ? `${message.link.domain} · ${message.linkSafety.level === "low" ? "проверено" : "есть риск"}` : message.link.domain}</span>
                  </span>
                </button>
              </span>
            )}
            {poll && (
              <span className="block min-w-56">
                <span className="mb-3 flex items-start justify-between gap-3">
                  <span>
                    <span className="block text-[10px] font-semibold uppercase tracking-wide opacity-65">{poll.quiz ? "Квиз" : "Опрос"}</span>
                    <span className="mt-1 block text-sm font-semibold leading-5">{poll.question}</span>
                  </span>
                  {poll.canClose && <button type="button" onClick={(event) => { event.stopPropagation(); onClosePoll(message.id); }} className="shrink-0 rounded-full border border-white/15 px-2 py-1 text-[9px] font-semibold opacity-70 hover:bg-white/10">Закрыть</button>}
                </span>
                <span className="space-y-2">
                  {poll.options.map((option) => {
                    const percent = poll.totalVotes ? Math.round((option.votes / poll.totalVotes) * 100) : 0;
                    const correct = poll.correctOptionId === option.id;
                    const wrong = Boolean(poll.correctOptionId && option.selected && !correct);
                    return (
                      <button
                        key={option.id}
                        type="button"
                        disabled={poll.closed}
                        onClick={(event) => { event.stopPropagation(); onVote(message.id, option.id); }}
                        className={cn(
                          "relative block w-full overflow-hidden rounded-xl border border-white/15 px-3 py-2 text-left text-xs transition disabled:cursor-default",
                          option.selected && !poll.correctOptionId && "border-white/40 bg-white/10",
                          correct && "border-emerald-300/60 bg-emerald-400/10",
                          wrong && "border-red-300/60 bg-red-400/10",
                        )}
                      >
                        <span className="absolute inset-y-0 left-0 bg-white/10" style={{ width: `${percent}%` }} />
                        <span className="relative flex items-center justify-between gap-3"><span>{option.text}</span><span className="text-[10px] opacity-70">{percent}% · {option.votes}</span></span>
                      </button>
                    );
                  })}
                </span>
                <span className="mt-2 block text-[10px] opacity-65">{poll.totalVotes} голосов{poll.closed ? " · завершён" : ""}</span>
              </span>
            )}
            {message.kind === "actions" && message.actions?.length ? (
              <span className="block min-w-56">
                <span>{message.text}</span>
                <span className="mt-3 flex flex-wrap gap-2">
                  {message.actions.map((action) => {
                    const used = Boolean(message.usedActionId);
                    const chosen = message.usedActionId === action.id;
                    return (
                      <button
                        key={action.id}
                        type="button"
                        disabled={used}
                        onClick={(event) => { event.stopPropagation(); onInvokeAction(message.id, action.id); }}
                        className={cn(
                          "rounded-xl border px-3 py-2 text-xs font-semibold transition",
                          chosen ? "border-[var(--accent1)]/60 bg-[var(--accent1)]/20" : "border-white/20 bg-white/5 hover:bg-white/10",
                          used && !chosen && "opacity-40",
                        )}
                      >
                        {chosen ? `✓ ${action.label}` : action.label}
                      </button>
                    );
                  })}
                </span>
              </span>
            ) : null}
            {contact && <span className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-full bg-white/15"><User size={19} /></span><span><span className="block font-semibold">{contact.name}</span><span className="block text-[10px] opacity-70">@{contact.username}</span></span></span>}
            {location && <span className="block overflow-hidden rounded-xl border border-white/15"><a href={`https://www.openstreetmap.org/?mlat=${location.latitude}&mlon=${location.longitude}#map=16/${location.latitude}/${location.longitude}`} target="_blank" rel="noreferrer" className="block"><span className="grid h-28 place-items-center bg-gradient-to-br from-emerald-500/25 to-sky-500/25"><MapPin size={30} /></span><span className="block px-3 py-2 text-xs font-semibold">{message.liveLocation ? message.liveLocation.stopped ? "Последняя геопозиция" : "Live-геопозиция" : "Открыть геопозицию"}{location.accuracy ? ` · ±${Math.round(location.accuracy)} м` : ""}</span></a>{message.liveLocation && <span className="flex items-center justify-between border-t border-white/10 px-3 py-2 text-[10px] opacity-75"><span>{message.liveLocation.stopped ? "Трансляция завершена" : `Обновлено ${new Date(message.liveLocation.updatedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`}</span>{message.mine && !message.liveLocation.stopped && <button type="button" onClick={(event) => { event.stopPropagation(); onStopLiveLocation(message.id); }} className="font-semibold text-red-300">Остановить</button>}</span>}</span>}
            {message.replyToText && (
              <span className="mb-1.5 block border-l-2 border-white/40 pl-2 text-[11px] opacity-75">{message.replyToText}</span>
            )}
            {(!message.kind || message.kind === "text") && message.text}
            {message.translation && <span className="mt-2 block rounded-xl border border-white/10 bg-black/15 px-3 py-2 text-xs leading-5"><span className="mb-1 block text-[9px] font-semibold uppercase tracking-wide opacity-55">Перевод</span>{message.translation}</span>}

            <span className="ml-3 inline-flex translate-y-1 items-center gap-1 text-[9px] opacity-65">
              {message.bookmarked && <Bookmark size={10} className="fill-current" />}
              {message.edited && <span className="mr-0.5">изм.</span>}
              {message.scheduledAt ? (
                <>
                  <Clock size={11} /> {message.scheduledAt}
                </>
              ) : (
                <>
                  {message.time}
                  {message.selfDestructSeconds && <><Timer size={10} /> {timerLabel(message.selfDestructSeconds)}</>}
                  {message.pending && <span className="ml-1 opacity-70">отправляется…</span>}
                  {message.mine && !message.pending && <StatusTicks status={message.status} statusAt={message.statusAt} />}
                </>
              )}
            </span>
          </div>

          <button onClick={() => setReactionsOpen((value) => !value)} className={cn("reaction-trigger", message.mine ? "-left-8" : "-right-8")}>
            <Smile size={14} />
          </button>

          <AnimatePresence>
            {reactionsOpen && (
              <motion.div {...popVariants} className={cn("reaction-menu", message.mine ? "right-0" : "left-0")}>
                {emojis.slice(0, 6).map((emoji) => (
                  <button
                    key={emoji}
                    onClick={() => {
                      onReact(message.id, emoji);
                      setReactionsOpen(false);
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {message.reaction && (
              <motion.span
                initial={{ scale: 0, y: 8 }}
                animate={{ scale: 1, y: 0 }}
                transition={{ type: "spring", stiffness: 500, damping: 18 }}
                className={cn("message-reaction", message.mine ? "right-2" : "left-2")}
              >
                {message.reaction}
              </motion.span>
            )}
          </AnimatePresence>
          <AnimatePresence>
            {browserUrl && <><button aria-label="Закрыть мини-браузер" onClick={() => setBrowserUrl(null)} className="fixed inset-0 z-[80] bg-black/70" /><motion.div {...modalVariants} className="fixed inset-4 z-[81] flex flex-col overflow-hidden rounded-[var(--r-xl)] border border-[var(--line)] bg-[var(--surface-solid)] shadow-2xl md:inset-12"><div className="flex h-12 items-center gap-2 border-b border-[var(--line)] px-3"><span className="min-w-0 flex-1 truncate text-[10px] text-[var(--muted)]">{browserUrl}</span><a href={browserUrl} target="_blank" rel="noreferrer" className="text-[10px] font-semibold text-[var(--accent1)]">Открыть снаружи</a><button onClick={() => setBrowserUrl(null)} className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/10"><X size={15} /></button></div><iframe src={browserUrl} sandbox="allow-forms allow-popups" referrerPolicy="no-referrer" title="Мини-браузер Wyre" className="min-h-0 flex-1 bg-white" /></motion.div></>}
          </AnimatePresence>
        </div>
      </motion.div>
    </>
  );
});

function ComposerPicker({
  kind,
  onEmoji,
  onSticker,
  onAttachment,
  onStructured,
  onPoll,
  allowPoll,
  onLiveLocation,
  onClose,
  uploading,
  uploadProgress,
}: {
  kind: PickerKind;
  onEmoji: (emoji: string) => void;
  onSticker: (sticker: string) => void;
  onAttachment: (file: File, caption: string, requestFolderTransfer: boolean) => void;
  onStructured: (kind: "contact" | "location", payload: string) => void;
  onPoll: (poll: { question: string; options: string[]; quiz: boolean; correctOptionIndex: number | null }) => Promise<void>;
  allowPoll: boolean;
  onLiveLocation: (minutes: 15 | 60 | 480) => Promise<void>;
  onClose: () => void;
  uploading: boolean;
  uploadProgress: number;
}) {
  const [tab, setTab] = useState<"emoji" | "gif" | "sticker">("emoji");
  const [emojiCategory, setEmojiCategory] = useState(0);
  const [pack, setPack] = useState<keyof typeof stickerPacks>("Mellow");
  const [caption, setCaption] = useState("");
  const [attachmentType, setAttachmentType] = useState("Фото");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [contactQuery, setContactQuery] = useState("");
  const [locating, setLocating] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [pollQuestion, setPollQuestion] = useState("");
  const [pollOptions, setPollOptions] = useState(["", ""]);
  const [pollQuiz, setPollQuiz] = useState(false);
  const [pollCorrectIndex, setPollCorrectIndex] = useState<number | null>(null);
  const [pollSubmitting, setPollSubmitting] = useState(false);
  const [liveMinutes, setLiveMinutes] = useState<15 | 60 | 480>(15);
  const [requestFolderTransfer, setRequestFolderTransfer] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data: contactPeople = [] } = useQuery({ ...wyreLiveQuery<Person[]>("wyre.searchPeople", { query: contactQuery }), enabled: kind === "attachment" && attachmentType === "Контакт" });
  if (!kind) return null;

  const attachmentTypes = [
    { name: "Фото", icon: Image, accept: "image/*", ready: true },
    { name: "Видео", icon: Video, accept: "video/*", ready: true },
    { name: "Файл", icon: File, accept: "*/*", ready: true },
    { name: "Гео", icon: MapPin, accept: undefined, ready: true },
    { name: "Контакт", icon: User, accept: undefined, ready: true },
    ...(allowPoll ? [{ name: "Опрос", icon: ListChecks, accept: undefined, ready: true }] : []),
  ];

  if (kind === "attachment") {
    const activeType = attachmentTypes.find((item) => item.name === attachmentType);
    return (
      <motion.div {...modalVariants} className="composer-picker">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-xs font-semibold">Вложение</span>
          <button onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          // The `accept` list must be rebuilt when the type changes, otherwise
          // the OS dialog keeps the previous filter (photos while sending video).
          key={attachmentType}
          accept={activeType?.accept}
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            setSelectedFile(file ?? null);
            event.target.value = "";
          }}
        />
        <div className="grid grid-cols-3 gap-2">
          {attachmentTypes.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.name}
                onClick={() => {
                  setAttachmentType(item.name);
                  setSelectedFile(null);
                  setPickerError(null);
                  // React must apply the new `accept` before the dialog opens.
                  if (item.ready && item.name !== "Гео" && item.name !== "Контакт" && item.name !== "Опрос") {
                    window.setTimeout(() => fileInputRef.current?.click(), 0);
                  }
                }}
                className={cn(
                  "attachment-type",
                  attachmentType === item.name && "attachment-active",
                )}
              >
                <Icon size={19} />
                <span>{item.name}</span>
              </button>
            );
          })}
        </div>
        {attachmentType === "Опрос" ? (
          <div className="mt-4 space-y-3">
            <input value={pollQuestion} onChange={(event) => setPollQuestion(event.target.value)} maxLength={300} className="glass-input" placeholder="Вопрос" />
            <div className="space-y-2">
              {pollOptions.map((option, index) => (
                <div key={index} className="flex items-center gap-2">
                  {pollQuiz && <button type="button" onClick={() => setPollCorrectIndex(index)} aria-label="Правильный ответ" className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-full border text-[10px]", pollCorrectIndex === index ? "border-emerald-300 bg-emerald-400/20" : "border-[var(--line)]")}><Check size={13} /></button>}
                  <input value={option} onChange={(event) => setPollOptions((items) => items.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} maxLength={100} className="glass-input min-w-0 flex-1" placeholder={`Вариант ${index + 1}`} />
                  {pollOptions.length > 2 && <button type="button" onClick={() => { setPollOptions((items) => items.filter((_, itemIndex) => itemIndex !== index)); setPollCorrectIndex((current) => current === index ? null : current != null && current > index ? current - 1 : current); }} className="grid h-8 w-8 shrink-0 place-items-center rounded-full hover:bg-white/10"><X size={13} /></button>}
                </div>
              ))}
            </div>
            {pollOptions.length < 10 && <button type="button" onClick={() => setPollOptions((items) => [...items, ""])} className="text-[11px] font-semibold text-[var(--accent1)]">+ Добавить вариант</button>}
            <button type="button" onClick={() => { setPollQuiz((value) => !value); if (pollQuiz) setPollCorrectIndex(null); }} className="flex w-full items-center justify-between rounded-xl border border-[var(--line)] px-3 py-2 text-left text-xs"><span><span className="block font-semibold">Режим квиза</span><span className="text-[10px] text-[var(--muted)]">Укажите один правильный ответ</span></span><span className={cn("h-5 w-9 rounded-full p-0.5 transition", pollQuiz ? "bg-[var(--accent1)]" : "bg-white/15")}><span className={cn("block h-4 w-4 rounded-full bg-white transition", pollQuiz && "translate-x-4")} /></span></button>
            <PrimaryButton
              disabled={pollSubmitting || !pollQuestion.trim() || pollOptions.some((option) => !option.trim()) || (pollQuiz && pollCorrectIndex == null)}
              onClick={async () => {
                setPickerError(null);
                setPollSubmitting(true);
                try {
                  await onPoll({ question: pollQuestion, options: pollOptions, quiz: pollQuiz, correctOptionIndex: pollQuiz ? pollCorrectIndex : null });
                } catch (error) {
                  setPickerError(error instanceof Error ? error.message : "Не удалось создать опрос");
                } finally {
                  setPollSubmitting(false);
                }
              }}
              className="w-full"
            >
              <ListChecks size={16} /> {pollSubmitting ? "Создаём…" : "Создать опрос"}
            </PrimaryButton>
            {pickerError && <p className="text-xs text-red-400">{pickerError}</p>}
          </div>
        ) : attachmentType === "Гео" ? (
          <div className="mt-4">
            <p className="text-xs text-[var(--muted)]">Wyre запросит геопозицию только для этой отправки.</p>
            <PrimaryButton disabled={locating} onClick={() => { setLocating(true); setPickerError(null); navigator.geolocation.getCurrentPosition((position) => { onStructured("location", JSON.stringify({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy })); setLocating(false); }, (error) => { setPickerError(error.message || "Не удалось получить геопозицию"); setLocating(false); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }); }} className="mt-3 w-full"><MapPin size={16} /> {locating ? "Определяем…" : "Отправить геопозицию"}</PrimaryButton>
            <div className="mt-3 flex gap-2"><select value={liveMinutes} onChange={(event) => setLiveMinutes(Number(event.target.value) as 15 | 60 | 480)} className="glass-select flex-1"><option value="15">15 минут</option><option value="60">1 час</option><option value="480">8 часов</option></select><PrimaryButton disabled={locating} onClick={() => { setLocating(true); setPickerError(null); void onLiveLocation(liveMinutes).catch((error) => setPickerError(error instanceof Error ? error.message : "Не удалось начать трансляцию")).finally(() => setLocating(false)); }}><MapPin size={16} /> Делиться</PrimaryButton></div>
            {pickerError && <p className="mt-2 text-xs text-red-400">{pickerError}</p>}
          </div>
        ) : attachmentType === "Контакт" ? (
          <div className="mt-4">
            <label className="search-box"><Search size={14} /><input value={contactQuery} onChange={(event) => setContactQuery(event.target.value)} placeholder="Имя или @username" /></label>
            <div className="mt-2 max-h-48 overflow-y-auto rounded-2xl border border-[var(--line)] p-1">{contactPeople.map((person) => <button key={person.userId} onClick={() => onStructured("contact", JSON.stringify({ userId: person.userId }))} className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left hover:bg-white/5"><Avatar initials={person.initials} colors={person.colors} size="sm" /><span><span className="block text-xs font-semibold">{person.name}</span><span className="block text-[10px] text-[var(--muted)]">@{person.username}</span></span></button>)}{!contactPeople.length && <p className="p-3 text-center text-xs text-[var(--muted)]">Контакты не найдены</p>}</div>
          </div>
        ) : activeType?.ready ? (
          <>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="glass-input mt-4 flex w-full items-center justify-between text-left text-xs"
            >
              <span className="truncate">{selectedFile ? selectedFile.name : "Выбрать файл…"}</span>
              {selectedFile && <span className="ml-2 shrink-0 opacity-60">{formatFileSize(selectedFile.size)}</span>}
            </button>
            <input value={caption} onChange={(event) => setCaption(event.target.value)} className="glass-input mt-3" placeholder="Добавить подпись" />
            {attachmentType === "Файл" && <label className="mt-3 flex items-center gap-2 rounded-xl border border-[var(--line)] px-3 py-2 text-xs"><input type="checkbox" checked={requestFolderTransfer} onChange={(event) => setRequestFolderTransfer(event.target.checked)} /><span>Попросить сохранить в выбранную папку устройства</span></label>}
            <PrimaryButton
              onClick={() => selectedFile && onAttachment(selectedFile, caption, requestFolderTransfer)}
              disabled={!selectedFile || uploading}
              className="mt-3 w-full"
            >
              {uploading ? `Отправка… ${uploadProgress}%` : "Прикрепить"}
            </PrimaryButton>
          </>
        ) : null}
      </motion.div>
    );
  }

  return (
    <motion.div {...modalVariants} className="composer-picker">
      <div className="mb-3 flex items-center gap-1 border-b border-white/10 pb-3">
        {(["emoji", "gif", "sticker"] as const).map((item) => (
          <button key={item} onClick={() => setTab(item)} className={cn("picker-tab", tab === item && "picker-tab-active")}>
            {item === "emoji" ? "Emoji" : item === "gif" ? "GIF" : "Стикеры"}
          </button>
        ))}
        <button onClick={onClose} className="ml-auto">
          <X size={15} />
        </button>
      </div>
      {tab === "emoji" && (
        <>
          <div className="mb-2 flex gap-1 overflow-x-auto border-b border-white/10 pb-2">
            {emojiCategories.map((category, index) => (
              <button
                key={category.name}
                type="button"
                title={category.name}
                onClick={() => setEmojiCategory(index)}
                className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg text-lg transition", emojiCategory === index ? "bg-[var(--accent1)]/25" : "hover:bg-white/10")}
              >
                {category.icon}
              </button>
            ))}
          </div>
          <div className="grid max-h-56 grid-cols-8 gap-0.5 overflow-y-auto">
            {emojiCategories[emojiCategory].emojis.map((emoji) => (
              <button key={emoji} onClick={() => onEmoji(emoji)} className="rounded-lg p-1 text-xl transition hover:bg-white/10">
                {emoji}
              </button>
            ))}
          </div>
        </>
      )}
      {tab === "gif" && (
        <div className="grid grid-cols-3 gap-2">
          {gifs.map((gif) => (
            <motion.button
              key={gif}
              animate={{ rotate: [0, 4, -4, 0] }}
              transition={{ repeat: Infinity, duration: 2.4 }}
              onClick={() => onSticker(gif)}
              className="grid aspect-square place-items-center rounded-xl bg-white/5 text-3xl"
            >
              {gif}
            </motion.button>
          ))}
        </div>
      )}
      {tab === "sticker" && (
        <>
          <div className="mb-3 flex gap-2 border-b border-white/10 pb-2">
            {(Object.keys(stickerPacks) as (keyof typeof stickerPacks)[]).map((packName) => (
              <button key={packName} onClick={() => setPack(packName)} className={cn("picker-tab", pack === packName && "picker-tab-active")}>
                {packName}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {stickerPacks[pack].map((sticker, index) => (
              <motion.button
                animate={pack === "Motion" ? { y: [0, -4, 0], rotate: [0, 3, 0] } : undefined}
                transition={{ repeat: Infinity, duration: 1.5, delay: index * 0.1 }}
                key={sticker}
                onClick={() => onSticker(sticker)}
                className="rounded-xl bg-white/5 p-3 text-3xl"
              >
                {sticker}
              </motion.button>
            ))}
          </div>
        </>
      )}
    </motion.div>
  );
}

function ContextMenu({
  message,
  position,
  onClose,
  onAction,
}: {
  message: ChatMessage;
  position: { x: number; y: number };
  onClose: () => void;
  onAction: (action: "reply" | "forward" | "bookmark" | "select" | "copy" | "pin" | "reminder" | "edit" | "delete" | "transcribe" | "translate") => void;
}) {
  const style = useMemo(() => {
    const width = 208;
    const x = Math.min(Math.max(position.x - width / 2, 12), window.innerWidth - width - 12);
    const y = Math.min(position.y, window.innerHeight - 260);
    return { left: x, top: y };
  }, [position]);

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <motion.div {...popVariants} style={style} onClick={(event) => event.stopPropagation()} className="glass-menu absolute w-52">
        <button className="menu-row" onClick={() => onAction("reply")}>
          <Reply size={16} /> Ответить
        </button>
        <button className="menu-row" onClick={() => onAction("forward")}>
          <Forward size={16} /> Переслать
        </button>
        <button className="menu-row" onClick={() => onAction("bookmark")}>
          <Bookmark size={16} /> {message.bookmarked ? "Убрать из избранного" : "В избранное"}
        </button>
        <button className="menu-row" onClick={() => onAction("select")}>
          <Check size={16} /> Выбрать сообщения
        </button>
        <button className="menu-row" onClick={() => onAction("copy")}>
          <Copy size={16} /> Копировать
        </button>
        <button className="menu-row" onClick={() => onAction("pin")}>
          <Pin size={16} /> {message.pinned ? "Открепить" : "Закрепить"}
        </button>
        <button className="menu-row" onClick={() => onAction("reminder")}>
          <Bell size={16} /> Напомнить
        </button>
        {message.kind === "voice" && message.fileUrl && !message.transcription && (
          <button className="menu-row" onClick={() => onAction("transcribe")}>
            <AudioLines size={16} /> Расшифровать
          </button>
        )}
        {(!message.kind || message.kind === "text" || message.kind === "link") && message.text && !message.translation && (
          <button className="menu-row" onClick={() => onAction("translate")}>
            <Languages size={16} /> Перевести на русский
          </button>
        )}
        {message.mine && (!message.kind || message.kind === "text" || message.kind === "link") && (
          <button className="menu-row" onClick={() => onAction("edit")}>
            <Edit3 size={16} /> Редактировать
          </button>
        )}
        {message.mine && (
          <button className="menu-row text-red-400" onClick={() => onAction("delete")}>
            <Trash2 size={16} /> Удалить
          </button>
        )}
      </motion.div>
    </div>
  );
}

function ForwardModal({ messageIds, onClose }: { messageIds: string[]; onClose: () => void }) {
  const { data: chats = [] } = useQuery(wyreLiveQuery<Chat[]>("wyre.listChats", {}));
  const { mutateAsync: forwardMessage } = useMutation(wyreMutation("wyre.forwardMessage"));
  const [busyChat, setBusyChat] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function forward(chatId: string) {
    setBusyChat(chatId);
    setError(null);
    try {
      for (const messageId of messageIds) await forwardMessage({ messageId, targetChatId: chatId });
      onClose();
    } catch (forwardError) {
      setError(forwardError instanceof Error ? forwardError.message : "Не удалось переслать сообщение");
    } finally {
      setBusyChat(null);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <motion.div {...modalVariants} onClick={(event) => event.stopPropagation()} className="modal-shell !max-w-md">
        <div className="flex items-center justify-between">
          <div><p className="eyebrow">{messageIds.length} сообщений</p><h2 className="mt-1 text-lg font-semibold">Переслать в чат</h2></div>
          <GlassButton onClick={onClose}><X size={17} /></GlassButton>
        </div>
        <div className="mt-5 max-h-[55dvh] overflow-y-auto">
          {chats.map((target) => (
            <button key={target.id} onClick={() => void forward(target.id)} disabled={Boolean(busyChat)} className="chat-row w-full text-left">
              <Avatar initials={target.initials} colors={target.colors} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{target.name}</span>
              <Forward size={15} className="text-[var(--accent1)]" />
            </button>
          ))}
          {!chats.length && <p className="py-8 text-center text-sm text-[var(--muted)]">Нет доступных чатов</p>}
        </div>
        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
      </motion.div>
    </div>
  );
}

function datetimeLocal(value: Date) {
  const adjusted = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return adjusted.toISOString().slice(0, 16);
}

const SELF_DESTRUCT_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: "Без таймера" },
  { value: 10, label: "10 секунд" },
  { value: 60, label: "1 минута" },
  { value: 3600, label: "1 час" },
  { value: 86400, label: "1 день" },
  { value: 604800, label: "7 дней" },
];

/** Glass popover for the per-message self-destruct timer (replaces the native select). */
function TimerPicker({ value, onChange }: { value: number | null; onChange: (value: number | null) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-label="Самоуничтожение сообщения"
        title="Самоуничтожение сообщения"
        className={cn(
          "flex h-8 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[10px] font-semibold transition",
          value
            ? "border-[var(--accent1)]/50 bg-[var(--accent1)]/15 text-white"
            : "border-[var(--line)] bg-white/5 text-[var(--muted)] hover:bg-white/10",
        )}
      >
        <Timer size={12} />
        {value ? timerLabel(value) : "Таймер"}
      </button>
      <AnimatePresence>
        {open && (
          <>
            <button aria-label="Закрыть выбор таймера" className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
            <motion.div {...popVariants} style={{ position: "absolute", bottom: 70, right: 0 }} className="glass-menu z-50 w-40 p-1">
              {SELF_DESTRUCT_OPTIONS.map((option) => {
                const selected = (option.value ?? null) === (value ?? null);
                return (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                    className={cn("menu-row justify-between", selected && "text-[var(--accent1)]")}
                  >
                    {option.label}
                    {selected && <Check size={14} />}
                  </button>
                );
              })}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function ScheduleModal({ text, onClose, onSchedule }: { text: string; onClose: () => void; onSchedule: (scheduledAt: string) => Promise<void> }) {
  const now = new Date();
  const min = datetimeLocal(new Date(now.getTime() + 60 * 60 * 1000));
  const max = datetimeLocal(new Date(now.getTime() + 366 * 24 * 60 * 60 * 1000));
  const [scheduledAt, setScheduledAt] = useState(min);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    try { await onSchedule(new Date(scheduledAt).toISOString()); onClose(); }
    catch (scheduleError) { setError(scheduleError instanceof Error ? scheduleError.message : "Не удалось запланировать сообщение"); }
    finally { setBusy(false); }
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <motion.div {...modalVariants} onClick={(event) => event.stopPropagation()} className="modal-shell !max-w-md">
        <div className="flex items-center justify-between"><div><p className="eyebrow">Отложенная отправка</p><h2 className="mt-1 text-lg font-semibold">Выберите время</h2></div><GlassButton onClick={onClose}><X size={17} /></GlassButton></div>
        <p className="mt-5 rounded-xl bg-white/5 p-3 text-sm text-[var(--muted)]">{text}</p>
        <label className="mt-4 block text-xs text-[var(--muted)]">Дата и время</label>
        <input type="datetime-local" value={scheduledAt} min={min} max={max} onChange={(event) => setScheduledAt(event.target.value)} className="glass-input mt-2" />
        <p className="mt-2 text-[10px] text-[var(--muted)]">Можно отправить от часа до года вперёд.</p>
        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
        <PrimaryButton disabled={busy} onClick={() => void submit()} className="mt-5 w-full"><Clock size={16} /> {busy ? "Сохраняем…" : "Запланировать"}</PrimaryButton>
      </motion.div>
    </div>
  );
}

function AutoDeleteModal({
  current,
  onClose,
  onSave,
}: {
  current: number | null;
  onClose: () => void;
  onSave: (days: number | null) => Promise<void>;
}) {
  const [days, setDays] = useState(current === null ? "" : String(current));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onSave(days ? Number(days) : null);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Не удалось сохранить настройку");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <motion.div {...modalVariants} onClick={(event) => event.stopPropagation()} className="modal-shell !max-w-md">
        <div className="flex items-center justify-between">
          <div><p className="eyebrow">Хранение сообщений</p><h2 className="mt-1 text-lg font-semibold">Автоудаление</h2></div>
          <GlassButton onClick={onClose}><X size={17} /></GlassButton>
        </div>
        <p className="mt-4 text-sm text-[var(--muted)]">Новые сообщения будут удаляться у всех участников после выбранного срока.</p>
        <select value={days} onChange={(event) => setDays(event.target.value)} className="glass-select mt-4 w-full">
          <option value="">Выключено</option>
          <option value="1">Через 1 день</option>
          <option value="7">Через 7 дней</option>
          <option value="30">Через 30 дней</option>
          <option value="90">Через 90 дней</option>
          <option value="365">Через 1 год</option>
        </select>
        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
        <PrimaryButton disabled={busy} onClick={() => void submit()} className="mt-5 w-full"><Timer size={16} /> {busy ? "Сохраняем…" : "Сохранить"}</PrimaryButton>
      </motion.div>
    </div>
  );
}

type GroupMemberView = {
  userId: string;
  name: string;
  username: string;
  initials: string;
  colors: [string, string];
  role: "owner" | "admin" | "member";
};

function GroupSettingsModal({ chatId, onClose, onLeft }: { chatId: string; onClose: () => void; onLeft: () => void }) {
  const { data: group } = useQuery(wyreLiveQuery<{ title: string; description: string; autoDeleteAfterDays: number | null; myRole: "owner" | "admin" | "member"; members: GroupMemberView[] }>("wyre.groupDetails", { chatId }));
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [albumOpen, setAlbumOpen] = useState(false);
  const [topicTitle, setTopicTitle] = useState("");
  const [topicNames, setTopicNames] = useState<Record<string, string>>({});
  const { data: album = [] } = useQuery({
    ...wyreLiveQuery<{ id: string; url: string; mimeType: string; fileName: string; caption: string; author: string; createdAt: string }[]>("wyre.groupMediaAlbum", { chatId }),
    enabled: albumOpen,
  });
  const { data: people = [] } = useQuery(wyreLiveQuery<{ userId: string; name: string; username: string; initials: string; colors: [string, string] }[]>("wyre.searchPeople", { query }));
  const { data: topics = [] } = useQuery(wyreLiveQuery<ChatTopic[]>("wyre.listTopics", { chatId }));
  const { mutateAsync: updateGroup } = useMutation(wyreMutation("wyre.updateGroup"));
  const { mutateAsync: addMembers } = useMutation(wyreMutation("wyre.addGroupMembers"));
  const { mutateAsync: removeMember } = useMutation(wyreMutation("wyre.removeGroupMember"));
  const { mutateAsync: setRole } = useMutation(wyreMutation("wyre.setGroupMemberRole"));
  const { mutateAsync: leaveGroup } = useMutation(wyreMutation("wyre.leaveGroup"));
  const { mutateAsync: setAutoDelete } = useMutation(wyreMutation("wyre.setChatAutoDelete"));
  const { mutateAsync: createTopic } = useMutation(wyreMutation("wyre.createTopic"));
  const { mutateAsync: renameTopic } = useMutation(wyreMutation("wyre.renameTopic"));
  const { mutateAsync: setTopicClosed } = useMutation(wyreMutation("wyre.setTopicClosed"));

  useEffect(() => {
    if (!group) return;
    setTitle(group.title);
    setDescription(group.description);
  }, [group?.title, group?.description]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (actionError) { setError(actionError instanceof Error ? actionError.message : "Не удалось изменить группу"); }
    finally { setBusy(false); }
  }

  const canManage = group?.myRole === "owner" || group?.myRole === "admin";
  const memberIds = new Set(group?.members.map((member) => member.userId) ?? []);
  const availablePeople = people.filter((person) => !memberIds.has(person.userId)).slice(0, 8);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <motion.div {...modalVariants} onClick={(event) => event.stopPropagation()} className="modal-shell !max-w-xl">
        <div className="flex items-center justify-between">
          <div><p className="eyebrow">Управление группой</p><h2 className="mt-1 text-lg font-semibold">Участники и роли</h2></div>
          <GlassButton onClick={onClose}><X size={17} /></GlassButton>
        </div>
        {!group ? <p className="py-10 text-center text-sm text-[var(--muted)]">Загружаем группу…</p> : (
          <>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <input value={title} onChange={(event) => setTitle(event.target.value)} disabled={!canManage} className="glass-input" placeholder="Название группы" />
              <input value={description} onChange={(event) => setDescription(event.target.value)} disabled={!canManage} className="glass-input" placeholder="Описание" />
            </div>
            {canManage && <button disabled={busy || !title.trim()} onClick={() => void run(() => updateGroup({ chatId, title: title.trim(), description: description.trim() }))} className="mt-2 text-xs font-semibold text-[var(--accent1)] disabled:opacity-40">Сохранить данные группы</button>}
            <div className="mt-4 flex items-center gap-3 rounded-2xl border border-[var(--line)] p-3"><Timer size={15} className="text-[var(--muted)]" /><span className="flex-1 text-xs">Автоудаление новых сообщений</span><select value={group.autoDeleteAfterDays ?? ""} disabled={busy || group.myRole !== "owner"} onChange={(event) => void run(() => setAutoDelete({ chatId, days: event.target.value ? Number(event.target.value) : null }))} className="glass-select !h-8 !w-32 !px-2 text-[10px]"><option value="">Выключено</option><option value="1">1 день</option><option value="7">7 дней</option><option value="30">30 дней</option><option value="90">90 дней</option><option value="365">1 год</option></select></div>
            <button onClick={() => setAlbumOpen((value) => !value)} className="mt-3 flex w-full items-center gap-3 rounded-2xl border border-[var(--line)] p-3 text-left"><Image size={15} className="text-[var(--accent1)]" /><span className="flex-1 text-xs font-semibold">Совместный медиа-альбом</span><span className="text-[10px] text-[var(--muted)]">{albumOpen ? "Скрыть" : "Открыть"}</span></button>
            {albumOpen && <div className="mt-3 grid max-h-64 grid-cols-3 gap-2 overflow-y-auto rounded-2xl border border-[var(--line)] p-2">{album.map((item) => <a key={item.id} href={item.url} target="_blank" rel="noreferrer" title={`${item.author}${item.caption ? ` · ${item.caption}` : ""}`} className="relative aspect-square overflow-hidden rounded-xl bg-black/20">{item.mimeType.startsWith("video/") ? <video src={item.url} muted preload="metadata" className="h-full w-full object-cover" /> : <img src={item.url} alt={item.caption || item.fileName} className="h-full w-full object-cover" />}<span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1.5 py-1 text-[9px]">{item.author}</span></a>)}{!album.length && <p className="col-span-3 py-6 text-center text-xs text-[var(--muted)]">В группе пока нет фото и видео</p>}</div>}

            <div className="mt-4 rounded-2xl border border-[var(--line)] p-3">
              <div className="flex items-center gap-2"><Hash size={15} className="text-[var(--accent1)]" /><span className="flex-1 text-xs font-semibold">Темы группы</span><span className="text-[10px] text-[var(--muted)]">{topics.length}/100</span></div>
              {canManage && <div className="mt-3 flex gap-2"><input value={topicTitle} onChange={(event) => setTopicTitle(event.target.value)} maxLength={80} placeholder="Новая тема" className="glass-input !min-h-9 flex-1" /><button disabled={busy || !topicTitle.trim()} onClick={() => void run(async () => { await createTopic({ chatId, title: topicTitle.trim() }); setTopicTitle(""); })} className="rounded-xl px-3 text-xs font-semibold text-[var(--accent1)] disabled:opacity-40">Создать</button></div>}
              <div className="mt-2 max-h-48 space-y-1 overflow-y-auto">
                {topics.map((topic) => <div key={topic.id} className="flex items-center gap-2 rounded-xl px-2 py-2 hover:bg-white/[0.03]"><Hash size={13} className="shrink-0 text-[var(--muted)]" /><input value={topicNames[topic.id] ?? topic.title} onChange={(event) => setTopicNames((names) => ({ ...names, [topic.id]: event.target.value }))} disabled={!canManage} maxLength={80} className="min-w-0 flex-1 bg-transparent text-xs outline-none disabled:text-[var(--muted)]" />{canManage && topicNames[topic.id]?.trim() && topicNames[topic.id].trim() !== topic.title && <button disabled={busy} onClick={() => void run(async () => { await renameTopic({ topicId: topic.id, title: topicNames[topic.id].trim() }); setTopicNames((names) => { const next = { ...names }; delete next[topic.id]; return next; }); })} className="text-[10px] text-[var(--accent1)]">Сохранить</button>}{canManage && <button disabled={busy} onClick={() => void run(() => setTopicClosed({ topicId: topic.id, closed: !topic.closed }))} className={cn("text-[10px]", topic.closed ? "text-emerald-400" : "text-amber-400")}>{topic.closed ? "Открыть" : "Закрыть"}</button>}</div>)}
                {!topics.length && <p className="py-4 text-center text-xs text-[var(--muted)]">Тем пока нет</p>}
              </div>
            </div>

            <div className="mt-5 max-h-56 overflow-y-auto rounded-2xl border border-[var(--line)] p-1">
              {group.members.map((member) => (
                <div key={member.userId} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-white/[0.03]">
                  <Avatar initials={member.initials} colors={member.colors} size="sm" />
                  <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{member.name}</p><p className="truncate text-[10px] text-[var(--muted)]">@{member.username}</p></div>
                  {member.role === "owner" ? <span className="flex items-center gap-1 text-[10px] text-amber-400"><Crown size={12} /> Владелец</span> : group.myRole === "owner" ? (
                    <select value={member.role} disabled={busy} onChange={(event) => void run(() => setRole({ chatId, userId: member.userId, role: event.target.value }))} className="glass-select !h-8 !w-24 !px-2 text-[10px]"><option value="member">Участник</option><option value="admin">Админ</option></select>
                  ) : <span className="text-[10px] text-[var(--muted)]">{member.role === "admin" ? "Админ" : "Участник"}</span>}
                  {canManage && member.role !== "owner" && !(group.myRole === "admin" && member.role === "admin") && <button disabled={busy} onClick={() => void run(() => removeMember({ chatId, userId: member.userId }))} title="Удалить участника" className="grid h-8 w-8 place-items-center rounded-full text-red-400 hover:bg-red-500/10"><UserMinus size={14} /></button>}
                </div>
              ))}
            </div>

            {canManage && <div className="mt-5"><label className="search-box"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Добавить по имени или @username" /></label>{query.trim() && <div className="mt-2 max-h-36 overflow-y-auto rounded-2xl border border-[var(--line)] p-1">{availablePeople.map((person) => <button key={person.userId} disabled={busy} onClick={() => void run(async () => { await addMembers({ chatId, userIds: [person.userId] }); setQuery(""); })} className="flex w-full items-center gap-2 rounded-xl p-2 text-left hover:bg-white/5"><Avatar initials={person.initials} colors={person.colors} size="sm" /><span className="min-w-0 flex-1 truncate text-xs">{person.name} <span className="text-[var(--muted)]">@{person.username}</span></span><UserPlus size={14} className="text-[var(--accent1)]" /></button>)}</div>}</div>}
            {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
            <button disabled={busy} onClick={() => { if (window.confirm("Выйти из группы?")) void run(async () => { await leaveGroup({ chatId }); onLeft(); }); }} className="mt-5 flex items-center gap-2 text-xs font-semibold text-red-400"><UserMinus size={14} /> Выйти из группы</button>
          </>
        )}
      </motion.div>
    </div>
  );
}

function ScheduledMessagesPanel({ chatId }: { chatId: string }) {
  const { data: items = [] } = useQuery(wyreLiveQuery<{ id: string; text: string; scheduledAt: string }[]>("wyre.scheduledMessages", { chatId }));
  const { mutateAsync: update } = useMutation(wyreMutation("wyre.updateScheduledMessage"));
  const { mutateAsync: cancel } = useMutation(wyreMutation("wyre.cancelScheduledMessage"));
  const [editing, setEditing] = useState<Record<string, string>>({});
  if (!items.length) return null;
  return (
    <div className="relative z-10 mx-auto mb-2 w-full max-w-3xl space-y-1 px-4 sm:px-8">
      {items.map((item) => {
        const value = editing[item.id] ?? datetimeLocal(new Date(item.scheduledAt));
        return <div key={item.id} className="composer-context flex-wrap"><Clock size={14} /><span className="min-w-0 flex-1 truncate">{item.text}</span><input type="datetime-local" value={value} min={datetimeLocal(new Date(Date.now() + 60 * 60 * 1000))} onChange={(event) => setEditing((state) => ({ ...state, [item.id]: event.target.value }))} className="glass-input !min-h-7 !w-40 !px-2 text-[10px]" /><button onClick={() => void update({ scheduledMessageId: item.id, text: item.text, scheduledAt: new Date(value).toISOString() })} className="text-[10px] text-[var(--accent1)]">Сохранить</button><button onClick={() => void cancel({ scheduledMessageId: item.id })} className="text-[10px] text-red-400">Отменить</button></div>;
      })}
    </div>
  );
}

export function ChatWindow({
  chat,
  onBack,
  onCall,
  minimizedCall,
  onReturnToCall,
  onOpenProfile,
}: {
  chat: Chat;
  onBack: () => void;
  onCall: (kind: "audio" | "video") => void;
  minimizedCall?: { title: string; kind: "audio" | "video" } | null;
  onReturnToCall?: () => void;
  onOpenProfile?: (userId: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const draftHydrated = useRef(false);
  const [picker, setPicker] = useState<PickerKind>(null);
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [forwarding, setForwarding] = useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [autoDeleteOpen, setAutoDeleteOpen] = useState(false);
  const [groupSettingsOpen, setGroupSettingsOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [selectedTopic, setSelectedTopic] = useState<{ chatId: string; topicId: string } | null>(null);
  const [chatSearch, setChatSearch] = useState("");
  // Header panels are mutually exclusive: opening one closes the others.
  const [activePanel, setActivePanel] = useState<"ai" | "search" | null>(null);
  const chatSearchOpen = activePanel === "search";
  const aiOpen = activePanel === "ai";
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiQuery, setAiQuery] = useState("");
  const [aiResults, setAiResults] = useState<{ id: string; author: string; text: string; time: string }[]>([]);
  const [aiReplies, setAiReplies] = useState<string[]>([]);
  const [reminderDraft, setReminderDraft] = useState<{ messageId: string; text: string; remindAt: string } | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteVersion, setNoteVersion] = useState(0);
  const [noteDirty, setNoteDirty] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [selfDestructSeconds, setSelfDestructSeconds] = useState<number | null>(null);
  const [selectedMessages, setSelectedMessages] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [replying, setReplying] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordMode, setRecordMode] = useState<"voice" | "video">("voice");
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [pendingMessages, setPendingMessages] = useState<ChatMessage[]>([]);
  const [viewerItem, setViewerItem] = useState<MediaItem | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [dragDepth, setDragDepth] = useState(0);
  const startX = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bubbleRefs = useRef(new Map<string, HTMLDivElement | null>());
  const typingSentAt = useRef(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const modeLockedRef = useRef(false);
  const videoPreviewRef = useRef<HTMLVideoElement | null>(null);
  const captureActiveRef = useRef(false);
  const captureRequestRef = useRef(0);
  const liveLocationWatchRef = useRef<number | null>(null);
  const liveLocationTimerRef = useRef<number | null>(null);
  const liveLocationMessageRef = useRef<string | null>(null);

  const queryClient = useQueryClient();
  const selectedTopicId = selectedTopic?.chatId === chat.id ? selectedTopic.topicId : null;
  const { data: topics = [] } = useQuery({
    ...wyreLiveQuery<ChatTopic[]>("wyre.listTopics", { chatId: chat.id }),
    enabled: Boolean(chat.group),
  });
  const activeTopic = topics.find((topic) => topic.id === selectedTopicId);
  const { data: messages = [] } = useQuery(wyreLiveQuery<ChatMessage[]>("wyre.listMessages", { chatId: chat.id, topicId: selectedTopicId ?? undefined }));
  const { data: peer } = useQuery(wyreLiveQuery<Chat | null>("wyre.chatPeer", { chatId: chat.id }));
  // Typing/recording indicators arrive as targeted pushes (no refetching):
  // patch this chat's peer presence straight into the cache.
  useEffect(() => onWyrePresence((payload) => {
    if (payload.chatId !== chat.id) return;
    queryClient.setQueryData<Chat | null>(["wyre", "wyre.chatPeer", { chatId: chat.id }], (current) => {
      if (!current) return current;
      const presence = payload.type === "typing"
        ? (payload.typing ? "typing" : "online")
        : (payload.activity ?? "online");
      return { ...current, presence: presence as Chat["presence"] };
    });
  }), [chat.id, queryClient]);
  const { data: savedDraft, isSuccess: draftLoaded } = useQuery(wyreLiveQuery<string>("wyre.draft", { chatId: chat.id }));
  const { data: mentionCandidates = [] } = useQuery(wyreLiveQuery<{ userId: string; name: string; username: string; initials: string; colors: [string, string] }[]>("wyre.mentionCandidates", { chatId: chat.id }));
  const { data: reminders = [] } = useQuery(wyreLiveQuery<{ id: string; messageId: string; text: string; remindAt: string; due: boolean }[]>("wyre.reminders", { chatId: chat.id }));
  const { data: sharedNote } = useQuery(wyreLiveQuery<{ content: string; version: number; updatedAt: string | null }>("wyre.sharedNote", { chatId: chat.id }));

  const { mutate: send } = useMutation(wyreMutation("wyre.sendMessage"));
  const { mutateAsync: sendAsync } = useMutation(wyreMutation("wyre.sendMessage"));
  const { mutateAsync: requestUpload } = useMutation(wyreMutation("wyre.requestAttachmentUpload"));
  const { mutate: editMessage } = useMutation(wyreMutation("wyre.editMessage"));
  const { mutate: deleteMessage } = useMutation(wyreMutation("wyre.deleteMessage"));
  const { mutateAsync: deleteMessageAsync } = useMutation(wyreMutation("wyre.deleteMessage"));
  const { mutate: react } = useMutation(wyreMutation("wyre.reactToMessage"));
  const { mutateAsync: invokeAction } = useMutation(wyreMutation("wyre.invokeMessageAction"));
  const { mutate: pinMessage } = useMutation(wyreMutation("wyre.pinMessage"));
  const { mutate: toggleBookmark } = useMutation(wyreMutation("wyre.toggleMessageBookmark"));
  // Read receipts, typing pings and draft saving fire constantly — they run
  // quietly (no global invalidation) so typing never lags the composer.
  const { mutate: markRead } = useMutation(wyreQuietMutation("wyre.markChatRead"));
  const { mutate: setTyping } = useMutation(wyreQuietMutation("wyre.setTyping"));
  const { mutate: setActivity } = useMutation(wyreQuietMutation("wyre.setActivity"));
  const { mutate: saveDraft } = useMutation(wyreQuietMutation("wyre.saveDraft"));
  const { mutate: clearDraft } = useMutation(wyreQuietMutation("wyre.clearDraft"));
  const { mutateAsync: scheduleMessage } = useMutation(wyreMutation("wyre.scheduleMessage"));
  const { mutateAsync: setChatAutoDelete } = useMutation(wyreMutation("wyre.setChatAutoDelete"));
  const { mutateAsync: createPoll } = useMutation(wyreMutation("wyre.createPoll"));
  const { mutate: votePoll } = useMutation(wyreMutation("wyre.votePoll"));
  const { mutate: closePoll } = useMutation(wyreMutation("wyre.closePoll"));
  const { mutateAsync: transcribeVoice } = useMutation(wyreMutation("wyre.transcribeVoiceMessage"));
  const { mutateAsync: translateMessage } = useMutation(wyreMutation("wyre.translateMessage"));
  const { mutateAsync: updateLiveLocation } = useMutation(wyreMutation("wyre.updateLiveLocation"));
  const { mutateAsync: stopLiveLocation } = useMutation(wyreMutation("wyre.stopLiveLocation"));
  const { mutateAsync: respondFolderTransfer } = useMutation(wyreMutation("wyre.respondFolderTransfer"));
  const { mutateAsync: summarizeChat } = useMutation(wyreMutation("wyre.summarizeChat"));
  const { mutateAsync: semanticSearchMessages } = useMutation(wyreMutation("wyre.semanticSearchMessages"));
  const { mutateAsync: suggestChatReplies } = useMutation(wyreMutation("wyre.suggestChatReplies"));
  const { mutateAsync: checkLinkSafety } = useMutation(wyreMutation("wyre.checkLinkSafety"));
  const { mutateAsync: suggestReminder } = useMutation(wyreMutation("wyre.suggestReminder"));
  const { mutateAsync: saveReminder } = useMutation(wyreMutation("wyre.saveReminder"));
  const { mutateAsync: completeReminder } = useMutation(wyreMutation("wyre.completeReminder"));
  const { mutateAsync: updateSharedNote } = useMutation(wyreMutation("wyre.updateSharedNote"));

  const header = peer ?? chat;
  const typing = header.presence === "typing";
  const unreadFromPeer = messages.filter((message) => !message.mine).length;
  const mentionMatch = draft.match(/@([a-zA-Z0-9_]*)$/);
  const visibleMentionCandidates = mentionMatch
    ? mentionCandidates.filter((candidate) => candidate.username.toLowerCase().startsWith(mentionMatch[1].toLowerCase())).slice(0, 5)
    : [];
  const visibleMessages = [...messages, ...pendingMessages];
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(chatSearch.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [chatSearch]);

  const { data: searchResults = [], isFetching: searchLoading } = useQuery({
    ...wyreQuery<{ id: string; author: string; text: string; kind: string; time: string; date: string; createdAt: string }[]>("wyre.searchMessages", {
      chatId: chat.id,
      topicId: selectedTopicId ?? undefined,
      query: debouncedSearch,
    }),
    enabled: chatSearchOpen && debouncedSearch.length > 0,
  });

  function insertMention(username: string) {
    if (!mentionMatch) return;
    setDraft(`${draft.slice(0, mentionMatch.index)}@${username} `);
    pingTyping();
  }

  useEffect(() => {
    setSelfDestructSeconds(null);
    setSelectedTopic(null);
    setAutoDeleteOpen(false);
    setGroupSettingsOpen(false);
    setOverflowOpen(false);
    setActivePanel(null);
    setChatSearch("");
    setAiSummary(null);
    setAiResults([]);
    setAiReplies([]);
    setAiError(null);
    setReminderDraft(null);
    setNoteDraft("");
    setNoteVersion(0);
    setNoteDirty(false);
  }, [chat.id]);

  useEffect(() => {
    if (!sharedNote || noteDirty || sharedNote.version < noteVersion) return;
    setNoteDraft(sharedNote.content);
    setNoteVersion(sharedNote.version);
  }, [sharedNote, noteDirty, noteVersion]);

  useEffect(() => () => {
    if (liveLocationWatchRef.current != null) navigator.geolocation.clearWatch(liveLocationWatchRef.current);
    if (liveLocationTimerRef.current != null) window.clearTimeout(liveLocationTimerRef.current);
  }, []);

  useEffect(() => {
    if (draftLoaded && !draftHydrated.current) {
      setDraft((current) => current || savedDraft || "");
      draftHydrated.current = true;
    }
  }, [savedDraft, draftLoaded]);

  useEffect(() => {
    if (!draftHydrated.current) return;
    const timer = window.setTimeout(() => saveDraft({ chatId: chat.id, text: draft }), 450);
    return () => window.clearTimeout(timer);
  }, [chat.id, draft, saveDraft]);

  // Everything visible in an open chat counts as read. The mutation is quiet,
  // so the chat list badge is cleared right here in the cache.
  useEffect(() => {
    markRead({ chatId: chat.id, topicId: selectedTopicId ?? undefined });
    queryClient.setQueryData<Chat[]>(["wyre", "wyre.listChats", {}], (current) =>
      current?.map((item) => (item.id === chat.id && item.unread ? { ...item, unread: 0 } : item)),
    );
  }, [chat.id, selectedTopicId, unreadFromPeer, markRead, queryClient]);

  // Opening a chat must land at the very bottom instantly; later messages
  // animate smoothly. `scrollTop` is used because smooth scrolling of a long
  // list can stop mid-way while images are still resolving their height.
  const initialScrollRef = useRef(true);
  useEffect(() => {
    initialScrollRef.current = true;
  }, [chat.id, selectedTopicId]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const jump = () => {
      node.scrollTop = node.scrollHeight;
    };
    if (initialScrollRef.current) {
      initialScrollRef.current = false;
      jump();
      // Attachments finish loading after paint and change the total height.
      const timer = window.setTimeout(jump, 120);
      return () => window.clearTimeout(timer);
    }
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 260;
    if (nearBottom) node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [visibleMessages.length, selectedTopicId, typing, chat.id]);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setRecordSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [recording]);

  // The preview element mounts after the capture has already started, so the
  // camera stream is attached here — otherwise the video circle records blind.
  useEffect(() => {
    if (!recording || recordMode !== "video") return;
    const preview = videoPreviewRef.current;
    const stream = mediaStreamRef.current;
    if (!preview || !stream) return;
    if (preview.srcObject !== stream) preview.srcObject = stream;
    void preview.play().catch(() => undefined);
  }, [recording, recordMode]);

  // Stop broadcasting "typing" when the chat is closed.
  useEffect(() => {
    return () => {
      if (typingSentAt.current) setTyping({ chatId: chat.id, typing: false });
      setActivity({ chatId: chat.id, activity: null });
    };
  }, [chat.id, setActivity, setTyping]);

  // Never leave the mic/camera running if the component unmounts mid-recording.
  useEffect(() => {
    return () => {
      captureActiveRef.current = false;
      captureRequestRef.current += 1;
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      setActivity({ chatId: chat.id, activity: null });
    };
  }, [chat.id, setActivity]);

  const pinned = messages.find((message) => message.pinned);

  function pingTyping() {
    const now = Date.now();
    if (now - typingSentAt.current < 3000) return;
    typingSentAt.current = now;
    setTyping({ chatId: chat.id, typing: true });
  }

  function stopTyping() {
    if (!typingSentAt.current) return;
    typingSentAt.current = 0;
    setTyping({ chatId: chat.id, typing: false });
  }

  function sendMessage() {
    if (activeTopic?.closed) return setAttachError("Тема закрыта для новых сообщений");
    const text = draft.trim();
    if (!text) return;
    if (editing) {
      editMessage({ messageId: editing, text });
      setEditing(null);
    } else {
      // Optimistic echo: the bubble appears instantly. When the server answers
      // with the real serialized copy, it is inserted into the query cache and
      // the pending bubble is dropped in the same tick — the message never
      // disappears and the entrance animation does not replay.
      const localId = `pending-${crypto.randomUUID()}`;
      setPendingMessages((items) => [...items, {
        id: localId,
        mine: true,
        text,
        time: new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
        kind: "text",
        status: "sent",
        pending: true,
        replyToText: replying ? messages.find((message) => message.id === replying)?.text.slice(0, 140) : undefined,
      }]);
      const messagesKey = ["wyre", "wyre.listMessages", { chatId: chat.id, topicId: selectedTopicId ?? undefined }] as const;
      void sendAsync({ chatId: chat.id, topicId: selectedTopicId ?? undefined, text, kind: "text", replyToId: replying, selfDestructSeconds: selfDestructSeconds ?? undefined })
        .then((result) => {
          const serverMessage = (result as { message?: ChatMessage }).message;
          if (serverMessage) {
            queryClient.setQueryData<ChatMessage[]>(messagesKey, (current) => {
              const list = current ?? [];
              return list.some((item) => item.id === serverMessage.id) ? list : [...list, serverMessage];
            });
          }
          setPendingMessages((items) => items.filter((item) => item.id !== localId));
        })
        .catch((error) => {
          setPendingMessages((items) => items.filter((item) => item.id !== localId));
          setAttachError(error instanceof Error ? error.message : "Не удалось отправить сообщение");
          setDraft((current) => current || text);
        });
      setReplying(null);
      setSelfDestructSeconds(null);
    }
    setDraft("");
    clearDraft({ chatId: chat.id });
    stopTyping();
  }

  async function scheduleCurrentMessage(scheduledAt: string) {
    if (activeTopic?.closed) throw new Error("Тема закрыта для новых сообщений");
    await scheduleMessage({ chatId: chat.id, topicId: selectedTopicId ?? undefined, text: draft.trim(), scheduledAt });
    setDraft("");
    clearDraft({ chatId: chat.id });
  }

  function addSpecial(text: string, kind: NonNullable<ChatMessage["kind"]> = "sticker", extra: { fileName?: string; fileSize?: string } = {}) {
    if (activeTopic?.closed) return setAttachError("Тема закрыта для новых сообщений");
    send({ chatId: chat.id, topicId: selectedTopicId ?? undefined, text, kind, ...extra, selfDestructSeconds: selfDestructSeconds ?? undefined });
    setSelfDestructSeconds(null);
    setPicker(null);
  }

  async function handleAttachment(file: File, caption: string, requestFolderTransfer = false) {
    if (activeTopic?.closed) return setAttachError("Тема закрыта для новых сообщений");
    setAttachError(null);
    setUploading(true);
    setUploadProgress(0);
    try {
      const { url, fields, filePath } = (await requestUpload({
        chatId: chat.id,
        fileName: file.name,
        fileSize: file.size,
        contentType: file.type || "application/octet-stream",
      })) as { url: string; fields: Record<string, string>; filePath: string };

      await uploadSignedFile({ url, fields, file, fileName: file.name, onProgress: setUploadProgress });

      await sendAsync({
        chatId: chat.id,
        topicId: selectedTopicId ?? undefined,
        text: caption.trim(),
        kind: "file",
        filePath,
        mimeType: file.type || "application/octet-stream",
        fileName: file.name,
        fileSize: formatFileSize(file.size),
        selfDestructSeconds: selfDestructSeconds ?? undefined,
        requestFolderTransfer,
      });
      setSelfDestructSeconds(null);
      setPicker(null);
    } catch (error) {
      setAttachError(error instanceof Error ? error.message : "Не удалось отправить вложение");
    } finally {
      setUploading(false);
    }
  }

  const stopLiveTracking = useCallback(async (messageId: string) => {
    if (liveLocationMessageRef.current === messageId) {
      if (liveLocationWatchRef.current != null) navigator.geolocation.clearWatch(liveLocationWatchRef.current);
      if (liveLocationTimerRef.current != null) window.clearTimeout(liveLocationTimerRef.current);
      liveLocationWatchRef.current = null;
      liveLocationTimerRef.current = null;
      liveLocationMessageRef.current = null;
    }
    await stopLiveLocation({ messageId });
  }, [stopLiveLocation]);

  const bubbleHandlers = useMemo(() => ({
    onSelect: (id: string) => setSelectedMessages((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id]),
    registerRef: (id: string, el: HTMLDivElement | null) => { if (el) bubbleRefs.current.set(id, el); else bubbleRefs.current.delete(id); },
    onMenu: (id: string, x: number, y: number) => setContextMenu({ id, x, y }),
    onReact: (id: string, emoji: string) => react({ messageId: id, emoji }),
    onVote: (id: string, optionId: string) => votePoll({ messageId: id, optionId }),
    onClosePoll: (id: string) => closePoll({ messageId: id }),
    onInvokeAction: (id: string, actionId: string) => { void invokeAction({ messageId: id, actionId }).catch(() => undefined); },
    onCheckLinkSafety: (id: string) => checkLinkSafety({ messageId: id }) as Promise<{ level: "low" | "medium" | "high"; reason: string }>,
    onStopLiveLocation: (id: string) => { void stopLiveTracking(id); },
    onFolderTransferStatus: (id: string, status: "accepted" | "completed" | "declined") => respondFolderTransfer({ messageId: id, status }),
    onViewMedia: setViewerItem,
  }), [react, votePoll, closePoll, invokeAction, checkLinkSafety, stopLiveTracking, respondFolderTransfer]);

  async function startLiveTracking(minutes: 15 | 60 | 480) {
    if (activeTopic?.closed) throw new Error("Тема закрыта для новых сообщений");
    if (!navigator.geolocation) throw new Error("Геолокация не поддерживается браузером");
    const position = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }));
    if (liveLocationMessageRef.current) await stopLiveTracking(liveLocationMessageRef.current);
    const result = await sendAsync({
      chatId: chat.id,
      topicId: selectedTopicId ?? undefined,
      text: JSON.stringify({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy }),
      kind: "location",
      liveLocationMinutes: minutes,
    }) as { messageId: string };
    liveLocationMessageRef.current = result.messageId;
    liveLocationWatchRef.current = navigator.geolocation.watchPosition((next) => {
      void updateLiveLocation({ messageId: result.messageId, latitude: next.coords.latitude, longitude: next.coords.longitude, accuracy: next.coords.accuracy }).catch(() => {
        if (liveLocationWatchRef.current != null) navigator.geolocation.clearWatch(liveLocationWatchRef.current);
        liveLocationWatchRef.current = null;
      });
    }, (error) => setAttachError(error.message || "Не удалось обновить геопозицию"), { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 });
    liveLocationTimerRef.current = window.setTimeout(() => void stopLiveTracking(result.messageId), minutes * 60_000);
    setPicker(null);
  }

  async function handleFileDrop(event: ReactDragEvent<HTMLElement>) {
    event.preventDefault();
    setDragDepth(0);
    const files = [...event.dataTransfer.files];
    for (const file of files) await handleAttachment(file, "");
  }

  function pickMimeType(candidates: string[]) {
    if (typeof MediaRecorder === "undefined") return undefined;
    return candidates.find((type) => MediaRecorder.isTypeSupported?.(type));
  }

  function releaseStream() {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    if (videoPreviewRef.current) videoPreviewRef.current.srcObject = null;
  }

  async function beginCapture(mode: "voice" | "video", requestId: number) {
    try {
      const stream = await requestMediaStream(
        mode === "video"
          ? { audio: true, video: { facingMode: "user", width: { ideal: 480 }, height: { ideal: 480 } } }
          : { audio: true },
        mode === "video" ? ["microphone", "camera"] : ["microphone"],
      );
      if (!captureActiveRef.current || captureRequestRef.current !== requestId) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      mediaStreamRef.current = stream;
      if (mode === "video" && videoPreviewRef.current) {
        videoPreviewRef.current.srcObject = stream;
      }
      const mimeType = pickMimeType(
        mode === "video"
          ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]
          : ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]
      );
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recordedChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordedChunksRef.current.push(event.data);
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setActivity({ chatId: chat.id, activity: mode === "video" ? "recording_video" : "recording_voice" });
      setRecording(true);
      return true;
    } catch (error) {
      captureActiveRef.current = false;
      setActivity({ chatId: chat.id, activity: null });
      setRecording(false);
      releaseStream();
      const reason = error instanceof Error ? error.message : mediaAccessError(error, mode === "video" ? ["microphone", "camera"] : ["microphone"]);
      setAttachError(
        mode === "video"
          ? `Не удалось записать видеокружок: ${reason}. Этот браузер не поддерживает нужный формат записи.`
          : reason,
      );
      return false;
    }
  }

  async function switchToVideo() {
    if (!captureActiveRef.current) return;
    const requestId = ++captureRequestRef.current;
    const recorder = mediaRecorderRef.current;
    mediaRecorderRef.current = null;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    releaseStream();
    setRecordMode("video");
    setRecording(false);
    await beginCapture("video", requestId);
  }

  async function uploadRecording(blob: Blob, mode: "voice" | "video", seconds: number) {
    if (activeTopic?.closed) return setAttachError("Тема закрыта для новых сообщений");
    setUploading(true);
    setAttachError(null);
    try {
      const extension = blob.type.includes("mp4") ? "mp4" : "webm";
      const fileName = `${mode === "video" ? "video_message" : "voice_message"}.${extension}`;
      const contentType = blob.type || (mode === "video" ? "video/webm" : "audio/webm");
      const { url, fields, filePath } = (await requestUpload({
        chatId: chat.id,
        fileName,
        fileSize: blob.size,
        contentType,
      })) as { url: string; fields: Record<string, string>; filePath: string };

      await uploadSignedFile({ url, fields, file: blob, fileName, onProgress: setUploadProgress });

      await sendAsync({
        chatId: chat.id,
        topicId: selectedTopicId ?? undefined,
        text: "",
        kind: mode,
        filePath,
        mimeType: contentType,
        duration: seconds,
        replyToId: replying ?? undefined,
        selfDestructSeconds: selfDestructSeconds ?? undefined,
      });
      setReplying(null);
      setSelfDestructSeconds(null);
    } catch (error) {
      setAttachError(error instanceof Error ? error.message : "Не удалось отправить запись");
    } finally {
      setUploading(false);
    }
  }

  function startRecording(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setAttachError("Запись голосовых и видеосообщений не поддерживается в этом браузере");
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    startX.current = event.clientX;
    modeLockedRef.current = false;
    captureActiveRef.current = true;
    const requestId = ++captureRequestRef.current;
    setAttachError(null);
    setRecordMode("voice");
    setRecordSeconds(0);
    setRecording(false);
    void beginCapture("voice", requestId);
  }
  function moveRecording(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!recording || modeLockedRef.current) return;
    if (event.clientX - startX.current < -45) {
      modeLockedRef.current = true;
      void switchToVideo();
    }
  }
  async function stopRecording() {
    if (!captureActiveRef.current && !mediaRecorderRef.current) return;
    captureActiveRef.current = false;
    captureRequestRef.current += 1;
    setActivity({ chatId: chat.id, activity: null });
    setRecording(false);
    const recorder = mediaRecorderRef.current;
    const mode = recordMode;
    const seconds = recordSeconds;
    mediaRecorderRef.current = null;

    if (!recorder) {
      releaseStream();
      return;
    }

    const blob = await new Promise<Blob>((resolve) => {
      recorder.addEventListener(
        "stop",
        () => resolve(new Blob(recordedChunksRef.current, { type: recorder.mimeType || (mode === "video" ? "video/webm" : "audio/webm") })),
        { once: true }
      );
      if (recorder.state !== "inactive") recorder.stop();
      else resolve(new Blob(recordedChunksRef.current, { type: recorder.mimeType }));
    });
    releaseStream();

    if (seconds < 1 || blob.size === 0) return;
    await uploadRecording(blob, mode, seconds);
  }
  function cancelRecording() {
    captureActiveRef.current = false;
    captureRequestRef.current += 1;
    setActivity({ chatId: chat.id, activity: null });
    setRecording(false);
    const recorder = mediaRecorderRef.current;
    mediaRecorderRef.current = null;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    releaseStream();
  }

  function handleContextAction(action: "reply" | "forward" | "bookmark" | "select" | "copy" | "pin" | "reminder" | "edit" | "delete" | "transcribe" | "translate") {
    if (!contextMenu) return;
    const message = messages.find((item) => item.id === contextMenu.id);
    if (!message) return setContextMenu(null);
    if (action === "reply") setReplying(message.id);
    if (action === "forward") setForwarding(message.id);
    if (action === "bookmark") toggleBookmark({ messageId: message.id });
    if (action === "select") setSelectedMessages((items) => (items.includes(message.id) ? items : [...items, message.id]));
    if (action === "copy") navigator.clipboard?.writeText(message.text).catch(() => undefined);
    if (action === "pin") pinMessage({ messageId: message.id });
    if (action === "reminder") {
      setActivePanel("ai");
      void runAi(async () => {
        const suggestion = await suggestReminder({ messageId: message.id }) as { text: string; remindAt: string };
        setReminderDraft({ messageId: message.id, text: suggestion.text, remindAt: datetimeLocal(new Date(suggestion.remindAt)) });
      });
    }
    if (action === "transcribe") {
      setActionNote("Расшифровываем голосовое…");
      void transcribeVoice({ messageId: message.id })
        .catch((error) => setAttachError(error instanceof Error ? error.message : "Не удалось расшифровать голосовое"))
        .finally(() => setActionNote(null));
    }
    if (action === "translate") {
      setActionNote("Переводим сообщение…");
      void translateMessage({ messageId: message.id, targetLanguage: "ru" })
        .catch((error) => setAttachError(error instanceof Error ? error.message : "Не удалось перевести сообщение"))
        .finally(() => setActionNote(null));
    }
    if (action === "edit") {
      setEditing(message.id);
      setDraft(message.text);
    }
    if (action === "delete") deleteMessage({ messageId: message.id });
    setContextMenu(null);
  }

  async function runAi(action: () => Promise<void>) {
    setAiBusy(true);
    setAiError(null);
    try { await action(); }
    catch (error) { setAiError(error instanceof Error ? error.message : "AI-помощник временно недоступен"); }
    finally { setAiBusy(false); }
  }

  function jumpToMessage(messageId: string) {
    setHighlighted(messageId);
    bubbleRefs.current.get(messageId)?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => setHighlighted(null), 1400);
  }

  function jumpToPinned() {
    if (pinned) jumpToMessage(pinned.id);
  }

  function requestSummary() {
    void runAi(async () => {
      const result = await summarizeChat({ chatId: chat.id, topicId: selectedTopicId ?? undefined }) as { summary: string };
      setAiSummary(result.summary);
    });
  }

  function requestSemanticSearch() {
    if (aiQuery.trim().length < 2) return;
    void runAi(async () => {
      const result = await semanticSearchMessages({ chatId: chat.id, topicId: selectedTopicId ?? undefined, query: aiQuery.trim() }) as { results: { id: string; author: string; text: string; time: string }[] };
      setAiResults(result.results);
    });
  }

  function requestSmartReplies() {
    void runAi(async () => {
      const result = await suggestChatReplies({ chatId: chat.id, topicId: selectedTopicId ?? undefined }) as { replies: string[] };
      setAiReplies(result.replies);
    });
  }

  async function confirmReminder() {
    if (!reminderDraft) return;
    await runAi(async () => {
      await saveReminder({ messageId: reminderDraft.messageId, text: reminderDraft.text, remindAt: new Date(reminderDraft.remindAt).toISOString() });
      setReminderDraft(null);
    });
  }

  async function saveSharedNote() {
    await runAi(async () => {
      const result = await updateSharedNote({ chatId: chat.id, content: noteDraft, expectedVersion: noteVersion }) as { version: number };
      setNoteVersion(result.version);
      setNoteDirty(false);
    });
  }

  const activeMessage = messages.find((message) => message.id === contextMenu?.id);
  const selectedSet = new Set(selectedMessages);
  const selectedMine = messages.filter((message) => selectedSet.has(message.id) && message.mine);

  async function deleteSelected() {
    await Promise.all(selectedMine.map((message) => deleteMessageAsync({ messageId: message.id })));
    setSelectedMessages([]);
  }

  function bookmarkSelected() {
    selectedMessages.forEach((messageId) => toggleBookmark({ messageId }));
    setSelectedMessages([]);
  }

  return (
    <section
      className="chat-window"
      onDragEnter={(event) => { event.preventDefault(); setDragDepth((value) => value + 1); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { event.preventDefault(); setDragDepth((value) => Math.max(0, value - 1)); }}
      onDrop={(event) => void handleFileDrop(event)}
    >
      <AnimatePresence>
        {dragDepth > 0 && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="pointer-events-none absolute inset-3 z-[70] grid place-items-center rounded-[var(--r-xl)] border-2 border-dashed border-[var(--accent1)] bg-[var(--glass-heavy)] backdrop-blur-xl"><div className="flex flex-col items-center gap-2 text-sm font-semibold"><Paperclip size={28} className="text-[var(--accent1)]" />Отпустите файлы для отправки</div></motion.div>}
      </AnimatePresence>
      <header className="chat-header glass-panel">
        <button onClick={onBack} className="mr-1 grid h-9 w-9 place-items-center rounded-full transition hover:bg-white/10 md:hidden">
          <ArrowLeft size={19} />
        </button>
        {chat.peerId && onOpenProfile ? (
          <button
            type="button"
            onClick={() => { if (chat.peerId) onOpenProfile(chat.peerId); }}
            className="shrink-0"
            aria-label={`Открыть профиль ${header.name}`}
            title={`Открыть профиль ${header.name}`}
          >
            <Avatar initials={header.initials} colors={header.colors} avatarUrl={header.avatarUrl} size="sm" presence={header.presence === "offline" ? undefined : header.presence} />
          </button>
        ) : (
          <Avatar initials={header.initials} colors={header.colors} avatarUrl={header.avatarUrl} size="sm" presence={header.presence === "offline" ? undefined : header.presence} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {chat.peerId && onOpenProfile ? (
              <button
                type="button"
                onClick={() => { if (chat.peerId) onOpenProfile(chat.peerId); }}
                className="truncate text-sm font-semibold transition hover:text-[var(--accent1)]"
                title={`Открыть профиль ${header.name}`}
              >
                {header.name}
              </button>
            ) : (
              <h2 className="truncate text-sm font-semibold">{header.name}</h2>
            )}
            <UserBadge kind={header.badge} />
            <WarningIndicator warnings={header.warnings} />
          </div>
          <p className="mt-0.5 text-[10px] text-[var(--muted)]">{header.status}</p>
        </div>
        <div className="hidden gap-2.5 md:flex">
          <GlassButton onClick={() => setActivePanel((current) => (current === "search" ? null : "search"))} active={chatSearchOpen} title="Поиск в чате">
            <Search size={17} />
          </GlassButton>
        </div>
        {!chat.service && (
          <>
            <GlassButton onClick={() => onCall("audio")} title="Аудиозвонок">
              <Phone size={18} />
            </GlassButton>
            <GlassButton onClick={() => onCall("video")} title="Видеозвонок">
              <Video size={18} />
            </GlassButton>
          </>
        )}
        <GlassButton
          className="shrink-0"
          onClick={() => {
            if (window.matchMedia("(min-width: 768px)").matches) {
              if (chat.group) setGroupSettingsOpen(true);
              else setAutoDeleteOpen(true);
            } else {
              setOverflowOpen(true);
            }
          }}
          title={chat.group ? "Управление группой" : "Ещё"}
        >
          <MoreHorizontal size={18} />
        </GlassButton>
      </header>
      <AnimatePresence>
        {overflowOpen && (
          <>
            <button aria-label="Закрыть меню" className="fixed inset-0 z-30" onClick={() => setOverflowOpen(false)} />
            <motion.div {...popVariants} style={{ position: "absolute", top: 76, right: 12 }} className="glass-menu z-[80] w-56 p-1">
              <button className="menu-row md:hidden" onClick={() => { setOverflowOpen(false); setActivePanel("search"); }}>
                <Search size={16} /> Поиск в чате
              </button>
              {chat.group ? (
                <button className="menu-row" onClick={() => { setOverflowOpen(false); setGroupSettingsOpen(true); }}>
                  <Users size={16} /> Настройки группы
                </button>
              ) : (
                <button className="menu-row" onClick={() => { setOverflowOpen(false); setAutoDeleteOpen(true); }}>
                  <Timer size={16} /> Автоудаление сообщений
                </button>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {chatSearchOpen && (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="relative z-10 mx-4 mt-2 sm:mx-8">
            <div className="composer-context">
              <Search size={14} className="shrink-0" />
              <input autoFocus value={chatSearch} onChange={(event) => setChatSearch(event.target.value)} placeholder="Найти в чате, вложениях и расшифровках" className="min-w-0 flex-1 bg-transparent text-xs outline-none" />
              <span className="text-[10px] text-[var(--muted)]">{chatSearch.trim() ? searchResults.length : messages.length}</span>
              <button onClick={() => { setChatSearch(""); setActivePanel(null); }}><X size={14} /></button>
            </div>
            {chatSearch.trim().length > 0 && (
              <div className="glass-menu mt-2 max-h-64 overflow-y-auto p-1">
                {searchResults.map((result) => (
                  <button key={result.id} onClick={() => jumpToMessage(result.id)} className="flex w-full items-start gap-2 rounded-xl px-2 py-2 text-left hover:bg-white/5">
                    <span className="min-w-0 flex-1">
                      <span className="block text-[10px] font-semibold text-[var(--accent1)]">{result.author}</span>
                      <span className="block truncate text-xs text-white/80">{result.text}</span>
                    </span>
                    <span className="shrink-0 text-[9px] text-[var(--muted)]">{result.date} {result.time}</span>
                  </button>
                ))}
                {!searchResults.length && <p className="px-2 py-4 text-center text-xs text-[var(--muted)]">{searchLoading ? "Ищем…" : "Ничего не найдено"}</p>}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {aiOpen && (
          <motion.div {...popVariants} className="glass-menu mx-4 mt-2 max-h-[55vh] overflow-y-auto p-3 sm:mx-8">
            <div className="flex items-center gap-2"><Sparkles size={15} className="text-[var(--accent1)]" /><span className="flex-1 text-xs font-semibold">AI-помощник</span><button onClick={() => setActivePanel(null)}><X size={14} /></button></div>
            <div className="mt-3 flex flex-wrap gap-2"><button disabled={aiBusy} onClick={requestSummary} className="rounded-xl bg-white/10 px-3 py-2 text-[11px] disabled:opacity-40">Что я пропустил</button><button disabled={aiBusy} onClick={requestSmartReplies} className="rounded-xl bg-white/10 px-3 py-2 text-[11px] disabled:opacity-40">Предложить ответы</button></div>
            {aiSummary && <div className="mt-3 rounded-2xl border border-[var(--line)] p-3"><p className="text-[10px] font-semibold text-[var(--accent1)]">Краткое содержание</p><p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-white/80">{aiSummary}</p></div>}
            <div className="mt-3 flex gap-2"><label className="search-box min-w-0 flex-1"><Search size={14} /><input value={aiQuery} onChange={(event) => setAiQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") requestSemanticSearch(); }} placeholder="Смысловой поиск" /></label><button disabled={aiBusy || aiQuery.trim().length < 2} onClick={requestSemanticSearch} className="rounded-xl bg-white/10 px-3 text-[11px] disabled:opacity-40">Найти</button></div>
            {aiResults.length > 0 && <div className="mt-2 space-y-1">{aiResults.map((result) => <button key={result.id} onClick={() => jumpToMessage(result.id)} className="flex w-full items-start gap-2 rounded-xl px-2 py-2 text-left hover:bg-white/5"><span className="min-w-0 flex-1"><span className="block text-[10px] font-semibold text-[var(--accent1)]">{result.author}</span><span className="block truncate text-xs text-white/75">{result.text}</span></span><span className="text-[9px] text-[var(--muted)]">{result.time}</span></button>)}</div>}
            {aiReplies.length > 0 && <div className="mt-3"><p className="mb-2 text-[10px] text-[var(--muted)]">Варианты ответа</p><div className="flex flex-wrap gap-2">{aiReplies.map((reply) => <button key={reply} onClick={() => { setDraft(reply); setActivePanel(null); }} className="rounded-xl border border-[var(--line)] px-3 py-2 text-left text-[11px] hover:bg-white/5">{reply}</button>)}</div></div>}
            {reminderDraft && <div className="mt-3 rounded-2xl border border-[var(--line)] p-3"><div className="mb-2 flex items-center gap-2 text-[10px] font-semibold text-[var(--accent1)]"><Bell size={12} />Новое напоминание</div><input value={reminderDraft.text} onChange={(event) => setReminderDraft((current) => current ? { ...current, text: event.target.value } : null)} maxLength={300} className="glass-input !min-h-8 w-full !px-2 text-xs" /><div className="mt-2 flex gap-2"><input type="datetime-local" value={reminderDraft.remindAt} onChange={(event) => setReminderDraft((current) => current ? { ...current, remindAt: event.target.value } : null)} className="glass-input !min-h-8 min-w-0 flex-1 !px-2 text-[10px]" /><button disabled={aiBusy || !reminderDraft.text.trim() || !reminderDraft.remindAt} onClick={() => void confirmReminder()} className="rounded-xl bg-white/10 px-3 text-[11px] disabled:opacity-40">Сохранить</button><button onClick={() => setReminderDraft(null)} title="Отменить"><X size={14} /></button></div></div>}
            <div className="mt-3 rounded-2xl border border-[var(--line)] p-3"><div className="mb-2 flex items-center gap-2 text-[10px] font-semibold text-[var(--accent1)]"><StickyNote size={12} />Совместная заметка</div><textarea value={noteDraft} onChange={(event) => { setNoteDraft(event.target.value); setNoteDirty(true); }} maxLength={20000} rows={4} className="glass-input h-auto w-full resize-y !px-2 !py-2 text-xs" placeholder="Общие планы, адреса и списки" /><div className="mt-2 flex items-center justify-between"><span className="text-[9px] text-[var(--muted)]">Версия {noteVersion}</span><button disabled={aiBusy || !noteDirty} onClick={() => void saveSharedNote()} className="rounded-xl bg-white/10 px-3 py-1.5 text-[11px] disabled:opacity-40">Сохранить</button></div></div>
            {reminders.length > 0 && <div className="mt-3"><p className="mb-2 text-[10px] text-[var(--muted)]">Напоминания</p><div className="space-y-1">{reminders.map((reminder) => <div key={reminder.id} className={cn("flex items-center gap-2 rounded-xl px-2 py-2", reminder.due ? "bg-amber-400/10" : "bg-white/5")}><button onClick={() => jumpToMessage(reminder.messageId)} className="min-w-0 flex-1 text-left"><span className="block truncate text-xs">{reminder.text}</span><span className="text-[9px] text-[var(--muted)]">{new Date(reminder.remindAt).toLocaleString("ru-RU")}</span></button><button onClick={() => void completeReminder({ reminderId: reminder.id })} title="Выполнено"><Check size={14} /></button></div>)}</div></div>}
            {aiBusy && <p className="mt-3 text-center text-[10px] text-[var(--muted)]">AI анализирует переписку…</p>}
            {aiError && <p className="mt-3 text-xs text-red-400">{aiError}</p>}
          </motion.div>
        )}
      </AnimatePresence>
      {chat.group && topics.length > 0 && (
        <div className="flex gap-2 overflow-x-auto border-b border-[var(--line)] px-4 py-2 sm:px-8">
          <button onClick={() => { setSelectedTopic(null); setSelectedMessages([]); setReplying(null); setEditing(null); }} className={cn("flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-[11px] transition", !selectedTopicId ? "bg-white/10 text-white" : "text-[var(--muted)] hover:bg-white/5")}><Hash size={12} />Все</button>
          {topics.map((topic) => <button key={topic.id} onClick={() => { setSelectedTopic({ chatId: chat.id, topicId: topic.id }); setSelectedMessages([]); setReplying(null); setEditing(null); }} className={cn("flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-[11px] transition", selectedTopicId === topic.id ? "bg-white/10 text-white" : "text-[var(--muted)] hover:bg-white/5", topic.closed && "opacity-65")}><Hash size={12} />{topic.title}{topic.closed && <span aria-label="Тема закрыта">· закрыта</span>}{topic.unread > 0 && <span className="grid min-w-4 place-items-center rounded-full bg-[var(--accent1)] px-1 text-[9px] text-white">{topic.unread}</span>}</button>)}
        </div>
      )}
      <AnimatePresence>
        {selectedMessages.length > 0 && (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="absolute left-1/2 top-20 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/10 bg-[var(--glass-heavy)] px-3 py-2 shadow-xl backdrop-blur-xl">
            <span className="px-1 text-xs font-semibold">Выбрано: {selectedMessages.length}</span>
            <button onClick={() => void deleteSelected()} disabled={!selectedMine.length} className="rounded-full px-2 py-1 text-[11px] text-red-400 disabled:opacity-40">Удалить</button>
            <button onClick={bookmarkSelected} className="rounded-full px-2 py-1 text-[11px] text-[var(--accent1)]">В избранное</button>
            <button onClick={() => setForwarding(selectedMessages[0])} className="rounded-full px-2 py-1 text-[11px] text-[var(--accent1)]">Переслать</button>
            <button onClick={() => setSelectedMessages([])} className="grid h-6 w-6 place-items-center rounded-full hover:bg-white/10" title="Отменить"><X size={13} /></button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {minimizedCall && (
          <motion.button initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} onClick={onReturnToCall} className="call-active-bar w-full text-left">
            <PhoneCall size={14} className="text-emerald-400" />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold text-emerald-400">Звонок продолжается</p>
              <p className="truncate text-xs text-[var(--muted)]">{minimizedCall.title}</p>
            </div>
            <span className="shrink-0 text-[10px] font-semibold text-[var(--accent1)]">Вернуться</span>
          </motion.button>
        )}
      </AnimatePresence>

      {pinned && (
        <motion.button initial={{ height: 0 }} animate={{ height: "auto" }} onClick={jumpToPinned} className="pinned-bar w-full text-left">
          <Pin size={14} className="text-amber-400" />
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold text-amber-400">Закреплённое сообщение</p>
            <p className="truncate text-xs text-[var(--muted)]">{pinned.text}</p>
          </div>
        </motion.button>
      )}

      <div className="chat-backdrop" />
      <ScheduledMessagesPanel chatId={chat.id} />
      <div ref={scrollRef} className="message-list">
        <div className="mx-auto w-full max-w-3xl space-y-3 px-4 py-7 sm:px-8">
          {!messages.length && (
            <div className="py-16 text-center text-sm text-[var(--muted)]">Здесь пока пусто. Напишите первое сообщение.</div>
          )}
          {visibleMessages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              highlighted={highlighted === message.id}
              selecting={selectedMessages.length > 0}
              selected={selectedSet.has(message.id)}
              {...bubbleHandlers}
            />
          ))}
          <AnimatePresence>
            {typing && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="message-wrap justify-start">
                <div className="typing-indicator">
                  <span />
                  <span />
                  <span />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className={cn("composer-zone", activeTopic?.closed && "pointer-events-none opacity-60")}>
        {activeTopic?.closed && <p className="mb-2 text-center text-xs text-[var(--muted)]">Тема закрыта для новых сообщений</p>}
        <AnimatePresence>
          {visibleMentionCandidates.length > 0 && (
            <motion.div {...popVariants} className="glass-menu mx-auto mb-2 w-full max-w-3xl overflow-hidden p-1">
              {visibleMentionCandidates.map((candidate) => (
                <button key={candidate.userId} type="button" onClick={() => insertMention(candidate.username)} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition hover:bg-white/10">
                  <Avatar initials={candidate.initials} colors={candidate.colors} size="sm" />
                  <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{candidate.name}</span><span className="block truncate text-[10px] text-[var(--muted)]">@{candidate.username}</span></span>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {picker && (
            <ComposerPicker
              kind={picker}
              onClose={() => setPicker(null)}
              onEmoji={(emoji) => setDraft((value) => value + emoji)}
              onSticker={(sticker) => addSpecial(sticker)}
              onAttachment={handleAttachment}
              onStructured={(kind, payload) => addSpecial(payload, kind)}
              allowPoll={Boolean(chat.group)}
              onPoll={async (poll) => {
                await createPoll({ chatId: chat.id, topicId: selectedTopicId ?? undefined, ...poll });
                setPicker(null);
              }}
              onLiveLocation={startLiveTracking}
              uploading={uploading}
              uploadProgress={uploadProgress}
            />
          )}
        </AnimatePresence>
        {uploading && !picker && <p className="mt-2 text-center text-xs text-[var(--muted)]">Загрузка… {uploadProgress}%</p>}
        {attachError && <p className="mt-2 text-center text-xs text-red-400">{attachError}</p>}
        {actionNote && <p className="mt-2 text-center text-xs text-[var(--muted)]">{actionNote}</p>}
        <AnimatePresence>
          {(editing || replying) && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="composer-context">
              {editing ? <Edit3 size={15} /> : <Reply size={15} />}
              <span className="truncate">
                {editing ? "Редактирование сообщения" : `Ответ на: ${messages.find((item) => item.id === replying)?.text}`}
              </span>
              <button
                onClick={() => {
                  setEditing(null);
                  setReplying(null);
                  setDraft("");
                }}
              >
                <X size={15} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {recording && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="recording-bar">
              {recordMode === "video" && (
                <video ref={videoPreviewRef} autoPlay muted playsInline className="h-9 w-9 rounded-full object-cover" />
              )}
              <motion.span animate={{ opacity: [1, 0.35, 1] }} transition={{ repeat: Infinity, duration: 1 }} className="h-2 w-2 rounded-full bg-red-400" />
              <span className="font-mono text-xs">0:{String(recordSeconds).padStart(2, "0")}</span>
              <Waveform active />
              <span className="ml-auto text-xs font-medium">{recordMode === "video" ? "Видеокружок" : "Проведите влево: видео"}</span>
            </motion.div>
          )}
        </AnimatePresence>
        <div className="composer glass-panel">
          <GlassButton onClick={() => setPicker(picker === "emoji" ? null : "emoji")} active={picker === "emoji"} title="Эмодзи, GIF, стикеры">
            <Smile size={19} />
          </GlassButton>
          <input
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              if (event.target.value.trim()) pingTyping();
              else stopTyping();
            }}
            onBlur={stopTyping}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                sendMessage();
              }
            }}
            placeholder="Сообщение"
          />
          <button onClick={() => setPicker(picker === "attachment" ? null : "attachment")} className="composer-icon" title="Прикрепить">
            <Paperclip size={19} />
          </button>
          <TimerPicker value={selfDestructSeconds} onChange={setSelfDestructSeconds} />
          <button onClick={() => setScheduleOpen(true)} disabled={!draft.trim()} className="composer-icon disabled:opacity-30" title="Запланировать">
            <Clock size={18} />
          </button>
          {draft.trim() ? (
            <motion.button initial={{ scale: 0.7 }} animate={{ scale: 1 }} onClick={sendMessage} className="send-button">
              <Send size={18} />
            </motion.button>
          ) : (
            <motion.button
              onPointerDown={startRecording}
              onPointerMove={moveRecording}
              onPointerUp={stopRecording}
              onPointerCancel={cancelRecording}
              className={cn("mic-button touch-none", recording && "mic-recording")}
              title="Удерживайте для записи"
            >
              {recordMode === "video" && recording ? <Video size={18} /> : <Volume2 size={18} />}
            </motion.button>
          )}
        </div>
      </div>

      <AnimatePresence>
        {contextMenu && activeMessage && (
          <ContextMenu message={activeMessage} position={contextMenu} onClose={() => setContextMenu(null)} onAction={handleContextAction} />
        )}
        {forwarding && <ForwardModal messageIds={selectedMessages.length > 0 ? selectedMessages : [forwarding]} onClose={() => { setForwarding(null); setSelectedMessages([]); }} />}
        {scheduleOpen && <ScheduleModal text={draft.trim()} onClose={() => setScheduleOpen(false)} onSchedule={scheduleCurrentMessage} />}
        {autoDeleteOpen && <AutoDeleteModal current={header.autoDeleteAfterDays ?? null} onClose={() => setAutoDeleteOpen(false)} onSave={async (days) => { await setChatAutoDelete({ chatId: chat.id, days }); }} />}
        {groupSettingsOpen && <GroupSettingsModal chatId={chat.id} onClose={() => setGroupSettingsOpen(false)} onLeft={() => { setGroupSettingsOpen(false); onBack(); }} />}
        {viewerItem && <MediaViewer item={viewerItem} onClose={() => setViewerItem(null)} />}
      </AnimatePresence>
    </section>
  );
}
