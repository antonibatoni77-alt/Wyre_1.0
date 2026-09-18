import 'dotenv/config';
import path from 'node:path';
import z from 'zod';

const booleanValue = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  SITE_URL: z.string().url().default('https://localhost:3000'),
  HTTPS_KEY_FILE: z.string().default(''),
  HTTPS_CERT_FILE: z.string().default(''),
  HTTPS_DEV_CERT_DIR: z.string().default('./data/tls'),
  MONGODB_URI: z.string().default(''),
  MONGODB_DB_NAME: z.string().min(1).default('wyre'),
  MONGODB_EMBEDDED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  MONGODB_DATA_DIR: z.string().default('./data/mongodb'),
  MONGODB_BINARY_DIR: z.string().default('./data/mongodb-binaries'),
  SESSION_SECRET: z.string().min(32).default('wyre-development-secret-change-me-1234567890'),
  SESSION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  WEBAUTHN_RP_ID: z.string().trim().default(''),
  WEBAUTHN_ORIGIN: z.string().trim().default(''),
  WEBAUTHN_APP_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  OWNER_EMAIL: z.string().trim().toLowerCase().default(''),
  TRUST_PROXY: booleanValue,
  EMAIL_TRANSPORT: z.enum(['smtp', 'console']).default('console'),
  SMTP_FALLBACK_TO_CONSOLE: booleanValue,
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: booleanValue,
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  EMAIL_FROM: z.string().default('Wyre <noreply@example.com>'),
  OTP_TTL_MINUTES: z.coerce.number().int().min(2).max(30).default(10),
  OTP_RESEND_SECONDS: z.coerce.number().int().min(15).max(600).default(60),
  DISPOSABLE_EMAIL_DOMAINS: z.string().default(''),
  YANDEX_CLIENT_ID: z.string().default(''),
  YANDEX_CLIENT_SECRET: z.string().default(''),
  TURN_SERVER_URL: z.string().default(''),
  TURN_SERVER_USERNAME: z.string().default(''),
  TURN_SERVER_CREDENTIAL: z.string().default(''),
  GROQ_API_KEY: z.string().default(''),
  AI_ASSISTANT_ENABLED: z.coerce.boolean().default(true),
  AI_TRANSCRIPTION_URL: z.string().url().default('https://api.groq.com/openai/v1/audio/transcriptions'),
  AI_TRANSCRIPTION_MODEL: z.string().min(1).default('whisper-large-v3-turbo'),
  AI_CHAT_URL: z.string().url().default('https://api.groq.com/openai/v1/chat/completions'),
  AI_CHAT_MODEL: z.string().min(1).default('openai/gpt-oss-120b'),
  AI_IMAGE_ENABLED: booleanValue.default(true),
  AI_IMAGE_URL: z.string().url().default('https://image.pollinations.ai/prompt'),
  UPLOAD_DIR: z.string().default('./uploads'),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(51_200).default(51_200),
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  VAPID_SUBJECT: z.string().default(''),
  FIREBASE_PROJECT_ID: z.string().default(''),
  FIREBASE_CLIENT_EMAIL: z.string().default(''),
  FIREBASE_PRIVATE_KEY: z.string().default(''),
  PDF_FONT_FILE: z.string().default(''),
});

export const env = schema.parse(process.env);

if (Boolean(env.HTTPS_KEY_FILE) !== Boolean(env.HTTPS_CERT_FILE)) {
  throw new Error('HTTPS_KEY_FILE и HTTPS_CERT_FILE должны быть заданы вместе');
}

if (env.NODE_ENV !== 'test' && new URL(env.SITE_URL).protocol !== 'https:') {
  throw new Error('SITE_URL должен использовать https://');
}

if (env.WEBAUTHN_RP_ID && /[:/]/.test(env.WEBAUTHN_RP_ID)) {
  throw new Error('WEBAUTHN_RP_ID должен быть доменом без протокола и порта');
}

if (env.WEBAUTHN_ORIGIN) {
  const webauthnOrigin = new URL(env.WEBAUTHN_ORIGIN);
  if (webauthnOrigin.origin !== env.WEBAUTHN_ORIGIN.replace(/\/$/, '') || webauthnOrigin.protocol !== 'https:') {
    throw new Error('WEBAUTHN_ORIGIN должен быть HTTPS origin без пути');
  }
}

if (env.NODE_ENV === 'production' && !env.HTTPS_KEY_FILE && !env.TRUST_PROXY) {
  throw new Error('Production без HTTPS_KEY_FILE/HTTPS_CERT_FILE требует TRUST_PROXY=true для TLS-прокси');
}

if (env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('В production обязательно задайте случайный SESSION_SECRET в .env');
}

if (env.NODE_ENV === 'production' && !process.env.SITE_URL) {
  throw new Error('В production обязательно задайте публичный SITE_URL в .env');
}

if (env.NODE_ENV === 'production' && !env.MONGODB_URI) {
  throw new Error('В production обязательно задайте MONGODB_URI в .env');
}

if (env.NODE_ENV === 'production' && env.EMAIL_TRANSPORT === 'console') {
  throw new Error('В production задайте EMAIL_TRANSPORT=smtp и SMTP_* в .env');
}

if (env.EMAIL_TRANSPORT === 'smtp' && (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS)) {
  throw new Error('Для EMAIL_TRANSPORT=smtp обязательны SMTP_HOST, SMTP_USER и SMTP_PASS');
}

if (Boolean(env.VAPID_PUBLIC_KEY) !== Boolean(env.VAPID_PRIVATE_KEY)) {
  throw new Error('VAPID_PUBLIC_KEY и VAPID_PRIVATE_KEY должны быть заданы вместе');
}

if (env.VAPID_PUBLIC_KEY && !env.VAPID_SUBJECT) {
  throw new Error('Для web push задайте VAPID_SUBJECT (mailto: или https://)');
}

export const uploadRoot = path.resolve(process.cwd(), env.UPLOAD_DIR);
