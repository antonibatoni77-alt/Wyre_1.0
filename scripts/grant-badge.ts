/**
 * Assigns or clears a Wyre badge for an existing account by email.
 *
 * Usage:
 *   node dist/grant-badge.mjs                          list accounts and badges
 *   node dist/grant-badge.mjs you@example.com dev       give the Dev badge
 *   node dist/grant-badge.mjs you@example.com official  give the Official badge
 *   node dist/grant-badge.mjs you@example.com none      remove the badge
 *
 * Badges are normally issued from the admin panel; this is the manual path for
 * the first installation or when the panel is unavailable.
 */
import { closeDatabase, connectDatabase } from '../src/server/core/database';
import { env } from '../src/server/core/env';

const BADGES = ['dev', 'official', 'none'] as const;
type BadgeArgument = (typeof BADGES)[number];

async function main() {
  const [rawEmail, rawBadge] = process.argv.slice(2);
  const database = await connectDatabase();
  const profiles = database.collection('wyreProfiles');

  if (!rawEmail) {
    const all = await profiles.find({}, { projection: { email: 1, username: 1, role: 1, badge: 1, isDecoy: 1 } }).toArray();
    console.info(`База: ${env.MONGODB_DB_NAME}`);
    if (!all.length) console.info('Аккаунтов нет.');
    for (const item of all) {
      if (item.isDecoy) continue;
      console.info(`  ${item.email}  @${item.username}  роль: ${item.role}  бейдж: ${item.badge ?? '(нет)'}`);
    }
    console.info('\nЧтобы выдать бейдж: node dist/grant-badge.mjs <email> <dev|official|none>');
    await closeDatabase();
    return;
  }

  const email = rawEmail.trim().toLowerCase();
  const badgeArgument = (rawBadge ?? 'dev').trim() as BadgeArgument;
  if (!BADGES.includes(badgeArgument)) throw new Error(`Бейдж должен быть одним из: ${BADGES.join(', ')}`);

  const profile = await profiles.findOne({ email });
  if (!profile) throw new Error(`Профиль с email ${email} не найден`);
  if (profile.isDecoy) throw new Error('Нельзя выдавать бейдж decoy-аккаунту');

  const badge = badgeArgument === 'none' ? null : badgeArgument;
  await profiles.updateOne({ _id: profile._id }, { $set: { badge, updatedAt: new Date() } });
  console.info(`Бейдж обновлён: ${email} -> ${badge ?? 'снят'}`);

  await closeDatabase();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await closeDatabase().catch(() => undefined);
  process.exitCode = 1;
});
