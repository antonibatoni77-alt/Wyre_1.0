import z from 'zod';
import { ObjectId } from '../core/database';
import { ValidationError } from '../core/errors';
import { getFileUrl, getUploadUrl, storedFileExists } from '../core/storage';
import type { UserInfo } from '../core/types';

import { dbChats, dbProfiles, dbStories, dbStoryViews } from './db';
import { blockedUserIds, requireNotBlocked, requireVerifiedProfile } from './profile';

const STORY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVE_STORIES = 20;
const STORY_CONTENT_TYPE = /^(image\/(?:jpeg|png|webp|gif)|video\/(?:webm|mp4|quicktime))$/i;

async function visibleAuthorIds(viewerId: string) {
  const [chats, blocked] = await Promise.all([dbChats.fetch({ memberIds: viewerId }), blockedUserIds(viewerId)]);
  return new Set(chats.flatMap((chat) => chat.memberIds ?? []).filter((id) => id !== viewerId && !blocked.has(id)));
}

async function requireVisibleStory(storyId: string, viewerId: string) {
  if (!ObjectId.isValid(storyId)) throw new ValidationError('История не найдена');
  const story = await dbStories.findOne({ _id: new ObjectId(storyId), expiresAt: { $gt: new Date() } });
  if (!story) throw new ValidationError('История уже недоступна');
  if (story.authorId === viewerId) return story;
  await requireNotBlocked(viewerId, story.authorId);
  const allowed = await visibleAuthorIds(viewerId);
  if (!allowed.has(story.authorId)) throw new ValidationError('История недоступна');
  return story;
}

export const storyQueries = {
  /** Only unseen, non-expired stories are returned, so the tray disappears after viewing. */
  listStories: async (_args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const authorIds = [...await visibleAuthorIds(viewerId)];
    if (authorIds.length === 0) return [];

    const stories = await dbStories.fetch(
      { authorId: { $in: authorIds }, expiresAt: { $gt: new Date() } },
      { sort: { createdAt: -1 }, limit: 100 },
    );
    if (stories.length === 0) return [];

    const storyIds = stories.map((story) => story._id.toString());
    const [views, profiles] = await Promise.all([
      dbStoryViews.fetch({ viewerId, storyId: { $in: storyIds } }),
      dbProfiles.fetch({ userId: { $in: authorIds.filter(ObjectId.isValid).map((id) => new ObjectId(id)) } }),
    ]);
    const viewed = new Set(views.map((entry) => entry.storyId));
    const authors = new Map(profiles.map((entry) => [entry.userId.toString(), entry]));

    return Promise.all(
      stories
        .filter((story) => !viewed.has(story._id.toString()))
        .map(async (story) => {
          const author = authors.get(story.authorId);
          const media = await getFileUrl(story.filePath, story.mimeType);
          return {
            id: story._id.toString(),
            authorId: story.authorId,
            name: author?.name ?? 'Пользователь Wyre',
            initials: author?.initials ?? '??',
            colors: [author?.colors?.[0] ?? '#8b5cf6', author?.colors?.[1] ?? '#2563eb'],
            caption: story.caption,
            mediaUrl: media.url,
            mimeType: story.mimeType,
            createdAt: story.createdAt,
            expiresAt: story.expiresAt,
          };
        }),
    );
  },
};

export const storyMutations = {
  requestStoryUpload: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const authorId = profile.userId.toString();
    const { fileName, fileSize, contentType } = z
      .object({
        fileName: z.string().trim().min(1).max(200),
        fileSize: z.number().int().positive().max(2 * 1024 * 1024 * 1024, 'Файл истории больше 2 ГБ'),
        contentType: z.string().trim().regex(STORY_CONTENT_TYPE, 'Для истории выберите фото или видео'),
      })
      .parse(args);
    void fileSize;

    const safeName = fileName.replace(/[^\w.\-]+/g, '_').slice(-100);
    const filePath = `private/wyre-stories/${authorId}/${new ObjectId().toString()}-${safeName}`;
    const upload = await getUploadUrl({ filePath, contentType });
    return { url: upload.url, fields: upload.fields, filePath };
  },

  createStory: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const authorId = profile.userId.toString();
    const { caption, filePath, mimeType } = z
      .object({
        caption: z.string().trim().max(500, 'Подпись не длиннее 500 символов').default(''),
        filePath: z.string().min(1),
        mimeType: z.string().trim().regex(STORY_CONTENT_TYPE, 'Некорректный формат истории'),
      })
      .parse(args);

    if (!filePath.startsWith(`private/wyre-stories/${authorId}/`)) {
      throw new ValidationError('Некорректный файл истории');
    }
    if (!await storedFileExists(filePath)) throw new ValidationError('Сначала загрузите файл истории');

    const now = new Date();
    const activeCount = await dbStories.countDocuments({ authorId, expiresAt: { $gt: now } });
    if (activeCount >= MAX_ACTIVE_STORIES) {
      throw new ValidationError(`Одновременно можно опубликовать до ${MAX_ACTIVE_STORIES} историй`);
    }

    const expiresAt = new Date(now.getTime() + STORY_LIFETIME_MS);
    const { insertedId } = await dbStories.insertOne({
      authorId,
      caption,
      filePath,
      mimeType,
      createdAt: now,
      expiresAt,
    });
    return { storyId: insertedId.toString(), expiresAt };
  },

  markStoryViewed: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { storyId } = z.object({ storyId: z.string() }).parse(args);
    const story = await requireVisibleStory(storyId, viewerId);
    if (story.authorId === viewerId) return { viewed: true };

    await dbStoryViews.updateOne(
      { storyId, viewerId },
      {
        $setOnInsert: {
          storyId,
          viewerId,
          viewedAt: new Date(),
          expiresAt: story.expiresAt,
        },
      },
      { upsert: true },
    );
    return { viewed: true };
  },
};
