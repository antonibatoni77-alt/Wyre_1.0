import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import {
  Camera,
  CameraOff,
  Copy,
  Maximize2,
  Mic,
  MicOff,
  Link2,
  Minimize2,
  MonitorUp,
  MousePointer2,
  PhoneOff,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import { onCallControlEvent, wyreLiveQuery, wyreMutation } from "../../lib/api";
import { cn } from "../utils/cn";
import { Avatar, UserBadge, WarningIndicator } from "./Glass";
import type { CallState, RemoteControlEvent, RemotePeer } from "../calls/types";
import { useWebRtcCall } from "../calls/useWebRtcCall";
import { getWyreDesktop, isWyreDesktop } from "../utils/desktop";

function formatElapsed(seconds: number) {
  const mm = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const ss = (seconds % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

function VideoTile({ stream, muted, mirrored }: { stream: MediaStream | null; muted?: boolean; mirrored?: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (element.srcObject !== stream) element.srcObject = stream;
    if (stream) void element.play().catch(() => undefined);
  }, [stream]);

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className={cn("call-video", mirrored && "call-video-mirror")}
    />
  );
}

/**
 * Remote audio is played by a dedicated element: a `video` tile can be unmounted
 * or hidden by the layout, which would silently stop the call sound.
 */
function PeerAudio({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || !stream) return;
    if (element.srcObject !== stream) element.srcObject = stream;
    element.muted = false;
    element.volume = 1;
    const play = () => void element.play().catch(() => undefined);
    play();
    // Some browsers refuse the first play() until the next user gesture.
    window.addEventListener("pointerdown", play, { once: true });
    return () => window.removeEventListener("pointerdown", play);
  }, [stream]);

  return <audio ref={ref} autoPlay playsInline className="hidden" />;
}

function PeerStage({ peer, participant }: { peer: RemotePeer; participant?: CallState["participants"][number] }) {
  return (
    <div className="call-peer-tile">
      <PeerAudio stream={peer.stream} />
      {/* The video element stays mounted even when the camera is off — the
          stylesheet shrinks it to an invisible pixel, so the stream never
          needs to re-attach and the tile never flickers between states. */}
      {peer.stream && <VideoTile stream={peer.stream} muted />}
      {!peer.videoActive && (
        <div className="call-peer-fallback">
          <Avatar initials={participant?.initials ?? "??"} colors={participant?.colors ?? ["#8b5cf6", "#2563eb"]} size="xl" />
        </div>
      )}
      <div className="call-peer-label">
        <span>{participant?.name ?? "Участник"}</span>
        {peer.reconnecting && <span className="call-peer-warn">переподключение…</span>}
      </div>
    </div>
  );
}

/**
 * Full-screen view of the controlled peer's screen with `object-contain`, so
 * the controller sees exactly what the target sees. Pointer coordinates are
 * normalised against the displayed video rect (letterboxing accounted for),
 * which makes them line up with the target's real screen.
 */
function RemoteControlStage({
  stream,
  onPointer,
}: {
  stream: MediaStream | null;
  onPointer: (event: ReactPointerEvent<HTMLVideoElement>, type: "pointer_move" | "pointer_down" | "pointer_up") => void;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (element.srcObject !== stream) element.srcObject = stream;
    if (stream) void element.play().catch(() => undefined);
  }, [stream]);

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className="absolute inset-0 z-[2] h-full w-full cursor-crosshair bg-black object-contain"
      onPointerMove={(event) => onPointer(event, "pointer_move")}
      onPointerDown={(event) => onPointer(event, "pointer_down")}
      onPointerUp={(event) => onPointer(event, "pointer_up")}
    />
  );
}

