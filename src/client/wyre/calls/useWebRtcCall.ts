import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { wyreLiveQuery, wyreMutation, wyreQuietMutation, wyreQuery } from "../../lib/api";
import {
  CALL_AUDIO_CONSTRAINTS,
  CALL_VIDEO_CONSTRAINTS,
  mediaAccessError,
  requestMediaStream,
  takePreparedCallMedia,
} from "../utils/mediaPermissions";
import { createNoiseSuppression, noiseSuppressionSupported, type NoiseSuppression } from "./noiseSuppression";

import type { CallQuality, CallSignal, CallState, RemotePeer } from "./types";

/**
 * Real WebRTC engine for Wyre calls.
 *
 * - Media is peer-to-peer and encrypted end-to-end by DTLS-SRTP (mandatory in
 *   WebRTC — there is nothing to switch on). Only SDP/ICE metadata passes
 *   through the server.
 * - Signaling rides the app's existing realtime layer (`wyre.callSignals`,
 *   a LiveData query backed by a Mongo change stream) — no extra service.
 * - Topology is a P2P mesh: one RTCPeerConnection per remote participant.
 * - Negotiation uses the standard "perfect negotiation" pattern, so both
 *   sides may offer simultaneously without deadlocking (needed for
 *   screen-share renegotiation and ICE restarts).
 */

const STATS_INTERVAL_MS = 2000;
const PING_INTERVAL_MS = 10_000;
/** How long a connection may stay `disconnected` before we try an ICE restart. */
const RECONNECT_GRACE_MS = 3500;
const MAX_ICE_RESTARTS = 5;

/** Video encoding ladder — index 0 is full quality, the last rung is audio-only. */
const VIDEO_LADDER = [
  { maxBitrate: 1_600_000, scaleResolutionDownBy: 1, maxFramerate: 30 },
  { maxBitrate: 500_000, scaleResolutionDownBy: 1.5, maxFramerate: 24 },
  { maxBitrate: 150_000, scaleResolutionDownBy: 2, maxFramerate: 15 },
  { maxBitrate: 60_000, scaleResolutionDownBy: 4, maxFramerate: 8 },
];

interface PeerEntry {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  pendingIce: RTCIceCandidateInit[];
  audioSender: RTCRtpSender | null;
  videoSender: RTCRtpSender | null;
  stream: MediaStream;
  queue: Promise<unknown>;
  prevPacketsLost: number;
  prevPacketsReceived: number;
  poorStreak: number;
  goodStreak: number;
  level: number;
  videoSuspended: boolean;
  restartTimer: number | null;
  restartAttempts: number;
}

function emptyPeer(userId: string): RemotePeer {
  return {
    userId,
    stream: null,
    videoActive: false,
    quality: "good",
    connection: "new",
    rtt: null,
    loss: 0,
    reconnecting: false,
  };
}

export interface UseWebRtcCallResult {
  localStream: MediaStream | null;
  peers: RemotePeer[];
  micOn: boolean;
  cameraOn: boolean;
  sharing: boolean;
  toggleMic: () => void;
  toggleCamera: () => Promise<void>;
  toggleShare: () => Promise<void>;
  /** Worst quality across all peers — what the on-screen indicator shows. */
  quality: CallQuality;
  /** Human-readable warning when the engine had to degrade something. */
  notice: string | null;
  /** Fatal media error (permission denied / no devices). */
  mediaError: string | null;
  connected: boolean;
  reconnecting: boolean;
  elapsed: number;
  hangUp: () => Promise<void>;
  usingTurn: boolean;
}

