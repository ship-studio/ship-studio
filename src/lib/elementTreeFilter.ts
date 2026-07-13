/**
 * Element-tree search — prunes the visual editor's element tree to the nodes
 * matching a query, keeping the ancestor path to every match.
 *
 * This is the first consumer of the borrowed Meno filter engine
 * ({@link module:lib/menoFilter}). A node "matches" when its `tag`, `cls`, or
 * `text` contains the query (the engine's `$contains`, OR-ed across the three
 * fields here). Case-insensitivity for the search box is provided by lower-casing
 * both sides in this adapter, so the engine's `$contains` stays faithfully
 * case-sensitive. A node is kept if it matches or if any descendant matches, so
 * the tree still renders hierarchically with the path to each hit.
 *
 * Pure and dependency-free (no React, no DOM).
 *
 * @module lib/elementTreeFilter
 */

import type { ElementTreeNode } from '../hooks/useElementTree';
import { matchesFilter } from './menoFilter';

/** True when a non-blank query should drive filtering. */
export function isTreeQueryActive(query: string): boolean {
  return query.trim().length > 0;
}

/**
 * Does this node itself match the (already lower-cased) query on tag/cls/text?
 * Fields are coerced with `String(field ?? '')` because the tree crosses an
 * untrusted boundary (the preview iframe's DOM snapshot) — a malformed node with
 * a missing/non-string field must not throw and tear down the whole panel.
 */
function selfMatches(node: ElementTreeNode, loweredQuery: string): boolean {
  return [node.tag, node.cls, node.text].some((field) =>
    matchesFilter({ v: String(field ?? '').toLowerCase() }, { v: { $contains: loweredQuery } })
  );
}

/**
 * Recursively keep `node` only when it self-matches or has a surviving
 * descendant, returning a shallow copy carrying just the kept children. Returns
 * `null` when the whole subtree is pruned away.
 */
function prune(node: ElementTreeNode, loweredQuery: string): ElementTreeNode | null {
  const keptChildren: ElementTreeNode[] = [];
  for (const child of node.children) {
    const kept = prune(child, loweredQuery);
    if (kept) keptChildren.push(kept);
  }
  if (selfMatches(node, loweredQuery) || keptChildren.length > 0) {
    return { ...node, children: keptChildren };
  }
  return null;
}

/**
 * Return a pruned copy of the tree containing only nodes that match `query`
 * (on tag/cls/text, case-insensitive) plus the ancestors of every match.
 *
 * - A blank query returns the original tree reference unchanged (no filtering).
 * - `null` is returned when the tree is null, or when nothing matches.
 * - Sibling order and the kept nodes' child structure are preserved.
 */
export function filterElementTree(
  root: ElementTreeNode | null,
  query: string
): ElementTreeNode | null {
  if (!root) return null;
  if (!isTreeQueryActive(query)) return root;
  return prune(root, query.trim().toLowerCase());
}
