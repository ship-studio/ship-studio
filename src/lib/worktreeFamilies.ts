/**
 * Family-root resolution for worktree sessions — maps any checkout path to
 * its repository's MAIN worktree path ("family root"), using git as the
 * source of truth.
 *
 * The sidebar groups a repository's main checkout and all of its worktrees
 * into one row. Guessing the root by string surgery on the
 * `.worktrees/<project>/<branch>` layout breaks for external projects (the
 * repo doesn't live at `<root>/<project>`) and for containers created under
 * a wrong name — so each managed-worktree path is resolved once via
 * `list_worktrees` and cached here. The path-derived guess is only a
 * placeholder until the async resolution lands.
 *
 * @module lib/worktreeFamilies
 */

import { listWorktrees, isManagedWorktreePath, worktreeParentPath } from './worktrees';

/** Any member path (main or linked worktree) → the repo's main worktree path. */
const roots = new Map<string, string>();
/** Paths with a resolution in flight — dedupes concurrent lookups. */
const pending = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

/**
 * Synchronous family root for a path. Non-worktree paths are their own root.
 * Managed worktree paths return the cached git-resolved main worktree when
 * available, else the path-derived guess until `ensureFamilyRoot` resolves.
 */
export function familyRootOf(path: string): string {
  const cached = roots.get(path);
  if (cached !== undefined) return cached;
  if (!isManagedWorktreePath(path)) return path;
  return worktreeParentPath(path) ?? path;
}

/**
 * Kick off (once per path) the git-truth resolution for a managed worktree
 * path. No-op for regular project paths or already-resolved ones. Notifies
 * subscribers when the cache gains entries.
 */
export function ensureFamilyRoot(path: string): void {
  if (!isManagedWorktreePath(path) || roots.has(path) || pending.has(path)) return;
  pending.add(path);
  listWorktrees(path)
    .then((list) => {
      const main = list.find((w) => w.isMain);
      if (!main) return;
      // One lookup resolves the whole family — cache every member.
      for (const w of list) roots.set(w.path, main.path);
      version += 1;
      for (const listener of listeners) listener();
    })
    .catch(() => {
      // Non-git / unreadable: leave the path-derived fallback in place.
    })
    .finally(() => {
      pending.delete(path);
    });
}

/** Subscribe to cache updates (for `useSyncExternalStore`). */
export function subscribeFamilyRoots(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Monotonic cache version (the `useSyncExternalStore` snapshot). */
export function familyRootsVersion(): number {
  return version;
}

/** Test-only: reset the module-level cache between test cases. */
export function resetFamilyRootsForTest(): void {
  roots.clear();
  pending.clear();
  version = 0;
}
