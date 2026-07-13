import { describe, it, expect } from 'vitest';
import { matchesFilter, applyFilter, type Filter } from './menoFilter';

const rec = (o: Record<string, unknown>) => o;

describe('matchesFilter — implicit $eq and bypass', () => {
  it('treats a raw value as $eq', () => {
    expect(matchesFilter({ category: 'tech' }, { category: 'tech' })).toBe(true);
    expect(matchesFilter({ category: 'news' }, { category: 'tech' })).toBe(false);
  });

  it('ANDs multiple fields', () => {
    const f: Filter = { category: 'tech', published: true };
    expect(matchesFilter({ category: 'tech', published: true }, f)).toBe(true);
    expect(matchesFilter({ category: 'tech', published: false }, f)).toBe(false);
  });

  it('bypasses a field for "*", "", null, and undefined', () => {
    for (const bypass of ['*', '', null, undefined]) {
      expect(matchesFilter({ category: 'anything' }, { category: bypass })).toBe(true);
    }
  });

  it('an empty filter matches every record', () => {
    expect(matchesFilter({ a: 1 }, {})).toBe(true);
  });

  it('a missing field is undefined and fails a concrete $eq', () => {
    expect(matchesFilter({}, { category: 'tech' })).toBe(false);
  });
});

describe('matchesFilter — operators', () => {
  it('$eq / $neq', () => {
    expect(matchesFilter({ n: 5 }, { n: { $eq: 5 } })).toBe(true);
    expect(matchesFilter({ n: 5 }, { n: { $neq: 5 } })).toBe(false);
    expect(matchesFilter({ n: 6 }, { n: { $neq: 5 } })).toBe(true);
  });

  it('$gt / $gte / $lt / $lte on numbers', () => {
    expect(matchesFilter({ price: 100 }, { price: { $gt: 100 } })).toBe(false);
    expect(matchesFilter({ price: 101 }, { price: { $gt: 100 } })).toBe(true);
    expect(matchesFilter({ price: 100 }, { price: { $gte: 100 } })).toBe(true);
    expect(matchesFilter({ price: 100 }, { price: { $lt: 100 } })).toBe(false);
    expect(matchesFilter({ price: 99 }, { price: { $lt: 100 } })).toBe(true);
    expect(matchesFilter({ price: 100 }, { price: { $lte: 100 } })).toBe(true);
  });

  it('$gt / $lt work on strings (lexicographic)', () => {
    expect(matchesFilter({ s: 'b' }, { s: { $gt: 'a' } })).toBe(true);
    expect(matchesFilter({ s: 'a' }, { s: { $lt: 'b' } })).toBe(true);
  });

  it('comparisons across mismatched kinds are false', () => {
    expect(matchesFilter({ x: 'a' }, { x: { $gt: 1 } })).toBe(false);
    expect(matchesFilter({ x: undefined }, { x: { $gte: 0 } })).toBe(false);
  });

  it('ANDs multiple operators within one field', () => {
    const f: Filter = { price: { $gt: 100, $lt: 500 } };
    expect(matchesFilter({ price: 250 }, f)).toBe(true);
    expect(matchesFilter({ price: 50 }, f)).toBe(false);
    expect(matchesFilter({ price: 600 }, f)).toBe(false);
  });

  it('$contains on strings and arrays', () => {
    expect(matchesFilter({ title: 'featured post' }, { title: { $contains: 'feature' } })).toBe(
      true
    );
    expect(matchesFilter({ tags: ['a', 'b'] }, { tags: { $contains: 'b' } })).toBe(true);
    expect(matchesFilter({ tags: ['a', 'b'] }, { tags: { $contains: 'c' } })).toBe(false);
    expect(matchesFilter({ n: 5 }, { n: { $contains: '5' } })).toBe(false);
  });

  it('$notContains is the negation of $contains', () => {
    expect(matchesFilter({ title: 'hello' }, { title: { $notContains: 'x' } })).toBe(true);
    expect(matchesFilter({ title: 'hello' }, { title: { $notContains: 'ell' } })).toBe(false);
  });

  it('$startsWith / $endsWith are case-insensitive and string-only', () => {
    expect(matchesFilter({ s: 'HelloWorld' }, { s: { $startsWith: 'hello' } })).toBe(true);
    expect(matchesFilter({ s: 'HelloWorld' }, { s: { $endsWith: 'WORLD' } })).toBe(true);
    expect(matchesFilter({ s: 'HelloWorld' }, { s: { $startsWith: 'world' } })).toBe(false);
    expect(matchesFilter({ s: 42 }, { s: { $startsWith: '4' } })).toBe(false);
  });

  it('$in / $nin', () => {
    expect(matchesFilter({ c: 'tech' }, { c: { $in: ['tech', 'news'] } })).toBe(true);
    expect(matchesFilter({ c: 'sports' }, { c: { $in: ['tech', 'news'] } })).toBe(false);
    expect(matchesFilter({ c: 'sports' }, { c: { $nin: ['tech', 'news'] } })).toBe(true);
    expect(matchesFilter({ c: 'tech' }, { c: { $nin: ['tech', 'news'] } })).toBe(false);
  });

  it('$empty true/false covers null, undefined, "", and empty array', () => {
    for (const empty of [null, undefined, '', [] as unknown[]]) {
      expect(matchesFilter({ v: empty }, { v: { $empty: true } })).toBe(true);
      expect(matchesFilter({ v: empty }, { v: { $empty: false } })).toBe(false);
    }
    expect(matchesFilter({ v: 'x' }, { v: { $empty: false } })).toBe(true);
    expect(matchesFilter({ v: 0 }, { v: { $empty: true } })).toBe(false);
  });

  it('a plain object with non-operator keys is treated as a literal $eq', () => {
    // Not an operator object -> compared by strict equality (reference), so a
    // fresh literal never matches; this documents the disambiguation rule.
    expect(matchesFilter({ meta: { a: 1 } }, { meta: { a: 1 } })).toBe(false);
  });
});

describe('applyFilter', () => {
  const rows = [
    rec({ id: 1, category: 'tech', price: 100 }),
    rec({ id: 2, category: 'tech', price: 300 }),
    rec({ id: 3, category: 'news', price: 50 }),
  ];

  it('returns only matching records, order preserved', () => {
    const out = applyFilter(rows, { category: 'tech', price: { $gte: 200 } });
    expect(out.map((r) => r.id)).toEqual([2]);
  });

  it('returns all records for an all-bypass filter', () => {
    expect(applyFilter(rows, { category: '*' })).toHaveLength(3);
  });

  it('returns an empty array when nothing matches', () => {
    expect(applyFilter(rows, { category: 'sports' })).toEqual([]);
  });
});
