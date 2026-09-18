import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Server as SocketServer } from 'socket.io';
import z from 'zod';

import {
  authMiddleware,
  destroySession,
  loginWithCode,
  loginWithMagicToken,
  loginWithPassword,
  loginWithQrToken,
  resolveUserFromCookie,
  sendLoginCode,
  type UserRequest,
} from './core/auth';
import { closeDatabase, connectDatabase, databaseEvents } from './core/database';
import { deviceMiddleware, type DeviceRequest } from './core/devices';
import { env } from './core/env';
import { AppError, normalizeError } from './core/errors';
import { resolveHttpsConfiguration } from './core/https';
import { isLiveData } from './core/liveData';
import type { RpcContext } from './core/types';
import { registerStorageRoutes } from './core/storage';
import { wyreMutations, wyreQueries } from './wyre';
import { processStaleCalls, setCallControlEmitter } from './wyre/calls';
import { registerPushActionRoutes } from './wyre/pushAction';
import { registerYandexAuthRoutes } from './wyre/yandexAuth';
import { processDueReminders, processExpiredMessages, processScheduledMessages, setPresenceEmitter } from './wyre/chats';
import { buildExport, processAutoDnd } from './wyre/settings';
import { processNotificationJobs, reconcileMissedNotifications } from './wyre/notifications';
import { processQuietCare } from './wyre/family';
import { processExpiredWarnings } from './wyre/moderation';
import { ensureServiceAccounts } from './wyre/service';

type RpcHandler = (args: unknown, context: RpcContext) => Promise<unknown> | unknown;
const queries = Object.fromEntries(
  Object.entries(wyreQueries).map(([name, handler]) => [`wyre.${name}`, handler as RpcHandler]),
);
const mutations = Object.fromEntries(
  Object.entries(wyreMutations).map(([name, handler]) => [`wyre.${name}`, handler as RpcHandler]),
);

function assertSameOrigin(req: Request) {
  const origin = req.headers.origin;
  if (!origin) return;
  const allowed = new URL(env.SITE_URL).origin;
  if (origin !== allowed && env.NODE_ENV === 'production') {
    throw new AppError('Запрос с постороннего сайта отклонён', 403, 'CSRF');
  }
}

async function execute(handler: RpcHandler, args: unknown, req: UserRequest) {
  const result = await handler(args ?? {}, {
    user: req.user ?? null,
    sessionTokenHash: req.sessionTokenHash,
  });
  return isLiveData(result) ? result.fetch() : result;
}

