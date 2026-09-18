import z from 'zod';
import { ObjectId } from '../core/database';
import { ValidationError } from '../core/errors';
import { LiveData } from '../core/liveData';
import type { UserInfo } from '../core/types';
import { dbChannelComments, dbChannelPosts, dbChannels, dbProfiles } from './db';
import { initialsFrom, paletteFor, requireNotBlocked, requireVerifiedProfile } from './profile';

async function requireChannel(channelId: string, userId: string, subscribed = true) {
  if (!ObjectId.isValid(channelId)) throw new ValidationError('Канал не найден');
  const channel = await dbChannels.findOne({ _id: new ObjectId(channelId) });
  if (!channel || (subscribed && !channel.subscriberIds.includes(userId))) throw new ValidationError('Канал не найден');
  return channel;
}

async function requirePost(postId: string, userId: string) {
  if (!ObjectId.isValid(postId)) throw new ValidationError('Пост не найден');
  const post = await dbChannelPosts.findOne({ _id: new ObjectId(postId) });
  if (!post) throw new ValidationError('Пост не найден');
  const channel = await requireChannel(post.channelId, userId);
  return { post, channel };
}

function serializeChannel(channel: NonNullable<Awaited<ReturnType<typeof dbChannels.findOne>>>, viewerId: string) {
  return {
    id: channel._id.toString(), title: channel.title, description: channel.description,
    initials: initialsFrom(channel.title), colors: paletteFor(channel._id.toString()),
    subscribers: channel.subscriberIds.length, owner: channel.ownerId === viewerId,
    subscribed: channel.subscriberIds.includes(viewerId), updatedAt: channel.updatedAt,
  };
}

async function serializePost(post: NonNullable<Awaited<ReturnType<typeof dbChannelPosts.findOne>>>, viewerId: string) {
  const reactionEntries = Object.entries(post.reactions ?? {});
  return {
    id: post._id.toString(), channelId: post.channelId, text: post.text, createdAt: post.createdAt,
    edited: Boolean(post.editedAt), views: (post.viewedBy ?? []).length,
    reactions: reactionEntries.map(([emoji, ids]) => ({ emoji, count: ids.length, mine: ids.includes(viewerId) })),
    comments: await dbChannelComments.countDocuments({ postId: post._id.toString() }),
  };
}

export const channelQueries = {
  listChannels: async (_args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    return new LiveData({
      fetch: async () => (await dbChannels.fetch({ subscriberIds: viewerId }, { sort: { updatedAt: -1 }, limit: 100 })).map((channel) => serializeChannel(channel, viewerId)),
      watch: ({ publish }) => { const stream = dbChannels.watch(); stream.on('change', publish); return () => stream.close(); },
    });
  },

  discoverChannels: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user);
    const viewerId = profile.userId.toString();
    const { query } = z.object({ query: z.string().max(100).default('') }).parse(args ?? {});
    const filter = query.trim() ? { title: { $regex: query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } } : {};
    return (await dbChannels.fetch(filter, { sort: { updatedAt: -1 }, limit: 50 })).map((channel) => serializeChannel(channel, viewerId));
  },

  channelFeed: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user); const viewerId = profile.userId.toString();
    const { channelId } = z.object({ channelId: z.string() }).parse(args); await requireChannel(channelId, viewerId);
    return new LiveData({
      fetch: async () => Promise.all((await dbChannelPosts.fetch({ channelId }, { sort: { createdAt: -1 }, limit: 200 })).map((post) => serializePost(post, viewerId))),
      watch: ({ publish }) => { const a = dbChannelPosts.watch(); const b = dbChannelComments.watch(); a.on('change', publish); b.on('change', publish); return () => { a.close(); b.close(); }; },
    });
  },

  postComments: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user); const viewerId = profile.userId.toString();
    const { postId } = z.object({ postId: z.string() }).parse(args); await requirePost(postId, viewerId);
    const comments = await dbChannelComments.fetch({ postId }, { sort: { createdAt: 1 }, limit: 500 });
    const profiles = await dbProfiles.fetch({ userId: { $in: [...new Set(comments.map((comment) => comment.authorId))].filter(ObjectId.isValid).map((id) => new ObjectId(id)) } });
    const byId = new Map(profiles.map((item) => [item.userId.toString(), item]));
    return comments.map((comment) => ({ id: comment._id.toString(), text: comment.text, createdAt: comment.createdAt, edited: Boolean(comment.editedAt), mine: comment.authorId === viewerId, author: byId.get(comment.authorId)?.name ?? 'Пользователь' }));
  },
};

