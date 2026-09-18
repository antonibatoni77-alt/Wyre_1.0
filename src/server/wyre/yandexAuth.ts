import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Express, Request, Response } from 'express';

import { loginYandexUser, resolveUserFromCookie } from '../core/auth';
import { dbUsers } from '../core/authDb';
import { ObjectId } from '../core/database';
import type { DeviceRequest } from '../core/devices';
import { env } from '../core/env';
import { dbYandexLinkRequests } from './db';

const STATE_COOKIE = 'wyre_yandex_state';
const STATE_TTL_MS = 10 * 60 * 1000;

function callbackUrl() {
  return `${env.SITE_URL.replace(/\/$/, '')}/auth/yandex/callback`;
}

function stateHash(state: string) {
  return createHash('sha256').update(`${env.SESSION_SECRET}:yandex-link:${state}`).digest('hex');
}

function readCookie(req: Request, key: string) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === key) return decodeURIComponent(value.join('='));
  }
  return null;
}

function sameState(left: string | null, right: string | null) {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function exchangeCodeForToken(code: string) {
  const response = await fetch('https://oauth.yandex.ru/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: env.YANDEX_CLIENT_ID,
      client_secret: env.YANDEX_CLIENT_SECRET,
    }),
  });
  if (!response.ok) throw new Error(`Yandex token exchange failed: ${response.status}`);
  return response.json() as Promise<{ access_token: string }>;
}

async function fetchYandexUser(accessToken: string) {
  const response = await fetch('https://login.yandex.ru/info?format=json', {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Yandex profile request failed: ${response.status}`);
  const data = (await response.json()) as {
    id: string;
    login?: string;
    default_email?: string;
    emails?: string[];
  };
  const email = data.default_email ?? data.emails?.[0] ?? (data.login ? `${data.login}@yandex.ru` : null);
  if (!email) throw new Error('Yandex ID не передал email аккаунта');
  return { id: String(data.id), email: email.toLowerCase() };
}

export function registerYandexAuthRoutes(app: Express) {
  app.get('/auth/yandex', (_req, res) => {
    if (!env.YANDEX_CLIENT_ID || !env.YANDEX_CLIENT_SECRET) {
      res.status(503).send('Вход через Yandex ID пока не настроен в .env сервера.');
      return;
    }
    const state = randomBytes(24).toString('base64url');
    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/auth/yandex/callback',
      maxAge: STATE_TTL_MS,
    });
    const url = new URL('https://oauth.yandex.ru/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', env.YANDEX_CLIENT_ID);
    url.searchParams.set('redirect_uri', callbackUrl());
    url.searchParams.set('state', state);
    url.searchParams.set('force_confirm', 'yes');
    res.redirect(url.toString());
  });

  /**
   * Linking is a separate, authenticated operation: the pending request is
   * bound to the current user and session server-side, so a callback can never
   * attach a Yandex identity to a different account.
   */
  app.get('/auth/yandex/link', async (req: Request, res: Response) => {
    if (!env.YANDEX_CLIENT_ID || !env.YANDEX_CLIENT_SECRET) {
      res.status(503).send('Вход через Yandex ID пока не настроен в .env сервера.');
      return;
    }
    const { user, tokenHash } = await resolveUserFromCookie(req.headers.cookie);
    if (!user || !tokenHash) return res.redirect(`/?authError=${encodeURIComponent('Войдите в аккаунт, чтобы привязать Yandex ID')}`);
    const state = randomBytes(24).toString('base64url');
    const now = new Date();
    await dbYandexLinkRequests.deleteMany({ userId: new ObjectId(user.id) });
    await dbYandexLinkRequests.insertOne({
      userId: new ObjectId(user.id),
      sessionTokenHash: tokenHash,
      stateHash: stateHash(state),
      createdAt: now,
      expiresAt: new Date(now.getTime() + STATE_TTL_MS),
      consumedAt: null,
    });
    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/auth/yandex/callback',
      maxAge: STATE_TTL_MS,
    });
    const url = new URL('https://oauth.yandex.ru/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', env.YANDEX_CLIENT_ID);
    url.searchParams.set('redirect_uri', callbackUrl());
    url.searchParams.set('state', state);
    url.searchParams.set('force_confirm', 'yes');
    return res.redirect(url.toString());
  });

  app.get('/auth/yandex/callback', async (req: Request, res: Response) => {
    const fail = (message: string) => res.redirect(`/?authError=${encodeURIComponent(message)}`);
    const code = typeof req.query.code === 'string' ? req.query.code : null;
    const state = typeof req.query.state === 'string' ? req.query.state : null;
    const cookieState = readCookie(req, STATE_COOKIE);
    res.clearCookie(STATE_COOKIE, { path: '/auth/yandex/callback' });

    if (!code) return fail('Yandex ID не вернул код авторизации');
    if (!sameState(state, cookieState)) return fail('Не удалось подтвердить запрос авторизации Yandex ID');
    try {
      const pendingLink = state
        ? await dbYandexLinkRequests.native().findOneAndDelete({ stateHash: stateHash(state), consumedAt: null, expiresAt: { $gt: new Date() } })
        : null;
      if (pendingLink) dbYandexLinkRequests.changed();
      const token = await exchangeCodeForToken(code);
      const user = await fetchYandexUser(token.access_token);

      if (pendingLink) {
        const current = await resolveUserFromCookie(req.headers.cookie);
        if (!current.user || current.tokenHash !== pendingLink.sessionTokenHash || current.user.id !== pendingLink.userId.toString()) {
          return fail('Сессия изменилась, привязка Yandex ID отменена');
        }
        const owner = await dbUsers.findOne({ yandexId: user.id });
        if (owner && !owner._id.equals(pendingLink.userId)) return fail('Этот Yandex ID уже привязан к другому аккаунту Wyre');
        const account = await dbUsers.findOne({ _id: pendingLink.userId });
        if (!account) return fail('Аккаунт не найден');
        if (account.email !== user.email) return fail('Email Yandex ID не совпадает с email аккаунта Wyre');
        await dbUsers.updateOne({ _id: pendingLink.userId }, { $set: { yandexId: user.id } });
        return res.redirect('/?yandexLinked=1');
      }

      await loginYandexUser(user.email, user.id, res, { userAgent: req.get('user-agent'), ip: req.ip, device: (req as DeviceRequest).device });
      return res.redirect('/');
    } catch (error) {
      console.error('Yandex OAuth error', error);
      return fail('Вход через Yandex ID не удался, попробуйте ещё раз');
    }
  });
}
