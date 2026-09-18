/**
 * Wipes every Wyre account and all data derived from accounts.
 *
 * Usage:
 *   node dist/reset-accounts.mjs           dry run, only prints counts
 *   node dist/reset-accounts.mjs --confirm  actually deletes
 *
 * It clears auth users, sessions, OTPs, profiles, chats, messages, calls,
 * settings, security records, devices, channels, stories, moderation history and
 * every private attachment on disk, leaving an empty installation.
 */
import { rm, readdir } from 'node:fs/promises';
import path from 'node:path';

import { closeDatabase, connectDatabase } from '../src/server/core/database';
import { env, uploadRoot } from '../src/server/core/env';

const COLLECTIONS = [
  // auth
  'wyreUsers',
  'wyreSessions',
  'wyreOtps',
  'wyreQrLogins',
  'wyreDevices',
  'wyreDeviceAccounts',
  // profiles and settings
  'wyreProfiles',
  'wyreSettings',
  'wyreUserBlocks',
  'wyreFamilyInvites',
  'wyreFamilyLinks',
  'wyreQuietCareAlerts',
  'wyreYandexLinkRequests',
  // security
  'wyreWebAuthnCredentials',
  'wyreWebAuthnChallenges',
  'wyrePushSubscriptions',
  'wyreNotificationJobs',
  // chats
  'wyreChats',
  'wyreMessages',
  'wyreTopics',
  'wyreDrafts',
  'wyreMessageBookmarks',
  'wyreScheduledMessages',
  'wyreReminders',
  'wyreSharedNotes',
  // calls
  'wyreCalls',
  'wyreCallSignals',
  'wyreCallInvites',
  'wyreCallControlEvents',
  // content
  'wyreStories',
  'wyreStoryViews',
  'wyreChannels',
  'wyreChannelPosts',
  'wyreChannelComments',
  // moderation
  'wyreAdminActions',
] as const;

async function main() {
  const confirmed = process.argv.includes('--confirm');
  const database = await connectDatabase();

  console.info(`База: ${env.MONGODB_DB_NAME}`);
  let total = 0;
  const present: { name: string; count: number }[] = [];
  for (const name of COLLECTIONS) {
    const count = await database.collection(name).countDocuments({});
    total += count;
    if (count > 0) present.push({ name, count });
  }

  for (const item of present) console.info(`  ${item.name}: ${item.count}`);
  console.info(`Всего документов к удалению: ${total}`);

  if (!confirmed) {
    console.info('Пробный запуск. Ничего не удалено. Повторите с флагом --confirm.');
    await closeDatabase();
    return;
  }

  for (const name of COLLECTIONS) {
    const result = await database.collection(name).deleteMany({});
    if (result.deletedCount) console.info(`  очищено ${name}: ${result.deletedCount}`);
  }

  // Private attachments belong to deleted accounts, so they go as well.
  const privateRoot = path.join(uploadRoot, 'private');
  await rm(privateRoot, { recursive: true, force: true });
  await rm(path.join(uploadRoot, 'tmp'), { recursive: true, force: true });
  console.info(`Приватные вложения удалены: ${privateRoot}`);

  const users = await database.collection('wyreUsers').countDocuments({});
  const profiles = await database.collection('wyreProfiles').countDocuments({});
  const remaining = await readdir(uploadRoot).catch(() => [] as string[]);
  console.info(`Проверка: аккаунтов ${users}, профилей ${profiles}, в uploads осталось записей: ${remaining.length}`);

  await closeDatabase();
}

main().catch(async (error) => {
  console.error('Сброс не удался:', error);
  await closeDatabase().catch(() => undefined);
  process.exitCode = 1;
});
