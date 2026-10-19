import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import { openLocal } from './localStore.js';
import { storage } from '../config.js';
import { expandedPairs } from './pairStore.js';
import { auditPattern } from './performance.js';
import { key, words } from './normalize.js';

export const maintenancePath = path.join(
  storage,
  'replacement-state.json',
);

const digest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');

const databaseFingerprint = (db) => {
  const options = db.client.options;

  return digest([
    db.databaseName,
    options.srvHost || '',
    options.srvHost
      ? []
      : (options.hosts || []).map(String).sort(),
  ]);
};

function matchesDatabase(db, fingerprint) {
  if (
    fingerprint === databaseFingerprint(db)
  ) {
    return true;
  }

  const hosts = (
    db.client.options.hosts || []
  ).map(String);

  const srv =
    db.client.options.srvHost || '';

  if (
    fingerprint ===
    digest([db.databaseName, srv, hosts])
  ) {
    return true;
  }

  if (hosts.length > 6) return false;

  function visit(prefix, remaining) {
    if (!remaining.length) {
      return (
        fingerprint ===
        digest([
          db.databaseName,
          srv,
          prefix,
        ])
      );
    }

    return remaining.some((host, i) =>
      visit(
        [...prefix, host],
        remaining.filter((_, j) => i !== j),
      ),
    );
  }

  return visit([], hosts);
}

const patternId = (row) =>
  digest([
    row.url_pattern,
    row.url_pattern_id,
    row.priority,
    row.language_code,
    row.admin_name,
    row.updated_admin_id,
  ]);

