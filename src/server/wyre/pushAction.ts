// Push action tokens + endpoints: how the Android notification buttons
// (reply / mark read / accept call / decline call) act on behalf of a user
// without holding the HttpOnly session cookie.
//
// The authenticated web app (inside the Android WebView) requests an opaque
// token once and hands it to the native shell through the WyreNative bridge.
// The shell then calls /api/push-action/* with it. Only SHA-256 hashes are
// stored, the token lives 30 days, and issuing a new one revokes the old.
import { createHash, randomBytes } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import z from 'zod';

import { dbUsers } from '../core/authDb';
import { ObjectId } from '../core/database';
import type { UserInfo } from '../core/types';

import { callMutations } from './calls';
import { chatMutations } from './chats';
import { dbFcmTokens, dbPushActionTokens } from './db';
import { requireVerifiedProfile } from './profile';

const ACTION_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Per-token request budget: notification buttons never need more. */
const RATE_LIMIT_PER_MINUTE = 40;

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export async function createPushActionTokenFor(userId: string) {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  // One live token per user: a fresh issue invalidates the previous one.
  await dbPushActionTokens.deleteMany({ userId });
  await dbPushActionTokens.insertOne({
    tokenHash: hashToken(token),
    userId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + ACTION_TOKEN_TTL_MS),
  });
  return token;
}

const rateBucket = new Map<string, number[]>();
function rateLimited(token: string) {
  const now = Date.now();
  const stamps = (rateBucket.get(token) ?? []).filter((stamp) => now - stamp < 60_000);
  stamps.push(now);
  rateBucket.set(token, stamps);
  if (rateBucket.size > 5000) rateBucket.clear();
  return stamps.length > RATE_LIMIT_PER_MINUTE;
}

async function resolveActionUser(rawToken: unknown): Promise<UserInfo | null> {
  if (typeof rawToken !== 'string' || rawToken.length < 20 || rawToken.length > 200) return null;
  if (rateLimited(rawToken)) return null;
  const record = await dbPushActionTokens.findOne({ tokenHash: hashToken(rawToken), expiresAt: { $gt: new Date() } });
  if (!record) return null;
  if (!ObjectId.isValid(record.userId)) return null;
  const user = await dbUsers.findOne({ _id: new ObjectId(record.userId) });
  if (!user) return null;
  return { id: user._id.toString(), email: user.email };
}

export const pushActionMutations = {
  createPushActionToken: async (_args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    return { token: await createPushActionTokenFor(profile.userId.toString()) };
  },

  registerFcmToken: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const { token, platform } = z.object({
      token: z.string().min(20).max(4096),
      platform: z.string().max(40).default('android'),
    }).parse(args);
    await dbFcmTokens.updateOne(
      { token },
      { $set: { userId: profile.userId.toString(), platform, updatedAt: new Date() } },
      { upsert: true },
    );
    return { registered: true };
  },
};

const actionSchema = z.object({
  token: z.string().min(20).max(200),
});

/** Registers the four notification-action endpoints on the Express app. */
export function registerPushActionRoutes(app: Express) {
  const post = (path: string, handler: (args: unknown, user: UserInfo) => Promise<unknown>) => {
    app.post(path, async (req: Request, res: Response) => {
      try {
        const parsed = actionSchema.safeParse(req.body ?? {});
        const user = parsed.success ? await resolveActionUser(parsed.data.token) : null;
        if (!user) {
          res.status(401).json({ error: { message: 'Токен действий недействителен', code: 'BAD_ACTION_TOKEN' } });
          return;
        }
        res.json({ data: await handler({ ...req.body, token: undefined }, user) });
      } catch {
        res.status(400).json({ error: { message: 'Не удалось выполнить действие', code: 'ACTION_FAILED' } });
      }
    });
  };

  post('/api/push-action/register', async (args, user) => {
    const { token } = args as { token?: unknown };
    return pushActionMutations.registerFcmToken({ token, platform: 'android' }, { user });
  });

  post('/api/push-action/read', async (args, user) => {
    const { chatId } = z.object({ chatId: z.string() }).parse(args);
    return chatMutations.markChatRead({ chatId }, { user });
  });

  post('/api/push-action/reply', async (args, user) => {
    const { chatId, text } = z.object({ chatId: z.string(), text: z.string().min(1).max(4000) }).parse(args);
    return chatMutations.sendMessage({ chatId, text, kind: 'text' }, { user });
  });

  post('/api/push-action/call', async (args, user) => {
    const { callId, accept } = z.object({ callId: z.string(), accept: z.boolean() }).parse(args);
    return accept
      ? callMutations.acceptCall({ callId }, { user })
      : callMutations.declineCall({ callId }, { user });
  });
}
