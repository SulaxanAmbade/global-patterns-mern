import React, { useEffect, useState } from 'react';
import { api } from '../api';
import Table from './Table';
import Pager from './Pager';
export default function JobResults({ id, selected, onSelect }) {
  const [page, setPage] = useState(1),
    [data, setData] = useState({ rows: [], total: 0 }),
    [error, setError] = useState('');
  useEffect(() => setPage(1), [id]);
  useEffect(() => {
    let cancelled = false;
    setError('');
    api(`/jobs/${id}/rows?page=${page}`)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [id, page]);
  return (
    <>
      {error && <p className="error">{error}</p>}
      <Table rows={data.rows} selected={selected} onSelect={onSelect} />
      <Pager page={page} total={data.total} onChange={setPage} />
    </>
  );
}
