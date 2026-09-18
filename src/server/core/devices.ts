import { createHash, randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { dbDeviceAccounts, dbDevices, dbSessions } from './authDb';
import { ObjectId } from './database';
import { env } from './env';
import { AppError } from './errors';

export const DEVICE_COOKIE = 'wyre_device';
const DEVICE_TTL_DAYS = 400;
const secureCookies = new URL(env.SITE_URL).protocol === 'https:';

export type DeviceContext = {
  id: ObjectId;
  banned: boolean;
  banReason: string | null;
};

export type DeviceRequest = Request & { device?: DeviceContext | null };

function keyed(value: string, scope: string) {
  return createHash('sha256').update(`${env.SESSION_SECRET}:${scope}:${value}`).digest('hex');
}

function parseCookies(header: string | undefined) {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key) cookies[key] = decodeURIComponent(part.slice(separator + 1).trim());
  }
  return cookies;
}

function userAgentFamily(userAgent: string) {
  if (/Edg\//.test(userAgent)) return 'Edge';
  if (/OPR\//.test(userAgent)) return 'Opera';
  if (/Chrome\//.test(userAgent)) return 'Chrome';
  if (/Firefox\//.test(userAgent)) return 'Firefox';
  if (/Safari\//.test(userAgent)) return 'Safari';
  return 'Другой браузер';
}

function platformOf(userAgent: string) {
  if (/Windows/i.test(userAgent)) return 'Windows';
  if (/Android/i.test(userAgent)) return 'Android';
  if (/iPhone|iPad/i.test(userAgent)) return 'iOS';
  if (/Mac OS/i.test(userAgent)) return 'macOS';
  if (/Linux/i.test(userAgent)) return 'Linux';
  return 'Устройство';
}

/**
 * Coarse, low-entropy signal used only to correlate likely-related clients.
 * It intentionally avoids canvas/audio/font fingerprinting and stores a keyed
 * digest, so it can supplement moderation decisions without becoming a stable
 * cross-site tracking identifier.
 */
function fingerprintOf(userAgent: string, ip: string | undefined) {
  const network = (ip ?? '').split(':')[0].split('.').slice(0, 2).join('.');
  const parts = [platformOf(userAgent), userAgentFamily(userAgent), network];
  return parts.every((part) => !part) ? null : keyed(parts.join('|'), 'device-fingerprint');
}

export async function resolveDeviceFromCookie(cookieHeader: string | undefined) {
  const raw = parseCookies(cookieHeader)[DEVICE_COOKIE];
  if (!raw) return null;
  const device = await dbDevices.findOne({ deviceKeyHash: keyed(raw, 'device') });
  if (!device) return null;
  const banned = Boolean(device.bannedUntil && new Date(device.bannedUntil).getTime() > Date.now());
  return { id: device._id, banned, banReason: device.banReason ?? null } satisfies DeviceContext;
}

/**
 * Issues an opaque server-side device identifier before authentication.
 * The cookie only identifies a browser profile: clearing site data, private
 * browsing, another browser or a reinstall creates a new device record. It is
 * therefore an abuse-correlation signal, not hardware identity.
 */
export async function deviceMiddleware(req: DeviceRequest, res: Response, next: NextFunction) {
  try {
    const userAgent = (req.get('user-agent') ?? '').slice(0, 500);
    const cookies = parseCookies(req.headers.cookie);
    let raw = cookies[DEVICE_COOKIE];
    const now = new Date();
    let device = raw ? await dbDevices.findOne({ deviceKeyHash: keyed(raw, 'device') }) : null;

    if (!device) {
      raw = randomBytes(32).toString('base64url');
      const { insertedId } = await dbDevices.insertOne({
        deviceKeyHash: keyed(raw, 'device'),
        fingerprintHash: fingerprintOf(userAgent, req.ip),
        platform: platformOf(userAgent),
        userAgentFamily: userAgentFamily(userAgent),
        createdAt: now,
        lastSeenAt: now,
        bannedUntil: null,
        banReason: null,
        bannedBy: null,
      });
      device = await dbDevices.requireOne({ _id: insertedId });
      res.cookie(DEVICE_COOKIE, raw, {
        httpOnly: true,
        secure: secureCookies,
        sameSite: 'lax',
        path: '/',
        expires: new Date(now.getTime() + DEVICE_TTL_DAYS * 24 * 60 * 60 * 1000),
      });
    } else {
      await dbDevices.updateOneSilent({ _id: device._id }, { $set: { lastSeenAt: now } });
    }

    const banned = Boolean(device.bannedUntil && new Date(device.bannedUntil).getTime() > Date.now());
    req.device = { id: device._id, banned, banReason: device.banReason ?? null };
    if (banned) {
      // A banned device cannot keep or create sessions.
      await dbSessions.deleteMany({ deviceId: device._id });
    }
    next();
  } catch (error) {
    next(error);
  }
}

export async function associateDevice(deviceId: ObjectId, userId: ObjectId) {
  const now = new Date();
  await dbDeviceAccounts.updateOne(
    { deviceId, userId },
    { $set: { lastSeenAt: now }, $setOnInsert: { deviceId, userId, firstSeenAt: now } },
    { upsert: true },
  );
}

export function assertDeviceAllowed(device: DeviceContext | null | undefined) {
  if (device?.banned) {
    throw new AppError(
      `Это устройство заблокировано. Причина: ${device.banReason ?? 'не указана'}`,
      403,
      'DEVICE_BANNED',
    );
  }
}
