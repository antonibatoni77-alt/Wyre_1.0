import { callMethod } from '../../lib/api';

function urlBase64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = `${base64}${padding}`.replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(normalized);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
}

/** Registration is always user-initiated: browsers reject silent permission prompts. */
export async function subscribeToPush(publicKey: string) {
  if (!pushSupported()) throw new Error('Этот браузер не поддерживает push-уведомления');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Разрешите уведомления в браузере, чтобы получать их в фоне');
  const registration = (await navigator.serviceWorker.getRegistration('/')) ?? (await registerServiceWorker());
  if (!registration) throw new Error('Не удалось зарегистрировать service worker');
  await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  const payload = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!payload.endpoint || !payload.keys?.p256dh || !payload.keys.auth) throw new Error('Браузер вернул некорректную подписку');
  await callMethod('wyre.subscribePush', {
    endpoint: payload.endpoint,
    keys: { p256dh: payload.keys.p256dh, auth: payload.keys.auth },
    userAgent: navigator.userAgent,
  });
  return { endpoint: payload.endpoint };
}

export async function unsubscribeFromPush() {
  const registration = await navigator.serviceWorker?.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  const endpoint = subscription?.endpoint;
  await subscription?.unsubscribe().catch(() => undefined);
  await callMethod('wyre.unsubscribePush', endpoint ? { endpoint } : {});
}
