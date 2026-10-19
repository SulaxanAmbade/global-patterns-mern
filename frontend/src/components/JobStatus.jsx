import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
export default function JobStatus({ id, onReady, onFailed }) {
  const [job, setJob] = useState(null),
    [error, setError] = useState('');
  const ready = useRef(onReady);
  ready.current = onReady;
  const failed = useRef(onFailed);
  failed.current = onFailed;
  useEffect(() => {
    if (!id) return;
    let stopped = false,
      timer;
    setJob(null);
    setError('');
    async function poll() {
      try {
        const j = await api('/jobs/' + id);
        if (stopped) return;
        setJob(j);
        if (j.status === 'failed') failed.current?.(j);
        if (['completed', 'preview'].includes(j.status)) ready.current?.(j);
        else if (['queued', 'running'].includes(j.status))
          timer = setTimeout(poll, 1500);
      } catch (e) {
        if (!stopped) setError(e.message);
      }
    }
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id]);
  if (!id) return null;
  return (
    <div className="notice" role="status">
      {error ||
        (!job
          ? 'Loading job…'
          : `${job.status.toUpperCase()} · ${job.processed.toLocaleString()} records processed`)}
      {job?.error && <p className="error">{job.error}</p>}
      {job?.result && (
        <p>
          {JSON.stringify(
            Object.fromEntries(
              Object.entries(job.result).filter(
                ([k]) => k !== 'caught' && k !== 'caughtDetails' && k !== '_execution',
              ),
            ),
          )}
        </p>
      )}
    </div>
  );
}