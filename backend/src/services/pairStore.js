import { key } from './normalize.js';
import { auditPattern, decorateDomain } from './performance.js';
export async function* expandedPairs(db, metadata) {
  if (!metadata) return;
  if (metadata.schemaVersion !== 2) {
    yield* db
      .collection('pairs')
      .find({ revision: metadata.revision })
      .batchSize(500);
    return;
  }
  for await (const p of db.collection('pairs').aggregate(
    [
      {
        $lookup: {
          from: 'patterns',
          localField: 'patternId',
          foreignField: '_id',
          as: 'source',
        },
      },
      { $unwind: '$source' },
      { $match: { 'source.revision': metadata.revision } },
    ],
    { batchSize: 500 },
  )) {
    const r = p.source;
    yield {
      ...p,
      domain: r.domain,
      basis: r.basis,
      language: r.language_code,
      source_pattern: r.url_pattern,
      source_admin_name: r.admin_name,
      source_admin_id: r.updated_admin_id,
    };
  }
}
export async function liveMappings(
  db,
  revision,
  basis,
  keywordKey,
  language = '',
  domain = '',
) {
  const active = await db.collection('metadata').findOne({ _id: 'active' });
  if (active?.revision !== revision)
    throw Object.assign(
      Error('The shared dataset changed. Run the performance check again.'),
      { status: 409 },
    );
  const languageVariants = language ? [...new Set([
    language.toLowerCase().replaceAll('_', '-'),
    language.toUpperCase().replaceAll('_', '-'),
    language.toLowerCase().replaceAll('-', '_'),
    language.toUpperCase().replaceAll('-', '_'),
  ])] : [];
  const result = [],
    seen = new Set();
  const add = (r, p) => {
    const decorated = decorateDomain(r.domain, r.admin_name);
    if (domain && key(decorated.domain) !== domain) return;
    const m = {
      ...decorated,
      basis: r.basis,
      keywords: p.keyword,
      languagecode: r.language_code,
      priority: r.priority,
    };
    const id = JSON.stringify(m);
    if (!seen.has(id)) {
      result.push(m);
      seen.add(id);
    }
  };
  if (active.schemaVersion === 2) {
    const filter = { revision, aliases: auditPattern(basis) };
    if (language) filter.language_code = { $in: languageVariants };
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      const patterns = new Map(batch.map((p) => [p._id, p]));
      for await (const pair of db
        .collection('pairs')
        .find({ patternId: { $in: [...patterns.keys()] }, keywordKey })
        .batchSize(500))
        add(patterns.get(pair.patternId), pair);
      batch = [];
    };
    for await (const r of db
      .collection('patterns')
      .find(filter)
      .batchSize(500)) {
      batch.push(r);
      if (batch.length === 500) await flush();
    }
    await flush();
  } else {
    const filter = { revision, aliases: auditPattern(basis), keywordKey };
    if (language) filter.language = { $in: languageVariants };
    for await (const p of db.collection('pairs').find(filter).batchSize(500)) {
      const r = await db.collection('patterns').findOne({
        revision,
        url_pattern: p.source_pattern,
        language_code: p.language,
        ...(p.source_admin_name !== undefined
          ? { admin_name: p.source_admin_name }
          : {}),
      });
      if (r) add(r, p);
    }
  }
  return result;
}
