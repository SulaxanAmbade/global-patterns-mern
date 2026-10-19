import React, { useEffect, useState } from 'react';
import { api, submitFile } from '../api';
import Table from '../components/Table';
import Pager from '../components/Pager';
import JobStatus from '../components/JobStatus';
import JobResults from '../components/JobResults';
export default function DashboardPage() {
  const [meta, setMeta] = useState({ languages: [], admins: [] }),
    [data, setData] = useState({ rows: [], total: 0 }),
    [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    [mode, setMode] = useState('normalized'),
    [admin, setAdmin] = useState(''),
    [page, setPage] = useState(1),
    [file, setFile] = useState(null),
    [confirmed, setConfirmed] = useState(false),
    [activationId, setActivationId] = useState(''),
    [id, setId] = useState(() => sessionStorage.getItem('gp-import') || ''),
    [job, setJob] = useState(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const params = new URLSearchParams({ q: search, mode, admin, page });
  useEffect(() => {
    api('/dataset/meta')
      .then(setMeta)
      .catch((e) => setError(e.message));
  }, [revision]);
  useEffect(() => {
    let stopped = false;
    api('/dataset?' + params)
      .then((d) => {
        if (!stopped) setData(d);
      })
      .catch((e) => {
        if (!stopped) setError(e.message);
      });
    return () => {
      stopped = true;
    };
  }, [search, mode, admin, page, revision]);
  async function upload(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const j = await submitFile('/dataset/import', file, {
        dateConfirmed: confirmed,
      });
      setActivationId('');
      setJob(null);
      setId(j._id);
      sessionStorage.setItem('gp-import', j._id);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function activationReady() {
    setBusy(false);
    setJob((prev) => ({ ...prev, status: 'completed' }));
    setRevision((r) => r + 1);
  }
  async function activate() {
    try {
      setBusy(true);
      const activation = await api('/dataset/activate/' + id, {
        method: 'POST',
      });
      setActivationId(activation._id);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }
  return (
    <>
      <div className="eyebrow">SHARED DATABASE</div>
      <h1>Global Pattern Dashboard</h1>
      <p>
        Search the shared dataset, review an import, and activate it when ready.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="stats">
        <div className="card">
          <span>Active patterns</span>
          <strong>{(meta.total_rows || 0).toLocaleString()}</strong>
        </div>
        <div className="card">
          <span>Last updated by</span>
          <strong>{meta.updated_by || '—'}</strong>
        </div>
        <div className="card">
          <span>Source file</span>
          <strong className="small">{meta.filename || 'No dataset yet'}</strong>
        </div>
      </div>
      <details className="card">
        <summary>Update Shared Dataset</summary>
        <p>
          Replacement removes records omitted from the new file. Your current
          data stays available while the file is being checked.
        </p>
        <form onSubmit={upload}>
          <label>
            Dataset · CSV, TSV, XLSX, XLS or JSONL
            <input
              required
              type="file"
              accept=".csv,.tsv,.txt,.xlsx,.xls,.jsonl"
              onChange={(e) => {
                setFile(e.target.files[0]);
                setConfirmed(false);
              }}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            I verified the file date if missing or different from today
            (DD-MM-YYYY).
          </label>
          <button disabled={busy || !file} className="primary">
            Process &amp; Preview Dataset
          </button>
        </form>
        <JobStatus id={id} onReady={setJob} />
        <JobStatus
          id={activationId}
          onReady={activationReady}
          onFailed={() => setBusy(false)}
        />
        {job && (
          <>
            <JobResults id={id} />
            {job.result?.alignment && (
              <p>
                Alignment repairs: {job.result.alignment.languagesRecovered}{' '}
                language codes recovered;{' '}
                {job.result.alignment.patternIdsRecovered} pattern IDs
                recovered; {job.result.alignment.blockingRows} unresolved
                language errors.
              </p>
            )}
            {!!job.result?.alignment?.blockingRows && (
              <p className="error">
                Correct the flagged language rows and re-upload before replacing
                shared data.
              </p>
            )}
            {job.status === 'preview' && (
              <button
                className="primary"
                disabled={busy || !!job.result?.alignment?.blockingRows}
                onClick={activate}
              >
                Replace Shared Dataset
              </button>
            )}
          </>
        )}
      </details>
      <section className="card">
        <h2>Search URL Patterns / IDs / Bases</h2>
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setSearch(query);
          }}
        >
          <label>
            Search · comma or newline separated
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="heart*health, 123456"
            />
          </label>
          <label>
            Mode
            <select
              value={mode}
              onChange={(e) => {
                setMode(e.target.value);
                setPage(1);
              }}
            >
              <option value="normalized">Normalized Search</option>
              <option value="exact">Exact Match</option>
            </select>
          </label>
          <label>
            Admin
            <select
              value={admin}
              onChange={(e) => {
                setAdmin(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All admins</option>
              {meta.admins.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </label>
          <button className="primary">Search</button>
        </form>
        <Table
          rows={data.rows}
          columns={[
            'url_pattern',
            'url_pattern_id',
            'priority',
            'language_code',
            'admin_name',
            'updated_admin_id',
          ]}
        />
        <Pager page={page} total={data.total} onChange={setPage} />
        <a className="button" href={'/api/dataset/export?' + params}>
          Download Search Results
        </a>
      </section>
    </>
  );
}
