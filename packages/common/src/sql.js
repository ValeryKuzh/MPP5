'use strict';

const { GraphQLError } = require('graphql');
const { hashKey } = require('./redis');

const MAX_FILTER_DEPTH = 6;

const badInput = (message) => new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

/** Накопитель параметров запроса: все значения передаются только как $1..$n (защита от SQL-инъекций). */
class Params {
  constructor() {
    this.values = [];
  }
  add(value) {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

const escapeLike = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * SQL для одного поля: поддерживает операторы IntFilter / FloatFilter / StringFilter / DateFilter
 * (eq, ne, gt, gte, lt, lte, in, contains, startsWith) либо скаляр (Boolean / значение).
 */
function operatorSql(field, ops, p) {
  const { expr, ci } = field;
  const col = ci ? `lower(${expr})` : expr;
  const norm = (v) => (ci && typeof v === 'string' ? v.toLowerCase() : v);

  if (ops === null || typeof ops !== 'object') return `${col} = ${p.add(norm(ops))}`;
  if (Array.isArray(ops)) return ops.length ? `${col} = ANY(${p.add(ops.map(norm))})` : 'FALSE';

  const parts = [];
  for (const [op, v] of Object.entries(ops)) {
    if (v === undefined || v === null) continue;
    switch (op) {
      case 'eq': parts.push(`${col} = ${p.add(norm(v))}`); break;
      case 'ne': parts.push(`${col} IS DISTINCT FROM ${p.add(norm(v))}`); break;
      case 'gt': parts.push(`${expr} > ${p.add(v)}`); break;
      case 'gte': parts.push(`${expr} >= ${p.add(v)}`); break;
      case 'lt': parts.push(`${expr} < ${p.add(v)}`); break;
      case 'lte': parts.push(`${expr} <= ${p.add(v)}`); break;
      case 'in': parts.push(v.length ? `${col} = ANY(${p.add(v.map(norm))})` : 'FALSE'); break;
      case 'contains': parts.push(`${expr} ILIKE ${p.add(`%${escapeLike(v)}%`)}`); break;
      case 'startsWith': parts.push(`${expr} ILIKE ${p.add(`${escapeLike(v)}%`)}`); break;
      default: throw badInput(`Unsupported filter operator "${op}"`);
    }
  }
  return parts.length ? parts.join(' AND ') : null;
}

/**
 * Рекурсивно строит WHERE из входного объекта фильтра с логическими AND / OR / NOT.
 * fields: { имяПоля: { expr, ci? } | (value, params) => sql }
 */
function buildFilter(filter, fields, p, depth = 0) {
  if (!filter) return null;
  if (depth > MAX_FILTER_DEPTH) throw badInput(`Filter nesting is limited to ${MAX_FILTER_DEPTH} levels`);
  const parts = [];
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === null) continue;
    if (key === 'AND' || key === 'OR') {
      const sub = value.map((f) => buildFilter(f, fields, p, depth + 1)).filter(Boolean);
      if (sub.length) parts.push(`(${sub.map((s) => `(${s})`).join(key === 'AND' ? ' AND ' : ' OR ')})`);
      continue;
    }
    if (key === 'NOT') {
      const sub = buildFilter(value, fields, p, depth + 1);
      if (sub) parts.push(`NOT (${sub})`);
      continue;
    }
    const field = fields[key];
    if (!field) throw badInput(`Unknown filter field "${key}"`);
    const sql = typeof field === 'function' ? field(value, p) : operatorSql(field, value, p);
    if (sql) parts.push(sql);
  }
  return parts.length ? parts.join(' AND ') : null;
}

/**
 * Превращает [{ field, direction }] в выражения ORDER BY по белому списку полей.
 */
function resolveSort(sortInput, sortFields, fallback) {
  const list = (sortInput && sortInput.length ? sortInput : fallback).slice(0, 3);
  return list.map(({ field, direction }) => {
    const def = sortFields[field];
    if (!def) throw badInput(`Unknown sort field "${field}"`);
    return { expr: def, direction: direction === 'ASC' ? 'ASC' : 'DESC' };
  });
}

function encodeCursor(values) {
  return Buffer.from(JSON.stringify(values)).toString('base64url');
}

