import { DatabaseSync } from 'node:sqlite';
import { access } from 'node:fs/promises';
import { once } from 'node:events';
import { localPath } from './localStore.js';
import { csvCell, outputValue } from './files.js';

const basisField = `json_extract(payload, '$."Matching Bases"')`;
const jobField = `json_extract(payload, '$.jobId')`;
const impressionsField = `json_extract(payload, '$."Keyword Impressions"')`;
const revenueField = `json_extract(payload, '$.Revenue')`;
const share = (value, total) => total > 0 ? 100 * value / total : null;

async function openReport(job) {
  if (job.kind !== 'coverage' || job.status !== 'completed')
    throw Object.assign(Error('Coverage results are not ready'), { status: 400 });
  if (job.result?.reportVersion !== 2)
    throw Object.assign(Error('Run coverage again to generate the coverage rate and pivot table.'), { status: 409 });
  const filename = localPath(job._id);
  try { await access(filename); }
  catch { throw Object.assign(Error('This report has expired. Run coverage again.'), { status: 410 }); }
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout=10000; PRAGMA cache_size=-8192; PRAGMA temp_store=FILE;');
    db.exec(`CREATE INDEX IF NOT EXISTS coverage_pivot_basis ON jobRows(${jobField},${basisField},json_extract(payload,'$.seq'))`);
    return db;
  } catch (error) { db.close(); throw error; }
}
function values(row, totals) {
  const impressions = Number(row.impressions || 0), revenue = Number(row.revenue || 0);
  return {
    impressions, revenue,
    impressionsPercent: share(impressions, totals.totalImpressions),
    revenuePercent: share(revenue, totals.totalRevenue),
  };
}
function groupSQL() {
  return `SELECT ${basisField} AS basis, count(*) AS urls,
    sum(${impressionsField}) AS impressions, sum(${revenueField}) AS revenue
    FROM jobRows WHERE ${jobField}=? GROUP BY ${basisField}`;
}
export async function coveragePivot(job, { basis, page = 1 } = {}) {
  const db = await openReport(job);
  try {
    page = Math.max(1, Math.trunc(Number(page)) || 1);
    const limit = 100, offset = (page - 1) * limit, totals = job.result.summary;
    if (basis !== undefined) {
      const total = db.prepare(`SELECT count(*) AS n FROM jobRows WHERE ${jobField}=? AND ${basisField}=?`).get(job._id, basis).n;
      const rows = db.prepare(`SELECT payload FROM jobRows WHERE ${jobField}=? AND ${basisField}=? ORDER BY json_extract(payload,'$.seq') LIMIT ? OFFSET ?`).all(job._id, basis, limit, offset).map(({ payload }) => {
        const row = JSON.parse(payload);
        return {
          url: row.URL, language: String(row['Language Code'] || '').toUpperCase(), priority: row.Priority,
          ...values({ impressions: row['Keyword Impressions'], revenue: row.Revenue }, totals),
        };
      });
      return { rows, total, page, limit, basis };
    }
    const total = db.prepare(`SELECT count(*) AS n FROM (${groupSQL()})`).get(job._id).n;
    const rows = db.prepare(groupSQL() + ' ORDER BY impressions DESC,basis LIMIT ? OFFSET ?').all(job._id, limit, offset).map((row) => ({ basis: row.basis, urls: row.urls, ...values(row, totals) }));
    return { rows, total, page, limit, totals };
  } finally { db.close(); }
}
export async function exportCoveragePivot(job, res) {
  const db = await openReport(job);
  try {
    const totals = job.result.summary;
    const columns = ['Row Type', 'Matching Basis', 'URL', 'Language Code', 'Priority', 'Keyword Impressions', 'Keyword Impressions %', 'Revenue', 'Revenue %'];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="coverage_pivot.csv"');
    const write = async (row) => {
      if (!res.write(columns.map((c) => csvCell(outputValue(c, row[c]))).join(',') + '\r\n')) await once(res, 'drain');
    };
    res.write('\ufeff' + columns.map(csvCell).join(',') + '\r\n');
    const metrics = (impressions, revenue) => ({
      'Keyword Impressions': impressions,
      'Keyword Impressions %': share(impressions, totals.totalImpressions),
      Revenue: revenue, 'Revenue %': share(revenue, totals.totalRevenue),
    });
    const children = db.prepare(`SELECT payload FROM jobRows WHERE ${jobField}=? AND ${basisField}=? ORDER BY json_extract(payload,'$.seq')`);
    for (const group of db.prepare(groupSQL() + ' ORDER BY impressions DESC,basis').iterate(job._id)) {
      await write({ 'Row Type': 'Basis', 'Matching Basis': group.basis, ...metrics(group.impressions, group.revenue) });
      for (const { payload } of children.iterate(job._id, group.basis)) {
        const row = JSON.parse(payload);
        await write({ 'Row Type': 'URL', 'Matching Basis': group.basis, URL: row.URL, 'Language Code': row['Language Code'], Priority: row.Priority, ...metrics(row['Keyword Impressions'], row.Revenue) });
      }
    }
    await write({ 'Row Type': 'Grand Total', ...metrics(totals.totalImpressions, totals.totalRevenue) });
    res.end();
  } finally { db.close(); }
}
export function coverageReportRoutes(router, owned) {
  router.get('/:id/pivot', async (req, res) => {
    const job = await owned(req);
    res.json(await coveragePivot(job, { basis: req.query.basis === undefined ? undefined : String(req.query.basis), page: req.query.page }));
  });
  router.get('/:id/pivot/export', async (req, res) => {
    const job = await owned(req);
    await exportCoveragePivot(job, res);
  });
}