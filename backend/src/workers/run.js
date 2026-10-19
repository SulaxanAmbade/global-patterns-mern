import { jobDatabase } from '../services/localStore.js';
import { activateDataset } from '../services/replacement.js';
import {
  recordJobFailure,
  isStorageQuotaError,
  storageQuotaMessage,
} from '../services/storageErrors.js';
import { connect, client } from '../db.js';
import { importDataset } from '../services/importDataset.js';
import { coverage } from '../services/coverage.js';
import { performance } from '../services/performance.js';
const remote = await connect(),
  id = process.argv[2],
  job = await remote.collection('jobs').findOne({ _id: id });
const db = jobDatabase(remote, job);
let lastProgressAt = 0;
const progress = async (processed) => {
  if (Date.now() - lastProgressAt < 1000) return;
  lastProgressAt = Date.now();
  await remote
    .collection('jobs')
    .updateOne({ _id: id }, { $set: { processed } });
};

try {
  let result;
  if (['coverage', 'performance'].includes(job.kind)) {
    const active = await remote
      .collection('metadata')
      .findOne({ _id: 'active' });
    if (active?.revision !== job.input.revision)
      throw Error('The shared dataset changed. Run the check again.');
  }
  if (job.kind === 'activate') result = await activateDataset(remote, job);
  else if (job.kind === 'import')
    result = await importDataset(db, job, progress);
  else if (job.kind === 'coverage') result = await coverage(db, job, progress);
  else if (job.kind === 'performance')
    result = await performance(db, job, progress);
  else throw Error('Unknown job kind');
  result._execution = {
    workerPeakRSSMiB:
      Math.round((process.resourceUsage().maxRSS / 1024) * 10) / 10,
  };
  await db.collection('jobs').updateOne(
    { _id: id },
    {
      $set: {
        status: job.kind === 'import' ? 'preview' : 'completed',
        result,
        finishedAt: new Date(),
      },
    },
  );
} catch (e) {
  console.error(isStorageQuotaError(e) ? storageQuotaMessage : e.message);
  // Roll back only this incomplete job before attempting another status write.
  // If Atlas is full, the status write can fail too; it must not skip cleanup.
  const cleanup = [
    ['scratch', { jobId: id }],
    ['jobRows', { jobId: id }],
    ...(job.kind === 'import'
      ? [
          ['patterns', { revision: id }],
          ['pairs', { revision: id }],
        ]
      : []),
  ];
  for (const [collection, filter] of cleanup) {
    try {
      await db.collection(collection).deleteMany(filter);
    } catch (error) {
      console.error('Failed-job cleanup:', error.message);
    }
  }
  await recordJobFailure(
    db,
    id,
    isStorageQuotaError(e) ? storageQuotaMessage : e.message,
  );
} finally {
  db.local.close();
  await client.close();
}
