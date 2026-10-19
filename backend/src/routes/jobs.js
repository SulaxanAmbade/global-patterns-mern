import { validLanguage, languageCode } from '../services/alignment.js';
import { coverageReportRoutes } from '../services/coverageReports.js';
import { openLocal } from '../services/localStore.js';
import { liveMappings } from '../services/pairStore.js';
import { Router } from 'express';
import { enqueue } from '../services/jobs.js';
import { active } from './dataset.js';
import { sendCSV, csvCell, outputValue } from '../services/files.js';
import { text, key, priority } from '../services/normalize.js';
import { auditPattern } from '../services/performance.js';
import { once } from 'node:events';
export const jobs = Router();
async function owned(req) {
  const j = await req.app.locals.db
    .collection('jobs')
    .findOne({ _id: req.params.id, owner: req.user });
  if (!j) throw Object.assign(Error('Job not found'), { status: 404 });
  return j;
}
export function jobRoutes(upload) {
  jobs.post('/:kind', upload, async (req, res) => {
    if (!['coverage', 'performance'].includes(req.params.kind))
      throw Error('Invalid job type');
    const options = JSON.parse(req.body.options || '{}'),
      db = req.app.locals.db,
      m = await active(db);
    if (!req.file && options.sourceJob) {
      const src = await db.collection('jobs').findOne({
        _id: options.sourceJob,
        owner: req.user,
        kind: 'coverage',
        status: 'completed',
      });
      if (!src) throw Error('Original coverage job is unavailable');
      req.file = src.upload;
    }
    if (!req.file) throw Error('Choose an input file');
    if (
      req.params.kind === 'coverage' &&
      (!Array.isArray(options.languages) || !options.languages.length)
    )
      throw Error('Select a language');
    res
      .status(202)
      .json(
        await enqueue(
          db,
          req.user,
          req.params.kind,
          { ...options, revision: m.revision },
          req.file,
        ),
      );
  });
}
jobs.get('/', async (req, res) =>
  res.json(
    await req.app.locals.db
      .collection('jobs')
      .find({ owner: req.user })
      .project({ upload: 0 })
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray(),
  ),
);
jobs.get('/:id', async (req, res) => {
  const j = await owned(req);
  const { upload, ...safe } = j;
  res.json(safe);
});
jobs.get('/:id/rows', async (req, res) => {
  const j = await owned(req);
  if (!['completed', 'preview'].includes(j.status))
    throw Error('Job results are not ready');
  const page = Math.max(1, parseInt(req.query.page) || 1),
    limit = 100;
  const local = openLocal(j._id, { existing: true });
  let rows;
  try {
    rows = await local
      .collection(j.kind === 'import' ? 'patterns' : 'jobRows')
      .find()
      .sort(j.kind === 'import' ? { length: -1, _id: 1 } : { seq: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .project({ matches: 0 })
      .toArray();
  } finally {
    local.close();
  }
  res.json({ rows, page, limit, total: j.result.rows ?? j.result.count });
});
coverageReportRoutes(jobs, owned);
const coverageColumns = [
  'URL',
  'URL Domain',
  'Language Code',
  'Coverage Status',
  'Matched Basis Count',
  'Matching Bases',
  'Priority',
  'Keyword Impressions',
  'Revenue',
];
jobs.get('/:id/export', async (req, res) => {
  const j = await owned(req);
  if (j.status !== 'completed' || j.kind !== 'coverage')
    throw Error('Coverage results are not ready');
  const local = openLocal(j._id, { existing: true });
  try {
    await sendCSV(
      res,
      local.collection('jobRows').find().sort({ seq: 1 }),
      coverageColumns,
      j.input.sourceJob ? 'priority_url_summary.csv' : 'url_summary.csv',
    );
  } finally {
    local.close();
  }
});
async function selectedMappings(req) {
  const job = await owned(req);
  if (job.kind !== 'performance' || job.status !== 'completed')
    throw Error('Performance results are not ready');
  const ids = req.body.selected;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 10000 ||
    ids.some((n) => !Number.isSafeInteger(n) || n < 0)
  )
    throw Error('Select 1–10000 pairs');
  const current = await req.app.locals.db
    .collection('metadata')
    .findOne({ _id: 'active' });
  if (current?.revision !== job.input.revision)
    throw Object.assign(
      Error('The shared dataset changed. Run the performance check again.'),
      { status: 409 },
    );
  const local = openLocal(job._id, { existing: true });
  let rows;
  try {
    rows = await local
      .collection('jobRows')
      .find({ seq: { $in: ids } })
      .toArray();
  } finally {
    local.close();
  }
  const unique = new Map();
  for (const row of rows)
    for (const m of row.matches) {
      if (m.issue)
        throw Error(
          `${m.basis}: ${m.issue}. Correct admin_name setid and re-import.`,
        );
      unique.set(
        JSON.stringify([m.domain, m.basis, m.keywords, m.languagecode]),
        m,
      );
    }
  return [...unique.values()];
}
async function writeRows(res, rows, columns, name) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.write('\ufeff' + columns.join(',') + '\r\n');
  for (const r of rows)
    if (!res.write(columns.map((c) => csvCell(outputValue(c, r[c]))).join(',') + '\r\n'))
      await once(res, 'drain');
  res.end();
}
jobs.post('/:id/deletion', async (req, res) =>
  writeRows(
    res,
    await selectedMappings(req),
    ['domain', 'basis', 'keywords', 'languagecode'],
    'keyword_deletion.csv',
  ),
);
jobs.post('/:id/replacements', async (req, res) => {
  const mappings = await selectedMappings(req);
  res.json(
    mappings.map((m) => ({
      domain: m.domain,
      basis: m.basis,
      keywords: '',
      languagecode: m.languagecode,
      rank: 1,
      priority: Number.isFinite(priority(m.priority))
        ? priority(m.priority)
        : m.domain.includes('promote')
          ? 1000
          : m.basis.includes('*')
            ? 8000
            : 10000,
    })),
  );
});
jobs.post('/:id/upload-sheet', async (req, res) => {
  const j = await owned(req),
    db = req.app.locals.db,
    rows = req.body.rows;
  if (j.kind !== 'performance' || j.status !== 'completed')
    throw Error('Invalid performance job');
  if (!Array.isArray(rows) || !rows.length || rows.length > 10000)
    throw Error('Select 1–10000 replacement rows');
  if (
    (await db.collection('metadata').findOne({ _id: 'active' }))?.revision !==
    j.input.revision
  )
    throw Object.assign(
      Error('The shared dataset changed. Run the performance check again.'),
      { status: 409 },
    );
  const domains = new Set(
      await db
        .collection('patterns')
        .distinct('domain', { revision: j.input.revision }),
    ),
    seen = new Set(),
    output = [];
  for (const r of rows) {
    const domain = text(r.domain),
      basis = text(r.basis),
      keywords = text(r.keywords),
      languagecode = languageCode(r.languagecode),
      p = priority(r.priority);
    if (
      !basis ||
      !keywords ||
      !validLanguage(languagecode)
    )
      throw Error(
        'Every replacement needs a basis, keyword and valid language code',
      );
    if (
      !domains.has(domain) &&
      !(
        /^patternkeywords\.global\.promote\.\d+\.setid$/.test(domain) &&
        [...domains].some((d) => d.startsWith('patternkeywords.global.promote'))
      )
    )
      throw Error('Choose an available domain');
    if (
      domain.startsWith('patternkeywords.global.') &&
      !domain.includes('.promote') &&
      domain !== 'patternkeywords.global.' + languagecode
    )
      throw Error('Language-specific domain must match language code');
    if (!Number.isSafeInteger(p))
      throw Error('Priority must be a nonnegative whole number');
    const identity = JSON.stringify([
      auditPattern(basis),
      languagecode,
      key(keywords),
    ]);
    if (
      seen.has(identity) ||
      (
        await liveMappings(
          db,
          j.input.revision,
          basis,
          key(keywords),
          languagecode,
        )
      ).length > 0
    )
      throw Error(
        'Keyword already exists under this basis/language or repeats a replacement',
      );
    seen.add(identity);
    output.push({
      domain,
      basis,
      keywords,
      languagecode,
      rank: 1,
      priority: p,
    });
  }
  await writeRows(
    res,
    output,
    ['domain', 'basis', 'keywords', 'languagecode', 'rank', 'priority'],
    'keyword_upload.csv',
  );
});