export function CallScreen({
  call,
  myUserId,
  minimized = false,
  onMinimize,
  onExpand,
}: {
  call: CallState;
  myUserId: string;
  minimized?: boolean;
  onMinimize?: () => void;
  onExpand?: () => void;
}) {
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);
  const [remotePanel, setRemotePanel] = useState(false);
  const [remoteCode, setRemoteCode] = useState("");
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [remotePointer, setRemotePointer] = useState<{ x: number; y: number } | null>(null);
  const [miniOffset, setMiniOffset] = useState({ x: 16, y: 24 });
  const miniDrag = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const [osControlPc, setOsControlPc] = useState(false);
  const [osControlAvailable, setOsControlAvailable] = useState(false);
  const processedRemoteEvents = useRef(new Set<string>());
  const lastPointerSentAt = useRef(0);
  const controlBlockedRef = useRef(false);
  const autoSharedForControl = useRef(false);
  const osControlPcRef = useRef(false);
  osControlPcRef.current = osControlPc;
  const { mutateAsync: createCallInvite } = useMutation(wyreMutation("wyre.createCallInvite"));
  const { mutateAsync: requestRemoteControl } = useMutation(wyreMutation("wyre.requestRemoteControl"));
  const { mutateAsync: respondRemoteControl } = useMutation(wyreMutation("wyre.respondRemoteControl"));
  const { mutateAsync: stopRemoteControl } = useMutation(wyreMutation("wyre.stopRemoteControl"));
  const { mutateAsync: sendRemoteControlEvent } = useMutation(wyreMutation("wyre.sendRemoteControlEvent"));
  const receivingRemoteControl = call.remoteControl?.status === "active" && call.remoteControl.isTarget;
  const controllingRemote = call.remoteControl?.status === "active" && call.remoteControl.isController;
  const { data: remoteEvents = [] } = useQuery({
    ...wyreLiveQuery<RemoteControlEvent[]>("wyre.remoteControlEvents", { callId: call.callId }),
    enabled: Boolean(receivingRemoteControl),
  });
  const engine = useWebRtcCall(call, myUserId);
  const {
    localStream,
    peers,
    micOn,
    cameraOn,
    sharing,
    toggleMic,
    toggleCamera,
    toggleShare,
    quality,
    notice,
    mediaError,
    connected,
    elapsed,
    hangUp,
    usingTurn,
  } = engine;

  // Stable grid order: peers are keyed by position, so without sorting the
  // tiles would reshuffle whenever someone joins or the stats loop patches.
  const sortedPeers = useMemo(() => [...peers].sort((a, b) => a.userId.localeCompare(b.userId)), [peers]);

  const waiting = call.status === "ringing" || sortedPeers.length === 0;
  const single = sortedPeers.length <= 1;
  const primary = sortedPeers[0];
  const primaryParticipant = call.participants.find((p) => p.userId === primary?.userId);

  useEffect(() => {
    if (!isWyreDesktop) return;
    void getWyreDesktop()?.osControl.available().then(setOsControlAvailable).catch(() => setOsControlAvailable(false));
  }, []);

  /**
   * The controller must SEE the screen it controls: the moment a session goes
   * active, the target automatically starts sharing its screen, and the share
   * stops again when the session ends.
   */
  useEffect(() => {
    const status = call.remoteControl?.status;
    const isTarget = call.remoteControl?.isTarget;
    if (status === "active" && isTarget && !sharing && !autoSharedForControl.current) {
      autoSharedForControl.current = true;
      void toggleShare();
    }
    if (status !== "active" && autoSharedForControl.current) {
      autoSharedForControl.current = false;
      if (sharing) void toggleShare();
    }
  }, [call.remoteControl?.status, call.remoteControl?.isTarget, sharing, toggleShare]);

  const applyRemoteEvent = useCallback((event: RemoteControlEvent) => {
    if (processedRemoteEvents.current.has(event.id)) return;
    processedRemoteEvents.current.add(event.id);
    if (event.x != null && event.y != null) setRemotePointer({ x: event.x, y: event.y });
    if (event.type === "pointer_down" && event.x != null && event.y != null) {
      const target = document.elementFromPoint(event.x * window.innerWidth, event.y * window.innerHeight);
      if (target instanceof HTMLElement && !target.closest("[data-remote-protected='true']")) target.click();
    }
    if (event.type === "key_down" && event.key && document.activeElement instanceof HTMLElement && !document.activeElement.closest("[data-remote-protected='true']")) {
      document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: event.key, bubbles: true }));
    }
    // Inside the Windows desktop shell the same events can also control the
    // whole computer, but only while the local user keeps the toggle on.
    if (osControlPcRef.current) {
      void getWyreDesktop()?.osControl.inject({ type: event.type, x: event.x, y: event.y, button: event.button, key: event.key }).catch(() => undefined);
    }
  }, []);

  // Backup delivery via the live query; the socket channel below is primary.
  useEffect(() => {
    if (!receivingRemoteControl) {
      setRemotePointer(null);
      processedRemoteEvents.current.clear();
      return;
    }
    for (const event of remoteEvents) applyRemoteEvent(event);
  }, [receivingRemoteControl, remoteEvents, applyRemoteEvent]);

  useEffect(() => onCallControlEvent((raw) => {
    if (!receivingRemoteControl) return;
    applyRemoteEvent(raw as RemoteControlEvent);
  }), [receivingRemoteControl, applyRemoteEvent]);

  useEffect(() => {
    if (!controllingRemote || controlBlockedRef.current) return;
    const sendKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.key.length > 32) return;
      void sendRemoteControlEvent({ callId: call.callId, type: "key_down", key: event.key }).catch(() => {
        controlBlockedRef.current = true;
        setRemoteError("Сеанс управления прерван.");
      });
    };
    window.addEventListener("keydown", sendKey);
    return () => window.removeEventListener("keydown", sendKey);
  }, [call.callId, controllingRemote, sendRemoteControlEvent]);

  useEffect(() => {
    if (!controllingRemote) {
      controlBlockedRef.current = false;
      setRemoteError(null);
    }
  }, [controllingRemote]);

  function sendControlPointer(event: ReactPointerEvent<HTMLVideoElement>, type: "pointer_move" | "pointer_down" | "pointer_up") {
    if (!controllingRemote || controlBlockedRef.current) return;
    if (type === "pointer_move" && Date.now() - lastPointerSentAt.current < 33) return;
    if (type === "pointer_move") lastPointerSentAt.current = Date.now();
    const bounds = event.currentTarget.getBoundingClientRect();
    let x = (event.clientX - bounds.left) / bounds.width;
    let y = (event.clientY - bounds.top) / bounds.height;
    const element = event.currentTarget;
    if (element.videoWidth && element.videoHeight) {
      const scale = Math.min(bounds.width / element.videoWidth, bounds.height / element.videoHeight);
      const shownWidth = element.videoWidth * scale;
      const shownHeight = element.videoHeight * scale;
      x = (event.clientX - bounds.left - (bounds.width - shownWidth) / 2) / shownWidth;
      y = (event.clientY - bounds.top - (bounds.height - shownHeight) / 2) / shownHeight;
    }
    const point = { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
    void sendRemoteControlEvent({ callId: call.callId, type, ...point, button: event.button }).catch((error) => {
      controlBlockedRef.current = true;
      setRemoteError(error instanceof Error ? error.message : "Не удалось передать управление.");
    });
  }

  async function submitRemoteControlRequest() {
    setRemoteError(null);
    try {
      await requestRemoteControl({ callId: call.callId, code: remoteCode.replace(/\D/g, "") });
      setRemoteCode("");
    } catch (error) {
      setRemoteError(error instanceof Error ? error.message : "Не удалось отправить запрос");
    }
  }

  async function copyCallInvite() {
    const result = await createCallInvite({ callId: call.callId }) as { url: string };
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(result.url);
    else window.prompt("Скопируйте ссылку на звонок", result.url);
    setInviteNotice("Ссылка на звонок скопирована · действует 30 минут");
    window.setTimeout(() => setInviteNotice(null), 3500);
  }

  const qualityLabel =
    quality === "good"
      ? "Отличная связь"
      : quality === "ok"
        ? "Средняя связь"
        : quality === "poor"
          ? "Слабая связь"
          : "Нет соединения";

  const statusLine = mediaError
    ? "Ошибка устройства"
    : call.status === "ringing"
      ? call.isInitiator
        ? "Вызываем…"
        : "Соединяем…"
      : !connected
        ? "Соединяем…"
        : formatElapsed(elapsed);

  /**
   * Minimized audio call: the window disappears completely, but the WebRTC
   * engine and the hidden audio elements stay mounted so sound never stops.
   */
  if (minimized && call.kind === "audio") {
    return (
      <div aria-hidden className="call-mini-hidden">
        {peers.map((peer) => <PeerAudio key={peer.userId} stream={peer.stream} />)}
      </div>
    );
  }

  /** Minimized video call: one draggable floating window over the messenger. */
  if (minimized) {
    const clampOffset = (value: number, max: number) => Math.min(Math.max(8, value), Math.max(8, max));
    const onMiniPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest("button")) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      miniDrag.current = { startX: event.clientX, startY: event.clientY, baseX: miniOffset.x, baseY: miniOffset.y };
    };
    const onMiniPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!miniDrag.current) return;
      const width = Math.min(300, window.innerWidth - 24);
      const height = width * 0.62 + 34;
      setMiniOffset({
        x: clampOffset(miniDrag.current.baseX - (event.clientX - miniDrag.current.startX), window.innerWidth - width - 8),
        y: clampOffset(miniDrag.current.baseY - (event.clientY - miniDrag.current.startY), window.innerHeight - height - 8),
      });
    };
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0 }}
        className="call-mini glass-panel"
        style={{ right: miniOffset.x, bottom: miniOffset.y }}
      >
        <div
          className="call-mini-header"
          onPointerDown={onMiniPointerDown}
          onPointerMove={onMiniPointerMove}
          onPointerUp={() => { miniDrag.current = null; }}
          onPointerCancel={() => { miniDrag.current = null; }}
        >
          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold">{call.title}</span>
          <span className="shrink-0 text-[10px] text-white/50">{statusLine}</span>
          <button onClick={toggleMic} className={cn("grid h-6 w-6 place-items-center rounded-full hover:bg-white/10", !micOn && "text-red-300")} title={micOn ? "Выключить микрофон" : "Включить микрофон"}>
            {micOn ? <Mic size={13} /> : <MicOff size={13} />}
          </button>
          <button onClick={() => onExpand?.()} className="grid h-6 w-6 place-items-center rounded-full hover:bg-white/10" title="Развернуть звонок">
            <Maximize2 size={13} />
          </button>
          <button onClick={() => void hangUp()} className="grid h-6 w-6 place-items-center rounded-full text-red-300 hover:bg-red-500/20" title="Завершить звонок">
            <PhoneOff size={13} />
          </button>
        </div>
        <div className="call-mini-stage">
          {peers.length ? (
            <>
              <PeerStage peer={primary!} participant={primaryParticipant} />
              <div className="call-mini-hidden">
                {peers.slice(1).map((peer) => <PeerAudio key={peer.userId} stream={peer.stream} />)}
              </div>
            </>
          ) : (
            <div className="grid h-full place-items-center">
              <Avatar initials={call.initials} colors={call.colors} size="xl" />
            </div>
          )}
          {localStream && (cameraOn || sharing) && (
            <div className="absolute bottom-2 right-2 h-16 w-12 overflow-hidden rounded-lg border border-white/15">
              <VideoTile stream={localStream} muted mirrored={!sharing} />
            </div>
          )}
        </div>
      </motion.div>
    );
  }

  return (
    <motion.main initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="call-screen">
      <div className="call-visual">
        <div className="call-glow call-glow-one" />
        <div className="call-glow call-glow-two" />

        {controllingRemote && primary?.stream ? (
          /* While controlling, the peer's screen becomes the whole stage with
             object-contain so the pointer coordinates match the real screen. */
          <RemoteControlStage stream={primary.stream} onPointer={sendControlPointer} />
        ) : waiting ? (
          <motion.div initial={{ scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="call-avatar-stage">
            <Avatar initials={call.initials} colors={call.colors} size="xl" />
            {/* Ringing state can already carry audio from an early joiner. */}
            {peers.map((peer) => <PeerAudio key={peer.userId} stream={peer.stream} />)}
          </motion.div>
        ) : single && primary ? (
          <div className="call-single-stage">
            <PeerStage peer={primary} participant={primaryParticipant} />
          </div>
        ) : (
          <div className={cn("call-grid", sortedPeers.length > 2 && "call-grid-quad")}>
            {sortedPeers.map((peer) => (
              <PeerStage key={peer.userId} peer={peer} participant={call.participants.find((p) => p.userId === peer.userId)} />
            ))}
          </div>
        )}
      </div>

      {localStream && (cameraOn || sharing) && (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="call-self-view glass-panel">
          <VideoTile stream={localStream} muted mirrored={!sharing} />
        </motion.div>
      )}

      <div className="call-top">
        <div className="flex items-center justify-center gap-2">
          <h1 className="text-xl font-semibold">{call.title}</h1>
          <UserBadge kind={call.badge} />
          <WarningIndicator warnings={call.warnings} />
        </div>
        <p className="mt-1 text-center text-sm text-white/60">{statusLine}</p>
        <div className="call-quality justify-center">
          <span className="bars">
            <span
              style={{
                height: "4px",
                background: quality === "lost" ? "#f87171" : quality === "poor" ? "#fbbf24" : "#34d399",
              }}
            />
            <span
              style={{
                height: "7px",
                background: quality === "good" || quality === "ok" ? "#34d399" : "#3f3f46",
              }}
            />
            <span style={{ height: "10px", background: quality === "good" ? "#34d399" : "#3f3f46" }} />
          </span>
          {qualityLabel}
          {primary?.rtt != null && quality !== "lost" && <span className="text-white/35">· {primary.rtt} мс</span>}
        </div>
        <div className="call-secure">
          <ShieldCheck size={11} />
          Защищённый медиаканал DTLS-SRTP{usingTurn ? "" : " · без TURN"}
        </div>
      </div>

      <AnimatePresence>
        {(notice || mediaError || inviteNotice) && (
          <motion.div initial={{ y: -20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ opacity: 0 }} className="call-notice">
            <TriangleAlert size={14} />
            <span>{mediaError ?? inviteNotice ?? notice}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {sharing && (
        <div className="sharing-label">
          <MonitorUp size={14} /> Экран виден собеседнику
        </div>
      )}

      {receivingRemoteControl && remotePointer && <div className="pointer-events-none fixed z-[90] text-[var(--accent1)] drop-shadow-lg" style={{ left: `${remotePointer.x * 100}%`, top: `${remotePointer.y * 100}%` }}><MousePointer2 size={26} fill="currentColor" /></div>}

      {call.remoteControl?.status === "active" && (
        <div data-remote-protected="true" className="absolute inset-x-0 top-3 z-[85] mx-auto flex w-fit max-w-[calc(100%-2rem)] flex-wrap items-center gap-2 rounded-full border border-amber-400/40 bg-amber-500/15 px-4 py-2 text-xs font-semibold text-amber-200 backdrop-blur-xl">
          <MousePointer2 size={14} />{call.remoteControl.isController ? `Вы управляете экраном: ${call.remoteControl.targetName}` : `${call.remoteControl.controllerName} управляет вашим экраном`}
          {!call.remoteControl.isController && isWyreDesktop && osControlAvailable && (
            <label className="ml-1 flex items-center gap-1.5 rounded-full bg-black/20 px-2 py-1 text-[10px] font-semibold" title="Разрешить управление курсором и клавиатурой всего компьютера, пока включено">
              <input type="checkbox" checked={osControlPc} onChange={(event) => setOsControlPc(event.target.checked)} />
              Управление ПК
            </label>
          )}
          <button onClick={() => void stopRemoteControl({ callId: call.callId })} className="ml-1 rounded-full bg-red-500/20 px-2 py-1 text-red-200">Остановить</button>
        </div>
      )}

      <AnimatePresence>
        {call.remoteControl?.status === "pending" && call.remoteControl.isTarget && (
          <motion.div data-remote-protected="true" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} className="absolute left-1/2 top-1/2 z-[88] w-[min(26rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-[var(--r-xl)] border border-white/10 bg-[var(--glass-heavy)] p-5 text-center shadow-2xl backdrop-blur-2xl">
            <MousePointer2 size={28} className="mx-auto text-amber-300" /><h2 className="mt-3 text-base font-semibold">Запрос удалённого управления</h2><p className="mt-2 text-xs leading-5 text-white/60">{call.remoteControl.controllerName} сможет управлять указателем внутри Wyre. Остановить сеанс можно мгновенно в любой момент.</p><div className="mt-5 flex justify-center gap-3"><button onClick={() => void respondRemoteControl({ callId: call.callId, accept: false })} className="rounded-xl bg-white/10 px-4 py-2 text-xs">Отклонить</button><button onClick={() => void respondRemoteControl({ callId: call.callId, accept: true })} className="rounded-xl bg-[var(--accent1)] px-4 py-2 text-xs font-semibold text-white">Разрешить</button></div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {remotePanel && call.remoteControl?.status !== "active" && (
          <motion.div data-remote-protected="true" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="absolute bottom-28 left-1/2 z-[84] w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 rounded-[var(--r-xl)] border border-white/10 bg-[var(--glass-heavy)] p-4 shadow-2xl backdrop-blur-2xl">
            <div className="flex items-center gap-2"><MousePointer2 size={17} className="text-[var(--accent1)]" /><span className="flex-1 text-sm font-semibold">Удалённое управление</span><button onClick={() => setRemotePanel(false)} className="grid h-7 w-7 place-items-center rounded-full hover:bg-white/10"><X size={15} /></button></div>
            <div className="mt-3 rounded-2xl border border-white/10 p-3"><p className="text-[10px] text-white/50">Ваш код для собеседника</p><div className="mt-1 flex items-center gap-2"><code className="flex-1 text-lg tracking-[0.22em]">{call.remoteControlCode}</code><button onClick={() => void navigator.clipboard?.writeText(call.remoteControlCode)} className="grid h-8 w-8 place-items-center rounded-full bg-white/10"><Copy size={14} /></button></div></div>
            {call.remoteControl?.status === "pending" && call.remoteControl.isController ? <div className="mt-3 flex items-center gap-2 rounded-2xl bg-amber-500/10 p-3 text-xs text-amber-200"><span className="flex-1">Ожидаем согласия: {call.remoteControl.targetName}</span><button onClick={() => void stopRemoteControl({ callId: call.callId })} className="text-red-300">Отменить</button></div> : <div className="mt-3 flex gap-2"><input value={remoteCode} onChange={(event) => { setRemoteCode(event.target.value.replace(/\D/g, "").slice(0, 8)); setRemoteError(null); }} inputMode="numeric" placeholder="Код собеседника" className="glass-input flex-1" /><button disabled={remoteCode.length !== 8} onClick={() => void submitRemoteControlRequest()} className="rounded-xl bg-white/10 px-4 text-xs font-semibold disabled:opacity-40">Запросить</button></div>}
            {remoteError && <p className="mt-2 text-xs text-red-400">{remoteError}</p>}
          </motion.div>
        )}
      </AnimatePresence>

      <div data-remote-protected="true" className="call-controls glass-panel">
        <button onClick={toggleMic} className={cn("call-button", !micOn && "call-button-off")} title="Микрофон">
          {micOn ? <Mic size={21} /> : <MicOff size={21} />}
        </button>
        <button
          onClick={() => void toggleCamera()}
          className={cn("call-button", !cameraOn && "call-button-off")}
          title="Камера"
        >
          {cameraOn ? <Camera size={21} /> : <CameraOff size={21} />}
        </button>
        <button
          onClick={() => void toggleShare()}
          className={cn("call-button", sharing && "call-button-active")}
          title="Демонстрация экрана"
        >
          <MonitorUp size={21} />
        </button>
        <button onClick={() => setRemotePanel((value) => !value)} className={cn("call-button", (remotePanel || call.remoteControl?.status === "active") && "call-button-active")} title="Удалённое управление"><MousePointer2 size={20} /></button>
        {call.group && <button onClick={() => void copyCallInvite()} className="call-button" title="Скопировать ссылку-приглашение"><Link2 size={21} /></button>}
        {onMinimize && (
          <button onClick={onMinimize} className="call-button" title="Свернуть звонок">
            <Minimize2 size={21} />
          </button>
        )}
        <button onClick={() => void hangUp()} className="call-button call-end" title="Завершить звонок">
          <PhoneOff size={22} />
        </button>
      </div>
    </motion.main>
  );
}
