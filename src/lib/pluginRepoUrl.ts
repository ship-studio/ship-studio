/**
 * Repo-URL normalization for plugin identity matching.
 *
 * A plugin's registry slug (library `id`) and its manifest `id` can drift
 * apart (slug renames upstream). The stable identity across both is the
 * source repository, so "is this registry entry already installed?" must
 * also compare repo URLs — otherwise the Library keeps offering "Install"
 * for a plugin that is already on disk (install loop).
 *
 * Mirrors `normalize_repo_url` in
 * `src-tauri/src/commands/plugins/plugin_lifecycle.rs` — keep both in sync.
 *
 * @module lib/pluginRepoUrl
 */

/**
 * Normalize a git remote URL to a comparable `host/path` form:
 * - trims whitespace, trailing slashes, and a trailing `.git`
 * - drops the scheme (`https://`, `ssh://`, `git://`) and any `user@` in the
 *   authority, so ssh and https remotes of the same repo compare equal
 * - folds scp-style `git@host:owner/repo` into `host/owner/repo`
 * - lower-cases the host (paths are left as-is)
 */
export function normalizeRepoUrl(url: string): string {
  let u = url.trim();

  // scp-style: git@host:owner/repo (no slash before the colon)
  const scp = /^git@([^:/]+):(.+)$/.exec(u);
  if (scp) {
    u = `${scp[1]}/${scp[2]}`;
  } else {
    // Drop scheme:// and a user@ in the authority (never past the first /)
    u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '');
  }

  u = u.replace(/\/+$/, '');
  if (u.toLowerCase().endsWith('.git')) u = u.slice(0, -4);
  u = u.replace(/\/+$/, '');

  const slash = u.indexOf('/');
  if (slash === -1) return u.toLowerCase();
  return u.slice(0, slash).toLowerCase() + u.slice(slash);
}

/**
 * True when two repo URLs identify the same repository after normalization.
 * Empty/missing URLs never match (dev plugins have no source URL).
 */
export function repoUrlsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const na = normalizeRepoUrl(a);
  return na !== '' && na === normalizeRepoUrl(b);
}