async function start() {
  await connectDatabase();
  await ensureServiceAccounts();

  const app = express();
  let closeFrontend = async () => undefined;
  if (env.TRUST_PROXY) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    if (env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.use(deviceMiddleware);
  app.use(authMiddleware);

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.post('/api/auth/send-code', async (req, res, next) => {
    try {
      assertSameOrigin(req);
      res.json(await sendLoginCode(req.body?.email, req.ip ?? 'unknown'));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/auth/verify-code', async (req, res, next) => {
    try {
      assertSameOrigin(req);
      res.json(await loginWithCode(req.body?.email, req.body?.code, res, { userAgent: req.get('user-agent'), ip: req.ip, device: (req as DeviceRequest).device }));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/auth/magic-link', async (req, res, next) => {
    try {
      assertSameOrigin(req);
      res.json(await loginWithMagicToken(req.body?.token, res, { userAgent: req.get('user-agent'), ip: req.ip, device: (req as DeviceRequest).device }));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/auth/password', async (req, res, next) => {
    try {
      assertSameOrigin(req);
      res.json(await loginWithPassword(req.body?.email, req.body?.password, res, { userAgent: req.get('user-agent'), ip: req.ip, device: (req as DeviceRequest).device }));
    } catch (error) {
      next(error);
    }
  });
  app.get('/auth/qr', async (req, res) => {
    try {
      await loginWithQrToken(req.query.token, res, { userAgent: req.get('user-agent'), ip: req.ip, device: (req as DeviceRequest).device });
      res.redirect('/');
    } catch (error) {
      const normalized = normalizeError(error);
      res.redirect(`/?authError=${encodeURIComponent(normalized.message)}`);
    }
  });
  app.post('/api/auth/logout', async (req: UserRequest, res, next) => {
    try {
      assertSameOrigin(req);
      await destroySession(req, res);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/export/:format', async (req: UserRequest, res, next) => {
    try {
      const format = z.enum(['json', 'txt', 'pdf']).parse(req.params.format);
      const file = await buildExport(req.user ?? null, format);
      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="wyre-export.${file.extension}"`);
      res.send(file.body);
    } catch (error) { next(error); }
  });

  app.post('/api/rpc/query', async (req: UserRequest, res, next) => {
    try {
      const method = String(req.body?.method ?? '');
      const handler = queries[method];
      if (!handler) throw new AppError('Метод не найден', 404, 'METHOD_NOT_FOUND');
      res.json({ data: await execute(handler, req.body?.args, req) });
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/rpc/mutation', async (req: UserRequest, res, next) => {
    try {
      assertSameOrigin(req);
      const method = String(req.body?.method ?? '');
      const handler = mutations[method];
      if (!handler) throw new AppError('Метод не найден', 404, 'METHOD_NOT_FOUND');
      res.json({ data: await execute(handler, req.body?.args, req) });
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/rpc/call', async (req: UserRequest, res, next) => {
    try {
      assertSameOrigin(req);
      const method = String(req.body?.method ?? '');
      const handler = mutations[method] ?? queries[method];
      if (!handler) throw new AppError('Метод не найден', 404, 'METHOD_NOT_FOUND');
      res.json({ data: await execute(handler, req.body?.args, req) });
    } catch (error) {
      next(error);
    }
  });

  registerStorageRoutes(app);
  registerPushActionRoutes(app);
  registerYandexAuthRoutes(app);

  if (env.NODE_ENV === 'production') {
    const clientDir = path.resolve(process.cwd(), 'dist/client');
    app.use(express.static(clientDir, { index: false }));
    app.get('*path', (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    closeFrontend = async () => { await vite.close(); };
    app.use(vite.middlewares);
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const normalized = normalizeError(error);
    if (normalized.status >= 500) console.error(error);
    res.status(normalized.status).json({
      error: { message: normalized.message, code: normalized.code },
    });
  });

  const https = resolveHttpsConfiguration();
  const tlsEnabled = Boolean(https.options);
  const server = https.options
    ? createHttpsServer(https.options, app)
    : createHttpServer(app);
  const io = new SocketServer(server, { path: '/socket.io', serveClient: false });

  /**
   * A dead database must not turn into an endless stream of stack traces.
   * Connection failures are reported once, then the schedulers stay quiet until
   * MongoDB answers again.
   */
  let databaseDown = false;
  function isConnectionFailure(error: unknown) {
    const name = typeof error === 'object' && error && 'name' in error ? String(error.name) : '';
    return /MongoNetworkError|MongoServerSelectionError|MongoNotConnectedError|MongoTopologyClosedError/.test(name);
  }
  function reportSchedulerError(label: string, error: unknown) {
    if (isConnectionFailure(error)) {
      if (databaseDown) return;
      databaseDown = true;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`MongoDB недоступна, фоновые задачи приостановлены: ${message}`);
      console.error('Проверьте, что процесс базы жив и что в каталоге данных нет устаревшего mongod.lock.');
      return;
    }
    console.error(`${label}:`, error);
  }
  function runScheduled(label: string, task: () => Promise<unknown>) {
    void task()
      .then(() => {
        if (databaseDown) {
          databaseDown = false;
          console.info('MongoDB снова доступна, фоновые задачи возобновлены.');
        }
      })
      .catch((error) => reportSchedulerError(label, error));
  }

  const scheduler = setInterval(() => {
    runScheduled('Ошибка планировщика сообщений', processScheduledMessages);
    if (databaseDown) return;
    runScheduled('Ошибка планировщика напоминаний', processDueReminders);
    runScheduled('Ошибка авто-DND', processAutoDnd);
    runScheduled('Ошибка доставки push', processNotificationJobs);
    runScheduled('Ошибка восстановления очереди push', reconcileMissedNotifications);
    runScheduled('Ошибка тихой заботы', processQuietCare);
    runScheduled('Ошибка очистки истёкших сообщений', processExpiredMessages);
    runScheduled('Ошибка очистки истёкших предупреждений', processExpiredWarnings);
    runScheduled('Ошибка очистки зависших звонков', processStaleCalls);
  }, 5_000);
  scheduler.unref();
  io.use(async (socket, next) => {
    try {
      const { user } = await resolveUserFromCookie(socket.request.headers.cookie);
      socket.data.user = user;
      // Per-user room: targeted pushes (call control events) reach every
      // signed-in device of one account without broadcasting to everyone.
      if (user) socket.join(`user:${user.id}`);
      next();
    } catch (error) {
      next(error instanceof Error ? error : new Error('Socket auth failed'));
    }
  });

  const notifyRealtime = (collection: string) => io.emit('wyre:changed', { collection });
  databaseEvents.on('change', notifyRealtime);
  setCallControlEmitter((event, targetUserId) => io.to(`user:${targetUserId}`).emit('wyre:call-control', event));
  setPresenceEmitter((userId, payload) => io.to(`user:${userId}`).emit('wyre:presence', payload));

  server.listen(env.PORT, '0.0.0.0', () => {
    const protocol = tlsEnabled ? 'https' : 'http';
    console.info(`Wyre запущен локально: ${protocol}://localhost:${env.PORT}`);
    const lanAddresses = Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .filter((entry) => entry.family === 'IPv4' && !entry.internal)
      .map((entry) => entry.address);
    for (const address of [...new Set(lanAddresses)]) {
      console.info(`Wyre в локальной сети: ${protocol}://${address}:${env.PORT}`);
    }
    if (https.source === 'proxy') console.info('TLS завершается на доверенном reverse proxy.');
    console.info(`Публичный адрес для OAuth/email: ${env.SITE_URL}`);
  });

  const shutdown = async () => {
    clearInterval(scheduler);
    databaseEvents.off('change', notifyRealtime);
    io.close();
    server.close();
    await closeFrontend();
    await closeDatabase();
  };
  process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
}

start().catch((error) => {
  console.error('Не удалось запустить Wyre:', error);
  process.exitCode = 1;
});
