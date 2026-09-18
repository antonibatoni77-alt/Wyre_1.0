// Firebase Cloud Messaging sender for the Android shell (background push).
//
// Implemented directly against the FCM HTTP v1 API with a service-account
// JWT: no Firebase Admin SDK dependency. All three FIREBASE_* variables must
// be filled in .env (values come from the service-account JSON); when they are
// empty, FCM is simply off and Web Push keeps its role.
import { createSign } from 'node:crypto';

import { env } from '../core/env';

import { dbFcmTokens } from './db';

export function fcmConfigured() {
  return Boolean(env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY);
}

function base64url(input: Buffer | string) {
  return Buffer.from(input).toString('base64url');
}

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

async function fcmAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < cachedAccessToken.expiresAt - 60_000) return cachedAccessToken.token;
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = base64url(signer.sign(env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')));
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${payload}.${signature}` }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`FCM auth failed: ${response.status}`);
  const data = await response.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('FCM auth returned no token');
  cachedAccessToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cachedAccessToken.token;
}

/**
 * Sends a data-only message to every registered Android install of the user.
 * Data-only (no `notification` block) so the app always builds the toast
 * itself with the correct channel and action buttons.
 */
export async function sendFcmToUser(userId: string, data: Record<string, string>, priority: 'normal' | 'high' = 'high') {
  if (!fcmConfigured()) return;
  const registrations = await dbFcmTokens.fetch({ userId }, { limit: 12 });
  if (!registrations.length) return;
  let accessToken: string;
  try {
    accessToken = await fcmAccessToken();
  } catch (error) {
    console.error('Ошибка авторизации FCM:', error);
    return;
  }
  await Promise.all(registrations.map(async (registration) => {
    try {
      const response = await fetch(`https://fcm.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: registration.token,
            data,
            android: { priority, ttl: priority === 'high' ? '60s' : '86400s' },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      // 404/410: the install was uninstalled — drop the dead token.
      if (response.status === 404 || response.status === 410) await dbFcmTokens.deleteOne({ _id: registration._id });
    } catch {
      // Transient network errors are fine; the next event will retry.
    }
  }));
}
