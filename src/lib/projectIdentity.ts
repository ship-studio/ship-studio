/**
 * Stable, privacy-safe project identity for analytics.
 *
 * Project paths can leak user data (client names, repo names on disk). We
 * derive an 8-char hex hash of the path that's stable across launches and
 * use that as `project_id` in PostHog events. Project names are still
 * emitted as `project_name` for human readability in the PostHog UI.
 *
 * The hash is non-cryptographic (FNV-1a). We don't need to resist preimage
 * attacks — we just need a stable, short, sync identifier that doesn't ship
 * the literal path. Sync matters: enrichment and project-open run on the
 * render path and cannot await.
 *
 * @module lib/projectIdentity
 */

const idCache = new Map<string, string>();

/**
 * Compute (and cache) the 8-char project_id for a path. Sync — safe to call
 * inline from render-path code.
 */
export function getProjectId(path: string): string {
  const cached = idCache.get(path);
  if (cached) return cached;

  // FNV-1a 32-bit. Stable, fast, no crypto.
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const id = (h >>> 0).toString(16).padStart(8, '0');
  idCache.set(path, id);
  return id;
}
