import { describe, it, expect } from 'vitest';
import { filterElementTree, isTreeQueryActive } from './elementTreeFilter';
import type { ElementTreeNode } from '../hooks/useElementTree';

const node = (
  id: number,
  tag: string,
  cls: string,
  text: string,
  children: ElementTreeNode[] = []
): ElementTreeNode => ({ id, tag, cls, text, children });

// body > [ header > h1("Welcome"), main > [ p("hello world"), button.cta("Buy now") ] ]
const tree = node(0, 'body', '', '', [
  node(1, 'header', 'site-header', '', [node(2, 'h1', 'title', 'Welcome')]),
  node(3, 'main', '', '', [
    node(4, 'p', 'lede', 'hello world'),
    node(5, 'button', 'cta', 'Buy now'),
  ]),
]);

const ids = (n: ElementTreeNode | null): number[] => (n ? [n.id, ...n.children.flatMap(ids)] : []);

describe('isTreeQueryActive', () => {
  it('is false for blank/whitespace, true otherwise', () => {
    expect(isTreeQueryActive('')).toBe(false);
    expect(isTreeQueryActive('   ')).toBe(false);
    expect(isTreeQueryActive('p')).toBe(true);
  });
});

describe('filterElementTree', () => {
  it('returns the same tree reference for a blank query', () => {
    expect(filterElementTree(tree, '')).toBe(tree);
    expect(filterElementTree(tree, '   ')).toBe(tree);
  });

  it('returns null for a null tree', () => {
    expect(filterElementTree(null, 'p')).toBeNull();
  });

  it('keeps a matching leaf and its ancestor path, dropping unrelated branches', () => {
    // "Buy" matches button#5 text -> keep 0 (body) > 3 (main) > 5 (button)
    const out = filterElementTree(tree, 'Buy');
    expect(ids(out)).toEqual([0, 3, 5]);
  });

  it('matches on tag', () => {
    expect(ids(filterElementTree(tree, 'h1'))).toEqual([0, 1, 2]);
  });

  it('matches on class', () => {
    expect(ids(filterElementTree(tree, 'cta'))).toEqual([0, 3, 5]);
  });

  it('matches on text, case-insensitively', () => {
    expect(ids(filterElementTree(tree, 'WELCOME'))).toEqual([0, 1, 2]);
    expect(ids(filterElementTree(tree, 'hello'))).toEqual([0, 3, 4]);
  });

  it('returns null when nothing matches', () => {
    expect(filterElementTree(tree, 'zzz-nope')).toBeNull();
  });

  it('keeps multiple matches across branches and preserves sibling order', () => {
    // "e" hits header(#1 tag), Welcome(#2 text) and lede(#4 class), but NOT
    // button#5 ("button"/"cta"/"Buy now" have no "e"), so #5 is dropped.
    const out = filterElementTree(tree, 'e');
    expect(ids(out)).toEqual([0, 1, 2, 3, 4]);
  });

  it('a matched internal node with no matching descendants becomes a leaf', () => {
    // "main" matches node#3's tag; its children (p, button) do not contain "main".
    const out = filterElementTree(tree, 'main');
    expect(ids(out)).toEqual([0, 3]);
    expect(out?.children.find((c) => c.id === 3)?.children).toEqual([]);
  });

  it('does not mutate the original tree', () => {
    const snapshot = JSON.stringify(tree);
    filterElementTree(tree, 'Buy');
    expect(JSON.stringify(tree)).toBe(snapshot);
  });

  it('tolerates malformed nodes with missing/non-string fields (untrusted iframe boundary)', () => {
    const malformed = {
      id: 9,
      tag: 'div',
      cls: undefined,
      text: undefined,
      children: [],
    } as unknown as ElementTreeNode;
    const root = node(0, 'body', '', '', [malformed, node(1, 'p', 'hit', 'x')]);
    expect(() => filterElementTree(root, 'hit')).not.toThrow();
    // The valid match is still found; the malformed node is simply pruned.
    expect(ids(filterElementTree(root, 'hit'))).toEqual([0, 1]);
    // And a query that matches the malformed node's (valid) tag still works.
    expect(ids(filterElementTree(root, 'div'))).toEqual([0, 9]);
  });
});
