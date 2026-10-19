import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { importDataset } from '../../src/services/importDataset.js';
import {
  jobDatabase,
  openLocal,
  localPath,
} from '../../src/services/localStore.js';
import {
  optimizeStorage,
  replaceDataset,
  recoverReplacement,
  makeBackup,
  maintenancePath,
} from '../../src/services/replacement.js';
import { liveMappings } from '../../src/services/pairStore.js';
const client = new MongoClient(process.env.TEST_MONGODB_URI),
  db = client.db('storage_regression_' + randomUUID().replaceAll('-', ''));
await client.connect();
const records = Array.from({ length: 200 }, (_, i) => ({
  url_pattern: `*patternkeywords.global*topic${i}*health*`,
  url_pattern_id: String(i),
  priority: '1000',
  language_code: 'en',
  admin_name: 'Owner',
  updated_admin_id: '123',
  pattern_keywords: Array.from(
    { length: 20 },
    (_, j) => `Shop Topic ${i} Health Item ${j}`,
  ),
}));
async function logicalSize() {
  let n = 0;
  for (const name of ['patterns', 'pairs', 'scratch', 'jobRows']) {
    try {
      const s = await db.command({ collStats: name });
      n += s.size + s.totalIndexSize;
    } catch (e) {
      if (e.code !== 26) throw e;
    }
  }
  return n;
}
async function stage(rows) {
  const id = randomUUID(),
    file = path.join(process.env.STORAGE_DIR, 'stage-' + id + '.jsonl');
  await fs.writeFile(file, rows.map((r) => JSON.stringify(r)).join('\n'));
  const job = {
      _id: id,
      kind: 'import',
      upload: { path: file, originalname: 'fixture.jsonl' },
      input: { fileDate: null },
    },
    target = jobDatabase(db, job);
  try {
    await importDataset(target, job, async () => {});
  } finally {
    target.local.close();
    await fs.unlink(file);
  }
  return id;
}
async function activate(rows) {
  const id = await stage(rows);
  const out = await replaceDataset(db, id, {
    filename: 'fixture.jsonl',
    updated_by: 'test',
  });
  return { id, ...out };
}
try {
  // Populate the previous schema, two complete revisions, and temporary report rows.
  for (const revision of ['old', 'active']) {
    const patterns = [],
      pairs = [];
    for (let i = 0; i < records.length; i++) {
      const r = records[i],
        basis = `topic${i}*health`,
        pattern = {
          _id: revision + '-p-' + i,
          revision,
          ...r,
          domain: 'patternkeywords.global',
          basis,
          length: r.url_pattern.length,
          normalized: r.url_pattern.replaceAll('*', ' '),
        };
      delete pattern.pattern_keywords;
      patterns.push(pattern);
      for (let j = 0; j < 20; j++)
        pairs.push({
          _id: revision + '-k-' + i + '-' + j,
          revision,
          domain: pattern.domain,
          basis,
          basisKey: basis,
          aliases: [basis, r.url_pattern, pattern.domain + '*' + basis],
          keyword: r.pattern_keywords[j],
          keywordKey: r.pattern_keywords[j].toLowerCase(),
          language: 'en',
          source_pattern: r.url_pattern,
          source_admin_name: 'Owner',
          source_admin_id: '123',
        });
    }
    await db.collection('patterns').insertMany(patterns);
    await db.collection('pairs').insertMany(pairs);
  }
  await db
    .collection('pairs')
    .createIndex({ revision: 1, aliases: 1, keywordKey: 1, language: 1 });
  await db.collection('metadata').insertOne({
    _id: 'active',
    revision: 'active',
    filename: 'legacy.csv',
    total_rows: 200,
  });
  await db.collection('scratch').insertMany(
    Array.from({ length: 100 }, (_, i) => ({
      _id: String(i),
      jobId: 'legacy',
      text: 'temporary data '.repeat(50),
    })),
  );
  await db.collection('jobRows').insertMany(
    Array.from({ length: 100 }, (_, i) => ({
      _id: String(i),
      jobId: 'legacy',
      text: 'temporary result '.repeat(50),
    })),
  );
  const before = await logicalSize();
  await optimizeStorage(db);
  const optimized = await logicalSize();
  assert.equal(await db.collection('patterns').countDocuments(), 200);
  assert.equal(await db.collection('pairs').countDocuments(), 4000);
  assert.ok(optimized < before);
  const sizes = [],
    dataSizes = [];
  let last;
  for (let n = 0; n < 3; n++) {
    last = await activate(records);
    assert.equal(last.patterns, 200);
    assert.equal(last.keywords, 4000);
    assert.equal(
      (await db.collection('patterns').distinct('revision')).length,
      1,
    );
    const row = await db.collection('pairs').findOne();
    assert.deepEqual(
      Object.keys(row).sort(),
      ['_id', 'keyword', 'keywordKey', 'patternId'].sort(),
    );
    sizes.push(await logicalSize());
    let size = 0;
    for (const n of ['patterns', 'pairs'])
      size += (await db.command({ collStats: n })).size;
    dataSizes.push(size);
  }
  assert.equal(
    new Set(dataSizes).size,
    1,
    'Repeated identical replacements must have stable document data size',
  );
  assert.equal(
    (
      await liveMappings(
        db,
        last.id,
        'topic0*health',
        'shop topic 0 health item 0',
        'en',
      )
    ).length,
    1,
  );
  // Missing keywords retain only keyword mappings that are still live.
  const without = records.slice(0, 199).map(({ pattern_keywords, ...r }) => r);
  last = await activate(without);
  assert.equal(last.keywords, 3980);
  assert.equal(last.patterns, 199);
  assert.equal(
    await db
      .collection('patterns')
      .countDocuments({ basis: 'topic199*health' }),
    0,
  );
  // An explicit keyword column replaces, rather than appends to, the old mappings.
  const changed = records.slice(0, 199).map((r, i) =>
    i === 0
      ? {
          ...r,
          priority: '2000',
          pattern_keywords: ['New Health Keyword Online'],
        }
      : r,
  );
  last = await activate(changed);
  assert.equal(last.keywords, 3961);
  assert.equal(
    (
      await liveMappings(
        db,
        last.id,
        'topic0*health',
        'shop topic 0 health item 0',
        'en',
      )
    ).length,
    0,
  );
  await assert.rejects(
    () =>
      liveMappings(
        db,
        'old-revision',
        'topic0*health',
        'new health keyword online',
        'en',
      ),
    /shared dataset changed/,
  );
  const badAlignment = await stage([
    {
      url_pattern: '*example.com*health*',
      language_code: '18-10-2026',
      url_pattern_order: '4',
    },
  ]);
  await assert.rejects(
    () => replaceDataset(db, badAlignment, { filename: 'invalid-alignment' }),
    /Unresolved workbook alignment/,
  );
  assert.equal(await db.collection('patterns').countDocuments(), 199);
  const beforeFailure = await db
      .collection('metadata')
      .findOne({ _id: 'active' }),
    failedStage = await stage(records);
  await assert.rejects(
    () =>
      replaceDataset(
        db,
        failedStage,
        { filename: 'fail' },
        { failAfterClear: true },
      ),
    /previous dataset was restored/,
  );
  assert.equal(
    (await db.collection('metadata').findOne({ _id: 'active' })).revision,
    beforeFailure.revision,
  );
  assert.equal(await db.collection('pairs').countDocuments(), 3961);
  // Simulate a process stopping after the live data was cleared; restart recovery restores it.
  const backup = await makeBackup(db);
  await fs.writeFile(
    maintenancePath,
    JSON.stringify({
      ...backup,
      newRevision: 'interrupted',
      phase: 'replacing',
    }),
  );
  await db.collection('patterns').deleteMany({});
  await db.collection('pairs').deleteMany({});
  await recoverReplacement(db);
  assert.equal(await db.collection('patterns').countDocuments(), 199);
  assert.equal(await db.collection('pairs').countDocuments(), 3961);
  const empty = client.db('empty_storage_' + randomUUID().replaceAll('-', ''));
  try {
    await empty.collection('patterns').insertOne({
      _id: 'unfinished',
      revision: 'not-active',
      url_pattern: '*example.com*health*',
    });
    const result = await optimizeStorage(empty);
    assert.equal(result.archived, 1);
    assert.equal(await empty.collection('patterns').countDocuments(), 0);
    assert.equal(
      await empty.collection('metadata').findOne({ _id: 'active' }),
      null,
    );
  } finally {
    await empty.dropDatabase();
  }
  const report = {
    legacyLogicalBytes: before,
    optimizedLogicalBytes: optimized,
    reductionPercent: +((1 - optimized / before) * 100).toFixed(1),
    identicalUploadDataBytes: dataSizes,
    identicalUploadDataAndIndexBytes: sizes,
    recordsAfterRepeatedUpload: 200,
    keywordsAfterRepeatedUpload: 4000,
  };
  console.log('STORAGE PASS', JSON.stringify(report));
} finally {
  await db.dropDatabase();
  await client.close();
}
