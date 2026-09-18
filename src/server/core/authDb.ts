import { ObjectId, Store } from './database';

export interface AuthUserDocument {
  email: string;
  createdAt: Date;
  lastLoginAt: Date;
  yandexId?: string;
  loginPasswordVerifier?: string | null;
  loginPasswordFailedAttempts?: number;
  loginPasswordLockedUntil?: Date | null;
}

export interface DeviceDocument {
  deviceKeyHash: string;
  fingerprintHash: string | null;
  platform: string;
  userAgentFamily: string;
  createdAt: Date;
  lastSeenAt: Date;
  bannedUntil: Date | null;
  banReason: string | null;
  bannedBy: string | null;
}

export interface DeviceAccountDocument {
  deviceId: ObjectId;
  userId: ObjectId;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface SessionDocument {
  tokenHash: string;
  userId: ObjectId;
  deviceId?: ObjectId | null;
  createdAt: Date;
  expiresAt: Date;
  userAgent?: string;
  ip?: string;
  lastActiveAt?: Date;
  totpVerified?: boolean;
  totpAttempts?: number;
  pinVerified?: boolean;
  pinAttempts?: number;
  webauthnAccountVerified?: boolean;
  webauthnAppVerified?: boolean;
  appLockEnabled?: boolean;
  deviceApproved?: boolean;
  additionalPasswordVerified?: boolean;
  additionalPasswordAttempts?: number;
}

export interface OtpDocument {
  email: string;
  requestIp: string;
  codeHash: string;
  magicTokenHash: string;
  attempts: number;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface QrLoginDocument {
  tokenHash: string;
  userId: ObjectId;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

export const dbUsers = new Store<AuthUserDocument>('wyreUsers', [
  { key: { email: 1 }, unique: true },
  { key: { yandexId: 1 }, unique: true, partialFilterExpression: { yandexId: { $type: 'string' } } },
]);

export const dbDevices = new Store<DeviceDocument>('wyreDevices', [
  { key: { deviceKeyHash: 1 }, unique: true },
  { key: { fingerprintHash: 1 } },
  { key: { lastSeenAt: -1 } },
]);

export const dbDeviceAccounts = new Store<DeviceAccountDocument>('wyreDeviceAccounts', [
  { key: { deviceId: 1, userId: 1 }, unique: true },
  { key: { userId: 1, lastSeenAt: -1 } },
]);

export const dbSessions = new Store<SessionDocument>('wyreSessions', [
  { key: { tokenHash: 1 }, unique: true },
  { key: { userId: 1 } },
  { key: { deviceId: 1 } },
  { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
]);

export const dbOtps = new Store<OtpDocument>('wyreOtps', [
  { key: { email: 1, createdAt: -1 } },
  { key: { requestIp: 1, createdAt: -1 } },
  { key: { magicTokenHash: 1 }, unique: true },
  { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
]);

export const dbQrLogins = new Store<QrLoginDocument>('wyreQrLogins', [
  { key: { tokenHash: 1 }, unique: true },
  { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
]);