export const channelMutations = {
  createChannel: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user); const ownerId = profile.userId.toString();
    const { title, description } = z.object({ title: z.string().trim().min(1).max(80), description: z.string().trim().max(500).default('') }).parse(args);
    const now = new Date(); const result = await dbChannels.insertOne({ ownerId, title, description, subscriberIds: [ownerId], createdAt: now, updatedAt: now });
    return { channelId: result.insertedId.toString() };
  },
  joinChannel: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user); const userId = profile.userId.toString(); const { channelId } = z.object({ channelId: z.string() }).parse(args);
    const channel = await requireChannel(channelId, userId, false); await dbChannels.updateOne({ _id: channel._id }, { $addToSet: { subscriberIds: userId }, $set: { updatedAt: new Date() } }); return { subscribed: true };
  },
  leaveChannel: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user); const userId = profile.userId.toString(); const { channelId } = z.object({ channelId: z.string() }).parse(args);
    const channel = await requireChannel(channelId, userId); if (channel.ownerId === userId) throw new ValidationError('Владелец не может покинуть свой канал');
    await dbChannels.updateOne({ _id: channel._id }, { $pull: { subscriberIds: userId }, $set: { updatedAt: new Date() } }); return { subscribed: false };
  },
  publishPost: async (args: unknown, { user }: { user: UserInfo | null }) => {
    const profile = await requireVerifiedProfile(user); const userId = profile.userId.toString(); const { channelId, text } = z.object({ channelId: z.string(), text: z.string().trim().min(1).max(10000) }).parse(args);
    const channel = await requireChannel(channelId, userId); if (channel.ownerId !== userId) throw new ValidationError('Публиковать может только владелец канала');
    const result = await dbChannelPosts.insertOne({ channelId, authorId: userId, text, createdAt: new Date(), editedAt: null, viewedBy: [userId], reactions: {} }); await dbChannels.updateOne({ _id: channel._id }, { $set: { updatedAt: new Date() } }); return { postId: result.insertedId.toString() };
  },
  viewChannelPost: async (args: unknown, { user }: { user: UserInfo | null }) => { const profile = await requireVerifiedProfile(user); const userId = profile.userId.toString(); const { postId } = z.object({ postId: z.string() }).parse(args); const { post } = await requirePost(postId, userId); await dbChannelPosts.updateOne({ _id: post._id }, { $addToSet: { viewedBy: userId } }); return { viewed: true }; },
  reactChannelPost: async (args: unknown, { user }: { user: UserInfo | null }) => { const profile = await requireVerifiedProfile(user); const userId = profile.userId.toString(); const { postId, emoji } = z.object({ postId: z.string(), emoji: z.string().min(1).max(8) }).parse(args); const { post } = await requirePost(postId, userId); const ids = post.reactions?.[emoji] ?? []; await dbChannelPosts.updateOne({ _id: post._id }, { $set: { [`reactions.${emoji}`]: ids.includes(userId) ? ids.filter((id) => id !== userId) : [...ids, userId] } }); return { reacted: !ids.includes(userId) }; },
  commentChannelPost: async (args: unknown, { user }: { user: UserInfo | null }) => { const profile = await requireVerifiedProfile(user); const userId = profile.userId.toString(); const { postId, text } = z.object({ postId: z.string(), text: z.string().trim().min(1).max(4000) }).parse(args); const { post, channel } = await requirePost(postId, userId); await requireNotBlocked(userId, channel.ownerId); const result = await dbChannelComments.insertOne({ channelId: post.channelId, postId, authorId: userId, text, createdAt: new Date(), editedAt: null }); return { commentId: result.insertedId.toString() }; },
};
