// Bridge to the Wyre Android shell (injected by MainActivity as
// `window.WyreNative`). The WebView cannot use WebAuthn, so biometric
// confirmation and background-push registration ride this bridge instead.
// Absent in browsers and in the Windows desktop shell.

export interface WyreNativeBridge {
  /** True when the device has a secure lock screen to confirm with. */
  biometricAvailable: () => boolean;
  /** Shows the system lock-screen confirmation; resolves via __wyreNativeResult. */
  authenticate: (reason: string, callbackId: string) => void;
  /** Hands the server push-action token to the native shell. */
  setPushActionToken: (token: string) => void;
  /** Asks the shell to deliver its current FCM token via __wyreFcmToken. */
  requestFcmToken: () => void;
}

export function getWyreNative(): WyreNativeBridge | null {
  return (window as unknown as { WyreNative?: WyreNativeBridge }).WyreNative ?? null;
}

/** Runs the native device-lock confirmation and resolves with the outcome. */
export function nativeBiometricAuthenticate(reason: string): Promise<boolean> {
  const bridge = getWyreNative();
  if (!bridge || !bridge.biometricAvailable()) return Promise.resolve(false);
  return new Promise((resolve) => {
    const callbackId = `native-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const host = window as unknown as {
      __wyreNativeResult?: (id: string, success: boolean, error?: string) => void;
    };
    const previous = host.__wyreNativeResult;
    const timeout = window.setTimeout(() => {
      host.__wyreNativeResult = previous;
      resolve(false);
    }, 60_000);
    host.__wyreNativeResult = (id: string, success: boolean) => {
      if (id !== callbackId) return;
      window.clearTimeout(timeout);
      host.__wyreNativeResult = previous;
      resolve(success);
    };
    bridge.authenticate(reason, callbackId);
  });
}
