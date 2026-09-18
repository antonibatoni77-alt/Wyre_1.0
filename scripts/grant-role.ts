/**
 * Grants a Wyre role to an existing account by email.
 *
 * Usage:
 *   node dist/grant-role.mjs                       list accounts and roles
 *   node dist/grant-role.mjs user@example.com owner assign the role
 *
 * Roles: user | moderator | admin | owner.
 * `owner` is normally derived from OWNER_EMAIL, so this script is the manual
 * escape hatch for the very first installation.
 */
import { closeDatabase, connectDatabase } from '../src/server/core/database';
import { env } from '../src/server/core/env';

const ROLES = ['user', 'moderator', 'admin', 'owner'] as const;
type Role = (typeof ROLES)[number];

async function main() {
  const [rawEmail, rawRole] = process.argv.slice(2);
  const database = await connectDatabase();
  const profiles = database.collection('wyreProfiles');

  if (!rawEmail) {
    const all = await profiles.find({}, { projection: { email: 1, username: 1, role: 1, isDecoy: 1 } }).toArray();
    console.info(`База: ${env.MONGODB_DB_NAME}`);
    console.info(`OWNER_EMAIL в .env: ${env.OWNER_EMAIL || '(не задан)'}`);
    if (!all.length) console.info('Аккаунтов нет.');
    for (const item of all) {
      if (item.isDecoy) continue;
      console.info(`  ${item.email}  @${item.username}  роль: ${item.role}`);
    }
    console.info('\nЧтобы выдать роль: node dist/grant-role.mjs <email> <owner|admin|moderator|user>');
    await closeDatabase();
    return;
  }

  const email = rawEmail.trim().toLowerCase();
  const role = (rawRole ?? 'owner').trim() as Role;
  if (!ROLES.includes(role)) throw new Error(`Роль должна быть одной из: ${ROLES.join(', ')}`);

  const profile = await profiles.findOne({ email });
  if (!profile) throw new Error(`Профиль с email ${email} не найден`);
  if (profile.isDecoy) throw new Error('Нельзя выдавать роль decoy-аккаунту');

  await profiles.updateOne({ _id: profile._id }, { $set: { role, updatedAt: new Date() } });
  console.info(`Роль обновлена: ${email} -> ${role}`);
  if (role === 'owner' && env.OWNER_EMAIL !== email) {
    console.warn(`Внимание: OWNER_EMAIL в .env = "${env.OWNER_EMAIL || '(пусто)'}".`);
    console.warn('Пропишите туда этот email, иначе роль владельца может быть переопределена при следующем входе.');
  }

  await closeDatabase();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await closeDatabase().catch(() => undefined);
  process.exitCode = 1;
});