function decodeCursor(cursor, length) {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(v) || v.length !== length) throw new Error('shape');
    return v;
  } catch {
    throw badInput('Invalid or stale cursor');
  }
}

/**
 * Keyset (seek) пагинация в формате Relay Connection.
 * В отличие от OFFSET работает за O(log n) на любой странице:
 *   WHERE (k1, k2, id) "после" значений из курсора  ORDER BY k1, k2, id  LIMIT n+1
 * Поддерживает first/after (вперёд) и last/before (назад), totalCount считается лениво
 * (только если поле запрошено) и кэшируется в Redis.
 *
 * ВАЖНО: выражения сортировки должны быть NOT NULL (используйте COALESCE),
 * а параметры, на которые ссылаются выражения сортировки, должны встречаться и в WHERE.
 */
async function paginate({
  db,
  cache,
  cacheKey = 'count',
  from,
  select,
  where = [],
  params,
  sort = [],
  idExpr,
  first,
  after,
  last,
  before,
  defaultSize = 20,
  maxSize = 100,
  mapRow = (r) => r,
}) {
  if (first != null && last != null) throw badInput('Arguments "first" and "last" cannot be used together');
  if ((first != null && first < 0) || (last != null && last < 0)) throw badInput('Page size must be non-negative');
  const backward = last != null || (before != null && first == null);
  const size = Math.min(backward ? (last ?? defaultSize) : (first ?? defaultSize), maxSize);

  const keys = [...sort, { expr: idExpr, direction: 'ASC' }];
  const baseWhere = where.filter(Boolean);
  const countParams = params.values.slice();
  const countSql = `SELECT count(*)::int AS c FROM ${from}${baseWhere.length ? ` WHERE ${baseWhere.join(' AND ')}` : ''}`;

  const conds = [...baseWhere];
  const cursor = backward ? before : after;
  if (cursor) {
    const vals = decodeCursor(cursor, keys.length);
    const ors = keys.map((k, i) => {
      const eqs = keys.slice(0, i).map((kk, j) => `${kk.expr} = ${params.add(vals[j])}`);
      const forwardOp = k.direction === 'ASC' ? '>' : '<';
      const op = backward ? (forwardOp === '>' ? '<' : '>') : forwardOp;
      return `(${[...eqs, `${k.expr} ${op} ${params.add(vals[i])}`].join(' AND ')})`;
    });
    conds.push(`(${ors.join(' OR ')})`);
  }

  const orderBy = keys
    .map((k) => `${k.expr} ${(k.direction === 'ASC') !== backward ? 'ASC' : 'DESC'}`)
    .join(', ');
  const keySelect = keys.map((k, i) => `${k.expr} AS __k${i}`).join(', ');
  const sql = `SELECT ${select}, ${keySelect} FROM ${from}${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''} ORDER BY ${orderBy} LIMIT ${size + 1}`;

  const { rows } = size === 0 ? { rows: [] } : await db.query(sql, params.values);
  const hasMore = rows.length > size;
  const pageRows = rows.slice(0, size);
  if (backward) pageRows.reverse();

  const edges = pageRows.map((row) => {
    const vals = keys.map((_, i) => {
      const v = row[`__k${i}`];
      delete row[`__k${i}`];
      return v instanceof Date ? v.toISOString() : v;
    });
    return { cursor: encodeCursor(vals), node: mapRow(row) };
  });

  const countFn = () => db.query(countSql, countParams).then((r) => r.rows[0].c);

  return {
    edges,
    nodes: edges.map((e) => e.node),
    pageInfo: {
      hasNextPage: backward ? Boolean(before) : hasMore,
      hasPreviousPage: backward ? hasMore : Boolean(after),
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges[edges.length - 1]?.cursor ?? null,
    },
    // вызывается default-резолвером graphql-js только если поле totalCount запрошено
    totalCount: () => (cache ? cache.wrap(`${cacheKey}:${hashKey(countSql, countParams)}`, 120, countFn) : countFn()),
  };
}

module.exports = {
  Params,
  buildFilter,
  operatorSql,
  resolveSort,
  paginate,
  badInput,
  escapeLike,
  encodeCursor,
  decodeCursor,
};
