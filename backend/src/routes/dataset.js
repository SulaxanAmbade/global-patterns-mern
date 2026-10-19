import { validLanguage } from '../services/alignment.js';
import { Router } from 'express';
import { enqueue } from '../services/jobs.js';
import { words, text } from '../services/normalize.js';
import { sendCSV } from '../services/files.js';
export const dataset = Router();
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export async function active(db) {
  const m = await db.collection('metadata').findOne({ _id: 'active' });
  if (!m)
    throw Object.assign(Error('Import and activate a dataset first'), {
      status: 400,
    });
  return m;
}
export async function filters(req) {
  const m = await active(req.app.locals.db),
    q = { revision: m.revision };
  if (req.query.admin) q.admin_name = String(req.query.admin);
  const terms = String(req.query.q || '')
    .split(/[,\n]+/)
    .map(text)
    .filter(Boolean);
  if (terms.length > 100) throw Error('Use at most 100 search terms');
  if (terms.length)
    q.$or = terms.flatMap((t) =>
      req.query.mode === 'exact'
        ? [
            { url_pattern: { $regex: '^' + escape(t) + '$', $options: 'i' } },
            { basis: { $regex: '^' + escape(t) + '$', $options: 'i' } },
            {
              url_pattern_id: { $regex: '^' + escape(t) + '$', $options: 'i' },
            },
          ]
        : [
            {
              normalized: {
                $regex: words(t).map(escape).join('.*'),
                $options: 'i',
              },
            },
            { url_pattern_id: { $regex: escape(t), $options: 'i' } },
          ],
    );
  return q;
}
dataset.get('/meta', async (req, res) => {
  const db = req.app.locals.db,
    m = await db.collection('metadata').findOne({ _id: 'active' });
  if (!m)
    return res.json({ total_rows: 0, languages: [], admins: [], domains: [] });
  const [languages, admins, domains] = await Promise.all(
    ['language_code', 'admin_name', 'domain'].map((f) =>
      db.collection('patterns').distinct(f, { revision: m.revision }),
    ),
  );
  res.json({
    ...m,
    languages: [...new Set(languages.filter(validLanguage).map((language) => String(language).toLowerCase().replaceAll('_', '-')))].sort(),
    admins: admins.filter(Boolean).sort(),
    domains: domains.filter(Boolean).sort(),
  });
});
dataset.get('/', async (req, res) => {
  const q = await filters(req),
    page = Math.max(1, parseInt(req.query.page) || 1),
    limit = 100;
  const c = req.app.locals.db.collection('patterns');
  const [rows, total] = await Promise.all([
    c
      .find(q)
      .sort({ length: -1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    c.countDocuments(q),
  ]);
  res.json({ rows, total, page, limit });
});
dataset.get('/export', async (req, res) =>
  sendCSV(
    res,
    req.app.locals.db
      .collection('patterns')
      .find(await filters(req))
      .sort({ length: -1, _id: 1 })
      .batchSize(500),
    [
      'url_pattern',
      'url_pattern_id',
      'priority',
      'language_code',
      'admin_name',
      'updated_admin_id',
    ],
    'patterns.csv',
  ),
);
export function importRoute(upload) {
  dataset.post('/import', upload, async (req, res) => {
    if (!req.file) throw Error('Choose a dataset file');
    const input = JSON.parse(req.body.options || '{}');
    const m = req.file.originalname.match(/(\d{2})-(\d{2})-(\d{4})/);
    let date = m ? `${m[3]}-${m[2]}-${m[1]}` : null;
    if (
      date &&
      (!Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date)
    )
      date = null;
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    if (date !== today && !input.dateConfirmed)
      throw Error(
        'Filename date is missing or differs from today. Verify and tick the date confirmation.',
      );
    res
      .status(202)
      .json(
        await enqueue(
          req.app.locals.db,
          req.user,
          'import',
          { fileDate: date },
          req.file,
        ),
      );
  });
}
dataset.post('/activate/:id', async (req, res) => {
  const pending = await req.app.locals.db.collection('jobs').findOne({
    owner: req.user,
    kind: 'activate',
    'input.sourceJob': req.params.id,
    status: { $in: ['queued', 'running'] },
  });
  if (pending) return res.status(202).json(pending);
  const db = req.app.locals.db,
    job = await db.collection('jobs').findOne({
      _id: req.params.id,
      owner: req.user,
      kind: 'import',
      status: 'preview',
    });
  if (!job) throw Error('No import preview found');
  if (job.result.alignment?.blockingRows)
    throw Error(
      'Unresolved workbook alignment errors remain. Correct the flagged rows and re-upload.',
    );
  res
    .status(202)
    .json(
      await enqueue(db, req.user, 'activate', { sourceJob: job._id }, null),
    );
});
