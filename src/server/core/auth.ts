import { createHash, randomBytes, randomInt, timingSafeEqual, scrypt as scryptCallback } from 'node:crypto';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import type { NextFunction, Request, Response } from 'express';
import nodemailer from 'nodemailer';
import z from 'zod';

import { magicLinkEmail } from '../wyre/emails';
import { dbProfiles, dbSettings } from '../wyre/db';
import { dbOtps, dbQrLogins, dbSessions, dbUsers } from './authDb';
import { assertDeviceAllowed, associateDevice, resolveDeviceFromCookie, type DeviceContext } from './devices';
import { ObjectId } from './database';
import { env } from './env';
import { AppError, AuthError, ValidationError } from './errors';
import type { UserInfo } from './types';


export const SESSION_COOKIE = 'wyre_session';
const secureCookies = new URL(env.SITE_URL).protocol === 'https:';
const OTP_ATTEMPTS = 5;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;
const PASSWORD_ATTEMPTS = 5;
const PASSWORD_LOCK_MS = 15 * 60_000;
const emailSchema = z.string().trim().toLowerCase().email('Некорректный email').max(254);
const require = createRequire(import.meta.url);
const communityDisposableDomains = require('disposable-email-domains') as string[];
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const builtInDisposableDomains = new Set([
  ...communityDisposableDomains,
  ...env.DISPOSABLE_EMAIL_DOMAINS.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean),
]);

function isDisposableDomain(domain: string) {
  const labels = domain.toLowerCase().split('.');
  return labels.some((_label, index) => builtInDisposableDomains.has(labels.slice(index).join('.')));
}

function digest(value: string) {
  return createHash('sha256').update(`${env.SESSION_SECRET}:${value}`).digest('hex');
}

function constantEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCookies(header: string | undefined) {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

export type UserRequest = Request & {
  user?: UserInfo | null;
  sessionTokenHash?: string;
};

export async function resolveUserFromCookie(cookieHeader: string | undefined) {
  const rawToken = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!rawToken) return { user: null, tokenHash: undefined };
  const tokenHash = digest(rawToken);
  const session = await dbSessions.findOne({ tokenHash, expiresAt: { $gt: new Date() } });
  if (!session) return { user: null, tokenHash };
  const user = await dbUsers.findOne({ _id: session.userId });
  if (!user) return { user: null, tokenHash };
  // A banned device must lose access immediately, even mid-session.
  const device = await resolveDeviceFromCookie(cookieHeader);
  if (device?.banned) {
    await dbSessions.deleteMany({ tokenHash });
    return { user: null, tokenHash };
  }
  let webauthnAppVerified = Boolean(session.webauthnAppVerified);
  const inactiveFor = Date.now() - (session.lastActiveAt ?? session.createdAt).getTime();
  if (session.appLockEnabled && webauthnAppVerified && inactiveFor > env.WEBAUTHN_APP_LOCK_MINUTES * 60_000) {
    webauthnAppVerified = false;
    await dbSessions.updateOneSilent({ _id: session._id }, { $set: { webauthnAppVerified: false } });
  }
  return {
    user: {
      id: user._id.toString(),
      email: user.email,
      totpVerified: Boolean(session.totpVerified),
      pinVerified: Boolean(session.pinVerified),
      webauthnAccountVerified: Boolean(session.webauthnAccountVerified),
      webauthnAppVerified,
      deviceApproved: session.deviceApproved !== false,
      additionalPasswordVerified: Boolean(session.additionalPasswordVerified),
    } satisfies UserInfo,
    tokenHash,
  };
}

export async function authMiddleware(req: UserRequest, _res: Response, next: NextFunction) {
  try {
    const resolved = await resolveUserFromCookie(req.headers.cookie);
    req.user = resolved.user;
    req.sessionTokenHash = resolved.tokenHash;
    if (resolved.user && resolved.tokenHash) await dbSessions.updateOneSilent({ tokenHash: resolved.tokenHash }, { $set: { lastActiveAt: new Date() } });
    next();
  } catch (error) {
    next(error);
  }
}

