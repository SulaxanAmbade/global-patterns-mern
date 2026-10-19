import { csvRows } from './files.js';
import { key, text, number, totalRow, splitPattern } from './normalize.js';
import { createHash } from 'node:crypto';
export const auditPattern = (v) => key(v).replace(/\\\*/g, '*');
export const metrics = [
  'rpm',
  'impressions',
  'revenue',
  'clicks',
  'ad_clicks',
  'l2r',
  'rpc',
];
export function conditions(input) {
  const minimum = number(input.minimum ?? 1000);
  if (!Number.isInteger(minimum))
    throw Error('Minimum impressions must be a whole number');
  const mode = input.mode || 'all';
  if (!['all', 'any'].includes(mode)) throw Error('Invalid match mode');
  const rules = input.rules ?? [
    { metric: 'rpm', operator: '<', target: 'average', value: 100 },
  ];
  if (!Array.isArray(rules) || rules.length > 30)
    throw Error('Use at most 30 conditions');
  for (const r of rules) {
    if (
      !metrics.includes(r.metric) ||
      !['<', '<=', '>', '>=', '=', '!='].includes(r.operator) ||
      !['fixed', 'average', 'percent'].includes(r.target)
    )
      throw Error('Invalid condition');
    if (r.target !== 'average') r.value = number(r.value);
  }
  return { minimum, mode, rules };
}
export function passes(row, averages, c) {
  const flags = c.rules.map((r) => {
    const a = row[r.metric],
      b =
        r.target === 'fixed'
          ? r.value
          : averages[r.metric] * (r.target === 'percent' ? r.value / 100 : 1);
    return {
      '<': a < b,
      '<=': a <= b,
      '>': a > b,
      '>=': a >= b,
      '=': a === b,
      '!=': a !== b,
    }[r.operator];
  });
  return (
    !flags.length ||
    (c.mode === 'all' ? flags.every(Boolean) : flags.some(Boolean))
  );
}
export function decorateDomain(domain, admin) {
  if (!/\.promote(?:\.|$)/i.test(domain)) return { domain, issue: '' };
  const ids = [
    ...new Set(
      [...text(admin).matchAll(/\bset[\s_-]*id\s*[:=]\s*(\d+)\b/gi)].map(
        (m) => m[1],
      ),
    ),
  ];
  return ids.length === 1
    ? {
        domain: domain.split(/(?<=\.promote)\./i)[0] + '.' + ids[0] + '.setid',
        issue: '',
      }
    : {
        domain,
        issue: ids.length
          ? 'Conflicting setid values in admin_name'
          : 'Missing setid in admin_name',
      };
}
export async function performance(db, job, progress) {
  const c = conditions(job.input),
    cols = job.input.columns || {};
  for (const f of ['basis', 'keyword', 'impressions', 'rpm'])
    if (!cols[f]) throw Error(`Map the ${f} column`);
  if (
    new Set(Object.values(cols).filter(Boolean)).size !==
    Object.values(cols).filter(Boolean).length
  )
    throw Error('Each column can only be mapped once');
  const used = new Set(['rpm', 'impressions', ...c.rules.map((r) => r.metric)]);
  if (used.has('rpc') && cols.clicks) used.add('clicks');
  for (const m of used)
    if (!cols[m]) throw Error(`Map the ${m} column to use that condition`);
  let ops = [],
    count = 0,
    removed = 0,
    checkedHeaders = false;
  for await (const row of csvRows(job.upload.path)) {
    if (!checkedHeaders) {
      for (const col of [
        cols.basis,
        cols.keyword,
        ...[...used].map((m) => cols[m]),
        cols.language,
        cols.domain,
      ].filter(Boolean))
        if (!Object.hasOwn(row, col))
          throw Error(`CSV column not found: ${col}`);
      checkedHeaders = true;
    }
    if (totalRow(row)) {
      removed++;
      continue;
    }
    if (Object.values(row).every((v) => !text(v))) continue;
    const basis = text(row[cols.basis]),
      keyword = text(row[cols.keyword]);
    if (!basis || !keyword) throw Error('Every row needs a basis and keyword');
    const lang = (text(row[cols.language]) || text(job.input.defaultLanguage)).toUpperCase(),
      domain = (text(row[cols.domain]) || text(job.input.defaultDomain));
    const values = {};
    for (const m of used) {
      values[m] = number(row[cols[m]], m);
      if (
        ['impressions', 'clicks', 'ad_clicks'].includes(m) &&
        !Number.isInteger(values[m])
      )
        throw Error(`${m} must be a whole number`);
    }
    const identity = JSON.stringify([
      auditPattern(basis),
      key(keyword),
      lang,
      domain,
    ]);
    const inc = { n: 1, impressions: values.impressions };
    for (const m of used) {
      if (m === 'impressions') continue;
      if (['revenue', 'clicks', 'ad_clicks'].includes(m)) inc[m] = values[m];
      else {
        inc['weighted_' + m] = values[m] * values.impressions;
        inc['reported_' + m] = values[m];
      }
    }
    if (used.has('rpc') && used.has('clicks'))
      inc.click_weighted_rpc = values.rpc * values.clicks;
    ops.push({
      updateOne: {
        filter: {
          jobId: job._id,
          key: createHash('sha256').update(identity).digest('hex'),
        },
        update: {
          $setOnInsert: {
            basis,
            keyword,
            bkey: auditPattern(basis),
            keywordKey: key(keyword),
            language: lang,
            domain,
          },
          $inc: inc,
        },
        upsert: true,
      },
    });
    count++;
    if (ops.length === 500) {
      await db.collection('scratch').bulkWrite(ops, { ordered: false });
      ops = [];
      await progress(count);
    }
  }
  if (ops.length)
    await db.collection('scratch').bulkWrite(ops, { ordered: false });
  let eligible = 0;
  for await (const row of db
    .collection('scratch')
    .find({ jobId: job._id, impressions: { $gte: c.minimum } })
    .batchSize(200)) {
    const set = { eligible: true };
    for (const m of used) {
      if (m === 'impressions') continue;
      if (['revenue', 'clicks', 'ad_clicks'].includes(m)) set[m] = row[m];
      else
        set[m] = row.impressions
          ? row['weighted_' + m] / row.impressions
          : row['reported_' + m] / row.n;
    }
    if (used.has('rpc') && row.clicks > 0)
      set.rpc = row.click_weighted_rpc / row.clicks;
    await db.collection('scratch').updateOne({ _id: row._id }, { $set: set });
    eligible++;
  }
  const averageFields = {};
  for (const m of used) averageFields[m] = { $avg: '$' + m };
  let seq = 0,
    batch = [];
  const cursor = db.collection('scratch').aggregate(
    [
      { $match: { jobId: job._id, eligible: true } },
      {
        $group: {
          _id: { basis: '$bkey', language: '$language', domain: '$domain' },
          ...averageFields,
        },
      },
    ],
    { allowDiskUse: true, batchSize: 100 },
  );
  for await (const average of cursor) {
    for await (const row of db
      .collection('scratch')
      .find({
        jobId: job._id,
        eligible: true,
        bkey: average._id.basis,
        language: average._id.language,
        domain: average._id.domain,
      })
      .batchSize(200)) {
      if (!passes(row, average, c)) continue;
      const out = {
        jobId: job._id,
        seq: seq++,
        basis: row.basis,
        keyword: row.keyword,
        language: row.language,
        domain: row.domain,
        'Basis Average RPM': average.rpm,
      };
      for (const m of used) out[m] = row[m];
      batch.push(out);
      if (batch.length === 500) {
        await db.collection('jobRows').insertMany(batch);
        batch = [];
        await progress(count + seq);
      }
    }
  }
  if (batch.length) await db.collection('jobRows').insertMany(batch);
  await db.collection('scratch').deleteMany({ jobId: job._id });
  return { rows: seq, eligible, removed, sourceRows: count, source: 'uploaded-csv', sharedDatasetRequired: false };
}

