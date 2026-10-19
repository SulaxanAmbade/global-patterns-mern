import { connect, client, init } from '../src/db.js';
import { optimizeStorage } from '../src/services/replacement.js';
import { openLocal, localPath } from '../src/services/localStore.js';
import fs from 'node:fs/promises';
// Stop the API first. Operates only on this app's configured database.
try {
  const db = await connect();
  console.log(
    'Optimizing application storage. The active dataset is backed up locally before replacement.',
  );
  const result = await optimizeStorage(db);
  await db
    .collection('jobs')
    .updateMany(
      { status: { $in: ['queued', 'running'] } },
      {
        $set: {
          status: 'failed',
          error: 'Stopped for storage optimization. Run this job again.',
          finishedAt: new Date(),
        },
      },
    );
  for await (const job of db
    .collection('jobs')
    .find({ kind: 'import', status: 'preview' })) {
    try {
      await fs.access(localPath(job._id));
    } catch {
      await db
        .collection('jobs')
        .updateOne(
          { _id: job._id },
          {
            $set: {
              status: 'failed',
              error:
                'Legacy preview expired during storage optimization. Re-upload the source file.',
            },
          },
        );
    }
  }
  await init(db);
  console.log('Optimization complete:', result);
  console.log(
    'Active data is retained. Old MongoDB dataset revisions and obsolete temporary reports were removed. Keep backend/storage and its recovery backup.',
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
