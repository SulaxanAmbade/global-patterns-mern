import { text, key } from './normalize.js';
export function cleanAdmin(value) {
  const v = text(value)
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return ['', 'none', 'nan', 'null', '<na>', 'n/a', '-'].includes(
    v.toLowerCase(),
  )
    ? ''
    : v;
}
export function adminId(value) {
  const original = cleanAdmin(value);
  const input = /^\d{1,3}(?:,\d{3})+(?:\.0+)?$/.test(original)
    ? original.replaceAll(',', '')
    : original;
  const match = input.match(/^\+?(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!match) return original;
  const exponent = Number(match[3] || 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 1000) return original;
  const digits = match[1] + (match[2] || ''),
    point = match[1].length + exponent;
  if (point <= 0) return /^0+$/.test(digits) ? '0' : original;
  if (point < digits.length && !/^0*$/.test(digits.slice(point)))
    return original;
  const integer =
    point >= digits.length
      ? digits + '0'.repeat(point - digits.length)
      : digits.slice(0, point);
  return BigInt(integer || '0').toString();
}
export function baseAdmin(value) {
  return cleanAdmin(value)
    .replace(/(?:\s*\(Lookup\))+\s*$/gi, '')
    .replace(
      /\s+(?:[\[(]\s*)?set[\s_-]*id\s*(?:=|:)\s*[\w.-]+(?:\s*[\])])?\s*$/i,
      '',
    )
    .trim();
}
// Store only distinct admin identities; pattern/keyword rows remain in MongoDB.
export async function repairAdmins(db, revision, historicalDb = db, { repairPairs = true } = {}) {
  const current = await historicalDb
    .collection('metadata')
    .findOne({ _id: 'active' });
  const refs = async (rev, source = db) =>
    source
      .collection('patterns')
      .aggregate(
        [
          { $match: { revision: rev, updated_admin_id: { $ne: '' } } },
          { $group: { _id: { id: '$updated_admin_id', name: '$admin_name' } } },
        ],
        { allowDiskUse: true },
      )
      .toArray();
  const old = current ? await refs(current.revision, historicalDb) : [],
    fresh = await refs(revision),
    known = new Set([...old, ...fresh].map((r) => adminId(r._id.id)));
  const misplaced = (v) => /^\d+$/.test(adminId(v)) || known.has(adminId(v));
  let moved = 0,
    filled = 0,
    recovered = 0,
    overwritten = 0,
    databaseFilled = 0,
    workbookFilled = 0;
  for (const { _id: r } of await db
    .collection('patterns')
    .aggregate(
      [
        { $match: { revision } },
        { $group: { _id: { id: '$updated_admin_id', name: '$admin_name' } } },
      ],
      { allowDiskUse: true },
    )
    .toArray()) {
    if (!r.name || !misplaced(r.name)) continue;
    const id = adminId(r.name);
    const result = await db
      .collection('patterns')
      .updateMany(
        { revision, updated_admin_id: r.id, admin_name: r.name },
        {
          $set: { updated_admin_id: id, admin_name: '', _admin_repaired: true },
        },
      );
    moved += result.modifiedCount;
    if (!r.id) recovered += result.modifiedCount;
    else if (adminId(r.id) !== id) overwritten += result.modifiedCount;
    if (repairPairs) await db
      .collection('pairs')
      .updateMany(
        { revision, source_admin_id: r.id, source_admin_name: r.name },
        { $set: { source_admin_id: id, source_admin_name: '' } },
      );
  }
  function lookup(rows) {
    const map = new Map();
    for (const { _id: r } of rows) {
      const id = adminId(r.id),
        name = baseAdmin(r.name);
      if (!id || !name || misplaced(name)) continue;
      if (!map.has(id)) map.set(id, new Map());
      map.get(id).set(key(name), name);
    }
    return {
      valid: new Map(
        [...map]
          .filter(([, v]) => v.size === 1)
          .map(([id, v]) => [id, [...v.values()][0]]),
      ),
      conflicts: [...map].filter(([, v]) => v.size > 1).map(([id]) => id),
    };
  }
  const historical = lookup(old),
    workbook = lookup(await refs(revision));
  for (const id of await db
    .collection('patterns')
    .distinct('updated_admin_id', { revision, admin_name: '' })) {
    const saved = historical.valid.get(id),
      name = saved || workbook.valid.get(id);
    if (!name) continue;
    const updated = name + ' (Lookup)';
    const result = await db
      .collection('patterns')
      .updateMany(
        { revision, updated_admin_id: id, admin_name: '' },
        { $set: { admin_name: updated, _admin_repaired: true } },
      );
    filled += result.modifiedCount;
    if (saved) databaseFilled += result.modifiedCount;
    else workbookFilled += result.modifiedCount;
    if (repairPairs) await db
      .collection('pairs')
      .updateMany(
        { revision, source_admin_id: id, source_admin_name: '' },
        { $set: { source_admin_name: updated } },
      );
  }
  return {
    misplacedIds: moved,
    recoveredIds: recovered,
    overwrittenIds: overwritten,
    filledNames: filled,
    databaseNamesFilled: databaseFilled,
    workbookNamesFilled: workbookFilled,
    repairedRows: await db
      .collection('patterns')
      .countDocuments({ revision, _admin_repaired: true }),
    unresolvedRows: await db
      .collection('patterns')
      .countDocuments({ revision, admin_name: '' }),
    conflictingIds: [
      ...new Set([...historical.conflicts, ...workbook.conflicts]),
    ].sort(),
  };
}

