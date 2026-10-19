import { localPath } from './localStore.js';
import { replacementState } from './replacement.js';
import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, storage } from '../config.js';
import {
  isStorageQuotaError,
  storageQuotaMessage,
  recordJobFailure,
} from './storageErrors.js';
let busy = false;
export async function enqueue(db, owner, kind, input, upload) {
  if (
    (await db
      .collection('jobs')
      .countDocuments({ status: { $in: ['queued', 'running'] } })) >= 10
  ) {
    if (
      upload &&
      !(await db.collection('jobs').findOne({ 'upload.path': upload.path }))
    )
      await fs.unlink(upload.path).catch(() => {});
    throw Object.assign(Error('Queue full. Try again after a job finishes.'), {
      status: 429,
    });
  }
  const job = {
    _id: randomUUID(),
    owner,
    kind,
    input,
    upload: upload
      ? { path: upload.path, originalname: upload.originalname }
      : null,
    status: 'queued',
    processed: 0,
    createdAt: new Date(),
  };
  await db.collection('jobs').insertOne(job);
  return job;
}
export async function startQueue(db) {
  try {
    await db.collection('jobs').updateMany(
      { status: 'running' },
      {
        $set: {
          status: 'failed',
          error: 'Server restarted; please run this job again',
          finishedAt: new Date(),
        },
      },
    );
  } catch (error) {
    if (!isStorageQuotaError(error)) throw error;
    console.error(storageQuotaMessage);
  }
  let nextAttemptAt = 0;
  const tick = async () => {
    if (busy || Date.now() < nextAttemptAt) return;
    const recovering = !!(await replacementState());
    busy = true;
    try {
      const job = await db
        .collection('jobs')
        .findOneAndUpdate(
          { status: 'queued', ...(recovering ? { kind: 'performance' } : {}) },
          { $set: { status: 'running', startedAt: new Date() } },
          { sort: { createdAt: 1 }, returnDocument: 'after' },
        );
      if (!job) return;
      await new Promise((resolve) => {
        const child = fork(
          new URL('../workers/run.js', import.meta.url),
          [job._id],
          {
            execArgv: [`--max-old-space-size=${config.workerMB}`],
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
          },
        );
        const timer = setTimeout(() => child.kill('SIGKILL'), config.timeout);
        child.once('exit', async (code) => {
          clearTimeout(timer);
          try {
            if (code !== 0)
              await recordJobFailure(
                db,
                job._id,
                'Worker stopped unexpectedly. Check the backend log for database storage, memory or timeout errors.',
                true,
              );
          } finally {
            resolve();
          }
        });
        child.once('error', async (error) => {
          clearTimeout(timer);
          try {
            await recordJobFailure(db, job._id, error.message);
          } finally {
            resolve();
          }
        });
      });
    } catch (e) {
      if (isStorageQuotaError(e)) {
        nextAttemptAt = Date.now() + 30000;
        console.error('Queue paused for 30 seconds:', storageQuotaMessage);
      } else console.error('Queue:', e.message);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, 1000);
  timer.unref();
  const cleanup = async () => {
    if (busy || (await replacementState())) return;
    busy = true;
    try {
      const old = await db
        .collection('jobs')
        .find({
          createdAt: { $lt: new Date(Date.now() - config.retention) },
          status: { $nin: ['queued', 'running'] },
        })
        .toArray();
      for (const job of old) {
        await Promise.all([
          db.collection('jobRows').deleteMany({ jobId: job._id }),
          db.collection('scratch').deleteMany({ jobId: job._id }),
        ]);
        if (
          job.upload &&
          !(await db
            .collection('jobs')
            .findOne({ _id: { $ne: job._id }, 'upload.path': job.upload.path }))
        )
          await fs.unlink(job.upload.path).catch(() => {});
        if (
          await db.collection('jobs').findOne({
            'input.sourceJob': job._id,
            status: { $in: ['queued', 'running'] },
          })
        )
          continue;
        await fs.unlink(localPath(job._id)).catch(() => {});
        await db.collection('jobs').deleteOne({ _id: job._id });
      }
      // Files left behind by an interrupted upload are also bounded by retention.
      for (const name of await fs.readdir(storage)) {
        const p = path.join(storage, name);
        const s = await fs.stat(p);
        const orphan = name.match(/^([a-f0-9-]{36})\.sqlite$/);
        if (
          orphan &&
          s.mtimeMs < Date.now() - config.retention &&
          !(await db.collection('jobs').findOne({ _id: orphan[1] }))
        )
          await fs.unlink(p).catch(() => {});
        if (
          /^[a-f0-9]{32}$/.test(name) &&
          s.isFile() &&
          s.mtimeMs < Date.now() - config.retention &&
          !(await db.collection('jobs').findOne({ 'upload.path': p }))
        )
          await fs.unlink(p).catch(() => {});
      }
      // Active data is replaced explicitly; retention never prunes dataset revisions.
    } catch (e) {
      console.error('Cleanup:', e.message);
    } finally {
      busy = false;
    }
  };
  const cleaner = setInterval(cleanup, 60000);
  cleaner.unref();
}
