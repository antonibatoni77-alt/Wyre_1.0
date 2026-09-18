import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Express, NextFunction, Request, Response } from 'express';
import multer from 'multer';

import { env, uploadRoot } from './env';
import { AppError, AuthError, ValidationError } from './errors';
import type { UserInfo } from './types';

export const MAX_FILE_BYTES = env.MAX_UPLOAD_MB * 1024 * 1024;
const tempRoot = path.resolve(uploadRoot, 'tmp');

/**
 * Large attachments are streamed straight to disk instead of being buffered in
 * memory, so a 50 GB transfer costs a few megabytes of RAM on the server.
 */
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, done) => {
      mkdir(tempRoot, { recursive: true }).then(() => done(null, tempRoot), (error) => done(error as Error, tempRoot));
    },
  }),
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 8 },
});

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} ГБ`;
}

/** `audio/webm;codecs=opus` and `audio/webm` must be treated as the same type. */
function baseMimeType(value: string) {
  return value.split(';')[0].trim().toLowerCase();
}

function signatureFor(filePath: string, expires: string, contentType = '') {
  return createHmac('sha256', env.SESSION_SECRET)
    .update(`${filePath}\n${expires}\n${contentType}`)
    .digest('hex');
}

function validSignature(received: string, expected: string) {
  const left = Buffer.from(received, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function resolveStoragePath(filePath: string) {
  if (!filePath.startsWith('private/wyre-chats/') && !filePath.startsWith('private/wyre-stories/') && !filePath.startsWith('private/wyre-avatars/')) {
    throw new ValidationError('Недопустимый путь файла');
  }
  const resolved = path.resolve(uploadRoot, filePath);
  const prefix = `${uploadRoot}${path.sep}`;
  if (!resolved.startsWith(prefix)) throw new ValidationError('Недопустимый путь файла');
  return resolved;
}

function assertTicket(filePath: string, expires: string, signature: string, contentType = '') {
  if (!expires || Number(expires) < Date.now()) throw new ValidationError('Ссылка на файл истекла');
  if (!validSignature(signature, signatureFor(filePath, expires, contentType))) {
    throw new ValidationError('Недействительная подпись файла');
  }
}

export async function getUploadUrl({ filePath, contentType }: { filePath: string; contentType: string }) {
  resolveStoragePath(filePath);
  // Huge uploads can legitimately run for hours, so the ticket must outlive them.
  const expires = String(Date.now() + 12 * 60 * 60 * 1000);
  return {
    url: '/api/uploads',
    fields: {
      filePath,
      contentType,
      expires,
      signature: signatureFor(filePath, expires, contentType),
    },
  };
}

export async function getFileUrl(filePath: string, contentType = 'application/octet-stream') {
  resolveStoragePath(filePath);
  const expires = String(Date.now() + 6 * 60 * 60 * 1000);
  const query = new URLSearchParams({
    path: filePath,
    contentType,
    expires,
    signature: signatureFor(filePath, expires, contentType),
  });
  return { url: `/api/files?${query.toString()}` };
}

export async function storedFileExists(filePath: string) {
  try {
    const info = await stat(resolveStoragePath(filePath));
    return info.isFile();
  } catch {
    return false;
  }
}

export function readStoredFile(filePath: string) {
  return readFile(resolveStoragePath(filePath));
}

export async function writeStoredFile(filePath: string, data: Buffer) {
  const target = resolveStoragePath(filePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, data, { flag: 'wx' });
}

export async function deleteStoredFile(filePath: string) {
  try {
    await rm(resolveStoragePath(filePath), { force: true });
  } catch {
    // Missing files are not an error for cleanup paths.
  }
}

type UserRequest = Request & { user?: UserInfo | null };

export function registerStorageRoutes(app: Express) {
  app.post('/api/uploads', (req: UserRequest, res: Response, next: NextFunction) => {
    upload.single('file')(req, res, async (uploadError) => {
      const temporaryPath = req.file?.path;
      const cleanup = async () => {
        if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined);
      };
      if (uploadError) {
        await cleanup();
        const tooLarge = typeof uploadError === 'object' && uploadError && 'code' in uploadError && uploadError.code === 'LIMIT_FILE_SIZE';
        return next(tooLarge ? new ValidationError(`Файл больше ${env.MAX_UPLOAD_MB} МБ`) : uploadError);
      }
      try {
        if (!req.user) throw new AuthError();
        const filePath = String(req.body.filePath ?? '');
        const contentType = String(req.body.contentType ?? 'application/octet-stream');
        assertTicket(filePath, String(req.body.expires ?? ''), String(req.body.signature ?? ''), contentType);
        if (!req.file || !temporaryPath) throw new ValidationError('Файл не передан');
        if (req.file.size > MAX_FILE_BYTES) throw new ValidationError(`Файл больше ${env.MAX_UPLOAD_MB} МБ`);
        // Browsers report codec parameters inconsistently, so compare base types.
        if (baseMimeType(req.file.mimetype) !== baseMimeType(contentType)) throw new ValidationError('Тип файла не совпадает');

        const target = resolveStoragePath(filePath);
        await mkdir(path.dirname(target), { recursive: true });
        await rename(temporaryPath, target);
        res.status(201).json({ ok: true, size: req.file.size });
      } catch (error) {
        await cleanup();
        next(error);
      }
    });
  });

  /**
   * Signed download with HTTP range support, so photos and videos can be viewed
   * and scrubbed directly in a browser tab instead of being fully downloaded.
   */
  app.get('/api/files', async (req: UserRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new AuthError();
      const filePath = String(req.query.path ?? '');
      const contentType = String(req.query.contentType ?? 'application/octet-stream');
      assertTicket(filePath, String(req.query.expires ?? ''), String(req.query.signature ?? ''), contentType);
      const resolved = resolveStoragePath(filePath);
      let info;
      try {
        info = await stat(resolved);
      } catch {
        // A valid signature for a path that no longer exists is a 404, not a
        // server error — signed URLs legitimately outlive deleted files.
        throw new AppError('Файл не найден', 404, 'FILE_NOT_FOUND');
      }
      const download = req.query.download === '1';

      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('Content-Type', contentType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Disposition', download ? `attachment; filename="${path.basename(resolved)}"` : 'inline');

      const range = req.headers.range;
      const match = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
      if (match) {
        const start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2] || 0));
        const end = match[1] ? (match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1) : info.size - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= info.size) {
          res.setHeader('Content-Range', `bytes */${info.size}`);
          res.status(416).end();
          return;
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
        res.setHeader('Content-Length', String(end - start + 1));
        createReadStream(resolved, { start, end }).pipe(res);
        return;
      }

      res.setHeader('Content-Length', String(info.size));
      createReadStream(resolved).pipe(res);
    } catch (error) {
      next(error);
    }
  });
}
