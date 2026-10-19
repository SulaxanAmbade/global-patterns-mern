import React, { useEffect, useState } from 'react';
import { api, submitFile, download } from '../api';
import JobStatus from '../components/JobStatus';
import JobResults from '../components/JobResults';
const metrics = {
  rpm: 'RPM',
  impressions: 'Keyword Impressions',
  revenue: 'Revenue',
  clicks: 'Keyword Clicks',
  ad_clicks: 'Ad Clicks',
  l2r: 'L2R',
  rpc: 'RPC',
};
// Read only the header area; the full file is uploaded when the user runs it.
function parseHeader(text, delimiter) {
  const cells = [];
  let cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && !cell) quoted = true;
    else if (c === delimiter) { cells.push(cell.trim()); cell = ''; }
    else if (c === '\n' || c === '\r') {
      cells.push(cell.trim());
      return { cells, complete: true };
    } else cell += c;
  }
  cells.push(cell.trim());
  return { cells, complete: !quoted };
}
async function readHeaders(file) {
  const max = 256 * 1024;
  const bytes = new Uint8Array(await file.slice(0, max).arrayBuffer());
  if (bytes[0] === 254 && bytes[1] === 255)
    throw Error('Save this file as UTF-8 CSV or UTF-16 LE TSV first.');
  const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : 'utf-8';
  const text = new TextDecoder(encoding).decode(bytes)
    .replace(/^\ufeff/, '').replace(/^(?:[ \t]*\r?\n)+/, '');
  const candidates = [',', '\t', ';'].map((d) => parseHeader(text, d));
  const result = candidates.sort((a, b) => b.cells.length - a.cells.length)[0];
  if (!result.complete || (file.size > max && !/[\r\n]/.test(text)))
    throw Error('Could not read the complete CSV header.');
  const headers = result.cells;
  if (!headers.length || headers.some((h) => !h))
    throw Error('Every CSV column needs a name.');
  if (new Set(headers).size !== headers.length)
    throw Error('CSV column names must be unique.');
  return headers;
}
const columnLabels = {
  basis: 'Basis', keyword: 'Keyword', impressions: 'Keyword Impressions',
  rpm: 'RPM', revenue: 'Revenue', l2r: 'L2R', rpc: 'RPC',
  clicks: 'Keyword Clicks', ad_clicks: 'Ad Clicks',
  language: 'Language', domain: 'Domain',
};
const aliases = {
  basis: ['basis', 'Matching Bases', 'url_pattern'],
  keyword: ['kwds', 'keyword', 'keywords', 'Keyword Term'],
  impressions: ['kimpressions', 'Keyword Impressions', 'Impressions'],
  rpm: ['krpm', 'KWD RPM (audited)', 'KWD RPM', 'Keyword RPM', 'RPM'],
  revenue: ['revenue', 'Keyword Revenue'],
  l2r: ['kl2r', 'KWDL2R', 'KWD L2R', 'KWD L2R %', 'L2R'],
  rpc: ['rpc'], clicks: ['kwd clicks', 'Keyword Clicks'],
  ad_clicks: ['ad clicks'],
  language: ['language', 'language_code', 'languagecode', 'KBB Selected Language'],
  domain: ['domain', 'URL Domain'],
};
function suggestColumns(headers) {
  const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const used = new Set();
  return Object.fromEntries(Object.entries(aliases).map(([name, names]) => {
    let found = '';
    for (const alias of names) {
      found = headers.find((header) => !used.has(header) && normalize(header) === normalize(alias)) || '';
      if (found) break;
    }
    if (found) used.add(found);
    return [name, found];
  }));
}
export default function PerformancePage() {
  const [file, setFile] = useState(null),
    [headers, setHeaders] = useState([]),
    [headerFile, setHeaderFile] = useState(null),
    [columns, setColumns] = useState({
      basis: 'basis',
      keyword: 'kwds',
      impressions: 'kimpressions',
      rpm: 'krpm',
      revenue: 'revenue',
      l2r: 'kl2r',
      rpc: 'rpc',
      clicks: 'kwd clicks',
      ad_clicks: 'ad clicks',
      language: '',
      domain: '',
    }),
    [minimum, setMinimum] = useState(1000),
    [mode, setMode] = useState('all'),
    [rules, setRules] = useState([
      { metric: 'rpm', operator: '<', target: 'average', value: 100 },
    ]),
    [id, setId] = useState(
      () => sessionStorage.getItem('gp-performance') || '',
    ),
    [job, setJob] = useState(null),
    [selected, setSelected] = useState(new Set()),
    [replacements, setReplacements] = useState([]),
    [domains, setDomains] = useState([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api('/dataset/meta')
      .then((m) => setDomains(m.domains))
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    let cancelled = false;
    setHeaders([]);
    setHeaderFile(null);
    if (!file) return;
    setError('');
    readHeaders(file).then((names) => {
      if (cancelled) return;
      setHeaders(names);
      setColumns(suggestColumns(names));
      setHeaderFile(file);
    }).catch((e) => {
      if (!cancelled) setError(e.message);
    });
    return () => { cancelled = true; };
  }, [file]);
  const required = new Set(['basis', 'keyword', 'impressions', 'rpm', ...rules.map((rule) => rule.metric)]);
  const missing = [...required].filter((name) => !headers.includes(columns[name]));
  const mapped = Object.values(columns).filter(Boolean);
  const duplicates = new Set(mapped).size !== mapped.length;
  const mappingReady = !!file && headerFile === file && !missing.length && !duplicates;
  async function action(fn) {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const updateRule = (i, k, v) =>
    setRules(rules.map((r, j) => (i === j ? { ...r, [k]: v } : r)));
  return (
    <>
      <div className="eyebrow">KEYWORD AUDIT</div>
      <h1>Keyword Performance Check</h1>
      <p>
        Review existing database pairs using your conditions. Select pairs for a
        deletion sheet, then enter replacements manually.
      </p>
      {error && <p className="error">{error}</p>}
      <section className="card">
        <label>
          Performance CSV
          <input
            type="file"
            accept=".csv,.tsv"
            onChange={(e) => setFile(e.target.files[0])}
          />
        </label>
        {file && (
          <div>
            <h2>Select CSV Columns</h2>
            <p>Choose the matching column for each field. Fields used by your conditions are required.</p>
            {headerFile !== file ? <p>Waiting for readable column headers.</p> : (
              <div className="grid">
                {Object.entries(columnLabels).map(([name, label]) => (
                  <label key={name}>
                    {label}{required.has(name) ? ' (Required)' : ' (Optional)'}
                    <select
                      aria-label={label + ' column'}
                      value={columns[name]}
                      onChange={(e) => setColumns((old) => ({ ...old, [name]: e.target.value }))}
                    >
                      <option value="">{required.has(name) ? 'Select a column' : 'Not used'}</option>
                      {headers.map((header) => (
                        <option key={header} value={header}>{header}</option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            )}
            {headerFile === file && missing.length > 0 && <p>Choose columns for: {missing.map((name) => columnLabels[name]).join(', ')}.</p>}
            {duplicates && headerFile === file && <p className="error">Each CSV column can only be mapped once.</p>}
          </div>
        )}
        <h2>Performance Check Conditions</h2>
        <div className="row">
          <label>
            Minimum Pair Impressions
            <input
              type="number"
              min="0"
              step="1"
              value={minimum}
              onChange={(e) => setMinimum(Number(e.target.value))}
            />
          </label>
          <label>
            Match Rules
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="all">All conditions</option>
              <option value="any">Any condition</option>
            </select>
          </label>
        </div>
        {rules.map((r, i) => (
          <div className="row rule" key={i}>
            <select
              aria-label="Metric"
              value={r.metric}
              onChange={(e) => updateRule(i, 'metric', e.target.value)}
            >
              {Object.entries(metrics).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <select
              aria-label="Operator"
              value={r.operator}
              onChange={(e) => updateRule(i, 'operator', e.target.value)}
            >
              {['<', '<=', '>', '>=', '=', '!='].map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
            <select
              aria-label="Compare to"
              value={r.target}
              onChange={(e) => updateRule(i, 'target', e.target.value)}
            >
              <option value="fixed">Fixed Value</option>
              <option value="average">Basis Average</option>
              <option value="percent">Basis Average %</option>
            </select>
            <input
              aria-label="Comparison value"
              type="number"
              min="0"
              disabled={r.target === 'average'}
              value={r.value}
              onChange={(e) => updateRule(i, 'value', Number(e.target.value))}
            />
            <button onClick={() => setRules(rules.filter((_, j) => i !== j))}>
              Remove
            </button>
          </div>
        ))}
        <p>
          Counts and revenue sum. RPM and L2R use impression weights. RPC uses
          click weights when mapped. Basis averages are the mean of eligible
          distinct pairs before the conditions apply.
        </p>
        <div className="row">
          <button
            onClick={() =>
              setRules([
                ...rules,
                { metric: 'clicks', operator: '<', target: 'fixed', value: 5 },
              ])
            }
          >
            Add Condition
          </button>
          <button
            className="primary"
            disabled={busy || !mappingReady}
            onClick={() =>
              action(async () => {
                if (!mappingReady) throw Error('Complete the required column selections first.');
                const j = await submitFile('/jobs/performance', file, {
                  columns,
                  minimum,
                  mode,
                  rules,
                });
                setJob(null);
                setSelected(new Set());
                setReplacements([]);
                setId(j._id);
                sessionStorage.setItem('gp-performance', j._id);
              })
            }
          >
            Check Keyword Performance
          </button>
        </div>
        <JobStatus id={id} onReady={setJob} />
      </section>
      {job && (
        <section className="card">
          <h2>Underperforming Pairs</h2>
          <JobResults
            id={id}
            selected={selected}
            onSelect={(seq) => {
              setSelected((prev) => {
                const n = new Set(prev);
                n.has(seq) ? n.delete(seq) : n.add(seq);
                return n;
              });
              setReplacements([]);
            }}
          />
          <p>
            {selected.size} pairs selected · selection persists across pages.
          </p>
          <div className="row">
            <button
              disabled={!selected.size || busy}
              onClick={() =>
                action(() =>
                  download(
                    `/jobs/${id}/deletion`,
                    { selected: [...selected] },
                    'keyword_deletion.csv',
                  ),
                )
              }
            >
              Download Deletion Sheet
            </button>
            <button
              disabled={!selected.size || busy}
              onClick={() =>
                action(async () =>
                  setReplacements(
                    await api(`/jobs/${id}/replacements`, {
                      method: 'POST',
                      body: JSON.stringify({ selected: [...selected] }),
                    }),
                  ),
                )
              }
            >
              Prepare Manual Replacements
            </button>
          </div>
          {replacements.length > 0 && (
            <>
              <h2>Manual Replacement Keywords</h2>
              <p>
                Fill and select the rows to include. Keywords already present
                for the same basis and language are rejected.
              </p>
              {replacements.map((r, i) => (
                <div className="replacement" key={i}>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={!!r.selected}
                      onChange={(e) =>
                        setReplacements(
                          replacements.map((x, j) =>
                            j === i ? { ...x, selected: e.target.checked } : x,
                          ),
                        )
                      }
                    />
                    Include
                  </label>
                  {[
                    'domain',
                    'basis',
                    'keywords',
                    'languagecode',
                    'priority',
                  ].map((k) => (
                    <label key={k}>
                      {k}
                      {k === 'domain' ? (
                        <select
                          value={k === 'languagecode' ? String(r[k] ?? '').toUpperCase() : r[k]}
                          onChange={(e) =>
                            setReplacements(
                              replacements.map((x, j) =>
                                j === i ? { ...x, [k]: e.target.value } : x,
                              ),
                            )
                          }
                        >
                          {[...new Set([r.domain, ...domains])].map((d) => (
                            <option key={d}>{d}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={k === 'languagecode' ? String(r[k] ?? '').toUpperCase() : r[k]}
                          type={k === 'priority' ? 'number' : 'text'}
                          min={k === 'priority' ? 0 : undefined}
                          onChange={(e) =>
                            setReplacements(
                              replacements.map((x, j) =>
                                j === i ? { ...x, [k]: e.target.value } : x,
                              ),
                            )
                          }
                        />
                      )}
                    </label>
                  ))}
                </div>
              ))}
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  action(() =>
                    download(
                      `/jobs/${id}/upload-sheet`,
                      { rows: replacements.filter((r) => r.selected) },
                      'keyword_upload.csv',
                    ),
                  )
                }
              >
                Download Upload Sheet
              </button>
            </>
          )}
        </section>
      )}
    </>
  );
}