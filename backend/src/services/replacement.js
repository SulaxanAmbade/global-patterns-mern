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

const digest = (v) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');

// SRV resolution can change host order between connections.
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
  if (fingerprint === databaseFingerprint(db)) return true;

  // Accept manifests written by the earlier host-order-dependent version.
  const hosts = (db.client.options.hosts || []).map(String);
  const srv = db.client.options.srvHost || '';

  if (fingerprint === digest([db.databaseName, srv, hosts])) {
    return true;
  }

  if (hosts.length > 6) return false;

  function visit(prefix, remaining) {
    if (!remaining.length) {
      return fingerprint === digest([
        db.databaseName,
        srv,
        prefix,
      ]);
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

const patternId = (r) =>
  digest([
    r.url_pattern,
    r.url_pattern_id,
    r.priority,
    r.language_code,
    r.admin_name,
    r.updated_admin_id,
  ]);

export async function replacementState() {
  try {
    return JSON.parse(
      await fs.readFile(maintenancePath, 'utf8'),
    );
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
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

// Retained for legacy recovery and explicit storage optimization.
// Normal shared-dataset replacement does not call this function.
export async function makeBackup(db, requestedId) {
  const metadata = await db
    .collection('metadata')
    .findOne({ _id: 'active' });

  const id = requestedId || 'backup-' + randomUUID();
  const local = openLocal(id);

  let pc = 0;
  let kc = 0;

  const compact = metadata?.schemaVersion === 2;

  console.log('[Dataset] Backing up the current dataset...');

  try {
    if (metadata) {
      let batch = [];

      for await (
        const row of db
          .collection('patterns')
          .find({ revision: metadata.revision })
          .batchSize(BATCH_SIZE)
      ) {
        batch.push(row);
        pc++;

        if (batch.length >= BATCH_SIZE) {
          await local.collection('patterns').insertMany(batch);
          batch = [];
        }
      }

      if (batch.length) {
        await local.collection('patterns').insertMany(batch);
      }

      batch = [];

      // Schema 2 pairs are already compact.
      const cursor = compact
        ? db.collection('pairs').find({}).batchSize(BATCH_SIZE)
        : expandedPairs(db, metadata);

      for await (const row of cursor) {
        batch.push(row);
        kc++;

        if (batch.length >= BATCH_SIZE) {
          await local.collection('pairs').insertMany(batch);
          batch = [];
        }
      }

      if (batch.length) {
        await local.collection('pairs').insertMany(batch);
      }
    }

    if (
      pc !== await local.collection('patterns').countDocuments() ||
      kc !== await local.collection('pairs').countDocuments()
    ) {
      throw Error('Backup count verification failed');
    }
  } finally {
    local.close();
  }

  console.log(
    `[Dataset] Verified backup: ${pc} patterns, ${kc} pairs.`,
  );

  return {
    databaseFingerprint: databaseFingerprint(db),
    backupId: id,
    backupMetadata: metadata,
    backupPatterns: pc,
    backupKeywords: kc,
    backupPairsFormat: compact ? 'compact-v2' : 'expanded',
  };
}

async function clearActiveCollections(db) {
  // Keep sessions, jobs and metadata.
  for (const name of ['patterns', 'pairs']) {
    await db.collection(name).deleteMany({});

    await db
      .collection(name)
      .dropIndexes()
      .catch((e) => {
        if (e.code !== 26) throw e;
      });
  }

  // Obsolete processing collections from earlier releases.
  for (const name of ['scratch', 'jobRows']) {
    await db
      .collection(name)
      .drop()
      .catch((e) => {
        if (e.code !== 26) throw e;
      });
  }
}

export async function compactIndexes(db) {
  await db
    .collection('patterns')
    .createIndex({ revision: 1, length: -1, _id: 1 });

  await db
    .collection('patterns')
    .createIndex({ aliases: 1, language_code: 1 });

  await db
    .collection('pairs')
    .createIndex({ patternId: 1, keywordKey: 1 });
}

function compactPattern(r, revision) {
  return {
    _id: patternId(r),
    url_pattern: r.url_pattern,
    url_pattern_id: r.url_pattern_id,
    priority: r.priority,
    language_code: r.language_code,
    admin_name: r.admin_name,
    updated_admin_id: r.updated_admin_id,
    domain: r.domain,
    basis: r.basis,
    normalized: r.normalized || words(r.url_pattern).join(' '),
    length: r.length || r.url_pattern.length,
    revision,
    aliases: [
      ...new Set(
        [
          r.basis,
          r.url_pattern,
          r.domain + '*' + r.basis,
        ].map(auditPattern),
      ),
    ],
  };
}

async function* compactPairs(local) {
  const patterns = local.collection('patterns');
  const cache = new Map();

  let cachedIds = 0;

  for await (const pair of local.collection('pairs').find()) {
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
              ? { admin_name: pair.source_admin_name }
              : {}),
          };

      ids = [];

      for await (const row of patterns.find(filter)) {
        ids.push(patternId(row));
      }

      if (ids.length <= 1000) {
        while (
          cache.size &&
          (cache.size >= 256 || cachedIds + ids.length > 5000)
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

        console.log(`[Dataset] ${name}: ${count} processed`);
      }
    }

    if (batch.length) {
      await writeRemote(db, name, batch);
    }
  }

  console.log('[Dataset] Building indexes...');
  await compactIndexes(db);

  return {
    patterns: await db.collection('patterns').countDocuments(),
    keywords: await db.collection('pairs').countDocuments(),
  };
}

// Keep only the incoming snapshot. Existing database rows are compared
// in batches and are never saved as a rollback backup.
async function preparePlan(source, remote, revision, compare) {
  const id = 'replacement-' + randomUUID();
  const db = new DatabaseSync(localPath(id));

  const changes = {};
  const timings = {};
  const started = performance.now();

  try {
    db.exec(`
      PRAGMA busy_timeout=10000;
      PRAGMA cache_size=-8192;
      PRAGMA temp_store=FILE;

      CREATE TABLE patterns(
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );

      CREATE TABLE pairs(
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );

      CREATE TABLE mapping(
        sourceId TEXT,
        url TEXT,
        language TEXT,
        admin TEXT,
        pid TEXT
      );

      CREATE TABLE seen(
        kind TEXT,
        id TEXT,
        PRIMARY KEY(kind,id)
      );

      CREATE TABLE delta(
        kind TEXT,
        id TEXT,
        payload TEXT,
        PRIMARY KEY(kind,id)
      );
    `);

    const putPattern = db.prepare(`
      INSERT INTO patterns VALUES(?,?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload
    `);

    const putMapping = db.prepare(`
      INSERT INTO mapping VALUES(?,?,?,?,?)
    `);

    let pending = 0;

    db.exec('BEGIN');

    try {
      for await (
        const row of source.collection('patterns').find()
      ) {
        const compact = compactPattern(row, revision);

        putPattern.run(
          compact._id,
          JSON.stringify(compact),
        );

        putMapping.run(
          String(row._id),
          row.url_pattern ?? null,
          row.language_code ?? null,
          row.admin_name ?? null,
          compact._id,
        );

        if (++pending >= BATCH_SIZE) {
          db.exec('COMMIT; BEGIN');
          pending = 0;
        }
      }

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    db.exec(`
      CREATE INDEX mapping_source
      ON mapping(url,language,admin);

      CREATE INDEX mapping_id
      ON mapping(sourceId);
    `);

    const byId = db.prepare(`
      SELECT pid FROM mapping WHERE sourceId=?
    `);

    const bySource = db.prepare(`
      SELECT pid FROM mapping
      WHERE url IS ? AND language IS ?
    `);

    const byAdmin = db.prepare(`
      SELECT pid FROM mapping
      WHERE url IS ? AND language IS ? AND admin IS ?
    `);

    const putPair = db.prepare(`
      INSERT INTO pairs VALUES(?,?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload
    `);

    // Cache only compact IDs. Pattern hashes are computed once above.
    const cache = new Map();
    let cachedIds = 0;

    pending = 0;
    db.exec('BEGIN');

    try {
      for await (
        const pair of source.collection('pairs').find()
      ) {
        const raw =
          pair.source_pattern === undefined &&
          pair.patternId !== undefined;

        const cacheKey = JSON.stringify(
          raw
            ? ['id', pair.patternId]
            : [
                'source',
                pair.source_pattern,
                pair.language,
                pair.source_admin_name !== undefined,
                pair.source_admin_name,
              ],
        );

        let ids = cache.get(cacheKey);

        if (!ids) {
          const matches = raw
            ? byId.all(String(pair.patternId))
            : pair.source_admin_name !== undefined
              ? byAdmin.all(
                  pair.source_pattern ?? null,
                  pair.language ?? null,
                  pair.source_admin_name ?? null,
                )
              : bySource.all(
                  pair.source_pattern ?? null,
                  pair.language ?? null,
                );

          ids = matches.map((row) => row.pid);

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
          const row = {
            _id: digest([pid, keywordKey]),
            patternId: pid,
            keyword: pair.keyword,
            keywordKey,
          };

          putPair.run(
            row._id,
            JSON.stringify(row),
          );

          if (++pending >= BATCH_SIZE) {
            db.exec('COMMIT; BEGIN');
            pending = 0;
          }
        }
      }

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    db.exec('DROP TABLE mapping');

    timings.prepareMs = Math.round(
      performance.now() - started,
    );

    const comparing = performance.now();

    if (compare) {
      for (const name of ['patterns', 'pairs']) {
        const fields = name === 'patterns'
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

        const get = db.prepare(`
          SELECT payload FROM ${name} WHERE id=?
        `);

        const seen = db.prepare(`
          INSERT OR IGNORE INTO seen VALUES(?,?)
        `);

        const delta = db.prepare(`
          INSERT OR REPLACE INTO delta VALUES(?,?,?)
        `);

        const projection = Object.fromEntries(
          ['_id', ...fields].map((field) => [field, 1]),
        );

        const cursor = remote
          .collection(name)
          .find({}, { projection })
          .batchSize(BATCH_SIZE);

        let batch = [];
        let scanned = 0;

        const flush = () => {
          db.exec('BEGIN');

          try {
            for (const old of batch) {
              const current = get.get(String(old._id));

              if (!current) {
                delta.run(
                  name + '-delete',
                  String(old._id),
                  null,
                );
              } else {
                seen.run(name, String(old._id));

                const row = JSON.parse(current.payload);

                const differs = fields.some(
                  (field) =>
                    JSON.stringify(row[field] ?? null) !==
                    JSON.stringify(old[field] ?? null),
                );

                if (differs) {
                  delta.run(
                    name + '-upsert',
                    String(old._id),
                    current.payload,
                  );
                }
              }
            }

            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }

          scanned += batch.length;
          batch = [];
        };

        for await (const row of cursor) {
          batch.push(row);

          if (batch.length >= BATCH_SIZE) {
            flush();
          }
        }

        if (batch.length) {
          flush();
        }

        db.prepare(`
          INSERT INTO delta
          SELECT ?,t.id,t.payload
          FROM ${name} t
          LEFT JOIN seen s
            ON s.kind=? AND s.id=t.id
          WHERE s.id IS NULL
        `).run(name + '-upsert', name);

        console.log(
          `[Dataset] Compared ${scanned} existing ${name}; no rollback backup created.`,
        );
      }
    }

    for (const name of ['patterns', 'pairs']) {
      for (const operation of ['upsert', 'delete']) {
        changes[name + '-' + operation] = db
          .prepare(`
            SELECT count(*) AS n
            FROM delta
            WHERE kind=?
          `)
          .get(name + '-' + operation).n;
      }
    }

    const counts = {
      patterns: db
        .prepare('SELECT count(*) AS n FROM patterns')
        .get().n,
      keywords: db
        .prepare('SELECT count(*) AS n FROM pairs')
        .get().n,
    };

    timings.compareMs = Math.round(
      performance.now() - comparing,
    );

    db.exec('DROP TABLE seen');

    return {
      id,
      db,
      changes,
      counts,
      timings,
    };
  } catch (error) {
    db.close();

    await fs.unlink(localPath(id)).catch(() => {});

    throw error;
  }
}

async function applyPlan(db, plan, state, revision) {
  // Delete obsolete records first to release storage quota.
  for (const name of ['pairs', 'patterns']) {
    let ids = [];

    const cursor = plan.db.prepare(`
      SELECT id FROM delta
      WHERE kind=?
      ORDER BY id
    `).iterate(name + '-delete');

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

    const cursor = plan.db.prepare(`
      SELECT payload FROM delta
      WHERE kind=?
      ORDER BY id
    `).iterate(name + '-upsert');

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
      `[Dataset] ${name}: ${count} added/changed; ${
        plan.changes[name + '-delete']
      } removed.`,
    );
  }

  // Update retained patterns to the new active revision.
  await db.collection('patterns').updateMany(
    { revision: state.backupMetadata.revision },
    { $set: { revision } },
  );

  const counts = {
    patterns: await db.collection('patterns').countDocuments(),
    keywords: await db.collection('pairs').countDocuments(),
  };

  if (
    counts.patterns !== plan.counts.patterns ||
    counts.keywords !== plan.counts.keywords
  ) {
    throw Error('Replacement count verification failed');
  }

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
  if (!matchesDatabase(db, state.databaseFingerprint)) {
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
        rawBackup: state.backupPairsFormat === 'compact-v2',
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
      await db.collection('metadata').deleteOne({
        _id: 'active',
      });
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

// An interrupted no-backup update resumes the NEW snapshot.
// It cannot restore the previous dataset.
async function finishReplacement(db, plan, state) {
  let counts;

  if (state.mode === 'incremental') {
    counts = await applyPlan(
      db,
      plan,
      state,
      state.newRevision,
    );
  } else {
    const target = openLocal(
      state.deltaId,
      { existing: true },
    );

    try {
      counts = await install(
        db,
        target,
        state.newRevision,
        { rawBackup: true },
      );
    } finally {
      target.close();
    }

    if (
      counts.patterns !== state.counts.patterns ||
      counts.keywords !== state.counts.keywords
    ) {
      throw Error('Replacement count verification failed');
    }
  }

  await db.collection('metadata').replaceOne(
    { _id: 'active' },
    {
      _id: 'active',
      ...state.metadata,
      revision: state.newRevision,
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

  return counts;
}

export async function recoverReplacement(db) {
  const state = await replacementState();

  if (!state) return;

  if (state.noRollback) {
    if (!matchesDatabase(db, state.databaseFingerprint)) {
      throw Error(
        'Interrupted update belongs to another database. Restore the original MONGODB_URI.',
      );
    }

    const active = await db
      .collection('metadata')
      .findOne({ _id: 'active' });

    if (
      state.phase === 'committed' &&
      active?.revision === state.newRevision
    ) {
      await fs.unlink(maintenancePath);

      await fs
        .unlink(localPath(state.deltaId))
        .catch(() => {});

      return;
    }

    try {
      await fs.access(localPath(state.deltaId));
    } catch {
      throw Error(
        'The interrupted update has no rollback backup and its incoming snapshot is missing. Keep shared-data access blocked; restore the incoming snapshot before retrying.',
      );
    }

    const local = new DatabaseSync(
      localPath(state.deltaId),
    );

    try {
      console.log(
        '[Recovery] Resuming the new dataset; no previous-data backup exists.',
      );

      await finishReplacement(
        db,
        {
          db: local,
          counts: state.counts,
          changes: state.changes,
        },
        state,
      );
    } finally {
      local.close();
    }

    await fs
      .unlink(localPath(state.deltaId))
      .catch(() => {});

    console.log(
      '[Recovery] New dataset update completed.',
    );

    return;
  }

  // Compatibility with interrupted updates from older versions.
  const active = await db
    .collection('metadata')
    .findOne({ _id: 'active' });

  if (!matchesDatabase(db, state.databaseFingerprint)) {
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

    state.databaseFingerprint = databaseFingerprint(db);
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

// Used only by explicit storage optimization.
async function replaceWithBackup(
  db,
  sourceId,
  metadata,
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

  let backup;

  const started = performance.now();
  const timings = {};

  try {
    if (
      await source.collection('patterns').countDocuments({
        _alignment_issue: { $exists: true },
      })
    ) {
      throw Error(
        'Unresolved workbook alignment errors remain. Correct the flagged language rows and re-upload before replacing shared data.',
      );
    }

    if (
      !await source.collection('patterns').countDocuments()
    ) {
      throw Error('The preview contains no pattern rows');
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

    timings.planMs = 0;

    await manifest(state);

    try {
      const writingStarted = performance.now();

      const counts = await install(
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
        mode: 'full',
        changes: null,
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
  }
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
      'An interrupted update must finish first. Restart the backend to resume it.',
    );
  }

  const source = openLocal(
    sourceId,
    { existing: true },
  );

  const started = performance.now();

  let plan;
  let marked = false;
  let completed = false;

  try {
    if (
      await source.collection('patterns').countDocuments({
        _alignment_issue: { $exists: true },
      })
    ) {
      throw Error(
        'Unresolved workbook alignment errors remain. Correct the flagged language rows and re-upload before replacing shared data.',
      );
    }

    if (
      !await source.collection('patterns').countDocuments()
    ) {
      throw Error('The preview contains no pattern rows');
    }

    const active = await db
      .collection('metadata')
      .findOne({ _id: 'active' });

    let incremental =
      !forceFull && active?.schemaVersion === 2;

    if (incremental) {
      const [all, current, scratch, jobRows] =
        await Promise.all([
          db.collection('patterns').countDocuments(),
          db.collection('patterns').countDocuments({
            revision: active.revision,
          }),
          db.collection('scratch').countDocuments(),
          db.collection('jobRows').countDocuments(),
        ]);

      incremental =
        all === current &&
        scratch === 0 &&
        jobRows === 0;
    }

    console.log(
      '[Dataset] Preparing replacement without a rollback backup...',
    );

    const planningStarted = performance.now();

    plan = await preparePlan(
      source,
      db,
      sourceId,
      incremental,
    );

    const timings = {
      backupMs: 0,
      ...plan.timings,
      planMs: Math.round(
        performance.now() - planningStarted,
      ),
    };

    const state = {
      noRollback: true,
      databaseFingerprint: databaseFingerprint(db),
      backupMetadata: active,
      newRevision: sourceId,
      deltaId: plan.id,
      phase: 'replacing',
      mode: incremental ? 'incremental' : 'full',
      metadata,
      counts: plan.counts,
      changes: plan.changes,
    };

    console.log(
      '[Dataset] Planned changes:',
      JSON.stringify(plan.changes),
    );

    await manifest(state);
    marked = true;

    try {
      if (failAfterClear) {
        await clearActiveCollections(db);
        throw Error('Injected replacement failure');
      }

      const writingStarted = performance.now();

      const counts = await finishReplacement(
        db,
        plan,
        state,
      );

      completed = true;

      timings.writeMs = Math.round(
        performance.now() - writingStarted,
      );

      timings.totalMs = Math.round(
        performance.now() - started,
      );

      console.log(
        '[Dataset] Replacement complete:',
        JSON.stringify(timings),
      );

      return {
        ...counts,
        mode: state.mode,
        changes: incremental ? plan.changes : null,
        timings,
        rollbackBackup: false,
      };
    } catch (error) {
      throw Error(
        `Replacement paused (${error.message}). There is no rollback backup. Keep backend/storage intact and restart to resume the new dataset.`,
      );
    }
  } finally {
    source.close();

    if (plan) {
      plan.db.close();

      if (!marked || completed) {
        await fs
          .unlink(localPath(plan.id))
          .catch(() => {});
      }
    }
  }
}

export async function activateDataset(db, job) {
  const source = await db.collection('jobs').findOne({
    _id: job.input.sourceJob,
    owner: job.owner,
    kind: 'import',
    status: 'preview',
  });

  if (!source) {
    throw Error('Import preview is unavailable');
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

  const sourceId = 'optimize-' + randomUUID();

  if (active) {
    await makeBackup(db, sourceId);

    const counts = await replaceWithBackup(
      db,
      sourceId,
      {
        filename: active.filename,
        file_date: active.file_date,
        updated_by: 'storage optimization',
      },
    );

    await fs
      .unlink(path.join(storage, sourceId + '.sqlite'))
      .catch(() => {});

    return {
      ...counts,
      activeDatasetPreserved: true,
    };
  }

  // Archive incomplete legacy imports before explicit cleanup.
  const archiveId = 'archive-' + randomUUID();
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

      for await (
        const row of db.collection(name).find().batchSize(500)
      ) {
        batch.push(row);
        archived++;

        if (batch.length === 500) {
          await archive.collection(name).insertMany(batch);
          batch = [];
        }
      }

      if (batch.length) {
        await archive.collection(name).insertMany(batch);
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