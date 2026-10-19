import React from 'react';
export default function Pager({ page, total, limit = 100, onChange }) {
  return (
    <div className="row">
      <button disabled={page <= 1} onClick={() => onChange(page - 1)}>
        Previous
      </button>
      <span>
        Page {page} of {Math.max(1, Math.ceil((total || 0) / limit))} ·{' '}
        {(total || 0).toLocaleString()} rows
      </span>
      <button
        disabled={page * limit >= total}
        onClick={() => onChange(page + 1)}
      >
        Next
      </button>
    </div>
  );
}
