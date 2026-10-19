import React, { useRef, useState } from 'react';
import { save } from '../api';
import Table from '../components/Table';

const fields = ['Domain', 'Basis'];
const blank = () => ({ Domain: '', Basis: '' });

function clean(value) {
  let v = value.trim();

  const match = v.match(
    /^\[[^\]]*\]\((https?:\/\/[^)]+)\)$/i,
  );

  if (match) v = match[1];

  if (/^(https?:)?\/\//i.test(v)) {
    try {
      return new URL(
        v.startsWith('//') ? 'https:' + v : v,
      ).hostname;
    } catch {}
  }

  return v;
}

const csvCell = (value) =>
  '"' + value.replaceAll('"', '""') + '"';

function clipboardRows(value) {
  const rows = [];

  let row = [];
  let cell = '';
  let quoted = false;

  const text = value.replace(/\r\n?/g, '\n');

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        cell += c;
      }
    } else if (c === '"' && !cell) {
      quoted = true;
    } else if (c === '\t') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += c;
    }
  }

  if (quoted) {
    throw Error(
      'The pasted cells contain an unfinished quoted value.',
    );
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

export default function ConcatenatePage() {
  const [rows, setRows] = useState(() =>
    Array.from({ length: 10 }, blank),
  );
  const [result, setResult] = useState([]);
  const [error, setError] = useState('');
  const [activeRow, setActiveRow] = useState(0);

  const cells = useRef(new Map());

  const focus = (row, column) =>
    requestAnimationFrame(() =>
      cells.current.get(`${row}:${column}`)?.focus(),
    );

  function update(row, column, value) {
    setRows((previous) =>
      previous.map((entry, i) =>
        i === row
          ? { ...entry, [fields[column]]: value }
          : entry,
      ),
    );

    setResult([]);
    setError('');
  }

  function paste(event, startRow, startColumn) {
    const text =
      event.clipboardData.getData('text/plain');

    if (!/[\t\r\n]/.test(text)) return;

    event.preventDefault();

    try {
      let incoming = clipboardRows(text);

      // Allow pasting the Domain/Basis header with the data.
      if (
        startRow === 0 &&
        startColumn === 0 &&
        incoming[0]?.length === 2 &&
        incoming[0][0].trim().toLowerCase() === 'domain' &&
        incoming[0][1].trim().toLowerCase() === 'basis'
      ) {
        incoming = incoming.slice(1);
      }

      if (
        incoming.some(
          (entry) => entry.length + startColumn > 2,
        )
      ) {
        throw Error(
          'Paste two columns from the Domain cell, or one column from the Basis cell.',
        );
      }

      if (startRow + incoming.length > 10000) {
        throw Error(
          'Use at most 10,000 rows at a time.',
        );
      }

      setRows((previous) => {
        const next = previous.map((entry) => ({
          ...entry,
        }));

        while (
          next.length < startRow + incoming.length
        ) {
          next.push(blank());
        }

        incoming.forEach((entry, i) => {
          entry.forEach((value, j) => {
            next[startRow + i][
              fields[startColumn + j]
            ] = value;
          });
        });

        return next;
      });

      setError('');
      setResult([]);
    } catch (e) {
      setError(e.message);
    }
  }

  function move(event, row, column) {
    let nextRow = row;
    let nextColumn = column;

    if (event.key === 'Enter') {
      nextRow += event.shiftKey ? -1 : 1;
    } else if (event.key === 'ArrowDown') {
      nextRow++;
    } else if (event.key === 'ArrowUp') {
      nextRow--;
    } else if (
      event.key === 'Tab' &&
      !event.shiftKey &&
      row === rows.length - 1 &&
      column === 1
    ) {
      nextRow++;
      nextColumn = 0;
    } else {
      return;
    }

    event.preventDefault();

    if (nextRow < 0 || nextRow >= 10000) return;

    if (nextRow >= rows.length) {
      setRows((previous) => [...previous, blank()]);
    }

    focus(nextRow, nextColumn);
  }

  function generate() {
    setError('');

    const filled = rows
      .map((entry, i) => ({
        Domain: clean(entry.Domain),
        Basis: entry.Basis.trim(),
        index: i + 1,
      }))
      .filter((entry) => entry.Domain || entry.Basis);

    const incomplete = filled.find(
      (entry) => !entry.Domain || !entry.Basis,
    );

    if (incomplete) {
      setError(
        `Row ${incomplete.index}: enter both Domain and Basis.`,
      );
      return;
    }

    if (!filled.length) {
      setError(
        'Enter at least one domain and basis.',
      );
      return;
    }

    setResult(
      filled.map(({ Domain, Basis }) => ({
        Domain,
        Basis,
        Pattern: `*${
          Domain.startsWith(
            'patternkeywords.global.promote',
          )
            ? 'patternkeywords.global.promote'
            : Domain
        }*${Basis}*`,
      })),
    );
  }

  return (
    <>
      <div className="eyebrow">PATTERN BUILDER</div>
      <h1>Concatenate Sheet</h1>

      <p>
        Enter Domain and Basis in the cells below, or
        paste two columns from Excel or Google Sheets
        into the first Domain cell.
      </p>

      {error && <p className="error">{error}</p>}

      <section className="card">
        <div style={{ overflowX: 'auto' }}>
          <table
            aria-label="Domain and basis spreadsheet"
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              tableLayout: 'fixed',
            }}
          >
            <thead>
              <tr>
                <th scope="col">Domain</th>
                <th scope="col">Basis</th>
              </tr>
            </thead>

            <tbody>
              {rows.map((entry, i) => (
                <tr key={i}>
                  {fields.map((name, column) => (
                    <td
                      key={name}
                      style={{
                        border: '1px solid #9ca3af',
                        padding: 0,
                      }}
                    >
                      <input
                        ref={(element) => {
                          const key = `${i}:${column}`;

                          if (element) {
                            cells.current.set(key, element);
                          } else {
                            cells.current.delete(key);
                          }
                        }}
                        aria-label={`${name} row ${i + 1}`}
                        placeholder={
                          i === 0
                            ? name === 'Domain'
                              ? 'example.com'
                              : 'heart*health'
                            : ''
                        }
                        value={entry[name]}
                        onFocus={() => setActiveRow(i)}
                        onChange={(e) =>
                          update(
                            i,
                            column,
                            e.target.value,
                          )
                        }
                        onPaste={(e) =>
                          paste(e, i, column)
                        }
                        onKeyDown={(e) =>
                          move(e, i, column)
                        }
                        style={{
                          width: '100%',
                          minWidth: 0,
                          margin: 0,
                          border: 0,
                          borderRadius: 0,
                          boxSizing: 'border-box',
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p>
          {rows.length} rows · Selected row:{' '}
          {activeRow + 1}. Enter moves down; Tab moves
          to the next cell.
        </p>

        <div className="row">
          <button
            disabled={rows.length >= 10000}
            onClick={() =>
              setRows((previous) => [
                ...previous,
                ...Array.from(
                  {
                    length: Math.min(
                      10,
                      10000 - previous.length,
                    ),
                  },
                  blank,
                ),
              ])
            }
          >
            Add 10 Rows
          </button>

          <button
            onClick={() => {
              setRows((previous) =>
                previous.length > 1
                  ? previous.filter(
                      (_, i) => i !== activeRow,
                    )
                  : [blank()],
              );

              setActiveRow(0);
              setResult([]);
              setError('');
            }}
          >
            Remove Selected Row
          </button>

          <button
            onClick={() => {
              setRows(
                Array.from({ length: 10 }, blank),
              );
              setResult([]);
              setError('');
              setActiveRow(0);
            }}
          >
            Clear Cells
          </button>

          <button
            className="primary"
            onClick={generate}
          >
            Generate Patterns
          </button>
        </div>

        {result.length > 0 && (
          <>
            <Table rows={result} />

            <div className="row">
              <button
                onClick={() =>
                  save(
                    result
                      .map((entry) => entry.Pattern)
                      .join('\n'),
                    'generated_patterns.txt',
                  )
                }
              >
                Download TXT
              </button>

              <button
                onClick={() =>
                  save(
                    'Domain,Basis,Pattern\n' +
                      result
                        .map((entry) =>
                          [
                            entry.Domain,
                            entry.Basis,
                            entry.Pattern,
                          ]
                            .map(csvCell)
                            .join(','),
                        )
                        .join('\n'),
                    'generated_patterns.csv',
                    'text/csv',
                  )
                }
              >
                Download CSV
              </button>
            </div>
          </>
        )}
      </section>
    </>
  );
}