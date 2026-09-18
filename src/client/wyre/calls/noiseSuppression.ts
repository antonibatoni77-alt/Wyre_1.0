/**
 * Optional extra noise suppression for calls.
 *
 * The browser constraint `noiseSuppression: true` is always on. This module adds
 * a spectral-gating AudioWorklet on top of it for steady background noise. If
 * AudioWorklet is unavailable the original microphone track is used unchanged.
 */
export type NoiseSuppression = {
  track: MediaStreamTrack;
  setEnabled: (enabled: boolean) => void;
  stop: () => void;
};

export function noiseSuppressionSupported() {
  const AudioCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return Boolean(AudioCtor && "audioWorklet" in AudioContext.prototype && typeof MediaStreamAudioDestinationNode !== "undefined");
}

export async function createNoiseSuppression(track: MediaStreamTrack): Promise<NoiseSuppression | null> {
  if (!noiseSuppressionSupported()) return null;
  try {
    const context = new AudioContext();
    // Without an explicit resume the context can stay suspended and emit silence.
    if (context.state === "suspended") await context.resume();
    if (context.state !== "running") {
      await context.close().catch(() => undefined);
      return null;
    }
    await context.audioWorklet.addModule("/noise-suppressor.js");
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const worklet = new AudioWorkletNode(context, "wyre-noise-suppressor");
    const destination = context.createMediaStreamDestination();
    source.connect(worklet).connect(destination);
    const processed = destination.stream.getAudioTracks()[0];
    if (!processed || processed.readyState !== "live") {
      source.disconnect();
      worklet.disconnect();
      await context.close().catch(() => undefined);
      return null;
    }
    // Mirror mute state: the original track stays the source of truth.
    processed.enabled = track.enabled;
    return {
      track: processed,
      setEnabled: (enabled) => worklet.port.postMessage({ enabled }),
      stop: () => {
        source.disconnect();
        worklet.disconnect();
        processed.stop();
        void context.close().catch(() => undefined);
      },
    };
  } catch {
    return null;
  }
}
