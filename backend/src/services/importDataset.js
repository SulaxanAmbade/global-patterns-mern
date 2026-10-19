import { repairWorkbookRow } from './alignment.js';
import { expandedPairs } from './pairStore.js';
import { datasetRows } from './files.js';
import {
  splitPattern,
  text,
  key,
  basisKey,
  keywords,
  words,
} from './normalize.js';
import { cleanAdmin, adminId, repairAdmins } from './admins.js';
import { auditPattern } from './performance.js';
import { createHash } from 'node:crypto';
export async function importDataset(db, job, progress) {
  let batch = [],
    pairs = [],
    count = 0,
    skipped = 0,
    repairs = 0,
    hasKeywords = false;
  const alignment = {
    patternIdsRecovered: 0,
    languagesRecovered: 0,
    blockingRows: 0,
    missingLanguageRows: 0,
    examples: [],
  };
  let sourceRow = 0;
  const flush = async () => {
    if (batch.length)
      await db.collection('patterns').bulkWrite(batch, { ordered: false });
    if (pairs.length)
      await db.collection('pairs').bulkWrite(pairs, { ordered: false });
    batch = [];
    pairs = [];
    await progress(count);
  };
  for await (const rawRow of datasetRows(
    job.upload.path,
    job.upload.originalname,
  )) {
    sourceRow++;
    const repaired = repairWorkbookRow(rawRow),
      row = repaired.row;
    if (!text(row.url_pattern)) continue;
    repairs += repaired.fixes.length;
    if (repaired.fixes.includes('pattern_id_from_total_count'))
      alignment.patternIdsRecovered++;
    if (repaired.fixes.includes('language_from_url_pattern_order'))
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
    if (Object.hasOwn(row, 'pattern_keywords')) {
      hasKeywords = true;
      try {
        for (const keyword of keywords(row.pattern_keywords)) {
          const p = {
            revision: job._id,
            domain,
            basis,
            basisKey: basisKey(basis),
            keyword,
            keywordKey: key(keyword),
            aliases: [
              ...new Set(
                [basis, r.url_pattern, domain + '*' + basis].map(auditPattern),
              ),
            ],
            language,
            source_pattern: r.url_pattern,
            source_admin_name: r.admin_name,
            source_admin_id: r.updated_admin_id,
          };
          const pid = createHash('sha256')
            .update(
              JSON.stringify([
                r.url_pattern,
                language,
                key(keyword),
                key(r.admin_name),
              ]),
            )
            .digest('hex');
          pairs.push({
            updateOne: {
              filter: { _id: job._id + pid },
              update: { $set: p },
              upsert: true,
            },
          });
        }
      } catch {
        skipped++;
      }
    }
    if (batch.length >= 500 || pairs.length >= 1000) await flush();
  }
  await flush();
  count = await db.collection('patterns').countDocuments({ revision: job._id });
  if (!count)
    throw Error('No usable pattern rows found. Expected a url_pattern column.');
  // An omitted keyword column retains the old private snapshot, matching Streamlit.
  if (!hasKeywords) {
    const remote = db.remote || db;
    const old = await remote.collection('metadata').findOne({ _id: 'active' });
    if (old) {
      let b = [];
      for await (const p of expandedPairs(remote, old)) {
        const { _id, ...rest } = p;
        b.push({
          ...rest,
          _id: createHash('sha256')
            .update(
              JSON.stringify([
                rest.source_pattern,
                rest.language,
                key(rest.keyword),
                key(rest.source_admin_name),
              ]),
            )
            .digest('hex'),
          revision: job._id,
        });
        if (b.length === 500) {
          await db.collection('pairs').insertMany(b);
          b = [];
        }
      }
      if (b.length) await db.collection('pairs').insertMany(b);
    }
  }
  const adminRepairs = await repairAdmins(db, job._id, db.remote || db);
  return {
    count,
    adminRepairs,
    skippedKeywordRows: skipped,
    repairs: repairs + (adminRepairs.repairedRows || 0),
    alignment,
    filename: job.upload.originalname,
    fileDate: job.input.fileDate,
  };
}