export function useWebRtcCall(call: CallState | null, myUserId: string): UseWebRtcCallResult {
  const callId = call?.callId ?? null;
  const joined = call?.myState === "joined" && call?.status !== "ended";

  const { data: ice } = useQuery({
    ...wyreQuery<{ iceServers: RTCIceServer[]; hasTurn: boolean }>("wyre.iceServers", {}),
    staleTime: 5 * 60 * 1000,
  });

  const { data: signals = [] } = useQuery({
    ...wyreLiveQuery<CallSignal[]>("wyre.callSignals", { callId: callId ?? "" }),
    enabled: Boolean(callId) && joined,
  });

  const { mutateAsync: sendSignalMutation } = useMutation(wyreQuietMutation("wyre.sendCallSignal"));
  const { mutateAsync: ackSignals } = useMutation(wyreQuietMutation("wyre.ackCallSignals"));
  const { mutateAsync: pingCall } = useMutation(wyreQuietMutation("wyre.pingCall"));
  const { mutateAsync: leaveCall } = useMutation(wyreMutation("wyre.leaveCall"));

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [peers, setPeers] = useState<RemotePeer[]>([]);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(call?.kind === "video");
  const [sharing, setSharing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const entriesRef = useRef(new Map<string, PeerEntry>());
  const localStreamRef = useRef<MediaStream | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const processedRef = useRef(new Set<string>());
  const pendingAckRef = useRef<string[]>([]);
  const iceRef = useRef<RTCIceServer[]>([{ urls: "stun:stun.l.google.com:19302" }]);
  const callIdRef = useRef<string | null>(null);
  const cameraOnRef = useRef(cameraOn);
  const micOnRef = useRef(micOn);
  const noiseRef = useRef<NoiseSuppression | null>(null);
  const rawMicTrackRef = useRef<MediaStreamTrack | null>(null);

  callIdRef.current = callId;
  cameraOnRef.current = cameraOn;
  micOnRef.current = micOn;
  if (ice?.iceServers?.length) iceRef.current = ice.iceServers;

  const patchPeer = useCallback((userId: string, patch: Partial<RemotePeer>) => {
    setPeers((current) => {
      const index = current.findIndex((peer) => peer.userId === userId);
      if (index === -1) return [...current, { ...emptyPeer(userId), ...patch }];
      const prev = current[index];
      // Stats arrive every 2s; skip the update entirely when nothing changed
      // so the whole call screen does not re-render for identical values.
      const changed = Object.entries(patch).some(([key, value]) => prev[key as keyof RemotePeer] !== value);
      if (!changed) return current;
      const next = [...current];
      next[index] = { ...prev, ...patch };
      return next;
    });
  }, []);

  const sendSignal = useCallback(
    async (toUserId: string, type: "offer" | "answer" | "ice", payload: unknown) => {
      const id = callIdRef.current;
      if (!id) return;
      try {
        await sendSignalMutation({ callId: id, toUserId, type, payload: JSON.stringify(payload) });
      } catch {
        // A dropped signal is recoverable — ICE restart / renegotiation retries.
      }
    },
    [sendSignalMutation],
  );

  /* ---------------------------------------------------------------- media */

  /**
   * Noise suppression is always on when the browser supports the AudioWorklet:
   * the processed track replaces the raw microphone track on every sender.
   * New peers created later pick the processed track from `noiseRef` directly.
   */
  const applyNoiseSuppression = useCallback(async () => {
    const micTrack = rawMicTrackRef.current;
    if (!micTrack || noiseRef.current) return;
    const suppression = await createNoiseSuppression(micTrack);
    if (!suppression) return;
    noiseRef.current = suppression;
    suppression.setEnabled(true);
    suppression.track.enabled = micTrack.enabled;
    for (const entry of entriesRef.current.values()) {
      await entry.audioSender?.replaceTrack(suppression.track).catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    if (!joined) return;
    let cancelled = false;

    async function acquire() {
      const wantsVideo = call?.kind === "video";

      try {
        let stream = takePreparedCallMedia(wantsVideo ? "video" : "audio");
        if (!stream) {
          try {
            stream = await requestMediaStream(
              { audio: CALL_AUDIO_CONSTRAINTS, video: wantsVideo ? CALL_VIDEO_CONSTRAINTS : false },
              wantsVideo ? ["microphone", "camera"] : ["microphone"],
            );
          } catch (error) {
            if (!wantsVideo) throw error;
            setNotice(`${error instanceof Error ? error.message : mediaAccessError(error, ["camera"])} Продолжаем только со звуком.`);
            stream = await requestMediaStream(
              { audio: CALL_AUDIO_CONSTRAINTS, video: false },
              ["microphone"],
            );
          }
        }
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        cameraTrackRef.current = stream.getVideoTracks()[0] ?? null;
        // The raw microphone track always stays in the stream, so audio can
        // never break because of the optional filter. Suppression replaces it
        // on the senders right after this.
        rawMicTrackRef.current = stream.getAudioTracks()[0] ?? null;
        localStreamRef.current = stream;
        setLocalStream(stream);
        setCameraOn(Boolean(cameraTrackRef.current));
        if (rawMicTrackRef.current && noiseSuppressionSupported()) void applyNoiseSuppression();
      } catch (error) {
        if (!cancelled) {
          setMediaError(error instanceof Error ? error.message : mediaAccessError(error, ["microphone"]));
        }
      }
    }

    void acquire();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, call?.kind, applyNoiseSuppression]);

  /* ------------------------------------------------------- sender tuning */

  const applyLevel = useCallback((entry: PeerEntry, level: number) => {
    const sender = entry.videoSender;
    if (!sender) return;
    const clamped = Math.max(0, Math.min(level, VIDEO_LADDER.length));
    entry.level = clamped;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    // Video always yields before audio does.
    params.degradationPreference = "balanced";
    const encoding = params.encodings[0];
    if (clamped >= VIDEO_LADDER.length) {
      encoding.active = false;
      entry.videoSuspended = true;
    } else {
      const rung = VIDEO_LADDER[clamped];
      encoding.active = cameraOnRef.current || screenStreamRef.current !== null;
      encoding.maxBitrate = rung.maxBitrate;
      encoding.scaleResolutionDownBy = rung.scaleResolutionDownBy;
      encoding.maxFramerate = rung.maxFramerate;
      encoding.networkPriority = "low";
      encoding.priority = "low";
      entry.videoSuspended = false;
    }
    void sender.setParameters(params).catch(() => undefined);
  }, []);

  const prioritizeAudio = useCallback((entry: PeerEntry) => {
    const sender = entry.audioSender;
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].priority = "high";
    params.encodings[0].networkPriority = "high";
    void sender.setParameters(params).catch(() => undefined);
  }, []);

  /* ------------------------------------------------- peer connection setup */

  const closePeer = useCallback((userId: string) => {
    const entry = entriesRef.current.get(userId);
    if (!entry) return;
    if (entry.restartTimer) window.clearTimeout(entry.restartTimer);
    entry.pc.onicecandidate = null;
    entry.pc.ontrack = null;
    entry.pc.onnegotiationneeded = null;
    entry.pc.oniceconnectionstatechange = null;
    entry.pc.onconnectionstatechange = null;
    try {
      entry.pc.close();
    } catch {
      /* already closed */
    }
    entriesRef.current.delete(userId);
    setPeers((current) => current.filter((peer) => peer.userId !== userId));
  }, []);

  const ensurePeer = useCallback(
    (userId: string): PeerEntry | null => {
      const existing = entriesRef.current.get(userId);
      if (existing) return existing;

      const local = localStreamRef.current;
      if (!local) return null;

      const pc = new RTCPeerConnection({
        iceServers: iceRef.current,
        iceCandidatePoolSize: 2,
        bundlePolicy: "max-bundle",
      });

      const entry: PeerEntry = {
        pc,
        // Deterministic tie-break: the lexicographically larger id is polite.
        polite: myUserId > userId,
        makingOffer: false,
        ignoreOffer: false,
        pendingIce: [],
        audioSender: null,
        videoSender: null,
        stream: new MediaStream(),
        queue: Promise.resolve(),
        prevPacketsLost: 0,
        prevPacketsReceived: 0,
        poorStreak: 0,
        goodStreak: 0,
        level: 0,
        videoSuspended: false,
        restartTimer: null,
        restartAttempts: 0,
      };
      entriesRef.current.set(userId, entry);
      setPeers((current) => (current.some((p) => p.userId === userId) ? current : [...current, emptyPeer(userId)]));

      // Fixed m-line order on both sides: audio first, then video. The video
      // transceiver exists even in audio calls so the camera or a screen share
      // can be attached later without rebuilding the connection.
      const audioTrack = noiseRef.current?.track ?? local.getAudioTracks()[0];
      const videoTrack = screenStreamRef.current?.getVideoTracks()[0] ?? local.getVideoTracks()[0];
      entry.audioSender = pc.addTransceiver(audioTrack ?? "audio", { direction: "sendrecv" }).sender;
      entry.videoSender = pc.addTransceiver(videoTrack ?? "video", { direction: "sendrecv" }).sender;
      prioritizeAudio(entry);
      applyLevel(entry, 0);

      pc.onicecandidate = (event) => {
        if (event.candidate) void sendSignal(userId, "ice", event.candidate.toJSON());
      };

      pc.ontrack = (event) => {
        entry.stream.addTrack(event.track);
        const track = event.track;
        if (track.kind === "video") {
          const sync = () => patchPeer(userId, { videoActive: !track.muted });
          track.onmute = sync;
          track.onunmute = sync;
          sync();
        }
        patchPeer(userId, { stream: entry.stream });
      };

      pc.onnegotiationneeded = () => {
        entry.queue = entry.queue
          .then(async () => {
            try {
              entry.makingOffer = true;
              await pc.setLocalDescription();
              if (pc.localDescription) await sendSignal(userId, "offer", pc.localDescription.toJSON());
            } catch {
              /* renegotiation will be retried by the reconnect logic */
            } finally {
              entry.makingOffer = false;
            }
          })
          .catch(() => undefined);
      };

      const scheduleRestart = (immediate: boolean) => {
        if (entry.restartTimer) return;
        if (entry.restartAttempts >= MAX_ICE_RESTARTS) {
          setNotice("Не удалось восстановить соединение — проверьте интернет или перезвоните");
          return;
        }
        // The impolite side drives recovery; the polite side only steps in late.
        const delay = immediate ? 0 : entry.polite ? RECONNECT_GRACE_MS * 2 : RECONNECT_GRACE_MS;
        entry.restartTimer = window.setTimeout(() => {
          entry.restartTimer = null;
          const state = pc.iceConnectionState;
          if (state === "connected" || state === "completed" || state === "closed") return;
          entry.restartAttempts += 1;
          try {
            pc.restartIce();
          } catch {
            /* nothing else we can do */
          }
        }, delay);
      };

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        if (state === "disconnected") {
          patchPeer(userId, { reconnecting: true, quality: "lost" });
          setNotice("Связь нестабильна — восстанавливаем соединение…");
          scheduleRestart(false);
        } else if (state === "failed") {
          patchPeer(userId, { reconnecting: true, quality: "lost" });
          setNotice("Соединение потеряно — переподключаемся…");
          scheduleRestart(true);
        } else if (state === "connected" || state === "completed") {
          if (entry.restartTimer) {
            window.clearTimeout(entry.restartTimer);
            entry.restartTimer = null;
          }
          entry.restartAttempts = 0;
          patchPeer(userId, { reconnecting: false });
          setNotice(null);
        }
      };

      pc.onconnectionstatechange = () => {
        patchPeer(userId, { connection: pc.connectionState });
      };

      return entry;
    },
    [applyLevel, myUserId, patchPeer, prioritizeAudio, sendSignal],
  );

  /* ------------------------------------------------------ peer lifecycle */

  useEffect(() => {
    if (!joined || !localStream || !call) {
      return;
    }
    const wanted = new Set(call.peers);
    for (const userId of wanted) ensurePeer(userId);
    for (const userId of [...entriesRef.current.keys()]) {
      if (!wanted.has(userId)) closePeer(userId);
    }
  }, [joined, localStream, call, ensurePeer, closePeer]);

  /* ------------------------------------------------------ signal handling */

  useEffect(() => {
    if (!joined || !localStream || signals.length === 0) return;

    const fresh = signals.filter((signal) => !processedRef.current.has(signal.id));
    if (fresh.length === 0) return;

    for (const signal of fresh) {
      processedRef.current.add(signal.id);
      pendingAckRef.current.push(signal.id);

      const entry = ensurePeer(signal.from);
      if (!entry) continue;
      const { pc } = entry;

      entry.queue = entry.queue
        .then(async () => {
          const payload = JSON.parse(signal.payload);

          if (signal.type === "ice") {
            if (entry.ignoreOffer) return;
            if (!pc.remoteDescription) {
              entry.pendingIce.push(payload as RTCIceCandidateInit);
              return;
            }
            try {
              await pc.addIceCandidate(payload as RTCIceCandidateInit);
            } catch {
              if (!entry.ignoreOffer) {
                /* candidate arrived before the description — safe to drop */
              }
            }
            return;
          }

          const description = payload as RTCSessionDescriptionInit;
          if (description.type === "answer" && pc.signalingState !== "have-local-offer") return;
          const collision =
            description.type === "offer" && (entry.makingOffer || pc.signalingState !== "stable");
          entry.ignoreOffer = !entry.polite && collision;
          if (entry.ignoreOffer) return;

          await pc.setRemoteDescription(description);
          for (const candidate of entry.pendingIce.splice(0)) {
            await pc.addIceCandidate(candidate).catch(() => undefined);
          }
          if (description.type === "offer") {
            await pc.setLocalDescription();
            if (pc.localDescription) await sendSignal(signal.from, "answer", pc.localDescription.toJSON());
          }
        })
        .catch(() => undefined);
    }
  }, [signals, joined, localStream, ensurePeer, sendSignal]);

  /** Batch-deletes consumed envelopes so the live inbox does not grow. */
  useEffect(() => {
    if (!joined) return;
    const timer = window.setInterval(() => {
      const batch = pendingAckRef.current.splice(0, 100);
      if (batch.length > 0) void ackSignals({ signalIds: batch }).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [joined, ackSignals]);

  /* --------------------------------------------------------- stats loop */

  useEffect(() => {
    if (!joined) return;

    const timer = window.setInterval(async () => {
      for (const [userId, entry] of entriesRef.current) {
        let rtt: number | null = null;
        let packetsLost = 0;
        let packetsReceived = 0;

        try {
          const stats = await entry.pc.getStats();
          stats.forEach((report) => {
            if (report.type === "candidate-pair" && (report as any).nominated && (report as any).state === "succeeded") {
              const value = (report as any).currentRoundTripTime;
              if (typeof value === "number") rtt = Math.round(value * 1000);
            }
            if (report.type === "inbound-rtp" && !(report as any).isRemote) {
              packetsLost += (report as any).packetsLost ?? 0;
              packetsReceived += (report as any).packetsReceived ?? 0;
            }
          });
        } catch {
          continue;
        }

        const lostDelta = Math.max(0, packetsLost - entry.prevPacketsLost);
        const receivedDelta = Math.max(0, packetsReceived - entry.prevPacketsReceived);
        entry.prevPacketsLost = packetsLost;
        entry.prevPacketsReceived = packetsReceived;

        const total = lostDelta + receivedDelta;
        const loss = total > 0 ? lostDelta / total : 0;
        const live = entry.pc.iceConnectionState === "connected" || entry.pc.iceConnectionState === "completed";

        let quality: CallQuality;
        if (!live) quality = "lost";
        else if (loss < 0.02 && (rtt === null || rtt < 250)) quality = "good";
        else if (loss < 0.08 && (rtt === null || rtt < 600)) quality = "ok";
        else quality = "poor";

        if (quality === "poor" || quality === "lost") {
          entry.poorStreak += 1;
          entry.goodStreak = 0;
        } else if (quality === "good") {
          entry.goodStreak += 1;
          entry.poorStreak = 0;
        } else {
          entry.poorStreak = Math.max(0, entry.poorStreak - 1);
          entry.goodStreak = 0;
        }

        // Step down one rung per two bad samples; audio is never touched.
        if (entry.poorStreak >= 2 && entry.level < VIDEO_LADDER.length) {
          entry.poorStreak = 0;
          applyLevel(entry, entry.level + 1);
          setNotice(
            entry.level >= VIDEO_LADDER.length
              ? "Слабый сигнал — видео временно отключено, звук сохраняем"
              : "Слабый сигнал — снижаем качество видео",
          );
        } else if (entry.goodStreak >= 3 && entry.level > 0) {
          entry.goodStreak = 0;
          applyLevel(entry, entry.level - 1);
          if (entry.level === 0) setNotice(null);
        }

        patchPeer(userId, { rtt, loss, quality });
      }
    }, STATS_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [joined, applyLevel, patchPeer]);

  /* ------------------------------------------------------------- ping */

  useEffect(() => {
    if (!joined || !callId) return;
    void pingCall({ callId }).catch(() => undefined);
    const timer = window.setInterval(() => {
      void pingCall({ callId }).catch(() => undefined);
    }, PING_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [joined, callId, pingCall]);

  /* ------------------------------------------------------------ timer */

  useEffect(() => {
    if (!call?.startedAt || call.status !== "active") return;
    const started = new Date(call.startedAt).getTime();
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [call?.startedAt, call?.status]);

  /* ----------------------------------------------------------- controls */

  const toggleMic = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !micOnRef.current;
    stream.getAudioTracks().forEach((track) => {
      track.enabled = next;
    });
    if (rawMicTrackRef.current) rawMicTrackRef.current.enabled = next;
    if (noiseRef.current) noiseRef.current.track.enabled = next;
    setMicOn(next);
  }, []);

  const toggleCamera = useCallback(async () => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !cameraOnRef.current;

    if (next && !cameraTrackRef.current) {
      // Audio-only call being upgraded to video: acquire the camera now.
      try {
        const camera = await requestMediaStream({ video: CALL_VIDEO_CONSTRAINTS }, ["camera"]);
        const track = camera.getVideoTracks()[0];
        cameraTrackRef.current = track;
        stream.addTrack(track);
        setLocalStream(new MediaStream(stream.getTracks()));
        for (const entry of entriesRef.current.values()) {
          await entry.videoSender?.replaceTrack(track).catch(() => undefined);
        }
      } catch (error) {
        setNotice(error instanceof Error ? error.message : mediaAccessError(error, ["camera"]));
        return;
      }
    }

    cameraOnRef.current = next;
    setCameraOn(next);
    if (cameraTrackRef.current && !screenStreamRef.current) cameraTrackRef.current.enabled = next;
    for (const entry of entriesRef.current.values()) applyLevel(entry, entry.level);
  }, [applyLevel]);

  const stopSharing = useCallback(async () => {
    const screen = screenStreamRef.current;
    screenStreamRef.current = null;
    screen?.getTracks().forEach((track) => track.stop());
    const camera = cameraTrackRef.current;
    for (const entry of entriesRef.current.values()) {
      await entry.videoSender?.replaceTrack(camera ?? null).catch(() => undefined);
    }
    if (camera) camera.enabled = cameraOnRef.current;
    setSharing(false);
    for (const entry of entriesRef.current.values()) applyLevel(entry, entry.level);
  }, [applyLevel]);

  const toggleShare = useCallback(async () => {
    if (screenStreamRef.current) {
      await stopSharing();
      return;
    }
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 } },
        audio: false,
      });
      screenStreamRef.current = screen;
      const track = screen.getVideoTracks()[0];
      track.onended = () => {
        void stopSharing();
      };
      for (const entry of entriesRef.current.values()) {
        await entry.videoSender?.replaceTrack(track).catch(() => undefined);
      }
      setSharing(true);
      for (const entry of entriesRef.current.values()) applyLevel(entry, entry.level);
    } catch {
      // User cancelled the picker — nothing to report.
    }
  }, [applyLevel, stopSharing]);

  const hangUp = useCallback(async () => {
    const id = callIdRef.current;
    if (id) await leaveCall({ callId: id }).catch(() => undefined);
  }, [leaveCall]);

  /* ----------------------------------------------------------- teardown */

  useEffect(() => {
    if (joined) return;
    // Left / declined / ended: release every device and socket immediately.
    for (const userId of [...entriesRef.current.keys()]) closePeer(userId);
    noiseRef.current?.stop();
    noiseRef.current = null;
    rawMicTrackRef.current?.stop();
    rawMicTrackRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    screenStreamRef.current = null;
    cameraTrackRef.current = null;
    processedRef.current.clear();
    pendingAckRef.current = [];
    setLocalStream(null);
    setPeers([]);
    setSharing(false);
    setNotice(null);
    setElapsed(0);
  }, [joined, closePeer]);

  useEffect(() => {
    const onUnload = () => {
      const id = callIdRef.current;
      if (id) void leaveCall({ callId: id }).catch(() => undefined);
    };
    window.addEventListener("pagehide", onUnload);
    return () => {
      window.removeEventListener("pagehide", onUnload);
      for (const userId of [...entriesRef.current.keys()]) closePeer(userId);
      noiseRef.current?.stop();
      noiseRef.current = null;
      rawMicTrackRef.current?.stop();
      rawMicTrackRef.current = null;
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [closePeer, leaveCall]);

  const quality = useMemo<CallQuality>(() => {
    if (peers.length === 0) return "good";
    const order: CallQuality[] = ["good", "ok", "poor", "lost"];
    return peers.reduce<CallQuality>(
      (worst, peer) => (order.indexOf(peer.quality) > order.indexOf(worst) ? peer.quality : worst),
      "good",
    );
  }, [peers]);

  const connected = peers.some((peer) => peer.connection === "connected");
  const reconnecting = peers.some((peer) => peer.reconnecting);

  return {
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
    reconnecting,
    elapsed,
    hangUp,
    usingTurn: Boolean(ice?.hasTurn),
  };
}
