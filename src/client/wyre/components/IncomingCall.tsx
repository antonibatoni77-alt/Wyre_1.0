import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import { Phone, PhoneOff, Video } from "lucide-react";
import { Avatar, UserBadge, WarningIndicator } from "./Glass";
import type { CallState } from "../calls/types";

/**
 * Ringtone synthesized with the Web Audio API — no asset to ship, and it
 * respects autoplay policy because it only starts after a user gesture
 * somewhere in the session (falls back to silence otherwise).
 */
function useRingtone(active: boolean) {
  const contextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let interval = 0;

    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const context = new Ctor();
      contextRef.current = context;

      const beep = () => {
        if (stopped || context.state === "closed") return;
        const now = context.currentTime;
        [0, 0.42].forEach((offset) => {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.type = "sine";
          oscillator.frequency.value = 620;
          gain.gain.setValueAtTime(0.0001, now + offset);
          gain.gain.exponentialRampToValueAtTime(0.14, now + offset + 0.04);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.3);
          oscillator.connect(gain).connect(context.destination);
          oscillator.start(now + offset);
          oscillator.stop(now + offset + 0.32);
        });
      };

      void context.resume().catch(() => undefined);
      beep();
      interval = window.setInterval(beep, 2400);
    } catch {
      /* audio unavailable — the visual ring is enough */
    }

    return () => {
      stopped = true;
      if (interval) window.clearInterval(interval);
      void contextRef.current?.close().catch(() => undefined);
      contextRef.current = null;
    };
  }, [active]);
}

export function IncomingCall({
  call,
  onAccept,
  onDecline,
}: {
  call: CallState;
  onAccept: () => void | Promise<void>;
  onDecline: () => void;
}) {
  useRingtone(true);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="incoming-call">
      <div className="call-glow call-glow-one" />
      <div className="call-glow call-glow-two" />

      <motion.div
        initial={{ scale: 0.9, y: 24, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 24 }}
        className="incoming-card glass-panel"
      >
        <div className="incoming-pulse">
          <Avatar initials={call.initials} colors={call.colors} size="xl" />
        </div>
        <div className="mt-5 flex items-center justify-center gap-2">
          <h2 className="text-xl font-semibold">{call.title}</h2>
          <UserBadge kind={call.badge} />
          <WarningIndicator warnings={call.warnings} />
        </div>
        <p className="mt-1.5 text-sm text-white/55">
          {call.group ? `${call.initiatorName} зовёт в групповой звонок` : "Входящий"}
          {call.kind === "video" ? " · видео" : " · аудио"}
        </p>

        <div className="mt-8 flex items-center justify-center gap-10">
          <button onClick={onDecline} className="incoming-action incoming-decline" title="Отклонить">
            <PhoneOff size={24} />
          </button>
          <button onClick={onAccept} className="incoming-action incoming-accept" title="Ответить">
            {call.kind === "video" ? <Video size={24} /> : <Phone size={24} />}
          </button>
        </div>
        <div className="mt-4 flex justify-center gap-10 text-[11px] text-white/45">
          <span className="w-16 text-center">Отклонить</span>
          <span className="w-16 text-center">Ответить</span>
        </div>
      </motion.div>
    </motion.div>
  );
}