export async function replacementState() {
  try {
    return JSON.parse(
      await fs.readFile(
        maintenancePath,
        'utf8',
      ),
    );
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

async function manifest(state) {
  await fs.writeFile(
    maintenancePath + '.tmp',
    JSON.stringify(state),
  );

  await fs.rename(
    maintenancePath + '.tmp',
    maintenancePath,
  );
}

export async function makeBackup(
  db,
  requestedId,
) {
  const metadata = await db
    .collection('metadata')
    .findOne({ _id: 'active' });

  const id =
    requestedId || 'backup-' + randomUUID();

  const local = openLocal(id);

  let patternCount = 0;
  let keywordCount = 0;

  try {
    if (metadata) {
      let batch = [];

      for await (const row of db
        .collection('patterns')
        .find({
          revision: metadata.revision,
        })
        .batchSize(500)) {
        batch.push(row);
        patternCount++;

        if (batch.length === 500) {
          await local
            .collection('patterns')
            .insertMany(batch);

          batch = [];
        }
      }

      if (batch.length) {
        await local
          .collection('patterns')
          .insertMany(batch);
      }

      batch = [];

      for await (const row of expandedPairs(
        db,
        metadata,
      )) {
        batch.push(row);
        keywordCount++;

        if (batch.length === 500) {
          await local
            .collection('pairs')
            .insertMany(batch);

          batch = [];
        }
      }

      if (batch.length) {
        await local
          .collection('pairs')
          .insertMany(batch);
      }
    }

    const savedPatterns = await local
      .collection('patterns')
      .countDocuments();

    const savedKeywords = await local
      .collection('pairs')
      .countDocuments();

    if (
      patternCount !== savedPatterns ||
      keywordCount !== savedKeywords
    ) {
      throw Error(
        'Backup count verification failed',
      );
    }
  } finally {
    local.close();
  }

  return {
    databaseFingerprint:
      databaseFingerprint(db),
    backupId: id,
    backupMetadata: metadata,
    backupPatterns: patternCount,
    backupKeywords: keywordCount,
  };
}

async function clearActiveCollections(db) {
  // Keep sessions, jobs and metadata.
  for (const name of [
    'patterns',
    'pairs',
  ]) {
    await db
      .collection(name)
      .deleteMany({});

    await db
      .collection(name)
      .dropIndexes()
      .catch((error) => {
        if (error.code !== 26) {
          throw error;
        }
      });
  }

  // Remove obsolete processing collections.
  for (const name of [
    'scratch',
    'jobRows',
  ]) {
    await db
      .collection(name)
      .drop()
      .catch((error) => {
        if (error.code !== 26) {
          throw error;
        }
      });
  }
}

export async function compactIndexes(db) {
  await db
    .collection('patterns')
    .createIndex({
      revision: 1,
      length: -1,
      _id: 1,
    });

  await db
    .collection('patterns')
    .createIndex({
      aliases: 1,
      language_code: 1,
    });

  await db
    .collection('pairs')
    .createIndex({
      patternId: 1,
      keywordKey: 1,
    });
}

async function install(db, local, revision) {
  console.log(
    '[Dataset] Clearing incomplete records...',
  );

  await clearActiveCollections(db);

  console.log(
    '[Dataset] Reading the local dataset...',
  );

  const processed = {
    patterns: 0,
    pairs: 0,
  };

  async function writeBatch(name, rows) {
    if (!rows.length) return;

    console.log(
      `[Dataset] Sending ${rows.length} ${name} records...`,
    );

    await db
      .collection(name)
      .bulkWrite(rows, {
        ordered: false,
      });

    processed[name] += rows.length;

    console.log(
      `[Dataset] ${name}: ${processed[name]} processed`,
    );
  }

  let batch = [];

  const sourcePatterns =
    local.collection('patterns');

  for await (const row of sourcePatterns.find()) {
    const pattern = {
      _id: patternId(row),
      url_pattern: row.url_pattern,
      url_pattern_id: row.url_pattern_id,
      priority: row.priority,
      language_code: row.language_code,
      admin_name: row.admin_name,
      updated_admin_id: row.updated_admin_id,
      domain: row.domain,
      basis: row.basis,
      normalized:
        row.normalized ||
        words(row.url_pattern).join(' '),
      length:
        row.length ||
        row.url_pattern.length,
      revision,
      aliases: [
        ...new Set(
          [
            row.basis,
            row.url_pattern,
            row.domain + '*' + row.basis,
          ].map(auditPattern),
        ),
      ],
    };

    batch.push({
      updateOne: {
        filter: {
          _id: pattern._id,
        },
        update: {
          $set: pattern,
        },
        upsert: true,
      },
    });

    if (batch.length === 1000) {
      await writeBatch('patterns', batch);
      batch = [];
    }
  }

  if (batch.length) {
    await writeBatch('patterns', batch);
  }

  batch = [];

  // Reuse source-pattern IDs across a pattern's keywords.
  // Bound both cache entries and total cached IDs.
  const sourceCache = new Map();
  let cachedIds = 0;

  async function sourceIds(pair) {
    const cacheKey = JSON.stringify([
      pair.source_pattern,
      pair.language,
      pair.source_admin_name !== undefined,
      pair.source_admin_name,
    ]);

    if (sourceCache.has(cacheKey)) {
      const ids = sourceCache.get(cacheKey);

      sourceCache.delete(cacheKey);
      sourceCache.set(cacheKey, ids);

      return ids;
    }

    const filter = {
      url_pattern: pair.source_pattern,
      language_code: pair.language,
    };

    if (
      pair.source_admin_name !== undefined
    ) {
      filter.admin_name =
        pair.source_admin_name;
    }

    const ids = [];

    for await (const row of sourcePatterns.find(
      filter,
    )) {
      ids.push(patternId(row));
    }

    if (ids.length <= 1000) {
      while (
        sourceCache.size &&
        (
          sourceCache.size >= 256 ||
          cachedIds + ids.length > 5000
        )
      ) {
        const oldest =
          sourceCache.keys().next().value;

        cachedIds -=
          sourceCache.get(oldest).length;

        sourceCache.delete(oldest);
      }

      sourceCache.set(cacheKey, ids);
      cachedIds += ids.length;
    }

    return ids;
  }

  for await (const pair of local
    .collection('pairs')
    .find()) {
    const keywordKey = key(pair.keyword);

    for (const pid of await sourceIds(pair)) {
      const row = {
        _id: digest([pid, keywordKey]),
        patternId: pid,
        keyword: pair.keyword,
        keywordKey,
      };

      batch.push({
        updateOne: {
          filter: {
            _id: row._id,
          },
          update: {
            $set: row,
          },
          upsert: true,
        },
      });

      if (batch.length === 1000) {
        await writeBatch('pairs', batch);
        batch = [];
      }
    }
  }

  if (batch.length) {
    await writeBatch('pairs', batch);
  }

  console.log(
    '[Dataset] Rebuilding indexes...',
  );

  await compactIndexes(db);

  return {
    patterns: await db
      .collection('patterns')
      .countDocuments(),
    keywords: await db
      .collection('pairs')
      .countDocuments(),
  };
}

async function restore(db, state) {
  if (
    !matchesDatabase(
      db,
      state.databaseFingerprint,
    )
  ) {
    throw Error(
      'Recovery backup belongs to a different database. Restore the previous MONGODB_URI before recovering.',
    );
  }

  const local = openLocal(
    state.backupId,
    { existing: true },
  );

  try {
    await install(
      db,
      local,
      state.backupMetadata?.revision ||
        'empty',
    );

    if (state.backupMetadata) {
      await db
        .collection('metadata')
        .replaceOne(
          { _id: 'active' },
          {
            ...state.backupMetadata,
            schemaVersion: 2,
          },
          { upsert: true },
        );
    } else {
      await db
        .collection('metadata')
        .deleteOne({
          _id: 'active',
        });
    }

    await fs.unlink(maintenancePath);
  } finally {
    local.close();
  }
}

export async function recoverReplacement(db) {
  const state = await replacementState();

  if (!state) return;

  const active = await db
    .collection('metadata')
    .findOne({ _id: 'active' });

  if (
    !matchesDatabase(
      db,
      state.databaseFingerprint,
    )
  ) {
    const expected = [
      state.backupMetadata?.revision,
      state.newRevision,
    ].filter(Boolean);

    if (
      !active?.revision ||
      !expected.includes(active.revision)
    ) {
      throw Error(
        'Recovery cannot verify this database. Restore the original MONGODB_URI. Keep backend/storage unchanged.',
      );
    }

    state.databaseFingerprint =
      databaseFingerprint(db);

    await manifest(state);
  }

  if (
    state.phase === 'committed' &&
    active?.revision === state.newRevision
  ) {
    await fs.unlink(maintenancePath);

    console.log(
      '[Recovery] Completed replacement confirmed.',
    );

    return;
  }

  console.log(
    'Restoring the previous dataset from its local backup...',
  );

  await restore(db, state);

  console.log(
    '[Recovery] Previous dataset restored successfully.',
  );
}

export async function replaceDataset(
  db,
  sourceId,
  metadata,
  { failAfterClear = false } = {},
) {
  if (await replacementState()) {
    throw Error(
      'An interrupted replacement needs recovery. Restart the backend first.',
    );
  }

  const local = openLocal(
    sourceId,
    { existing: true },
  );

  if (
    await local
      .collection('patterns')
      .countDocuments({
        _alignment_issue: {
          $exists: true,
        },
      })
  ) {
    local.close();

    throw Error(
      'Unresolved workbook alignment errors remain. Correct the flagged language rows and re-upload before replacing shared data.',
    );
  }

  try {
    if (
      !(await local
        .collection('patterns')
        .countDocuments())
    ) {
      throw Error(
        'The preview contains no pattern rows',
      );
    }

    const state = {
      ...(await makeBackup(db)),
      newRevision: sourceId,
      phase: 'replacing',
    };

    await manifest(state);

    try {
      if (failAfterClear) {
        await clearActiveCollections(db);

        throw Error(
          'Injected replacement failure',
        );
      }

      const counts = await install(
        db,
        local,
        sourceId,
      );

      await db
        .collection('metadata')
        .replaceOne(
          { _id: 'active' },
          {
            _id: 'active',
            ...metadata,
            revision: sourceId,
            total_rows: counts.patterns,
            schemaVersion: 2,
            updated_at: new Date(),
          },
          { upsert: true },
        );

      await manifest({
        ...state,
        phase: 'committed',
      });

      await fs.unlink(maintenancePath);

      // Retain one verified backup on local disk.
      for (const name of await fs.readdir(
        storage,
      )) {
        if (
          /^backup-.*\.sqlite$/.test(name) &&
          name !==
            state.backupId + '.sqlite'
        ) {
          await fs
            .unlink(
              path.join(storage, name),
            )
            .catch(() => {});
        }
      }

      return counts;
    } catch (error) {
      try {
        await restore(db, state);
      } catch (recovery) {
        throw Error(
          `Replacement failed (${error.message}); automatic recovery also failed (${recovery.message}). Keep backend/storage intact and restart after fixing database access.`,
        );
      }

      throw Error(
        'Replacement failed; the previous dataset was restored. ' +
          error.message,
      );
    }
  } finally {
    local.close();
  }
}

export async function activateDataset(
  db,
  job,
) {
  const source = await db
    .collection('jobs')
    .findOne({
      _id: job.input.sourceJob,
      owner: job.owner,
      kind: 'import',
      status: 'preview',
    });

  if (!source) {
    throw Error(
      'Import preview is unavailable',
    );
  }

  const counts = await replaceDataset(
    db,
    source._id,
    {
      filename: source.result.filename,
      file_date: source.result.fileDate,
      updated_by: job.owner,
    },
  );

  await db
    .collection('jobs')
    .updateOne(
      { _id: source._id },
      {
        $set: {
          status: 'completed',
          result: {
            ...source.result,
            replaced: true,
            activePatterns: counts.patterns,
            activeKeywords: counts.keywords,
          },
        },
      },
    );

  return {
    ...counts,
    replaced: true,
  };
}

export async function optimizeStorage(db) {
  await recoverReplacement(db);

  const active = await db
    .collection('metadata')
    .findOne({ _id: 'active' });

  const sourceId =
    'optimize-' + randomUUID();

  if (active) {
    await makeBackup(db, sourceId);

    const counts = await replaceDataset(
      db,
      sourceId,
      {
        filename: active.filename,
        file_date: active.file_date,
        updated_by:
          'storage optimization',
      },
    );

    await fs
      .unlink(
        path.join(
          storage,
          sourceId + '.sqlite',
        ),
      )
      .catch(() => {});

    return {
      ...counts,
      activeDatasetPreserved: true,
    };
  }

  const archiveId =
    'archive-' + randomUUID();

  const archive = openLocal(archiveId);

  let archived = 0;

  try {
    for (const name of [
      'patterns',
      'pairs',
      'scratch',
      'jobRows',
    ]) {
      let batch = [];

      for await (const row of db
        .collection(name)
        .find()
        .batchSize(500)) {
        batch.push(row);
        archived++;

        if (batch.length === 500) {
          await archive
            .collection(name)
            .insertMany(batch);

          batch = [];
        }
      }

      if (batch.length) {
        await archive
          .collection(name)
          .insertMany(batch);
      }
    }
  } finally {
    archive.close();
  }

  await clearActiveCollections(db);

  return {
    patterns: 0,
    keywords: 0,
    archived,
    archiveId,
    activeDatasetPreserved: true,
  };
}