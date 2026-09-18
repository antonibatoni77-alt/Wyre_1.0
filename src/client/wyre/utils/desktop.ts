import type { QueryClient } from '@tanstack/react-query';

export interface WyreDesktopBridge {
  platform: string;
  appVersion: string;
  getConfig: () => Promise<{ serverUrl: string; autostart: boolean; closeToTray: boolean; allowSelfSigned: boolean }>;
  setConfig: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>;
  openSettings: () => void;
  openLogs: () => void;
  quit: () => void;
  log: (level: string, line: string) => void;
  osControl: {
    available: () => Promise<boolean>;
    inject: (event: { type: string; x?: number | null; y?: number | null; button?: number | null; key?: string | null }) => Promise<boolean>;
  };
}

export function getWyreDesktop(): WyreDesktopBridge | null {
  return (window as unknown as { wyreDesktop?: WyreDesktopBridge }).wyreDesktop ?? null;
}

/** True when the app runs inside the Wyre Windows desktop shell. */
export const isWyreDesktop = Boolean(getWyreDesktop());

export function isNetworkFailure(error: unknown) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (error instanceof TypeError) return true;
  return error instanceof Error && /failed to fetch|networkerror|load failed/i.test(error.message);
}

// --- Offline "last known state" persistence ---------------------------------
//
// The web app keeps no query persistence by design; inside the desktop shell
// (and as a bonus in any browser) a bounded snapshot of the session, chat list
// and recently opened conversations is mirrored into localStorage. On an
// offline start the interface renders the last state instead of an error.

const CACHE_KEY = 'wyre:query-cache:v1';
const MAX_CACHE_BYTES = 4_000_000;
const MAX_MESSAGE_CHATS = 12;
const PERSISTED_METHODS = new Set(['wyre.session', 'wyre.listChats', 'wyre.settings']);
const MESSAGE_METHOD = 'wyre.listMessages';

type CacheEntry = { key: unknown[]; data: unknown; at: number };

export function initOfflinePersistence(queryClient: QueryClient) {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (raw) {
      for (const entry of JSON.parse(raw) as CacheEntry[]) {
        if (Array.isArray(entry.key) && entry.data !== undefined) {
          queryClient.setQueryData(entry.key, entry.data, { updatedAt: entry.at });
        }
      }
    }
  } catch {
    // A corrupted cache is simply ignored.
  }

  let saveTimer: number | null = null;
  const save = () => {
    saveTimer = null;
    try {
      const primary: CacheEntry[] = [];
      const messageEntries: CacheEntry[] = [];
      for (const query of queryClient.getQueryCache().getAll()) {
        const method = query.queryKey[1];
        if (typeof method !== 'string' || query.state.status !== 'success' || query.state.data === undefined) continue;
        const entry: CacheEntry = { key: query.queryKey as unknown[], data: query.state.data, at: query.state.dataUpdatedAt };
        if (PERSISTED_METHODS.has(method)) primary.push(entry);
        else if (method === MESSAGE_METHOD) messageEntries.push(entry);
      }
      // Keep only the most recently viewed conversations.
      messageEntries.sort((left, right) => right.at - left.at);
      const entries = [...primary, ...messageEntries.slice(0, MAX_MESSAGE_CHATS)];
      let bytes = 0;
      const bounded: CacheEntry[] = [];
      for (const entry of entries) {
        const size = JSON.stringify(entry).length;
        if (bytes + size > MAX_CACHE_BYTES) continue;
        bytes += size;
        bounded.push(entry);
      }
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(bounded));
    } catch {
      // Quota exceeded — the previous snapshot stays.
    }
  };
  const schedule = () => {
    if (saveTimer === null) saveTimer = window.setTimeout(save, 1500);
  };
  queryClient.getQueryCache().subscribe(schedule);
}

// --- Windows notifications inside the desktop shell -------------------------
//
// Electron has no Web Push, so system toasts come from the renderer: whenever
// the hidden window sees unread counters grow, a native Notification is shown.
// In regular browsers nothing changes — Web Push keeps its role.

interface NotifiableChatRow {
  id: string;
  name: string;
  last: string;
  unread: number;
  muted?: boolean;
}

interface NotifiableCallState {
  callId: string;
  status: string;
  myState: string;
  kind: 'audio' | 'video';
  title: string;
}

export function initDesktopNotifications(queryClient: QueryClient) {
  if (!isWyreDesktop || typeof Notification === 'undefined') return;
  const previous = new Map<string, number>();
  let callNotification: Notification | null = null;

  queryClient.getQueryCache().subscribe(() => {
    // Incoming-call toast: click focuses the window where the accept/decline
    // screen is already waiting; the toast closes when ringing stops.
    const callQuery = queryClient.getQueryCache().find({ queryKey: ['wyre', 'wyre.callState', {}] });
    const call = callQuery?.state.data as NotifiableCallState | null | undefined;
    const ringing = Boolean(call && call.status === 'ringing' && call.myState === 'invited');
    if (ringing && call && !callNotification && document.visibilityState !== 'visible') {
      try {
        callNotification = new Notification(`Входящий ${call.kind === 'video' ? 'видеозвонок' : 'звонок'}`, {
          body: `${call.title} · откройте Wyre, чтобы ответить`,
          tag: 'wyre-incoming-call',
          silent: false,
        });
        callNotification.onclick = () => window.focus();
      } catch {
        // Notifications can be blocked by the OS — never break the app.
      }
    }
    if (!ringing && callNotification) {
      callNotification.close();
      callNotification = null;
    }

    const query = queryClient.getQueryCache().find({ queryKey: ['wyre', 'wyre.listChats', {}] });
    const chats = query?.state.data;
    if (!Array.isArray(chats)) return;
    for (const chat of chats as NotifiableChatRow[]) {
      const before = previous.get(chat.id);
      if (before !== undefined && chat.unread > before && !chat.muted && document.visibilityState !== 'visible') {
        try {
          const notification = new Notification(chat.name, {
            body: chat.last,
            tag: chat.id,
            silent: false,
          });
          notification.onclick = () => {
            window.focus();
            window.location.assign(`/?chat=${encodeURIComponent(chat.id)}`);
          };
        } catch {
          // Notifications can be blocked by the OS — never break the app.
        }
      }
      previous.set(chat.id, chat.unread);
    }
  });
}
