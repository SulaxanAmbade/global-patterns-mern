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
import {
  cleanAdmin,
  adminId,
  repairAdmins,
} from './admins.js';
import { auditPattern } from './performance.js';
import { createHash } from 'node:crypto';

export async function importDataset(db, job, progress) {
  const startedAt = performance.now();
  const timings = {};

  // Local insertMany performs transactional upserts.
  // Import rows are complete snapshots.
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

  console.log(
    '[Import] Reading and repairing workbook rows...',
  );

  let batch = [];
  let pairs = [];
  let count = 0;
  let skipped = 0;
  let repairs = 0;
  let hasKeywords = false;

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
    await write('pairs', pairs);

    batch = [];
    pairs = [];

    await progress(count);
  };

  for await (const rawRow of datasetRows(
    job.upload.path,
    job.upload.originalname,
  )) {
    sourceRow++;

    const repaired = repairWorkbookRow(rawRow);
    const row = repaired.row;

    if (!text(row.url_pattern)) continue;

    repairs += repaired.fixes.length;

    if (
      repaired.fixes.includes(
        'pattern_id_from_total_count',
      )
    ) {
      alignment.patternIdsRecovered++;
    }

    if (
      repaired.fixes.some(
        (fix) =>
          fix === 'language_from_url_pattern_order' ||
          fix === 'language_from_url_pattern',
      )
    ) {
      alignment.languagesRecovered++;
    }

    if (repaired.missingLanguage) {
      alignment.missingLanguageRows++;
    }

    if (repaired.issue) {
      alignment.blockingRows++;

      if (alignment.examples.length < 20) {
        alignment.examples.push({
          dataRow: sourceRow,
          url_pattern: row.url_pattern,
          originalLanguage: repaired.originalLanguage,
          issue: repaired.issue,
        });
      }
    }

    const [domain, basis] = splitPattern(
      row.url_pattern,
    );

    const language = row.language_code;
    const id = text(row.url_pattern_id);

    const pattern = {
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
      ...(repaired.issue
        ? { _alignment_issue: repaired.issue }
        : {}),
    };

    const identity = createHash('sha256')
      .update(JSON.stringify(pattern))
      .digest('hex');

    count++;

    batch.push({
      updateOne: {
        filter: {
          _id: job._id + identity,
        },
        update: {
          $set: pattern,
        },
        upsert: true,
      },
    });

    if (Object.hasOwn(row, 'pattern_keywords')) {
      hasKeywords = true;

      let parsedKeywords;

      try {
        parsedKeywords = keywords(
          row.pattern_keywords,
        );
      } catch {
        skipped++;
        parsedKeywords = [];
      }

      // Compute shared values once for this source row.
      const common = {
        revision: job._id,
        domain,
        basis,
        basisKey: pattern.basisKey,
        aliases: [
          ...new Set(
            [
              basis,
              pattern.url_pattern,
              domain + '*' + basis,
            ].map(auditPattern),
          ),
        ],
        language,
        source_pattern: pattern.url_pattern,
        source_admin_name: pattern.admin_name,
        source_admin_id: pattern.updated_admin_id,
      };

      const adminKey = key(pattern.admin_name);

      for (const keyword of parsedKeywords) {
        const keywordKey = key(keyword);

        const pair = {
          ...common,
          keyword,
          keywordKey,
        };

        const pairId = createHash('sha256')
          .update(
            JSON.stringify([
              pattern.url_pattern,
              language,
              keywordKey,
              adminKey,
            ]),
          )
          .digest('hex');

        pairs.push({
          updateOne: {
            filter: {
              _id: job._id + pairId,
            },
            update: {
              $set: pair,
            },
            upsert: true,
          },
        });

        // Bound memory even for unusually large keyword cells.
        if (pairs.length >= 100000) {
          await flush();
        }
      }
    }

    if (
      batch.length >= 50000 ||
      pairs.length >= 100000
    ) {
      await flush();
    }
  }

  await flush();

  timings.parseAndStageMs = Math.round(
    performance.now() - startedAt,
  );

  console.log(
    `[Import] Parsing and staging complete in ${timings.parseAndStageMs} ms.`,
  );

  count = await db
    .collection('patterns')
    .countDocuments({
      revision: job._id,
    });

  if (!count) {
    throw Error(
      'No usable pattern rows found. Expected a url_pattern column.',
    );
  }

  const retentionStartedAt = performance.now();

  // Preserve existing keywords when the column is omitted.
  if (!hasKeywords) {
    console.log(
      '[Import] Retaining existing keyword mappings...',
    );

    const remote = db.remote || db;

    const old = await remote
      .collection('metadata')
      .findOne({ _id: 'active' });

    if (old) {
      let retained = [];

      for await (const pair of expandedPairs(
        remote,
        old,
      )) {
        const { _id, ...rest } = pair;

        retained.push({
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

        if (retained.length === 50000) {
          await db
            .collection('pairs')
            .insertMany(retained);

          retained = [];
        }
      }

      if (retained.length) {
        await db
          .collection('pairs')
          .insertMany(retained);
      }
    }
  }

  timings.retainKeywordsMs = Math.round(
    performance.now() - retentionStartedAt,
  );

  console.log(
    '[Import] Repairing admin identities...',
  );

  const adminStartedAt = performance.now();

  const adminRepairs = await repairAdmins(
    db,
    job._id,
    db.remote || db,
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

  return {
    timings,
    count,
    adminRepairs,
    skippedKeywordRows: skipped,
    repairs:
      repairs + (adminRepairs.repairedRows || 0),
    alignment,
    filename: job.upload.originalname,
    fileDate: job.input.fileDate,
  };
}