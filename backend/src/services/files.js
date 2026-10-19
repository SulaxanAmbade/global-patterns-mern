import { headerName } from './alignment.js';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import { parse } from 'csv-parse';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { text } from './normalize.js';
export function datasetHeaders(values) {
  const seen = new Set();
  return Array.from(values, (v, i) => {
    const name = headerName(v) || '__unnamed_' + i;
    if (seen.has(name)) throw Error('Duplicate workbook column: ' + name);
    seen.add(name);
    return name;
  });
}
export async function* csvRows(file, { dataset = false } = {}) {
  const fd = await fs.promises.open(file, 'r');
  const b = Buffer.alloc(4);
  await fd.read(b, 0, 4, 0);
  await fd.close();
  const encoding = b[0] === 255 && b[1] === 254 ? 'utf16le' : 'utf8';
  const sample = await fs.promises.open(file, 'r');
  const buf = Buffer.alloc(8192);
  const { bytesRead } = await sample.read(buf, 0, 8192, 0);
  await sample.close();
  let line = buf.subarray(0, bytesRead).toString(encoding).split(/\r?\n/)[0];
  let fromLine = 1;
  if (dataset) {
    const input = fs.createReadStream(file, { encoding });
    const reader = createInterface({ input, crlfDelay: Infinity });
    let found = false,
      n = 0;
    try {
      for await (const candidate of reader) {
        n++;
        if (
          candidate
            .split(/[\t;,]/)
            .some((v) => headerName(v.replace(/^"|"$/g, '')) === 'url_pattern')
        ) {
          line = candidate;
          fromLine = n;
          found = true;
          break;
        }
      }
    } finally {
      reader.close();
      input.destroy();
    }
    if (!found) throw Error('No url_pattern header found');
  }
  let headers;
  const delimiter = line.includes('\t')
    ? '\t'
    : line.split(';').length > line.split(',').length
      ? ';'
      : ',';
  const parser = fs.createReadStream(file, { encoding }).pipe(
    parse({
      bom: true,
      columns: (h) => {
        headers = dataset ? datasetHeaders(h) : h.map(text);
        return headers;
      },
      from_line: fromLine,
      delimiter,
      skip_empty_lines: true,
      relax_column_count: true,
      // Preserve literal quotes in unquoted keyword cells, including TSV exports.
      relax_quotes: true,
      max_record_size: 2 * 1024 * 1024,
    }),
  );
  for await (const row of parser) {
    if (dataset)
      for (const h of headers) if (!Object.hasOwn(row, h)) row[h] = '';
    yield row;
  }
}
export async function* datasetRows(file, filename) {
  const ext = filename.toLowerCase().split('.').pop();
  if (['csv', 'tsv', 'txt', 'jsonl'].includes(ext)) {
    if (ext === 'jsonl') {
      const { createInterface } = await import('node:readline');
      for await (const line of createInterface({
        input: fs.createReadStream(file),
        crlfDelay: Infinity,
      }))
        if (line.trim()) yield JSON.parse(line);
    } else
      for await (const row of csvRows(file, { dataset: true }))
        yield Object.fromEntries(
          Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]),
        );
    return;
  }
  const fd = await fs.promises.open(file, 'r');
  const b = Buffer.alloc(4);
  await fd.read(b, 0, 4, 0);
  await fd.close();
  if (ext === 'xlsx' && b[0] === 80 && b[1] === 75) {
    const ExcelJS = (await import('exceljs')).default;
    const book = new ExcelJS.stream.xlsx.WorkbookReader(file, {
      sharedStrings: 'cache',
      worksheets: 'emit',
      styles: 'ignore',
      hyperlinks: 'ignore',
    });
    let header;
    for await (const sheet of book) {
      for await (const row of sheet) {
        const values = Array.from(
          row.values.slice(1),
          (v) => v?.text ?? v?.result ?? v ?? '',
        );
        if (!header) {
          if (values.some((v) => text(v).toLowerCase() === 'url_pattern'))
            header = datasetHeaders(values);
          continue;
        }
        yield Object.fromEntries(header.map((h, i) => [h, values[i] ?? '']));
      }
      break;
    }
    if (!header) throw Error('No url_pattern header found');
    return;
  }
  // Legacy XLS, HTML-as-XLS and UTF-16 exports: bounded by upload limit and worker heap.
  if (b[0] === 255 && b[1] === 254) {
    for await (const row of csvRows(file, { dataset: true }))
      yield Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]),
      );
    return;
  }
  const XLSX = (await import('xlsx')).default;
  const book = XLSX.read(await fs.promises.readFile(file), {
    type: 'buffer',
    cellDates: false,
  });
  const rows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], {
    header: 1,
    defval: '',
  });
  const idx = rows.findIndex((r) =>
    r.some((v) => text(v).toLowerCase() === 'url_pattern'),
  );
  if (idx < 0) throw Error('No url_pattern header found');
  const header = datasetHeaders(rows[idx]);
  for (const row of rows.slice(idx + 1))
    yield Object.fromEntries(header.map((h, i) => [h, row[i] ?? '']));
}
export function csvCell(v) {
  let s = String(v ?? '');
  if (
    /^[\s]*[=+@]/.test(s) ||
    /^[\t\r]/.test(s) ||
    (s.startsWith('-') && !/^-\d+(?:\.\d+)?$/.test(s))
  )
    s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
}
export function outputValue(column, value) {
  return ['language', 'languagecode', 'kbbselectedlanguage'].includes(
    String(column).toLowerCase().replace(/[^a-z]/g, ''),
  ) ? String(value ?? '').toUpperCase() : value;
}
export async function sendCSV(res, cursor, columns, filename) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const out = new Transform({
    objectMode: true,
    transform(row, _, cb) {
      cb(null, columns.map((c) => csvCell(outputValue(c, row[c]))).join(',') + '\r\n');
    },
  });
  res.write('\ufeff' + columns.map(csvCell).join(',') + '\r\n');
  try {
    await pipeline(cursor.stream(), out, res);
  } finally {
    await cursor.close();
  }
}
