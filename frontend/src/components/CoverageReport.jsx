import React, { useEffect, useState } from 'react';
import { api } from '../api';
import JobResults from './JobResults';
import Pager from './Pager';
const value = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const percent = (n) => n === null || n === undefined ? 'N/A' : `${Number(n).toFixed(2)}%`;
function Metrics({ row }) {
  return <><td>{value(row.impressions)}</td><td>{percent(row.impressionsPercent)}</td><td>{value(row.revenue)}</td><td>{percent(row.revenuePercent)}</td></>;
}
function BasisRow({ id, row }) {
  const [open, setOpen] = useState(false), [page, setPage] = useState(1);
  const [data, setData] = useState(null), [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setData(null); setError('');
    api(`/jobs/${id}/pivot?basis=${encodeURIComponent(row.basis)}&page=${page}`)
      .then((result) => { if (!cancelled) setData(result); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [open, id, row.basis, page]);
  return <>
    <tr>
      <th scope="row"><button aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${row.basis}`} onClick={() => setOpen(!open)}>{open ? '−' : '+'} {row.basis}</button> <small>{row.urls.toLocaleString()} URLs</small></th>
      <Metrics row={row} />
    </tr>
    {open && <tr><td colSpan={5} style={{ paddingLeft: '2rem' }}>
      {error && <p className="error">{error}</p>}
      {!data && !error && <p>Loading URLs…</p>}
      {data && <>
        <table aria-label={`URLs for ${row.basis}`} style={{ width: '100%' }}>
          <thead><tr><th>URL</th><th>Keyword Impressions Value</th><th>Keyword Impressions %</th><th>Revenue Value</th><th>Revenue %</th></tr></thead>
          <tbody>{data.rows.map((child) => <tr key={child.url}>
            <td style={{ overflowWrap: 'anywhere' }}>{child.url}<br /><small>{String(child.language).toUpperCase()}{child.priority !== '' && child.priority != null ? ` · Priority ${child.priority}` : ''}</small></td>
            <Metrics row={child} />
          </tr>)}</tbody>
        </table>
        <Pager page={page} total={data.total} onChange={setPage} />
      </>}
    </td></tr>}
  </>;
}
function Pivot({ id }) {
  const [page, setPage] = useState(1), [data, setData] = useState(null), [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setData(null); setError('');
    api(`/jobs/${id}/pivot?page=${page}`).then((result) => { if (!cancelled) setData(result); }).catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [id, page]);
  return <>
    <p>Expand a matching basis to see its URLs. Percentages are shares of the whole report total, including unmatched URLs.</p>
    <a className="button" href={`/api/jobs/${id}/pivot/export`}>Download Pivot CSV</a>
    {error && <p className="error">{error}</p>}
    {!data && !error && <p>Loading pivot…</p>}
    {data && <>
      <div className="table-wrap"><table>
        <thead><tr><th>Matching Basis → URLs</th><th>Keyword Impressions Value</th><th>Keyword Impressions %</th><th>Revenue Value</th><th>Revenue %</th></tr></thead>
        <tbody>{data.rows.map((row) => <BasisRow key={row.basis} id={id} row={row} />)}</tbody>
        <tfoot><tr><th>Grand Total</th><td>{value(data.totals.totalImpressions)}</td><td>{percent(data.totals.totalImpressions > 0 ? 100 : null)}</td><td>{value(data.totals.totalRevenue)}</td><td>{percent(data.totals.totalRevenue > 0 ? 100 : null)}</td></tr></tfoot>
      </table></div>
      <Pager page={page} total={data.total} onChange={setPage} />
    </>}
  </>;
}
export default function CoverageReport({ id, job }) {
  const [tab, setTab] = useState('summary');
  const summary = job.result?.summary;
  return <>
    <div className="row" role="tablist" aria-label="Coverage report views">
      {[['summary', 'URL Summary'], ['rate', 'Coverage Rate'], ['pivot', 'Pivot Table']].map(([name, label]) => (
        <button key={name} role="tab" aria-selected={tab === name} aria-controls={`${id}-report-panel`} onClick={() => setTab(name)}>{label}</button>
      ))}
    </div>
    <div id={`${id}-report-panel`} role="tabpanel" aria-label={tab === 'summary' ? 'URL Summary' : tab === 'rate' ? 'Coverage Rate' : 'Pivot Table'}>
      {tab === 'summary' && <>
        <JobResults id={id} />
        <a className="button" href={`/api/jobs/${id}/export`}>Download URL Summary</a>
      </>}
      {tab !== 'summary' && (!summary || job.result?.reportVersion !== 2) && <p>Run coverage again to generate the coverage rate and pivot table.</p>}
      {tab === 'rate' && summary && <>
        <p>Coverage rate = keyword impressions on covered URLs ÷ total keyword impressions × 100.</p>
        <div className="stats">
          <div className="card"><span>Impression Coverage Rate</span><strong>{percent(summary.coverageRate)}</strong></div>
          <div className="card"><span>Total Keyword Impressions</span><strong>{value(summary.totalImpressions)}</strong></div>
          <div className="card"><span>Covered Keyword Impressions</span><strong>{value(summary.coveredImpressions)}</strong></div>
          <div className="card"><span>Uncovered Keyword Impressions</span><strong>{value(summary.totalImpressions - summary.coveredImpressions)}</strong></div>
        </div>
        {summary.coverageRate == null && <p>Select an impressions column with a total greater than zero to calculate the coverage rate.</p>}
        <p>Covered URLs: {value(job.result.covered)} of {value(job.result.rows)}.</p>
      </>}
      {tab === 'pivot' && summary && job.result?.reportVersion === 2 && <Pivot id={id} />}
    </div>
  </>;
}