export async function createSession(res: Response, userId: ObjectId, metadata: { userAgent?: string; ip?: string; device?: DeviceContext | null } = {}) {
  assertDeviceAllowed(metadata.device);
  const rawToken = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + env.SESSION_DAYS * 24 * 60 * 60 * 1000);
  const settings = await dbSettings.findOne({ userId: userId.toString() });
  const approvalRequired = Boolean(settings?.newDeviceApprovalEnabled);
  const approvedSessionCount = approvalRequired
    ? await dbSessions.countDocuments({ userId, deviceApproved: true, expiresAt: { $gt: now } })
    : 0;
  await dbSessions.insertOne({
    tokenHash: digest(rawToken),
    userId,
    deviceId: metadata.device?.id ?? null,
    createdAt: now,
    expiresAt,
    lastActiveAt: now,
    userAgent: metadata.userAgent?.slice(0, 500),
    ip: metadata.ip?.slice(0, 100),
    totpVerified: false,
    pinVerified: false,
    webauthnAccountVerified: false,
    webauthnAppVerified: false,
    appLockEnabled: Boolean(settings?.webauthnAppEnabled),
    deviceApproved: !approvalRequired || approvedSessionCount === 0,
    additionalPasswordVerified: false,
    additionalPasswordAttempts: 0,
  });
  if (metadata.device) await associateDevice(metadata.device.id, userId);
  res.cookie(SESSION_COOKIE, rawToken, {
    httpOnly: true,
    secure: secureCookies,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export async function createQrLogin(userId: ObjectId) {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 2 * 60 * 1000);
  await dbQrLogins.insertOne({ tokenHash: digest(token), userId, createdAt: now, expiresAt, consumedAt: null });
  return { token, url: `${env.SITE_URL.replace(/\/$/, '')}/auth/qr?token=${encodeURIComponent(token)}`, expiresAt };
}

export async function loginWithQrToken(rawToken: unknown, res: Response, metadata: { userAgent?: string; ip?: string; device?: DeviceContext | null } = {}) {
  const token = z.string().min(30).max(200).parse(rawToken);
  const login = await dbQrLogins.native().findOneAndUpdate(
    { tokenHash: digest(token), consumedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { consumedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!login) throw new ValidationError('QR-код недействителен или уже использован');
  dbQrLogins.changed();
  await createSession(res, login.userId, metadata);
  return { ok: true };
}

export async function destroySession(req: UserRequest, res: Response) {
  if (req.sessionTokenHash) await dbSessions.deleteMany({ tokenHash: req.sessionTokenHash });
  res.clearCookie(SESSION_COOKIE, { path: '/', sameSite: 'lax', secure: secureCookies });
}

async function findOrCreateUser(email: string, yandexId: string | null = null) {
  const now = new Date();
  await dbUsers.updateOne(
    { email },
    {
      $set: { lastLoginAt: now, ...(yandexId ? { yandexId } : {}) },
      $setOnInsert: { email, createdAt: now },
    },
    { upsert: true },
  );
  return dbUsers.requireOne({ email });
}

function passwordSchema() {
  return z.string().min(PASSWORD_MIN_LENGTH, `Пароль должен содержать минимум ${PASSWORD_MIN_LENGTH} символов`).max(PASSWORD_MAX_LENGTH);
}

async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = Buffer.from(await scrypt(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }) as Buffer);
  return `scrypt$v1$16384$8$1$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

async function verifyPassword(password: string, verifier: string) {
  const [, version, n, r, p, saltRaw, hashRaw] = verifier.split('$');
  if (version !== 'v1' || n !== '16384' || r !== '8' || p !== '1' || !saltRaw || !hashRaw) return false;
  const actual = Buffer.from(await scrypt(password, Buffer.from(saltRaw, 'base64url'), 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }) as Buffer);
  const expected = Buffer.from(hashRaw, 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function markExistingProfileChallenge(userId: ObjectId) {
  const profile = await dbProfiles.findOne({ userId });
  if (profile) {
    await dbProfiles.updateOne(
      { _id: profile._id },
      { $set: { pendingChallenge: true, challengeAttempts: 0, updatedAt: new Date() } },
    );
  }
}

let mailer: nodemailer.Transporter | null = null;

function getMailer() {
  mailer ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  return mailer;
}

export async function sendLoginCode(rawEmail: unknown, requestIp = 'unknown') {
  const email = emailSchema.parse(rawEmail);
  const domain = email.split('@')[1];
  if (isDisposableDomain(domain)) {
    throw new ValidationError('Регистрация с временной почты запрещена');
  }

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const [emailRequests, ipRequests] = await Promise.all([
    dbOtps.countDocuments({ email, createdAt: { $gt: hourAgo } }),
    dbOtps.countDocuments({ requestIp, createdAt: { $gt: hourAgo } }),
  ]);
  if (emailRequests >= 10 || ipRequests >= 30) {
    throw new ValidationError('Слишком много запросов кода. Попробуйте позже.', 'RATE_LIMIT');
  }

  const latest = await dbOtps.fetch({ email }, { sort: { createdAt: -1 }, limit: 1 });
  if (latest[0] && Date.now() - latest[0].createdAt.getTime() < env.OTP_RESEND_SECONDS * 1000) {
    throw new ValidationError(`Новый код можно запросить через ${env.OTP_RESEND_SECONDS} секунд`, 'RATE_LIMIT');
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const magicToken = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + env.OTP_TTL_MINUTES * 60 * 1000);
  await dbOtps.updateMany(
    { email, consumedAt: null },
    { $set: { consumedAt: now } },
  );
  const { insertedId } = await dbOtps.insertOne({
    email,
    requestIp,
    codeHash: digest(`${email}:${code}`),
    magicTokenHash: digest(magicToken),
    attempts: 0,
    createdAt: now,
    expiresAt,
    consumedAt: null,
  });

  const magicLinkUrl = `${env.SITE_URL.replace(/\/$/, '')}/auth/magic-link?token=${encodeURIComponent(magicToken)}`;
  const html = magicLinkEmail({ name: '', email, code, magicLinkUrl });
  try {
    if (env.EMAIL_TRANSPORT === 'console') {
      console.info(`[Wyre development OTP] ${email}: ${code}`);
      console.info(`[Wyre development magic link] ${magicLinkUrl}`);
    } else {
      await getMailer().sendMail({
        from: env.EMAIL_FROM,
        to: email,
        subject: 'Ваш код входа в Wyre',
        html,
        text: `Код входа в Wyre: ${code}\n\nСсылка для входа: ${magicLinkUrl}`,
      });
    }
  } catch (error) {
    const smtpCode = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
    if (env.NODE_ENV !== 'production' && env.SMTP_FALLBACK_TO_CONSOLE) {
      console.warn(
        smtpCode === 'EAUTH'
          ? 'Яндекс отклонил SMTP-вход. Временно показываем OTP в консоли разработки.'
          : 'SMTP недоступен. Временно показываем OTP в консоли разработки.',
      );
      console.info(`[Wyre development OTP] ${email}: ${code}`);
      console.info(`[Wyre development magic link] ${magicLinkUrl}`);
      return { ok: true };
    }
    await dbOtps.deleteOne({ _id: insertedId });
    if (smtpCode === 'EAUTH') {
      throw new AppError(
        'Яндекс отклонил SMTP-вход. Включите доступ почтовых клиентов и используйте пароль приложения для этого же ящика.',
        503,
        'SMTP_AUTH_FAILED',
      );
    }
    throw new AppError('Не удалось отправить код по email. Проверьте SMTP-настройки.', 503, 'SMTP_UNAVAILABLE');
  }
  return { ok: true };
}

async function consumeOtp(filter: Record<string, unknown>, verifier?: (otp: Awaited<ReturnType<typeof dbOtps.requireOne>>) => boolean) {
  const records = await dbOtps.fetch(
    { ...filter, consumedAt: null, expiresAt: { $gt: new Date() } },
    { sort: { createdAt: -1 }, limit: 1 },
  );
  const otp = records[0];
  if (!otp) throw new ValidationError('Неверный или просроченный код', 'INVALID_OTP');
  if (otp.attempts >= OTP_ATTEMPTS) throw new ValidationError('Слишком много попыток. Запросите новый код.', 'OTP_LOCKED');
  if (verifier && !verifier(otp)) {
    await dbOtps.updateOne({ _id: otp._id }, { $inc: { attempts: 1 } });
    throw new ValidationError('Неверный или просроченный код', 'INVALID_OTP');
  }
  const consumed = await dbOtps.updateOne(
    { _id: otp._id, consumedAt: null },
    { $set: { consumedAt: new Date() } },
  );
  if (!consumed.modifiedCount) throw new ValidationError('Код уже использован', 'INVALID_OTP');
  return otp;
}

export async function loginWithCode(rawEmail: unknown, rawCode: unknown, res: Response, metadata: { userAgent?: string; ip?: string; device?: DeviceContext | null } = {}) {
  const email = emailSchema.parse(rawEmail);
  const code = z.string().trim().regex(/^\d{6}$/, 'Введите шестизначный код').parse(rawCode);
  await consumeOtp({ email }, (otp) => constantEqual(otp.codeHash, digest(`${email}:${code}`)));
  const user = await findOrCreateUser(email);
  await markExistingProfileChallenge(user._id);
  await createSession(res, user._id, metadata);
  return { ok: true };
}

export async function loginWithMagicToken(rawToken: unknown, res: Response, metadata: { userAgent?: string; ip?: string; device?: DeviceContext | null } = {}) {
  const token = z.string().min(20).parse(rawToken);
  const otp = await consumeOtp({ magicTokenHash: digest(token) });
  const user = await findOrCreateUser(otp.email);
  await markExistingProfileChallenge(user._id);
  await createSession(res, user._id, metadata);
  return { ok: true };
}

export async function loginYandexUser(emailValue: string, yandexId: string, res: Response, metadata: { userAgent?: string; ip?: string; device?: DeviceContext | null } = {}) {
  const email = emailSchema.parse(emailValue);
  const user = await findOrCreateUser(email, yandexId);
  await markExistingProfileChallenge(user._id);
  await createSession(res, user._id, metadata);
  return user;
}

export async function loginWithPassword(rawEmail: unknown, rawPassword: unknown, res: Response, metadata: { userAgent?: string; ip?: string; device?: DeviceContext | null } = {}) {
  const email = emailSchema.parse(rawEmail);
  const password = passwordSchema().parse(rawPassword);
  const user = await dbUsers.findOne({ email });
  if (!user?.loginPasswordVerifier) throw new ValidationError('Парольный вход для этого аккаунта не включён', 'PASSWORD_NOT_ENABLED');
  if (user.loginPasswordLockedUntil && user.loginPasswordLockedUntil.getTime() > Date.now()) throw new ValidationError('Слишком много попыток. Попробуйте позже.', 'PASSWORD_RATE_LIMIT');
  if (!await verifyPassword(password, user.loginPasswordVerifier)) {
    const attempts = (user.loginPasswordFailedAttempts ?? 0) + 1;
    await dbUsers.updateOne({ _id: user._id }, { $set: { loginPasswordFailedAttempts: attempts, loginPasswordLockedUntil: attempts >= PASSWORD_ATTEMPTS ? new Date(Date.now() + PASSWORD_LOCK_MS) : null } });
    throw new ValidationError('Неверный email или пароль', attempts >= PASSWORD_ATTEMPTS ? 'PASSWORD_LOCKED' : 'INVALID_PASSWORD');
  }
  await dbUsers.updateOne({ _id: user._id }, { $set: { loginPasswordFailedAttempts: 0, loginPasswordLockedUntil: null, lastLoginAt: new Date() } });
  await markExistingProfileChallenge(user._id);
  await createSession(res, user._id, metadata);
  return { ok: true };
}

export { hashPassword, passwordSchema, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, verifyPassword };

export function requireAuthUser(user: UserInfo | null) {
  if (!user) throw new AuthError();
  return user;
}
