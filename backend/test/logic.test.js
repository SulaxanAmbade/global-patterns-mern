import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMatcher } from '../src/services/matcher.js';
import {
  splitPattern,
  pattern,
  keywords,
  number,
} from '../src/services/normalize.js';
import {
  conditions,
  passes,
  decorateDomain,
} from '../src/services/performance.js';
import { csvCell, csvRows } from '../src/services/files.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const r = (basis, priority = 1000, language_code = 'en') => ({
  basis,
  priority,
  language_code,
});
test('domain split retains hostname in the basis', () => {
  assert.deepEqual(splitPattern('*patternkeywords.global*facty.com*health*'), [
    'patternkeywords.global',
    'facty.com*health',
  ]);
});
test('hostname basis only matches URLs containing that hostname and topic', () => {
  const m = buildMatcher([r('facty.com*health')]);
  assert.equal(m('https://facty.com/health').basis, 'facty.com*health');
  assert.equal(m('https://elsewhere.com/health'), null);
  assert.equal(m('https://facty.com/finance'), null);
});
test('wildcards, phrase adjacency, plural URL forms and exact locks', () => {
  const match = buildMatcher([r('bug*bite')]);
  assert.ok(match('https://example.com/bug-bites'));
  assert.ok(match('https://example.com/bug/itchy/bites'));
  assert.ok(
    buildMatcher([r('heart health')])('https://example.com/heart-health'),
  );
  assert.equal(
    buildMatcher([r('heart health')])('https://example.com/heart/and/health'),
    null,
  );
  assert.equal(buildMatcher([r('~bite~')])('https://example.com/bites'), null);
  assert.ok(buildMatcher([r('~bites~')])('https://example.com/bites'));
});
test('repeated fragments require repeated occurrences', () => {
  const m = buildMatcher([r('health*health')]);
  assert.equal(m('https://x.com/health'), null);
  assert.ok(m('https://x.com/health/health'));
});
test('priority precedes specificity; invalid and blank priorities catch last', () => {
  let m = buildMatcher([r('heart*health', 8000), r('health', 1000)]);
  assert.equal(m('https://x.com/heart-health').basis, 'health');
  m = buildMatcher([r('heart*health', 1000), r('health', 1000)]);
  assert.equal(m('https://x.com/heart-health').basis, 'heart*health');
  m = buildMatcher([r('heart*health', ''), r('health', 2000)]);
  assert.equal(m('https://x.com/heart-health').basis, 'health');
});
test('promote pattern strips suffix; export resolves setid', () => {
  assert.equal(
    pattern('patternkeywords.global.promote.123.setid', 'health'),
    '*patternkeywords.global.promote*health*',
  );
  assert.equal(
    decorateDomain('patternkeywords.global.promote', 'owner setid: 123').domain,
    'patternkeywords.global.promote.123.setid',
  );
  assert.ok(decorateDomain('patternkeywords.global.promote', 'owner').issue);
});
test('condition combinations and averages', () => {
  const row = { rpm: 10, clicks: 3 },
    avg = { rpm: 20 };
  const c = conditions({
    rules: [
      { metric: 'rpm', operator: '<', target: 'percent', value: 80 },
      { metric: 'clicks', operator: '>=', target: 'fixed', value: 5 },
    ],
  });
  assert.equal(passes(row, avg, c), false);
  assert.equal(passes(row, avg, { ...c, mode: 'any' }), true);
  assert.equal(passes(row, avg, { ...c, rules: [] }), true);
  assert.throws(() => conditions({ minimum: 1.2 }));
  assert.throws(() => conditions({ rules: [{ metric: 'other' }] }));
});
test('keyword parser and metrics reject invalid data', () => {
  assert.deepEqual(keywords('["One","Two"]'), ['One', 'Two']);
  assert.deepEqual(keywords('One;Two|Three\nFour'), [
    'One',
    'Two',
    'Three',
    'Four',
  ]);
  assert.throws(() => keywords('[broken'));
  assert.equal(number('$1,234.50'), 1234.5);
  assert.throws(() => number('-1'));
  assert.throws(() => number('abc'));
});
test('CSV formula injection protection and quoting', () => {
  assert.equal(csvCell('=CMD()'), "'=CMD()");
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(csvCell(10), '10');
});
test('UTF-16 TSV parsing is streamed', async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'gp-'));
  try {
    const f = path.join(d, 'in.tsv');
    await writeFile(
      f,
      Buffer.from('\ufeffURL\tRevenue\nhttps://x.com\t1\n', 'utf16le'),
    );
    const rows = [];
    for await (const row of csvRows(f)) rows.push(row);
    assert.deepEqual(rows, [{ URL: 'https://x.com', Revenue: '1' }]);
  } finally {
    await rm(d, { recursive: true });
  }
});
import { cleanAdmin, adminId, baseAdmin } from '../src/services/admins.js';
test('admin normalization retains exact integer IDs and strips lookup labels', () => {
  assert.equal(adminId('19,153.0'), '19153');
  assert.equal(adminId('999999999999999999.0'), '999999999999999999');
  assert.equal(cleanAdmin('  Name\u200b  Here '), 'Name Here');
  assert.equal(cleanAdmin('nan'), '');
  assert.equal(baseAdmin('Owner Name (setid: 123) (Lookup)'), 'Owner Name');
});

