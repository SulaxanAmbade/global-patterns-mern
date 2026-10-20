import {
  repairWorkbookRow,
  headerName,
} from './alignment.js';
import { datasetRows } from './files.js';
import {
  splitPattern,
  text,
  basisKey,
  words,
} from './normalize.js';
import {
  cleanAdmin,
  adminId,
  repairAdmins,
} from './admins.js';
import { createHash } from 'node:crypto';

const patternFields = new Set([
  'url_pattern',
  'url_pattern_id',
  'priority',
  'language_code',
  'admin_name',
  'updated_admin_id',
  'total_count',
  'url_pattern_order',
]);

export async function importDataset(db, job, progress) {
  const startedAt = performance.now();
  const timings = {};

  let readMs = 0;
  let transformMs = 0;
  let stageWriteMs = 0;
  let progressMs = 0;
  let flushes = 0;
  let stagedRows = 0;
  let duplicatesSkipped = 0;
  let cacheHits = 0;

  // Keep memory bounded. SQLite still handles duplicates that fall
  // outside these cache limits.
  const seenIds = new Set();
  const recent = new Map();
  let recentCharacters = 0;

  const remember = (signature, summary) => {
    if (signature.length > 4096) return;

    while (
      recent.size &&
      (
        recent.size >= 4096 ||
        recentCharacters + signature.length > 2 * 1024 * 1024
      )
    ) {
      const oldest = recent.keys().next().value;
      recentCharacters -= oldest.length;
      recent.delete(oldest);
    }

    recent.set(signature, summary);
    recentCharacters += signature.length;
  };

  const local = db.local || (db.filename ? db : null);

  const write = async (name, operations) => {
    if (!operations.length) return;

    if (local) {
      await local.collection(name).insertMany(
        operations.map(({ updateOne }) => ({
          ...updateOne.filter,
          ...updateOne.update.$set,
        })),
      );
    } else {
      await db.collection(name).bulkWrite(
        operations,
        { ordered: false },
      );
    }
  };

  console.log('[Import] Reading and repairing workbook rows...');

  let batch = [];
  let count = 0;
  let repairs = 0;
  let sourceRow = 0;

  const alignment = {
    patternIdsRecovered: 0,
    languagesRecovered: 0,
    blockingRows: 0,
    missingLanguageRows: 0,
    examples: [],
  };

  // Count repairs and alignment issues for every source row,
  // including rows whose pattern was already staged.
  const recordDiagnostics = (summary) => {
    count++;
    repairs += summary.fixes.length;

    if (
      summary.fixes.includes('pattern_id_from_total_count')
    ) {
      alignment.patternIdsRecovered++;
    }

    if (
      summary.fixes.some(
        (fix) =>
          fix === 'language_from_url_pattern_order' ||
          fix === 'language_from_url_pattern',
      )
    ) {
      alignment.languagesRecovered++;
    }

    if (summary.missingLanguage) {
      alignment.missingLanguageRows++;
    }

    if (summary.issue) {
      alignment.blockingRows++;

      if (alignment.examples.length < 20) {
        alignment.examples.push({
          dataRow: sourceRow,
          url_pattern: summary.urlPattern,
          originalLanguage: summary.originalLanguage,
          issue: summary.issue,
        });
      }
    }
  };

  const flush = async () => {
    const writingStarted = performance.now();

    try {
      await write('patterns', batch);
    } finally {
      stageWriteMs += performance.now() - writingStarted;
    }

    if (batch.length) flushes++;
    batch = [];

    const progressStarted = performance.now();

    try {
      await progress(count);
    } finally {
      progressMs += performance.now() - progressStarted;
    }
  };

  const iterator = datasetRows(
    job.upload.path,
    job.upload.originalname,
  )[Symbol.asyncIterator]();

  try {
    while (true) {
      const readingStarted = performance.now();
      let next;

      try {
        next = await iterator.next();
      } finally {
        readMs += performance.now() - readingStarted;
      }

      if (next.done) break;

      const rawRow = next.value;
      const transformStarted = performance.now();

      try {
        sourceRow++;

        // Ignore keyword columns and other fields that do not
        // affect the shared pattern record or alignment repairs.
        const patternRow = Object.fromEntries(
          Object.entries(rawRow).filter(([name]) =>
            patternFields.has(headerName(name)),
          ),
        );

        const signature = JSON.stringify(patternRow);
        const cached = recent.get(signature);

        if (cached) {
          recent.delete(signature);
          recent.set(signature, cached);

          recordDiagnostics(cached);
          cacheHits++;
          duplicatesSkipped++;
          continue;
        }

        const repaired = repairWorkbookRow(patternRow);
        const row = repaired.row;

        if (!text(row.url_pattern)) continue;

        const summary = {
          fixes: repaired.fixes,
          missingLanguage: repaired.missingLanguage,
          issue: repaired.issue,
          originalLanguage: repaired.originalLanguage,
          urlPattern: row.url_pattern,
        };

        recordDiagnostics(summary);

        const [domain, basis] = splitPattern(row.url_pattern);

        const r = {
          url_pattern: text(row.url_pattern),
          url_pattern_id: text(row.url_pattern_id),
          priority: text(row.priority),
          language_code: row.language_code,
          admin_name: cleanAdmin(row.admin_name),
          updated_admin_id: adminId(row.updated_admin_id),
          domain,
          basis,
          basisKey: basisKey(basis),
          normalized: words(row.url_pattern).join(' '),
          length: text(row.url_pattern).length,
          revision: job._id,
          ...(repaired.issue
            ? { _alignment_issue: repaired.issue }
            : {}),
        };

        const identity = createHash('sha256')
          .update(JSON.stringify(r))
          .digest('hex');

        remember(signature, summary);

        // Different raw spellings may produce the same repaired
        // pattern. Avoid staging that pattern again.
        if (seenIds.has(identity)) {
          duplicatesSkipped++;
          continue;
        }

        if (seenIds.size < 100000) {
          seenIds.add(identity);
        }

        stagedRows++;

        batch.push({
          updateOne: {
            filter: {
              _id: job._id + identity,
            },
            update: {
              $set: r,
            },
            upsert: true,
          },
        });
      } finally {
        transformMs += performance.now() - transformStarted;
      }

      if (batch.length >= 5000) {
        await flush();
      }
    }
  } finally {
    const closingStarted = performance.now();

    try {
      await iterator.return?.();
    } finally {
      readMs += performance.now() - closingStarted;
    }
  }

  await flush();

  const parseAndStageMs = performance.now() - startedAt;

  Object.assign(timings, {
    readMs: Math.round(readMs),
    transformMs: Math.round(transformMs),
    stageWriteMs: Math.round(stageWriteMs),
    progressMs: Math.round(progressMs),
    otherMs: Math.round(
      Math.max(
        0,
        parseAndStageMs -
          readMs -
          transformMs -
          stageWriteMs -
          progressMs,
      ),
    ),
    parseAndStageMs: Math.round(parseAndStageMs),
  });

  console.log(
    `[Import] Parsing and staging complete in ${timings.parseAndStageMs} ms.`,
  );

  console.log(
    '[Import] Stage timings:',
    JSON.stringify({
      ...timings,
      sourceRows: sourceRow,
      stagedRows,
      duplicatesSkipped,
      cacheHits,
      flushes,
    }),
  );

  const countingStarted = performance.now();

  count = await db.collection('patterns').countDocuments({
    revision: job._id,
  });

  timings.countVerificationMs = Math.round(
    performance.now() - countingStarted,
  );

  if (!count) {
    throw Error(
      'No usable pattern rows found. Expected a url_pattern column.',
    );
  }

  timings.retainKeywordsMs = 0;

  console.log('[Import] Repairing admin identities...');

  const adminStartedAt = performance.now();

  const adminRepairs = await repairAdmins(
    db,
    job._id,
    db.remote || db,
    { repairPairs: false },
  );

  timings.adminRepairsMs = Math.round(
    performance.now() - adminStartedAt,
  );

  timings.totalMs = Math.round(
    performance.now() - startedAt,
  );

  console.log(
    `[Import] Preview ready: ${count} patterns in ${timings.totalMs} ms.`,
  );

  console.log(
    '[Import] Complete timings:',
    JSON.stringify(timings),
  );

  return {
    timings,
    count,
    adminRepairs,
    skippedKeywordRows: 0,
    keywordPairsStored: false,
    sourceRows: sourceRow,
    stagedRows,
    duplicatesSkipped,
    cacheHits,
    repairs: repairs + (adminRepairs.repairedRows || 0),
    alignment,
    filename: job.upload.originalname,
    fileDate: job.input.fileDate,
  };
}