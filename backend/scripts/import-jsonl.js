import path from 'node:path';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { connect, client, init } from '../src/db.js';
import { importDataset } from '../src/services/importDataset.js';
import { jobDatabase } from '../src/services/localStore.js';
import {
  replaceDataset,
  recoverReplacement,
} from '../src/services/replacement.js';
const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run migrate -- /absolute/path/patterns.jsonl');
  process.exit(1);
}
const remote = await connect();
await recoverReplacement(remote);
const revision = randomUUID();
const job = {
    _id: revision,
    kind: 'import',
    upload: { path: path.resolve(file), originalname: path.basename(file) },
    input: { fileDate: null },
  },
  db = jobDatabase(remote, job);
try {
  await stat(file);
  const result = await importDataset(db, job, async () => {});
  db.local.close();
  const counts = await replaceDataset(remote, revision, {
    filename: result.filename,
    file_date: result.fileDate,
    updated_by: 'migration',
  });
  await init(remote);
  console.log('Replacement complete:', counts);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  try {
    db.local.close();
  } catch {}
  await client.close();
}
