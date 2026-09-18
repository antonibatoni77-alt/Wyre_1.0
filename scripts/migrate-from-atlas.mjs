// Обратная миграция: Atlas → локальная встроенная MongoDB (D:\wyre\data\mongodb).
// Локальные коллекции замещаются актуальными данными из Atlas.
import { spawn } from 'node:child_process';
import { MongoClient } from 'mongodb';

const LOCAL_URI = 'mongodb://127.0.0.1:27018/wyre';
const ATLAS_URI = process.env.ATLAS_URI;

if (!ATLAS_URI) {
  console.error('Задайте ATLAS_URI переменной окружения');
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectWithRetry(uri, label, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
      await client.connect();
      await client.db('wyre').command({ ping: 1 });
      return client;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`Не удалось подключиться к ${label}`);
}

const mongod = spawn('data/mongodb-binaries/mongod-x64-win32-7.0.14.exe', [
  '--dbpath', 'data/mongodb',
  '--port', '27018',
  '--bind_ip', '127.0.0.1',
], { stdio: 'ignore' });

try {
  const local = await connectWithRetry(LOCAL_URI, 'локальной базой');
  console.log('Локальная база поднята на 27018.');
  const atlas = await connectWithRetry(ATLAS_URI, 'Atlas', 10);
  console.log('Atlas подключён.');

  const source = atlas.db('wyre');
  const target = local.db('wyre');
  const names = await source.listCollections().toArray();
  let totalDocs = 0;
  for (const { name } of names) {
    const docs = await source.collection(name).find({}).toArray();
    await target.collection(name).deleteMany({});
    if (!docs.length) {
      console.log(`  ${name}: пусто в Atlas, локально очищено`);
      continue;
    }
    const result = await target.collection(name).insertMany(docs, { ordered: false });
    totalDocs += result.insertedCount ?? docs.length;
    console.log(`  ${name}: ${docs.length} документов перенесено`);
  }
  console.log(`Итого перенесено: ${totalDocs} документов, коллекций: ${names.length}`);

  await atlas.close();
  await local.close();
  try {
    const admin = new MongoClient(LOCAL_URI.replace('/wyre', '/admin'), { serverSelectionTimeoutMS: 2000 });
    await admin.connect();
    await admin.db('admin').command({ shutdown: 1 }).catch(() => undefined);
    await admin.close();
  } catch {
    // shutdown разрывает соединение — это ожидаемо
  }
  mongod.kill();
  console.log('Локальный mongod остановлен. Обратная миграция завершена.');
} catch (error) {
  mongod.kill();
  console.error('ОШИБКА МИГРАЦИИ:', error.message);
  process.exit(1);
}
