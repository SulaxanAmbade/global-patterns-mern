import React, { useEffect, useMemo, useState } from 'react';
import { api, submitFile } from '../api';
import JobStatus from '../components/JobStatus';
import CoverageReport from '../components/CoverageReport';
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
function suggestColumns(headers) {
  const normalized = (v) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
  const choose = (aliases) => {
    for (const alias of aliases) {
      const found = headers.find((h) => normalized(h) === normalized(alias));
      if (found) return found;
    }
    return '';
  };
  return {
    url: choose(['URL', 'Stripped URL', 'Page URL', 'Landing Page URL', 'Link']),
    impressions: choose(['Keyword Impressions', 'Impressions', 'kimpressions']),
    revenue: choose(['Revenue', 'Keyword Revenue', 'Estimated Revenue']),
  };
}

export default function CoveragePage() {
  const [languages, setLanguages] = useState([]),
    [selected, setSelected] = useState(['en']),
    [file, setFile] = useState(null),
    [urls, setURLs] = useState(''),
    [headers, setHeaders] = useState([]),
    [headerFile, setHeaderFile] = useState(null),
    [columns, setColumns] = useState({
      url: 'URL',
      impressions: 'Keyword Impressions',
      revenue: 'Revenue',
    }),
    [id, setId] = useState(() => sessionStorage.getItem('gp-coverage') || ''),
    [secondId, setSecondId] = useState(''),
    [job, setJob] = useState(null),
    [second, setSecond] = useState(null),
    [search, setSearch] = useState(''),
    [excluded, setExcluded] = useState(new Set()),
    [custom, setCustom] = useState([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api('/dataset/meta')
      .then((m) => {
        setLanguages(m.languages);
        setSelected(
          m.languages.some((language) => language.toLowerCase() === 'en') ? [m.languages.find((language) => language.toLowerCase() === 'en')] : m.languages.slice(0, 1),
        );
      })
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
  async function run(priority = false) {
    setError('');
    setBusy(true);
    try {
      if (!priority && file && (headerFile !== file || !headers.includes(columns.url)))
        throw Error('Choose the URL column from your uploaded file.');
      const inputFile = priority
        ? null
        : file ||
          new File(
            [
              'URL,Keyword Impressions,Revenue\n' +
                urls
                  .split(/\n/)
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .map((s) => '"' + s.replaceAll('"', '""') + '",0,0')
                  .join('\n'),
            ],
            'manual.csv',
            { type: 'text/csv' },
          );
      const options = priority
        ? { ...job.input, sourceJob: id, excluded: [...excluded], custom }
        : {
            languages: selected,
            columns: file
              ? columns
              : {
                  url: 'URL',
                  impressions: 'Keyword Impressions',
                  revenue: 'Revenue',
                },
          };
      const j = await submitFile('/jobs/coverage', inputFile, options);
      if (priority) {
        setSecond(null);
        setSecondId(j._id);
      } else {
        setJob(null);
        setSecond(null);
        setSecondId('');
        setExcluded(new Set());
        setId(j._id);
        sessionStorage.setItem('gp-coverage', j._id);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const detailsByBasis = useMemo(() => {
    const map = new Map();
    for (const row of job?.result?.caughtDetails || []) {
      if (!map.has(row.basis)) map.set(row.basis, []);
      map.get(row.basis).push(row);
    }
    return map;
  }, [job]);
  const choices = (job?.result?.caught || []).filter((basis) => {
    const matching = (detailsByBasis.get(basis) || []);
    return [basis, ...matching.flatMap((row) => [row.language, String(row.priority ?? '')])].join(' ').toLowerCase().includes(search.toLowerCase());
  });
  return (
    <>
      <div className="eyebrow">URL COVERAGE</div>
      <h1>Coverage Report</h1>
      <p>
        Each URL gets one basis. Lowest numeric priority wins; equal priorities
        prefer the longer basis. Matching includes the full basis after the
        domain split.
      </p>
      {error && <p className="error">{error}</p>}
      <section className="card">
        <div className="row">
          {languages.map((l) => (
            <label className="check" key={l}>
              <input
                type="checkbox"
                checked={selected.includes(l)}
                onChange={() =>
                  setSelected((s) =>
                    s.includes(l) ? s.filter((x) => x !== l) : [...s, l],
                  )
                }
              />
              {l.toUpperCase()}
            </label>
          ))}
        </div>
        <label>
          Coverage CSV / TSV
          <input
            type="file"
            accept=".csv,.tsv,.txt"
            onChange={(e) => setFile(e.target.files[0])}
          />
        </label>
        {file && (
          <div>
            <h3>Select CSV Columns</h3>
            {headerFile !== file ? (
              <p>Waiting for readable column headers.</p>
            ) : (
              <div className="row">
                {[
                  ['url', 'URL Column (Required)'],
                  ['impressions', 'Impressions Column (Optional)'],
                  ['revenue', 'Revenue Column (Optional)'],
                ].map(([name, label]) => (
                  <label key={name}>
                    {label}
                    <select
                      value={columns[name]}
                      onChange={(e) => setColumns((old) => ({ ...old, [name]: e.target.value }))}
                    >
                      <option value="">{name === 'url' ? 'Select a URL column' : 'None — use 0'}</option>
                      {headers.map((header) => (
                        <option key={header} value={header}>{header}</option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        <label>
          Or paste URLs · one per line
          <textarea
            disabled={!!file}
            rows={5}
            value={urls}
            onChange={(e) => setURLs(e.target.value)}
            placeholder="https://facty.com/health/heart-health"
          />
        </label>
        {file && (
          <button onClick={() => setFile(null)}>Use pasted URLs instead</button>
        )}
        <button
          className="primary"
          disabled={busy || !selected.length || (!file && !urls.trim()) || (!!file && (headerFile !== file || !headers.includes(columns.url)))}
          onClick={() => run()}
        >
          Run Coverage Check
        </button>
        <JobStatus id={id} onReady={setJob} />
      </section>
      {job && (
        <section className="card">
          <h2>Coverage Results</h2>
          <CoverageReport key={id} id={id} job={job} />
          <h2>Second Coverage Check</h2>
          <label>
            Search caught bases
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search basis, language or priority"
            />
          </label>
          <p>{excluded.size} selected for exclusion</p>
          <div className="choices">
            {choices.map((b) => (
              <label className="check" key={b}>
                <input
                  type="checkbox"
                  checked={excluded.has(b)}
                  onChange={() =>
                    setExcluded((prev) => {
                      const n = new Set(prev);
                      n.has(b) ? n.delete(b) : n.add(b);
                      return n;
                    })
                  }
                />
                {b} · {(detailsByBasis.get(b) || []).map((row) => `${row.language.toUpperCase()}: Priority ${row.priority ?? 'Not set'}`).join(' · ') || 'Run coverage again to show priority'}
              </label>
            ))}
          </div>
          <h3>Additional Bases</h3>
          <p>These apply to all languages chosen in the first check.</p>
          {custom.map((r, i) => (
            <div className="row" key={i}>
              <input
                aria-label="Custom basis"
                placeholder="facty.com*health"
                value={r.basis}
                onChange={(e) =>
                  setCustom(
                    custom.map((x, j) =>
                      j === i ? { ...x, basis: e.target.value } : x,
                    ),
                  )
                }
              />
              <input
                aria-label="Priority"
                type="number"
                min="0"
                value={r.priority}
                onChange={(e) =>
                  setCustom(
                    custom.map((x, j) =>
                      j === i ? { ...x, priority: e.target.value } : x,
                    ),
                  )
                }
              />
              <button
                onClick={() => setCustom(custom.filter((_, j) => i !== j))}
              >
                Remove
              </button>
            </div>
          ))}
          <div className="row">
            <button
              onClick={() =>
                setCustom([...custom, { basis: '', priority: 1000 }])
              }
            >
              Add Basis
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => run(true)}
            >
              Run Priority Coverage Check
            </button>
          </div>
          <JobStatus id={secondId} onReady={setSecond} />
          {second && (
            <>
              <h2>Priority Coverage Results</h2>
              <CoverageReport key={secondId} id={secondId} job={second} />
            </>
          )}
        </section>
      )}
    </>
  );
}
