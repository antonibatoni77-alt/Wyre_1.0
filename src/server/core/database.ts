import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  MongoClient,
  ObjectId,
  type Collection,
  type Db,
  type Document,
  type IndexDescription,
  type WithId,
} from 'mongodb';

import { env } from './env';

export { ObjectId };

let client: MongoClient | null = null;
let database: Db | null = null;
let embeddedServer: import('mongodb-memory-server').MongoMemoryServer | null = null;
const stores: Store<Document>[] = [];

export const databaseEvents = new EventEmitter();
databaseEvents.setMaxListeners(100);

export class Store<T extends Document> {
  private collectionRef: Collection<T> | null = null;
  private readonly events = new EventEmitter();

  constructor(
    public readonly name: string,
    private readonly indexes: IndexDescription[] = [],
  ) {
    stores.push(this as unknown as Store<Document>);
  }

  init(db: Db) {
    this.collectionRef = db.collection<T>(this.name);
  }

  native() {
    if (!this.collectionRef) throw new Error(`MongoDB store ${this.name} is not initialized`);
    return this.collectionRef;
  }

  async createIndexes() {
    if (this.indexes.length > 0) await this.native().createIndexes(this.indexes);
  }

  findOne(filter: Record<string, unknown>) {
    return this.native().findOne(filter as never) as Promise<WithId<T> | null>;
  }

  async requireOne(filter: Record<string, unknown>) {
    const result = await this.findOne(filter);
    if (!result) throw new Error(`${this.name}: document not found`);
    return result;
  }

  async fetch(
    filter: Record<string, unknown> = {},
    options: { sort?: Record<string, 1 | -1>; limit?: number } = {},
  ) {
    let cursor = this.native().find(filter as never);
    if (options.sort) cursor = cursor.sort(options.sort);
    if (options.limit) cursor = cursor.limit(options.limit);
    return cursor.toArray() as Promise<WithId<T>[]>;
  }

  async insertOne(document: T) {
    const result = await this.native().insertOne(document as never);
    this.changed();
    return result;
  }

  /** High-frequency ephemeral writes (call control events) must not storm every client. */
  async insertOneSilent(document: T) {
    return this.native().insertOne(document as never);
  }

  async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options: Record<string, unknown> = {}) {
    const result = await this.native().updateOne(filter as never, update, options);
    if (result.modifiedCount || result.upsertedCount) this.changed();
    return result;
  }

  updateOneSilent(filter: Record<string, unknown>, update: Record<string, unknown>, options: Record<string, unknown> = {}) {
    return this.native().updateOne(filter as never, update, options);
  }

  async updateMany(filter: Record<string, unknown>, update: Record<string, unknown>) {
    const result = await this.native().updateMany(filter as never, update);
    if (result.modifiedCount) this.changed();
    return result;
  }

  async deleteOne(filter: Record<string, unknown>) {
    const result = await this.native().deleteOne(filter as never);
    if (result.deletedCount) this.changed();
    return result;
  }

  /** Silent variant for high-frequency private cleanup (drafts). */
  async deleteOneSilent(filter: Record<string, unknown>) {
    return this.native().deleteOne(filter as never);
  }

  async deleteMany(filter: Record<string, unknown>) {
    const result = await this.native().deleteMany(filter as never);
    if (result.deletedCount) this.changed();
    return result;
  }

  countDocuments(filter: Record<string, unknown>) {
    return this.native().countDocuments(filter as never);
  }

  watch(_pipeline?: unknown[], _options?: Record<string, unknown>) {
    const bridge = new EventEmitter();
    const listener = () => bridge.emit('change');
    this.events.on('change', listener);
    return Object.assign(bridge, {
      close: () => this.events.off('change', listener),
    });
  }

  changed() {
    this.events.emit('change');
    databaseEvents.emit('change', this.name);
  }
}

export async function connectDatabase() {
  if (database) return database;
  const configuredUri = env.MONGODB_URI.trim();
  if (configuredUri) {
    client = new MongoClient(configuredUri, {
      serverSelectionTimeoutMS: isLocalMongoUri(configuredUri) ? 2_000 : 10_000,
    });
    try {
      await client.connect();
    } catch (error) {
      await client.close().catch(() => undefined);
      client = null;
      if (env.NODE_ENV === 'production' || !env.MONGODB_EMBEDDED || !isLocalMongoUri(configuredUri)) {
        throw error;
      }
      console.warn('Локальная MongoDB недоступна — запускаем встроенную базу Wyre.');
    }
  }

  if (!client) {
    if (env.NODE_ENV === 'production' || !env.MONGODB_EMBEDDED) {
      throw new Error('MongoDB не настроена. Задайте MONGODB_URI или включите MONGODB_EMBEDDED=true для разработки.');
    }
    const dataDir = path.resolve(process.cwd(), env.MONGODB_DATA_DIR);
    const binaryDir = path.resolve(process.cwd(), env.MONGODB_BINARY_DIR);
    await mkdir(dataDir, { recursive: true });
    await mkdir(binaryDir, { recursive: true });
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    embeddedServer = await MongoMemoryServer.create({
      binary: { downloadDir: binaryDir },
      instance: {
        dbName: env.MONGODB_DB_NAME,
        dbPath: dataDir,
        storageEngine: 'wiredTiger',
      },
    });
    client = new MongoClient(embeddedServer.getUri(), { serverSelectionTimeoutMS: 10_000 });
    await client.connect();
    console.info(`Встроенная MongoDB запущена. Данные: ${dataDir}`);
  }

  database = client.db(env.MONGODB_DB_NAME);
  for (const store of stores) store.init(database);
  await dropLegacyConflictingIndexes(database);
  for (const store of stores) await store.createIndexes();
  return database;
}

function isLocalMongoUri(uri: string) {
  return /^mongodb:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/i.test(uri);
}

async function dropLegacyConflictingIndexes(db: Db) {
  const candidates = [
    { collection: 'wyreChats', name: 'pairKey_1', conflicts: (index: Document) => Boolean(index.sparse) },
    { collection: 'wyreProfiles', name: 'email_1', conflicts: (index: Document) => !index.unique },
  ];
  for (const candidate of candidates) {
    const collection = db.collection(candidate.collection);
    const indexes = await collection.listIndexes().toArray().catch((error: unknown) => {
      if (typeof error === 'object' && error && 'code' in error && error.code === 26) return [];
      throw error;
    });
    const legacy = indexes.find((index) => index.name === candidate.name);
    if (legacy && candidate.conflicts(legacy)) await collection.dropIndex(candidate.name);
  }
}

export async function closeDatabase() {
  await client?.close();
  await embeddedServer?.stop();
  client = null;
  database = null;
  embeddedServer = null;
}
