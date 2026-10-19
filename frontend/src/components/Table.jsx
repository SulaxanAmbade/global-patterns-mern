import React from 'react';
export default function Table({ rows = [], columns, selected, onSelect }) {
  const keys =
    columns ||
    Object.keys(rows[0] || {}).filter(
      (k) =>
        ![
          '_id',
          '_admin_repaired',
          'revision',
          'length',
          'normalized',
          'basisKey',
          'jobId',
          'matches',
          'aliases',
          'keywordKey',
        ].includes(k),
    );
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {onSelect && <th>Select</th>}
            {keys.map((k) => (
              <th key={k}>
                {k === '_alignment_issue' ? 'Alignment Issue' : k}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={r._id || r.seq || i}
              className={r._alignment_issue ? 'alignment-warning' : undefined}
            >
              {onSelect && (
                <td>
                  <input
                    aria-label={'Select ' + (r.keyword || r.basis || i)}
                    type="checkbox"
                    checked={selected?.has(r.seq) || false}
                    onChange={() => onSelect(r.seq)}
                  />
                </td>
              )}
              {keys.map((k) => (
                <td key={k}>
                  {typeof r[k] === 'object'
                    ? JSON.stringify(r[k])
                    : ['language', 'languagecode', 'kbbselectedlanguage'].includes(k.toLowerCase().replace(/[^a-z]/g, ''))
                      ? String(r[k] ?? '').toUpperCase()
                      : String(r[k] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p>No rows to display.</p>}
    </div>
  );
}

