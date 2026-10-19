import { repairWorkbookRow } from './alignment.js';
import { datasetRows } from './files.js';
import {
  splitPattern,
  text,
  basisKey,
  words,
} from './normalize.js';
import { cleanAdmin, adminId, repairAdmins } from './admins.js';
import { createHash } from 'node:crypto';
export async function importDataset(db, job, progress) {
  const startedAt = performance.now();
  const timings = {};
  // Local insertMany uses a transaction and an ON CONFLICT upsert. These
  // import rows are complete snapshots, so no read/merge is needed per row.
  const local = db.local || (db.filename ? db : null);
  const write = async (name, operations) => {
    if (!operations.length) return;
    if (local) {
      await local.collection(name).insertMany(operations.map(({ updateOne }) => ({
        ...updateOne.filter, ...updateOne.update.$set,
      })));
    } else {
      await db.collection(name).bulkWrite(operations, { ordered: false });
    }
  };
  console.log('[Import] Reading and repairing workbook rows...');
  let batch = [],
    count = 0,
    repairs = 0;
  const alignment = {
    patternIdsRecovered: 0,
    languagesRecovered: 0,
    blockingRows: 0,
    missingLanguageRows: 0,
    examples: [],
  };
  let sourceRow = 0;
  const flush = async () => {
    await write('patterns', batch);
    batch = [];
    await progress(count);
  };
  for await (const rawRow of datasetRows(
    job.upload.path,
    job.upload.originalname,
  )) {
    sourceRow++;
    const { pattern_keywords: ignoredKeywords, ...patternRow } = rawRow;
    const repaired = repairWorkbookRow(patternRow),
      row = repaired.row;
    if (!text(row.url_pattern)) continue;
    repairs += repaired.fixes.length;
    if (repaired.fixes.includes('pattern_id_from_total_count'))
      alignment.patternIdsRecovered++;
    if (repaired.fixes.some((fix) => fix === 'language_from_url_pattern_order' || fix === 'language_from_url_pattern'))
      alignment.languagesRecovered++;
    if (repaired.missingLanguage) alignment.missingLanguageRows++;
    if (repaired.issue) {
      alignment.blockingRows++;
      if (alignment.examples.length < 20)
        alignment.examples.push({
          dataRow: sourceRow,
          url_pattern: row.url_pattern,
          originalLanguage: repaired.originalLanguage,
          issue: repaired.issue,
        });
    }
    const [domain, basis] = splitPattern(row.url_pattern);
    const language = row.language_code,
      id = text(row.url_pattern_id);
    const r = {
      url_pattern: text(row.url_pattern),
      url_pattern_id: id,
      priority: text(row.priority),
      language_code: language,
      admin_name: cleanAdmin(row.admin_name),
      updated_admin_id: adminId(row.updated_admin_id),
      domain,
      basis,
      basisKey: basisKey(basis),
      normalized: words(row.url_pattern).join(' '),
      length: text(row.url_pattern).length,
      revision: job._id,
      ...(repaired.issue ? { _alignment_issue: repaired.issue } : {}),
    };
    const identity = createHash('sha256')
      .update(JSON.stringify(r))
      .digest('hex');
    {
      count++;
      batch.push({
        updateOne: {
          filter: { _id: job._id + identity },
          update: { $set: r },
          upsert: true,
        },
      });
    }
    if (batch.length >= 5000) await flush();
  }
  await flush();
  timings.parseAndStageMs = Math.round(performance.now() - startedAt);
  console.log(`[Import] Parsing and staging complete in ${timings.parseAndStageMs} ms.`);
  count = await db.collection('patterns').countDocuments({ revision: job._id });
  if (!count)
    throw Error('No usable pattern rows found. Expected a url_pattern column.');
  timings.retainKeywordsMs = 0;
  console.log('[Import] Repairing admin identities...');
  const adminStartedAt = performance.now();
  const adminRepairs = await repairAdmins(db, job._id, db.remote || db, { repairPairs: false });
  timings.adminRepairsMs = Math.round(performance.now() - adminStartedAt);
  timings.totalMs = Math.round(performance.now() - startedAt);
  console.log(`[Import] Preview ready: ${count} patterns in ${timings.totalMs} ms.`);
  return {
    timings,
    count,
    adminRepairs,
    skippedKeywordRows: 0,
    keywordPairsStored: false,
    repairs: repairs + (adminRepairs.repairedRows || 0),
    alignment,
    filename: job.upload.originalname,
    fileDate: job.input.fileDate,
  };
}
