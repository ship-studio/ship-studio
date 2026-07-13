/**
 * Meno-style declarative filter engine — pure and dependency-free.
 *
 * Borrowed capability from the Meno web builder's documented `meno-filter-api`
 * (https://meno.so/docs/meno-filter-api): a small, declarative, data-in →
 * data-out filter spec. Reimplemented here as pure functions with no DOM, no
 * Meno runtime, and no coupling to Ship Studio's editor/proxy/framework
 * detection — so it can safely back any in-app list. Its first consumer is the
 * visual editor's element-tree search (see {@link module:lib/elementTreeFilter}).
 *
 * Spec implemented:
 *  - Operators: `$eq $neq $gt $gte $lt $lte $contains $notContains $startsWith
 *    $endsWith $in $nin $empty`.
 *  - A field constraint is either a raw value (implicit `$eq`) or an operator
 *    object `{ $op: value, … }` whose operators are AND-ed together. Multiple
 *    fields in a filter are AND-ed together.
 *  - Bypass values — `'*'`, `''`, `null`, `undefined` — mean "no constraint on
 *    this field" (match everything for that field).
 *
 * Faithful-but-bounded choices: comparisons (`$gt`…`$lte`) apply only when both
 * sides are the same comparable kind (number or string); `$startsWith` /
 * `$endsWith` are case-insensitive (per the docs) and string-only; `$eq` is
 * strict equality. Field access is flat (no nested dot-paths).
 *
 * Deliberately NOT implemented (see `.redline-loop/REVIEW_QUEUE.md`): sort,
 * pagination, URL-sync, the `data-meno-*` DOM layer, and nested dot-path fields —
 * none have a consumer yet.
 *
 * @module lib/menoFilter
 */

/** The thirteen documented filter operators. */
export interface FilterOperators {
  $eq?: unknown;
  $neq?: unknown;
  $gt?: number | string;
  $gte?: number | string;
  $lt?: number | string;
  $lte?: number | string;
  $contains?: unknown;
  $notContains?: unknown;
  $startsWith?: string;
  $endsWith?: string;
  $in?: unknown[];
  $nin?: unknown[];
  $empty?: boolean;
}

/**
 * A per-field constraint: either an operator object ({@link FilterOperators}) or
 * a raw value treated as an implicit `$eq`. Raw values can be anything, so this
 * is `unknown`; {@link matchesFilter} disambiguates at runtime via the
 * operator-object check.
 */
export type FieldConstraint = unknown;

/** A filter maps field names to constraints; fields are AND-ed together. */
export type Filter = Record<string, FieldConstraint>;

const OPERATOR_KEYS: ReadonlySet<string> = new Set([
  '$eq',
  '$neq',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$contains',
  '$notContains',
  '$startsWith',
  '$endsWith',
  '$in',
  '$nin',
  '$empty',
]);

/** True for a non-null, non-array object (an object literal / record). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A field constraint is an operator object only when it is a non-empty plain
 * object whose every key is a known operator. Anything else (including a plain
 * object with non-operator keys) is treated as a literal `$eq` value.
 */
function isOperatorObject(v: unknown): v is FilterOperators {
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => OPERATOR_KEYS.has(k));
}

/** `'*'`, `''`, `null`, `undefined` bypass the field (match everything). */
function isBypass(constraint: unknown): boolean {
  return constraint === '*' || constraint === '' || constraint === null || constraint === undefined;
}

/** Whether a value counts as empty for the `$empty` operator: null, undefined, '', or []. */
function isEmptyValue(actual: unknown): boolean {
  return (
    actual === null ||
    actual === undefined ||
    actual === '' ||
    (Array.isArray(actual) && actual.length === 0)
  );
}

/** Substring test for strings; membership test for arrays; false otherwise. */
function containsValue(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'string') return actual.includes(String(expected));
  if (Array.isArray(actual)) return actual.includes(expected);
  return false;
}

/** Ordering comparison, defined only when both sides share a comparable kind. */
function gt(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a > b;
  if (typeof a === 'string' && typeof b === 'string') return a > b;
  return false;
}

/** Strict less-than, defined only when both sides share a comparable kind (number or string). */
function lt(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a < b;
  if (typeof a === 'string' && typeof b === 'string') return a < b;
  return false;
}

/** Lower-case both sides for case-insensitive string ops; null when either side isn't a string. */
function caseFold(a: unknown, b: unknown): { actual: string; expected: string } | null {
  if (typeof a !== 'string' || typeof b !== 'string') return null;
  return { actual: a.toLowerCase(), expected: b.toLowerCase() };
}

/**
 * Evaluate a single operator against an `actual`/`expected` pair. Only known
 * operators reach here (admitted by {@link isOperatorObject}); the default arm is
 * unreachable and returns false.
 */
function evalOperator(op: string, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case '$eq':
      return actual === expected;
    case '$neq':
      return actual !== expected;
    case '$gt':
      return gt(actual, expected);
    case '$gte':
      return actual === expected || gt(actual, expected);
    case '$lt':
      return lt(actual, expected);
    case '$lte':
      return actual === expected || lt(actual, expected);
    case '$contains':
      return containsValue(actual, expected);
    case '$notContains':
      return !containsValue(actual, expected);
    case '$startsWith': {
      const f = caseFold(actual, expected);
      return f !== null && f.actual.startsWith(f.expected);
    }
    case '$endsWith': {
      const f = caseFold(actual, expected);
      return f !== null && f.actual.endsWith(f.expected);
    }
    case '$in':
      return Array.isArray(expected) && expected.includes(actual);
    case '$nin':
      return !Array.isArray(expected) || !expected.includes(actual);
    case '$empty':
      return expected ? isEmptyValue(actual) : !isEmptyValue(actual);
    default:
      // Unreachable: isOperatorObject only admits known operators.
      return false;
  }
}

/** Does `actual` satisfy every operator in `ops` (AND)? */
function matchesOperators(actual: unknown, ops: FilterOperators): boolean {
  for (const [op, expected] of Object.entries(ops)) {
    if (!evalOperator(op, actual, expected)) return false;
  }
  return true;
}

/**
 * Test one record against a filter. All fields must pass (AND). A field whose
 * constraint is a bypass value imposes no constraint. A raw-value constraint is
 * an implicit `$eq`; an operator object AND-s its operators.
 */
export function matchesFilter(record: Record<string, unknown>, filter: Filter): boolean {
  for (const [field, constraint] of Object.entries(filter)) {
    if (isBypass(constraint)) continue;
    const actual = record[field];
    if (isOperatorObject(constraint)) {
      if (!matchesOperators(actual, constraint)) return false;
    } else if (actual !== constraint) {
      return false;
    }
  }
  return true;
}

/** Return the records that match the filter (order preserved). */
export function applyFilter<T extends Record<string, unknown>>(records: T[], filter: Filter): T[] {
  return records.filter((r) => matchesFilter(r, filter));
}
