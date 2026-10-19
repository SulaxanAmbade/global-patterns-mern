import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { storage } from '../config.js';

const tables = new Set([
  'patterns',
  'pairs',
  'scratch',
  'jobRows',
]);

export function localPath(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw Error('Invalid local job ID');
  }

  return path.join(storage, id + '.sqlite');
}

const field = (name) =>
  name === '_id'
    ? 'id'
    : `json_extract(payload, '$.${String(name).replaceAll("'", "''")}')`;

function where(query = {}) {
  const args = [];

  const compile = (q) =>
    Object.entries(q)
      .map(([name, value]) => {
        if (name === '$or' || name === '$and') {
          return (
            '(' +
            value
              .map(compile)
              .join(name === '$or' ? ' OR ' : ' AND ') +
            ')'
          );
        }

        const f = field(name);

        if (
          value &&
          typeof value === 'object' &&
          !Array.isArray(value)
        ) {
          return Object.entries(value)
            .map(([op, v]) => {
              if (op === '$in' || op === '$nin') {
                if (!v.length) {
                  return op === '$in' ? '0' : '1';
                }

                args.push(
                  ...v.map((x) =>
                    typeof x === 'boolean'
                      ? Number(x)
                      : (x ?? null),
                  ),
                );

                return `${f} ${
                  op === '$in' ? 'IN' : 'NOT IN'
                } (${v.map(() => '?').join(',')})`;
              }

              if (op === '$exists') {
                return `${f} IS ${v ? 'NOT ' : ''}NULL`;
              }

              const operators = {
                $ne: 'IS NOT',
                $gte: '>=',
                $gt: '>',
                $lte: '<=',
                $lt: '<',
                $eq: 'IS',
              };

              if (!operators[op]) {
                throw Error(
                  'Unsupported local query operator: ' + op,
                );
              }

              args.push(
                typeof v === 'boolean'
                  ? Number(v)
                  : (v ?? null),
              );

              return `${f} ${operators[op]} ?`;
            })
            .join(' AND ');
        }

        args.push(
          typeof value === 'boolean'
            ? Number(value)
            : (value ?? null),
        );

        return `${f} IS ?`;
      })
      .join(' AND ') || '1';

  return {
    sql: compile(query),
    args,
  };
}

