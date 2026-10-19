import { MongoClient } from 'mongodb';
import { config } from './config.js';
export const client = new MongoClient(config.uri, {
  maxPoolSize: 8,
  serverSelectionTimeoutMS: 10000,
});
export async function connect() {
  await client.connect();
  return client.db();
}
export async function init(db) {
  await db.collection('jobs').createIndex({ owner: 1, createdAt: -1 });
  await db
    .collection('sessions')
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  const m = await db.collection('metadata').findOne({ _id: 'active' });
  if (m?.schemaVersion === 2) {
    const { compactIndexes } = await import('./services/replacement.js');
    await compactIndexes(db);
  }
}
