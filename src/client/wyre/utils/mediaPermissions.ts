export type CallMediaKind = "audio" | "video";
export type RequestedMediaDevice = "microphone" | "camera";

export const CALL_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export const CALL_VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: "user",
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
};

interface PreparedCallMedia {
  kind: CallMediaKind;
  stream: MediaStream;
  expires: number;
}

let preparedCallMedia: PreparedCallMedia | null = null;

function deviceLabel(devices: RequestedMediaDevice[]) {
  if (devices.includes("camera") && devices.includes("microphone")) return "камере и микрофону";
  if (devices.includes("camera")) return "камере";
  return "микрофону";
}

function stopStream(stream: MediaStream) {
  stream.getTracks().forEach((track) => track.stop());
}

export function callMediaConstraints(kind: CallMediaKind): MediaStreamConstraints {
  return {
    audio: CALL_AUDIO_CONSTRAINTS,
    video: kind === "video" ? CALL_VIDEO_CONSTRAINTS : false,
  };
}

export function mediaAccessError(error: unknown, devices: RequestedMediaDevice[]) {
  const label = deviceLabel(devices);

  if (!window.isSecureContext) {
    return `Доступ к ${label} возможен только через HTTPS. На компьютере можно использовать localhost, а на телефоне откройте защищённый HTTPS-адрес Wyre.`;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    return `Этот браузер не поддерживает доступ к ${label}. Обновите браузер или откройте Wyre в Chrome, Edge или Safari.`;
  }

  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return `Доступ к ${label} запрещён. Разрешите его в системном окне или в настройках сайта браузера и повторите действие.`;
    }
    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      return `Не найдено доступное устройство: ${label}. Проверьте подключение и системные настройки.`;
    }
    if (error.name === "NotReadableError" || error.name === "TrackStartError") {
      return `Не удалось включить ${label}: устройство занято другим приложением или отключено в системе.`;
    }
    if (error.name === "OverconstrainedError") {
      return `Браузер не смог подобрать режим для ${label}. Проверьте устройство и повторите попытку.`;
    }
  }

  return `Не удалось получить доступ к ${label}. Проверьте разрешения браузера и системы.`;
}

export async function requestMediaStream(
  constraints: MediaStreamConstraints,
  devices: RequestedMediaDevice[],
) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error(mediaAccessError(undefined, devices));
  }

  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    throw new Error(mediaAccessError(error, devices));
  }
}

export async function prepareCallMedia(kind: CallMediaKind) {
  discardPreparedCallMedia();
  const stream = await requestMediaStream(
    callMediaConstraints(kind),
    kind === "video" ? ["microphone", "camera"] : ["microphone"],
  );
  preparedCallMedia = {
    kind,
    stream,
    expires: window.setTimeout(() => discardPreparedCallMedia(), 30_000),
  };
  return stream;
}

export function takePreparedCallMedia(kind: CallMediaKind) {
  const prepared = preparedCallMedia;
  preparedCallMedia = null;
  if (!prepared) return null;
  window.clearTimeout(prepared.expires);

  const hasAudio = prepared.stream.getAudioTracks().some((track) => track.readyState === "live");
  const hasVideo = prepared.stream.getVideoTracks().some((track) => track.readyState === "live");
  if (!hasAudio || (kind === "video" && !hasVideo)) {
    stopStream(prepared.stream);
    return null;
  }
  return prepared.stream;
}

export function discardPreparedCallMedia() {
  if (!preparedCallMedia) return;
  window.clearTimeout(preparedCallMedia.expires);
  stopStream(preparedCallMedia.stream);
  preparedCallMedia = null;
}
