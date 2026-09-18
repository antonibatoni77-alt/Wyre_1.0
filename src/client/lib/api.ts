import type { QueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';

let queryClientRef: QueryClient | null = null;
let socket: Socket | null = null;
let invalidateTimer: number | null = null;

export class ApiError extends Error {
  constructor(message: string, public readonly code = 'API_ERROR') {
    super(message);
    this.name = 'ApiError';
  }
}

export function connectWyreClient(queryClient: QueryClient) {
  queryClientRef = queryClient;
  socket ??= io({ path: '/socket.io', transports: ['websocket', 'polling'] });
  socket.off('wyre:changed');
  socket.on('wyre:changed', (event?: { collection?: string }) => {
    if (event?.collection === 'wyreCallSignals') {
      void queryClientRef?.invalidateQueries({ queryKey: ['wyre', 'wyre.callSignals'], refetchType: 'active' });
      return;
    }
    if (invalidateTimer !== null) return;
    invalidateTimer = window.setTimeout(() => {
      invalidateTimer = null;
      // Only visible queries are refetched; background ones stay stale until used.
      void queryClientRef?.invalidateQueries({ refetchType: 'active' });
    }, 40);
  });
  socket.off('connect');
  socket.on('connect', () => { void queryClientRef?.invalidateQueries({ refetchType: 'active' }); });
}

/**
 * Targeted push channel for remote-control input events. The server emits them
 * only to the target user's sockets, so high-frequency pointer traffic never
 * touches the global invalidation path.
 */
export function onCallControlEvent(handler: (event: unknown) => void) {
  if (!socket) return () => undefined;
  const listener = (event: unknown) => handler(event);
  socket.on('wyre:call-control', listener);
  return () => {
    socket?.off('wyre:call-control', listener);
  };
}

/**
 * Targeted typing/recording presence pushes (see setTyping on the server).
 * Delivered only to the other chat members, never broadcast.
 */
export function onWyrePresence(handler: (payload: { type: string; chatId: string; userId: string; typing?: boolean; activity?: string | null }) => void) {
  if (!socket) return () => undefined;
  const listener = (payload: unknown) => handler(payload as Parameters<typeof handler>[0]);
  socket.on('wyre:presence', listener);
  return () => {
    socket?.off('wyre:presence', listener);
  };
}

export function getQueryClient() {
  return queryClientRef;
}

async function apiRequest<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as
    | { data?: T; error?: { message?: string; code?: string } }
    | null;
  if (!response.ok || payload?.error) {
    throw new ApiError(payload?.error?.message ?? `Ошибка сервера (${response.status})`, payload?.error?.code);
  }
  return (payload && 'data' in payload ? payload.data : payload) as T;
}

export function createQueryKey(method: string, args: unknown) {
  return ['wyre', method, args] as const;
}

export function wyreQuery<T>(method: string, args: unknown) {
  return {
    queryKey: createQueryKey(method, args),
    queryFn: () => apiRequest<T>('/api/rpc/query', { method, args }),
  };
}

export const wyreLiveQuery = wyreQuery;

export function wyreMutation<TData = unknown, TArgs = Record<string, unknown>>(method: string) {
  return {
    mutationFn: async (args: TArgs) => {
      const result = await apiRequest<TData>('/api/rpc/mutation', { method, args });
      return result;
    },
  };
}

/**
 * Mutation without the global invalidation: for high-frequency background
 * calls (draft saving, typing pings, read receipts, call pings) that must not
 * trigger a full refetch storm on every keystroke. Anything the UI needs back
 * arrives through the server's own `wyre:changed` broadcast instead.
 */
export function wyreQuietMutation<TData = unknown, TArgs = Record<string, unknown>>(method: string) {
  return {
    mutationFn: async (args: TArgs) => apiRequest<TData>('/api/rpc/mutation', { method, args }),
  };
}

export function callMethod<T = unknown>(method: string, args: unknown): Promise<T> {
  return apiRequest<T>('/api/rpc/call', { method, args });
}

export function sendMagicLink({ email }: { email: string }) {
  return apiRequest<{ ok: true }>('/api/auth/send-code', { email });
}

export async function loginWithOneTimeCode({ email, code }: { email: string; code: string }) {
  const result = await apiRequest<{ ok: true }>('/api/auth/verify-code', { email, code });
  socket?.disconnect().connect();
  void queryClientRef?.invalidateQueries();
  return result;
}

export async function loginWithAccountPassword({ email, password }: { email: string; password: string }) {
  const result = await apiRequest<{ ok: true }>('/api/auth/password', { email, password });
  socket?.disconnect().connect();
  void queryClientRef?.invalidateQueries();
  return result;
}

export async function loginWithMagicLink() {
  const token = new URLSearchParams(window.location.search).get('token');
  if (!token) throw new ApiError('Ссылка недействительна или истекла', 'INVALID_MAGIC_LINK');
  return apiRequest<{ ok: true }>('/api/auth/magic-link', { token });
}

export async function logout() {
  await apiRequest<{ ok: true }>('/api/auth/logout', {});
  socket?.disconnect().connect();
  queryClientRef?.clear();
}
