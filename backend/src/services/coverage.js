import { csvRows } from './files.js';
import {
  splitPattern,
  key,
  words,
  text,
  number,
  totalRow,
  priority,
  fragments,
} from './normalize.js';
import { buildMatcher } from './matcher.js';
import { createHash } from 'node:crypto';
const sha = (s) => createHash('sha256').update(s).digest('hex');
export async function coverage(db, job, progress) {
  const { languages, excluded = [], custom = [], columns = {} } = job.input;
  if (!Array.isArray(languages) || !languages.length)
    throw Error('Select at least one language');
  const languageVariants = [...new Set(languages.flatMap((value) => {
    const lower = String(value).trim().toLowerCase().replaceAll('_', '-');
    return [lower, lower.toUpperCase(), lower.replaceAll('-', '_'), lower.replaceAll('-', '_').toUpperCase()];
  }))];
  const catalog = new Map();
  const exclusions = new Set(excluded.map(String));
  const add = (row) => {
    if (!row.basis || !fragments(row.basis).length || exclusions.has(row.basis))
      return;
    const k = JSON.stringify([row.language_code, fragments(row.basis)]);
    const prev = catalog.get(k);
    if (!prev || priority(row.priority) < priority(prev.priority))
      catalog.set(k, row);
  };
  for await (const r of db
    .collection('patterns')
    .find({ revision: job.input.revision, language_code: { $in: languageVariants } })
    .project({ basis: 1, language_code: 1, priority: 1 })
    .batchSize(500))
    add(r);
  for (const r of custom) {
    if (!text(r.basis)) continue;
    const p = priority(r.priority);
    if (!Number.isFinite(p))
      throw Error('Custom basis priority must be nonnegative');
    for (const language_code of languages)
      add({ basis: text(r.basis), priority: p, language_code });
  }
  const match = buildMatcher([...catalog.values()]);
  let count = 0,
    ops = [],
    checkedHeaders = false;
  const flush = async () => {
    if (ops.length) {
      await db.collection('scratch').bulkWrite(ops, { ordered: false });
      ops = [];
    }
    await progress(count);
  };
  for await (const row of csvRows(job.upload.path)) {
    if (!checkedHeaders) {
      for (const col of [
        columns.url || 'URL',
        columns.impressions,
        columns.revenue,
      ].filter(Boolean))
        if (!Object.hasOwn(row, col))
          throw Error(`CSV column not found: ${col}`);
      checkedHeaders = true;
    }
    if (totalRow(row)) continue;
    const url = text(row[columns.url || 'URL']);
    if (!url) continue;
    // Mongo-backed grouping avoids retaining all URLs or normalized URLs in memory.
    const impressions = number(
        columns.impressions === ''
          ? 0
          : row[columns.impressions || 'Keyword Impressions'] || 0,
        'Impressions',
      ),
      revenue = number(
        columns.revenue === '' ? 0 : row[columns.revenue || 'Revenue'] || 0,
        'Revenue',
      );
    ops.push({
      updateOne: {
        filter: { jobId: job._id, key: sha(url) },
        update: { $setOnInsert: { url }, $inc: { impressions, revenue } },
        upsert: true,
      },
    });
    count++;
    if (ops.length >= 500) await flush();
  }
  await flush();
  let seq = 0,
    batch = [],
    covered = 0;
  const caught = new Set();
  const details = new Map();
  const summary = {
    impressionsMapped: columns.impressions !== '',
    revenueMapped: columns.revenue !== '',
    totalImpressions: 0, coveredImpressions: 0,
    totalRevenue: 0, coveredRevenue: 0,
  };
  for await (const r of db
    .collection('scratch')
    .find({ jobId: job._id })
    .batchSize(500)) {
    const winner = match(r.url);
    let domain = '';
    try {
      domain = new URL(r.url.includes('://') ? r.url : 'https://' + r.url)
        .hostname;
    } catch {}
    if (winner) {
      covered++;
      caught.add(winner.basis);
      const id = JSON.stringify([winner.basis, String(winner.language_code).toUpperCase(), winner.priority]);
      details.set(id, {
        basis: winner.basis,
        language: String(winner.language_code).toUpperCase(),
        priority: Number.isFinite(priority(winner.priority)) ? priority(winner.priority) : null,
      });
      summary.coveredImpressions += r.impressions;
      summary.coveredRevenue += r.revenue;
    }
    summary.totalImpressions += r.impressions;
    summary.totalRevenue += r.revenue;
    batch.push({
      jobId: job._id,
      seq: seq++,
      URL: r.url,
      'URL Domain': domain,
      'Language Code': String(winner?.language_code || languages.join(', ')).toUpperCase(),
      Priority: winner && Number.isFinite(priority(winner.priority)) ? priority(winner.priority) : '',
      'Coverage Status': winner ? 'Covered' : 'No Matching Basis',
      'Matched Basis Count': winner ? 1 : 0,
      'Matching Bases': winner?.basis || 'No Matching Basis',
      'Keyword Impressions': r.impressions,
      Revenue: r.revenue,
    });
    if (batch.length >= 500) {
      await db.collection('jobRows').insertMany(batch);
      batch = [];
      await progress(count + seq);
    }
  }
  if (batch.length) await db.collection('jobRows').insertMany(batch);
  await db.collection('scratch').deleteMany({ jobId: job._id });
  return {
    rows: seq,
    covered,
    uncovered: seq - covered,
    caught: [...caught].sort(),
    caughtDetails: [...details.values()].sort((a, b) => a.basis.localeCompare(b.basis) || (a.priority ?? Infinity) - (b.priority ?? Infinity)),
    summary: {
      ...summary,
      coverageRate: summary.totalImpressions > 0 ? 100 * summary.coveredImpressions / summary.totalImpressions : null,
      revenueCoverageRate: summary.totalRevenue > 0 ? 100 * summary.coveredRevenue / summary.totalRevenue : null,
    },
    reportVersion: 2,
  };
}