test('literal quotation marks in keyword text preserve TSV columns', async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'gp-quotes-'));
  try {
    const f = path.join(d, 'keywords.tsv');
    await writeFile(
      f,
      'url_pattern\tpattern_keywords\tlanguage_code\n*example.com*disk*\tFormatação de disquete de 3,5"\tpt\n',
    );
    const rows = [];
    for await (const row of csvRows(f)) rows.push(row);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].pattern_keywords, 'Formatação de disquete de 3,5"');
    assert.deepEqual(keywords(rows[0].pattern_keywords), [
      'Formatação de disquete de 3,5"',
    ]);
    assert.equal(rows[0].language_code, 'pt');
  } finally {
    await rm(d, { recursive: true });
  }
});

test('relaxed quotes still parse properly quoted CSV commas, quotes and newlines', async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'gp-csv-quotes-'));
  try {
    const f = path.join(d, 'keywords.csv');
    await writeFile(
      f,
      'url_pattern,pattern_keywords,language_code\n*example.com*disk*,"Formatação de disquete de 3,5""",pt\n*example.com*health*,"First keyword\nSecond keyword",en\n',
    );
    const rows = [];
    for await (const row of csvRows(f)) rows.push(row);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].pattern_keywords, 'Formatação de disquete de 3,5"');
    assert.deepEqual(keywords(rows[0].pattern_keywords), [
      'Formatação de disquete de 3,5"',
    ]);
    assert.equal(rows[0].language_code, 'pt');
    assert.equal(rows[1].pattern_keywords, 'First keyword\nSecond keyword');
    assert.equal(rows[1].language_code, 'en');
  } finally {
    await rm(d, { recursive: true });
  }
});

import {
  isStorageQuotaError,
  recordJobFailure,
} from '../src/services/storageErrors.js';
test('Atlas storage-quota errors are distinguished from other database errors', () => {
  assert.ok(
    isStorageQuotaError(
      new Error(
        'you are over your space quota, using 512 MB of 512 MB. Writes are blocked on your cluster.',
      ),
    ),
  );
  assert.equal(isStorageQuotaError(new Error('authentication failed')), false);
});
test('job failure reporting survives a second write blocked by Atlas quota', async () => {
  const db = {
    collection() {
      return {
        async updateOne() {
          throw new Error('you are over your space quota');
        },
      };
    },
  };
  assert.equal(
    await recordJobFailure(db, 'job', 'Worker stopped', true),
    false,
  );
});

import { openLocal, localPath } from '../src/services/localStore.js';
import { randomUUID } from 'node:crypto';
test('disk-backed reports aggregate, select, and paginate without MongoDB writes', async () => {
  const id = 'test-' + randomUUID(),
    local = openLocal(id);
  try {
    await local.collection('scratch').bulkWrite([
      {
        updateOne: {
          filter: { key: 'a' },
          update: {
            $setOnInsert: {
              basis: 'health',
              bkey: 'health',
              language: 'en',
              domain: '',
            },
            $inc: { impressions: 600 },
          },
          upsert: true,
        },
      },
      {
        updateOne: {
          filter: { key: 'a' },
          update: { $inc: { impressions: 400 } },
          upsert: true,
        },
      },
    ]);
    assert.equal(
      (await local.collection('scratch').findOne({ key: 'a' })).impressions,
      1000,
    );
    await local
      .collection('scratch')
      .updateMany({ key: 'a' }, { $set: { eligible: true, rpm: 10 } });
    const grouped = await local
      .collection('scratch')
      .aggregate([
        { $match: { eligible: true } },
        { $group: { _id: { basis: '$bkey' }, rpm: { $avg: '$rpm' } } },
      ])
      .toArray();
    assert.equal(grouped[0].rpm, 10);
    assert.equal(grouped[0]._id.basis, 'health');
    await local.collection('jobRows').insertMany([
      { seq: 0, matches: ['a'] },
      { seq: 1, matches: ['b'] },
    ]);
    assert.equal(
      (
        await local
          .collection('jobRows')
          .find({ seq: { $in: [1] } })
          .project({ matches: 0 })
          .toArray()
      )[0].seq,
      1,
    );
    assert.equal(
      (
        await local
          .collection('jobRows')
          .find()
          .sort({ seq: 1 })
          .skip(1)
          .limit(1)
          .toArray()
      ).length,
      1,
    );
  } finally {
    local.close();
    await rm(localPath(id), { force: true });
  }
});
