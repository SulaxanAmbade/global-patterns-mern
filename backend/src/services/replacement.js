import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openLocal, localPath } from './localStore.js';
import { DatabaseSync } from 'node:sqlite';
import { storage } from '../config.js';
import { expandedPairs } from './pairStore.js';
import { auditPattern } from './performance.js';
import { key, words } from './normalize.js';

const BATCH_SIZE = 5000;

export const maintenancePath = path.join(
  storage,
  'replacement-state.json',
);

const digest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');

// Keep database identity stable when SRV host order changes.
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
  if (fingerprint === databaseFingerprint(db)) {
    return true;
  }

  // Support manifests from the older fingerprint implementation.
  const hosts = (db.client.options.hosts || []).map(String);
  const srv = db.client.options.srvHost || '';

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
        digest([db.databaseName, srv, prefix])
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
      await fs.readFile(maintenancePath, 'utf8'),
    );
  } catch (error) {
    if (error.code === 'ENOENT') return null;
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

export async function makeBackup(db, requestedId) {
  const metadata = await db
    .collection('metadata')
    .findOne({ _id: 'active' });

  const id = requestedId || 'backup-' + randomUUID();
  const local = openLocal(id);

  let patternCount = 0;
  let keywordCount = 0;

  const compact = metadata?.schemaVersion === 2;

  console.log(
    '[Dataset] Backing up the current dataset...',
  );

  try {
    if (metadata) {
      let batch = [];

      for await (const row of db
        .collection('patterns')
        .find({ revision: metadata.revision })
        .batchSize(BATCH_SIZE)) {
        batch.push(row);
        patternCount++;

        if (batch.length >= BATCH_SIZE) {
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

      // Compact pairs need no join or repeated source metadata.
      const cursor = compact
        ? db
            .collection('pairs')
            .find({})
            .batchSize(BATCH_SIZE)
        : expandedPairs(db, metadata);

      for await (const row of cursor) {
        batch.push(row);
        keywordCount++;

        if (batch.length >= BATCH_SIZE) {
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
      throw Error('Backup count verification failed');
    }
  } finally {
    local.close();
  }

  console.log(
    `[Dataset] Verified backup: ${patternCount} patterns, ${keywordCount} pairs.`,
  );

  return {
    databaseFingerprint: databaseFingerprint(db),
    backupId: id,
    backupMetadata: metadata,
    backupPatterns: patternCount,
    backupKeywords: keywordCount,
    backupPairsFormat: compact
      ? 'compact-v2'
      : 'expanded',
  };
}

async function clearActiveCollections(db) {
  // Preserve sessions, jobs and metadata.
  for (const name of ['patterns', 'pairs']) {
    await db.collection(name).deleteMany({});

    await db
      .collection(name)
      .dropIndexes()
      .catch((error) => {
        if (error.code !== 26) throw error;
      });
  }

  // Remove obsolete MongoDB processing collections.
  for (const name of ['scratch', 'jobRows']) {
    await db
      .collection(name)
      .drop()
      .catch((error) => {
        if (error.code !== 26) throw error;
      });
  }
}

export async function compactIndexes(db) {
  await db.collection('patterns').createIndex({
    revision: 1,
    length: -1,
    _id: 1,
  });

  await db.collection('patterns').createIndex({
    aliases: 1,
    language_code: 1,
  });

  await db.collection('pairs').createIndex({
    patternId: 1,
    keywordKey: 1,
  });
}

function compactPattern(row, revision) {
  return {
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
}

async function* compactPairs(local) {
  const patterns = local.collection('patterns');
  const cache = new Map();

  let cachedIds = 0;

  for await (const pair of local
    .collection('pairs')
    .find()) {
    const raw =
      pair.source_pattern === undefined &&
      pair.patternId !== undefined;

    const cacheKey = raw
      ? JSON.stringify(['id', pair.patternId])
      : JSON.stringify([
          'source',
          pair.source_pattern,
          pair.language,
          pair.source_admin_name !== undefined,
          pair.source_admin_name,
        ]);

    let ids;

    if (cache.has(cacheKey)) {
      ids = cache.get(cacheKey);
      cache.delete(cacheKey);
      cache.set(cacheKey, ids);
    } else {
      const filter = raw
        ? { _id: pair.patternId }
        : {
            url_pattern: pair.source_pattern,
            language_code: pair.language,
            ...(pair.source_admin_name !== undefined
              ? {
                  admin_name:
                    pair.source_admin_name,
                }
              : {}),
          };

      ids = [];

      for await (const row of patterns.find(filter)) {
        ids.push(patternId(row));
      }

      if (ids.length <= 1000) {
        while (
          cache.size &&
          (
            cache.size >= 256 ||
            cachedIds + ids.length > 5000
          )
        ) {
          const first = cache.keys().next().value;

          cachedIds -= cache.get(first).length;
          cache.delete(first);
        }

        cache.set(cacheKey, ids);
        cachedIds += ids.length;
      }
    }

    const keywordKey = key(pair.keyword);

    for (const pid of ids) {
      yield {
        _id: digest([pid, keywordKey]),
        patternId: pid,
        keyword: pair.keyword,
        keywordKey,
      };
    }
  }
}

async function writeRemote(db, name, rows) {
  if (!rows.length) return;

  await db.collection(name).bulkWrite(
    rows.map((row) => ({
      updateOne: {
        filter: { _id: row._id },
        update: { $set: row },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

async function install(
  db,
  local,
  revision,
  { rawBackup = false } = {},
) {
  console.log(
    '[Dataset] Full installation: clearing incomplete records...',
  );

  await clearActiveCollections(db);

  for (const name of ['patterns', 'pairs']) {
    let batch = [];
    let count = 0;

    const cursor =
      name === 'patterns' || rawBackup
        ? local.collection(name).find()
        : compactPairs(local);

    for await (const source of cursor) {
      const row = rawBackup
        ? source
        : name === 'patterns'
          ? compactPattern(source, revision)
          : source;

      batch.push(row);

      if (batch.length >= BATCH_SIZE) {
        await writeRemote(db, name, batch);

        count += batch.length;
        batch = [];

        console.log(
          `[Dataset] ${name}: ${count} processed`,
        );
      }
    }

    if (batch.length) {
      await writeRemote(db, name, batch);
    }
  }

  console.log('[Dataset] Building indexes...');

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

// Compare disk-backed snapshots instead of keeping them in RAM.
async function preparePlan(
  source,
  state,
  revision,
) {
  const id = state.backupId + '-delta';
  const target = openLocal(id);

  try {
    for (const name of ['patterns', 'pairs']) {
      let batch = [];

      const cursor =
        name === 'patterns'
          ? source.collection(name).find()
          : compactPairs(source);

      for await (const row of cursor) {
        batch.push(
          name === 'patterns'
            ? compactPattern(row, revision)
            : row,
        );

        if (batch.length >= BATCH_SIZE) {
          await target
            .collection(name)
            .insertMany(batch);

          batch = [];
        }
      }

      if (batch.length) {
        await target
          .collection(name)
          .insertMany(batch);
      }
    }
  } finally {
    target.close();
  }

  const db = new DatabaseSync(localPath(id));

  try {
    db.exec(
      'PRAGMA busy_timeout=10000; ' +
      'PRAGMA cache_size=-8192; ' +
      'PRAGMA temp_store=FILE;',
    );

    db.prepare(
      'ATTACH DATABASE ? AS previous',
    ).run(localPath(state.backupId));

    db.exec(`
      CREATE TABLE delta (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        payload TEXT,
        PRIMARY KEY(kind,id)
      );
      BEGIN;
    `);

    try {
      for (const name of ['patterns', 'pairs']) {
        const fields =
          name === 'patterns'
            ? [
                'url_pattern',
                'url_pattern_id',
                'priority',
                'language_code',
                'admin_name',
                'updated_admin_id',
                'domain',
                'basis',
                'normalized',
                'length',
                'aliases',
              ]
            : [
                'patternId',
                'keyword',
                'keywordKey',
              ];

        const differs = fields
          .map(
            (field) =>
              `json_extract(t.payload,'$.${field}') ` +
              `IS NOT json_extract(p.payload,'$.${field}')`,
          )
          .join(' OR ');

        db.exec(`
          INSERT INTO delta
          SELECT
            '${name}-upsert',
            t.id,
            t.payload
          FROM main.${name} t
          LEFT JOIN previous.${name} p
            ON t.id=p.id
          WHERE p.id IS NULL OR ${differs};

          INSERT INTO delta
          SELECT
            '${name}-delete',
            p.id,
            NULL
          FROM previous.${name} p
          LEFT JOIN main.${name} t
            ON p.id=t.id
          WHERE t.id IS NULL;
        `);
      }

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    db.exec('DETACH DATABASE previous');

    const changes = {};

    for (const name of ['patterns', 'pairs']) {
      for (const operation of [
        'upsert',
        'delete',
      ]) {
        const kind = name + '-' + operation;

        changes[kind] = db.prepare(
          'SELECT count(*) AS n FROM delta WHERE kind=?',
        ).get(kind).n;
      }
    }

    const counts = {
      patterns: db.prepare(
        'SELECT count(*) AS n FROM patterns',
      ).get().n,
      keywords: db.prepare(
        'SELECT count(*) AS n FROM pairs',
      ).get().n,
    };

    return {
      id,
      db,
      changes,
      counts,
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

async function applyPlan(
  db,
  plan,
  state,
  revision,
) {
  // Release space occupied by removed records first.
  for (const name of ['pairs', 'patterns']) {
    let ids = [];

    const cursor = plan.db.prepare(
      'SELECT id FROM delta WHERE kind=? ORDER BY id',
    ).iterate(name + '-delete');

    for (const row of cursor) {
      ids.push(row.id);

      if (ids.length >= BATCH_SIZE) {
        await db.collection(name).deleteMany({
          _id: { $in: ids },
        });

        ids = [];
      }
    }

    if (ids.length) {
      await db.collection(name).deleteMany({
        _id: { $in: ids },
      });
    }
  }

  for (const name of ['patterns', 'pairs']) {
    let batch = [];
    let count = 0;

    const cursor = plan.db.prepare(
      'SELECT payload FROM delta WHERE kind=? ORDER BY id',
    ).iterate(name + '-upsert');

    for (const row of cursor) {
      batch.push(JSON.parse(row.payload));

      if (batch.length >= BATCH_SIZE) {
        await writeRemote(db, name, batch);

        count += batch.length;
        batch = [];

        console.log(
          `[Dataset] Changed ${name}: ${count} written`,
        );
      }
    }

    if (batch.length) {
      await writeRemote(db, name, batch);
      count += batch.length;
    }

    console.log(
      `[Dataset] ${name}: ${count} added/changed; ` +
      `${plan.changes[name + '-delete']} removed.`,
    );
  }

  // Promote retained patterns without re-sending their data.
  await db.collection('patterns').updateMany(
    {
      revision: state.backupMetadata.revision,
    },
    {
      $set: { revision },
    },
  );

  const counts = {
    patterns: await db
      .collection('patterns')
      .countDocuments(),
    keywords: await db
      .collection('pairs')
      .countDocuments(),
  };

  if (
    counts.patterns !== plan.counts.patterns ||
    counts.keywords !== plan.counts.keywords
  ) {
    throw Error(
      'Replacement count verification failed',
    );
  }

  // Preserve the existing indexes.
  return counts;
}

async function cleanupBackups(keep) {
  try {
    for (const name of await fs.readdir(storage)) {
      if (
        /^backup-.*\.sqlite$/.test(name) &&
        name !== keep + '.sqlite'
      ) {
        await fs
          .unlink(path.join(storage, name))
          .catch(() => {});
      }
    }
  } catch (error) {
    console.error(
      '[Dataset] Backup cleanup:',
      error.message,
    );
  }
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
      state.backupMetadata?.revision || 'empty',
      {
        rawBackup:
          state.backupPairsFormat === 'compact-v2',
      },
    );

    if (state.backupMetadata) {
      await db.collection('metadata').replaceOne(
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
        .deleteOne({ _id: 'active' });
    }

    await fs.unlink(maintenancePath);

    if (state.deltaId) {
      await fs
        .unlink(localPath(state.deltaId))
        .catch(() => {});
    }
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

    if (state.deltaId) {
      await fs
        .unlink(localPath(state.deltaId))
        .catch(() => {});
    }

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
  {
    failAfterClear = false,
    forceFull = false,
  } = {},
) {
  if (await replacementState()) {
    throw Error(
      'An interrupted replacement needs recovery. Restart the backend first.',
    );
  }

  const source = openLocal(
    sourceId,
    { existing: true },
  );

  let plan;
  let backup;

  const started = performance.now();
  const timings = {};

  try {
    if (
      await source
        .collection('patterns')
        .countDocuments({
          _alignment_issue: { $exists: true },
        })
    ) {
      throw Error(
        'Unresolved workbook alignment errors remain. Correct the flagged language rows and re-upload before replacing shared data.',
      );
    }

    if (
      !(await source
        .collection('patterns')
        .countDocuments())
    ) {
      throw Error(
        'The preview contains no pattern rows',
      );
    }

    backup = await makeBackup(db);

    timings.backupMs = Math.round(
      performance.now() - started,
    );

    const state = {
      ...backup,
      newRevision: sourceId,
      phase: 'replacing',
    };

    let canUpdate =
      !forceFull &&
      backup.backupPairsFormat === 'compact-v2';

    if (canUpdate) {
      const [
        patterns,
        scratch,
        jobRows,
      ] = await Promise.all([
        db.collection('patterns').countDocuments(),
        db.collection('scratch').countDocuments(),
        db.collection('jobRows').countDocuments(),
      ]);

      canUpdate =
        patterns === backup.backupPatterns &&
        scratch === 0 &&
        jobRows === 0;
    }

    const planningStarted = performance.now();

    if (canUpdate) {
      console.log(
        '[Dataset] Comparing the new dataset with the backup...',
      );

      plan = await preparePlan(
        source,
        state,
        sourceId,
      );

      state.deltaId = plan.id;

      console.log(
        '[Dataset] Planned changes:',
        JSON.stringify(plan.changes),
      );
    }

    timings.planMs = Math.round(
      performance.now() - planningStarted,
    );

    await manifest(state);

    try {
      if (failAfterClear) {
        await clearActiveCollections(db);

        throw Error(
          'Injected replacement failure',
        );
      }

      const writingStarted = performance.now();

      const counts = plan
        ? await applyPlan(
            db,
            plan,
            state,
            sourceId,
          )
        : await install(
            db,
            source,
            sourceId,
          );

      timings.writeMs = Math.round(
        performance.now() - writingStarted,
      );

      await db.collection('metadata').replaceOne(
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

      timings.totalMs = Math.round(
        performance.now() - started,
      );

      console.log(
        '[Dataset] Replacement complete:',
        JSON.stringify(timings),
      );

      await cleanupBackups(state.backupId);

      return {
        ...counts,
        mode: plan ? 'incremental' : 'full',
        changes: plan?.changes || null,
        timings,
      };
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
    source.close();

    if (plan) plan.db.close();

    if (backup) {
      await fs
        .unlink(
          localPath(backup.backupId + '-delta'),
        )
        .catch(() => {});
    }
  }
}

export async function activateDataset(db, job) {
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

  await db.collection('jobs').updateOne(
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
        updated_by: 'storage optimization',
      },
      { forceFull: true },
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