import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import XLSX from 'xlsx';
import { repairWorkbookRow } from '../src/services/alignment.js';
import { datasetRows } from '../src/services/files.js';
import { adminId, repairAdmins } from '../src/services/admins.js';
import { openLocal, localPath } from '../src/services/localStore.js';
for (const value of [
  new Date('2026-10-18T12:30:00Z'),
  46313,
  '46313.0',
  '2026-10-18',
  '18-10-2026',
  '10/18/2026',
  '18 Oct 2026 12:30',
  '2026-10-18T12:30:00Z',
]) {
  test('recover language when displaced value is ' + String(value), () => {
    const result = repairWorkbookRow({
      url_pattern: '*example.com*health*',
      language_code: value,
      url_pattern_order: 'EN',
    });
    assert.equal(result.row.language_code, 'en');
    assert.ok(result.fixes.includes('language_from_url_pattern_order'));
    assert.equal(result.issue, '');
  });
}
test('valid language is retained; valid fallback fills blank languages; uncertain values are flagged', () => {
  assert.equal(
    repairWorkbookRow({ language_code: 'fr', url_pattern_order: 'en' }).row
      .language_code,
    'fr',
  );
  assert.equal(
    repairWorkbookRow({ language_code: 'None', url_pattern_order: 'pt_BR' }).row
      .language_code,
    'pt-br',
  );
  const invalid = repairWorkbookRow({
    language_code: '18-10-2026',
    url_pattern_order: '4',
  });
  assert.equal(invalid.row.language_code, '');
  assert.ok(invalid.issue);
  assert.equal(
    repairWorkbookRow({ language_code: '', url_pattern_order: '' }).issue,
    '',
  );
});
test('missing-value cleanup recovers pattern IDs without damaging keyword arrays or newline lists', () => {
  for (const value of ['', null, 'None', 'nan', 'NaN']) {
    const result = repairWorkbookRow({
      url_pattern_id: value,
      total_count: '123',
    });
    assert.equal(result.row.url_pattern_id, '123');
  }
  assert.equal(
    repairWorkbookRow({ pattern_keywords: 'First Keyword\nSecond Keyword' }).row
      .pattern_keywords,
    'First Keyword\nSecond Keyword',
  );
  assert.deepEqual(
    repairWorkbookRow({ pattern_keywords: ['First Keyword', 'Second Keyword'] })
      .row.pattern_keywords,
    ['First Keyword', 'Second Keyword'],
  );
});
test('admin IDs support exact Excel decimal and scientific notation', () => {
  assert.equal(adminId('1.9153E4'), '19153');
  assert.equal(adminId('999999999999999999.000'), '999999999999999999');
  assert.equal(adminId('19,153.0'), '19153');
  assert.equal(adminId('12.5'), '12.5');
  assert.equal(adminId('12,34'), '12,34');
});
test('UTF-16 workbook exports detect headers after preamble, preserve admin width, and pad short rows', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'gp-align-'));
  try {
    const file = path.join(folder, 'export.xls');
    await writeFile(
      file,
      Buffer.from(
        '\ufeffExport generated on 18-10-2026\r\n\r\nurl_pattern\turl_pattern_id\ttotal_count\tlanguage_code\turl_pattern_order\tadmin_name\tupdated_admin_id\r\n*example.com*health*\t\t123\t46313\ten\tOwner\t19153\t\t\r\n*example.com*news*\t2\t\tde\t4\r\n',
        'utf16le',
      ),
    );
    const rows = [];
    for await (const row of datasetRows(file, 'export.xls')) rows.push(row);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].admin_name, 'Owner');
    assert.equal(rows[0].updated_admin_id, '19153');
    assert.equal(rows[1].admin_name, '');
    assert.equal(repairWorkbookRow(rows[0]).row.language_code, 'en');
    assert.equal(repairWorkbookRow(rows[0]).row.url_pattern_id, '123');
  } finally {
    await rm(folder, { recursive: true });
  }
});
test('real XLSX dates and binary XLS serial dates use the same alignment repairs', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'gp-align-workbook-'));
  try {
    const header = [
      'url_pattern',
      'url_pattern_id',
      'total_count',
      'language_code',
      'url_pattern_order',
      'admin_name',
      'updated_admin_id',
    ];
    const book = new ExcelJS.Workbook(),
      sheet = book.addWorksheet('Patterns');
    sheet.addRow(['Export report']);
    sheet.addRow(header);
    sheet.addRow([
      '*example.com*health*',
      null,
      123,
      new Date('2026-10-18'),
      'en',
      'Owner',
      19153,
    ]);
    await book.xlsx.writeFile(path.join(folder, 'dates.xlsx'));
    const legacy = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      legacy,
      XLSX.utils.aoa_to_sheet([
        ['Export report'],
        header,
        ['*example.com*health*', '', 123, 46313, 'de', 'Owner', 19153],
      ]),
      'Patterns',
    );
    await writeFile(
      path.join(folder, 'dates.xls'),
      XLSX.write(legacy, { bookType: 'biff8', type: 'buffer' }),
    );
    for (const name of ['dates.xlsx', 'dates.xls']) {
      const rows = [];
      for await (const row of datasetRows(path.join(folder, name), name))
        rows.push(row);
      assert.equal(rows.length, 1);
      const repaired = repairWorkbookRow(rows[0]);
      assert.equal(repaired.row.url_pattern_id, '123');
      assert.equal(
        repaired.row.language_code,
        name.endsWith('xlsx') ? 'en' : 'de',
      );
      assert.equal(repaired.row.admin_name, 'Owner');
    }
  } finally {
    await rm(folder, { recursive: true });
  }
});
test('admin alignment moves misplaced IDs, prefers historical names, and falls back around conflicts', async () => {
  const id = 'test-' + randomUUID(),
    local = openLocal(id),
    revision = 'test';
  const rows = [
    { _id: 'a', admin_name: 'Owner Local', updated_admin_id: '19153' },
    { _id: 'b', admin_name: '19153.0', updated_admin_id: '' },
    { _id: 'c', admin_name: '19153', updated_admin_id: '999' },
    { _id: 'd', admin_name: '', updated_admin_id: '777' },
    { _id: 'e', admin_name: 'Current Owner', updated_admin_id: '777' },
    { _id: 'f', admin_name: '', updated_admin_id: '888' },
    { _id: 'g', admin_name: 'Alpha', updated_admin_id: '888' },
    { _id: 'h', admin_name: 'Beta', updated_admin_id: '888' },
  ];
  const historical = {
    collection(name) {
      return name === 'metadata'
        ? {
            async findOne() {
              return { revision: 'historical' };
            },
          }
        : {
            aggregate() {
              return {
                async toArray() {
                  return [
                    { _id: { id: '19153', name: 'Saved Owner (setid: 123)' } },
                    { _id: { id: '777', name: 'Conflict A' } },
                    { _id: { id: '777', name: 'Conflict B' } },
                  ];
                },
              };
            },
          };
    },
  };
  try {
    await local
      .collection('patterns')
      .insertMany(rows.map((r) => ({ ...r, revision })));
    await local
      .collection('pairs')
      .insertMany([
        {
          _id: 'pair',
          revision,
          source_admin_name: '19153.0',
          source_admin_id: '',
        },
      ]);
    await repairAdmins(local, revision, historical);
    assert.equal(
      (await local.collection('patterns').findOne({ _id: 'a' })).admin_name,
      'Owner Local',
    );
    for (const record of ['b', 'c']) {
      const row = await local.collection('patterns').findOne({ _id: record });
      assert.equal(row.updated_admin_id, '19153');
      assert.equal(row.admin_name, 'Saved Owner (Lookup)');
    }
    assert.equal(
      (await local.collection('patterns').findOne({ _id: 'd' })).admin_name,
      'Current Owner (Lookup)',
    );
    assert.equal(
      (await local.collection('patterns').findOne({ _id: 'f' })).admin_name,
      '',
    );
    assert.equal(
      (await local.collection('pairs').findOne({ _id: 'pair' }))
        .source_admin_name,
      'Saved Owner (Lookup)',
    );
  } finally {
    local.close();
    await rm(localPath(id), { force: true });
  }
});