export function openLocal(id, { existing = false } = {}) {
  const filename = localPath(id);

  if (existing && !fs.existsSync(filename)) {
    throw Object.assign(
      Error(
        'Local report or preview has expired. Run the check again.',
      ),
      { status: 410 },
    );
  }

  fs.mkdirSync(storage, { recursive: true });

  const db = new DatabaseSync(filename);

  db.exec(
    'PRAGMA busy_timeout=10000; ' +
    'PRAGMA cache_size=-8192; ' +
    'PRAGMA temp_store=FILE;',
  );

  for (const table of tables) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS "${table}" (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      )`,
    );
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS result_seq
    ON jobRows(json_extract(payload,'$.seq'));

    CREATE INDEX IF NOT EXISTS pattern_source
    ON patterns(
      json_extract(payload,'$.url_pattern'),
      json_extract(payload,'$.language_code'),
      json_extract(payload,'$.admin_name')
    );

    CREATE INDEX IF NOT EXISTS scratch_key
    ON scratch(json_extract(payload,'$.key'));

    CREATE INDEX IF NOT EXISTS scratch_group
    ON scratch(
      json_extract(payload,'$.eligible'),
      json_extract(payload,'$.bkey'),
      json_extract(payload,'$.language'),
      json_extract(payload,'$.domain')
    );

    CREATE INDEX IF NOT EXISTS pattern_admin
    ON patterns(
      json_extract(payload,'$.revision'),
      json_extract(payload,'$.updated_admin_id'),
      json_extract(payload,'$.admin_name')
    );

    CREATE INDEX IF NOT EXISTS pair_admin
    ON pairs(
      json_extract(payload,'$.revision'),
      json_extract(payload,'$.source_admin_id'),
      json_extract(payload,'$.source_admin_name')
    );
  `);

  // Reuse compiled statements across rows.
  const statements = new Map();

  function prepare(sql) {
    if (!statements.has(sql)) {
      if (statements.size >= 128) {
        statements.delete(
          statements.keys().next().value,
        );
      }

      statements.set(sql, db.prepare(sql));
    }

    return statements.get(sql);
  }

  const collections = new Map();

  const collection = (table) => {
    if (collections.has(table)) {
      return collections.get(table);
    }

    if (!tables.has(table)) {
      throw Error('Unsupported local collection');
    }

    const put = prepare(
      `INSERT INTO "${table}"(id,payload)
       VALUES(?,?)
       ON CONFLICT(id)
       DO UPDATE SET payload=excluded.payload`,
    );

    const save = (row) => {
      const r = {
        ...row,
        _id: String(row._id ?? randomUUID()),
      };

      put.run(r._id, JSON.stringify(r));

      return r;
    };

    const cursor = (
      query = {},
      rawSql,
      rawArgs,
      decode = (r) => JSON.parse(r.payload),
    ) => {
      const w = where(query);

      let order = '';
      let skip = 0;
      let limit;
      let projection;

      const c = {
        sort(o) {
          order =
            ' ORDER BY ' +
            Object.entries(o)
              .map(
                ([k, v]) =>
                  `${field(k)} ${
                    v < 0 ? 'DESC' : 'ASC'
                  }`,
              )
              .join(',');

          return c;
        },

        skip(n) {
          skip = n;
          return c;
        },

        limit(n) {
          limit = n;
          return c;
        },

        project(p) {
          projection = p;
          return c;
        },

        batchSize() {
          return c;
        },

        async *[Symbol.asyncIterator]() {
          const sql =
            (rawSql ||
              `SELECT payload FROM "${table}"
               WHERE ${w.sql}`) +
            order +
            (limit !== undefined
              ? ` LIMIT ${Math.max(0, limit)}
                  OFFSET ${Math.max(0, skip)}`
              : skip
                ? ` LIMIT -1 OFFSET ${skip}`
                : '');

          for (const value of prepare(sql).iterate(
            ...(rawArgs || w.args),
          )) {
            let row = decode(value);

            if (projection) {
              const include = Object.entries(projection)
                .filter(([, v]) => v)
                .map(([k]) => k);

              row = include.length
                ? Object.fromEntries(
                    ['_id', ...include]
                      .filter((k) => k in row)
                      .map((k) => [k, row[k]]),
                  )
                : Object.fromEntries(
                    Object.entries(row).filter(
                      ([k]) => projection[k] !== 0,
                    ),
                  );
            }

            yield row;
          }
        },

        async toArray() {
          const out = [];

          for await (const r of c) {
            out.push(r);
          }

          return out;
        },

        stream() {
          return Readable.from(c);
        },

        async close() {},
      };

      return c;
    };

    const update = (filter, changes, upsert) => {
      const w = where(filter);

      const value = prepare(
        `SELECT payload FROM "${table}"
         WHERE ${w.sql} LIMIT 1`,
      ).get(...w.args);

      if (!value && !upsert) {
        return { modifiedCount: 0 };
      }

      const row = value
        ? JSON.parse(value.payload)
        : {
            ...filter,
            ...changes.$setOnInsert,
          };

      Object.assign(row, changes.$set || {});

      for (const [k, v] of Object.entries(
        changes.$inc || {},
      )) {
        row[k] = (row[k] || 0) + v;
      }

      save(row);

      return { modifiedCount: 1 };
    };

    const api = {
      find: cursor,

      async findOne(q) {
        return (
          (await cursor(q).limit(1).toArray())[0] ||
          null
        );
      },

      async countDocuments(q = {}) {
        const w = where(q);

        return prepare(
          `SELECT count(*) AS n FROM "${table}"
           WHERE ${w.sql}`,
        ).get(...w.args).n;
      },

      async insertMany(rows) {
        db.exec('BEGIN');

        try {
          for (const row of rows) {
            save(row);
          }

          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },

      async updateOne(q, u, o = {}) {
        return update(q, u, o.upsert);
      },

      async updateMany(q, u) {
        // Update matching rows in one atomic statement.
        if (
          Object.keys(u).every(
            (name) => name === '$set',
          )
        ) {
          const entries = Object.entries(
            u.$set || {},
          );

          if (!entries.length) {
            return { modifiedCount: 0 };
          }

          const w = where(q);

          const args = entries.flatMap(
            ([name, value]) => [
              '$.' + name,
              JSON.stringify(value ?? null),
            ],
          );

          const replacements = entries
            .map(() => '?,json(?)')
            .join(',');

          const result = prepare(
            `UPDATE "${table}"
             SET payload=json_set(
               payload,${replacements}
             )
             WHERE ${w.sql}`,
          ).run(...args, ...w.args);

          return {
            modifiedCount: Number(result.changes),
          };
        }

        let n = 0;

        db.exec('BEGIN');

        try {
          for await (const row of cursor(q)) {
            update({ _id: row._id }, u, false);
            n++;
          }

          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }

        return { modifiedCount: n };
      },

      async bulkWrite(ops) {
        db.exec('BEGIN');

        try {
          for (const { updateOne: o } of ops) {
            update(o.filter, o.update, o.upsert);
          }

          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },

      async deleteMany(q = {}) {
        const w = where(q);

        const result = prepare(
          `DELETE FROM "${table}"
           WHERE ${w.sql}`,
        ).run(...w.args);

        return {
          deletedCount: Number(result.changes),
        };
      },

      async distinct(name, q = {}) {
        const w = where(q);

        return prepare(
          `SELECT DISTINCT ${field(name)} AS v
           FROM "${table}" WHERE ${w.sql}`,
        )
          .all(...w.args)
          .map((r) => r.v);
      },

      aggregate(pipeline) {
        const match =
          pipeline.find((p) => p.$match)?.$match ||
          {};

        const group =
          pipeline.find((p) => p.$group)?.$group;

        if (!group) {
          throw Error(
            'Local aggregation requires a group',
          );
        }

        const keys = Object.entries(group._id || {});
        const w = where(match);

        const select = keys.map(
          ([k, v], i) =>
            `${field(v.slice(1))} AS g${i}`,
        );

        const averages = Object.entries(group).filter(
          ([k]) => k !== '_id',
        );

        for (const [name, expr] of averages) {
          select.push(
            `avg(${field(expr.$avg.slice(1))})
             AS "${name}"`,
          );
        }

        return cursor(
          {},
          `SELECT ${select.join(',')}
           FROM "${table}" WHERE ${w.sql}` +
            (keys.length
              ? ' GROUP BY ' +
                keys.map((_, i) => 'g' + i).join(',')
              : ''),
          w.args,
          (r) => ({
            _id: Object.fromEntries(
              keys.map(([k], i) => [
                k,
                r['g' + i],
              ]),
            ),
            ...Object.fromEntries(
              averages.map(([k]) => [k, r[k]]),
            ),
          }),
        );
      },
    };

    collections.set(table, api);

    return api;
  };

  return {
    collection,
    close: () => db.close(),
    filename,
  };
}

export function jobDatabase(remote, job) {
  const local = openLocal(job._id);

  const names =
    job.kind === 'import'
      ? tables
      : new Set(['scratch', 'jobRows']);

  return {
    remote,
    local,
    collection: (name) =>
      names.has(name)
        ? local.collection(name)
        : remote.collection(name),
  };
}