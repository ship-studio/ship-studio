/**
 * Stable, privacy-safe project identity for analytics.
 *
 * Project paths can leak user data (client names, repo names on disk). We
 * derive a 12-char hash of the path that's stable across launches and use
 * that as `project_id` in PostHog events. Project names are still emitted
 * as `project_name` for human readability in the PostHog UI.
 *
 * @module lib/projectIdentity
 */

import { logger } from './logger';

const idCache = new Map<string, string>();

/**
 * Async: compute and cache the 12-char project_id for a path. Call this on
 * project open so the sync getter is hot for `enrichProperties`.
 */
export async function getProjectId(path: string): Promise<string> {
  const cached = idCache.get(path);
  if (cached) return cached;

  try {
    const data = new TextEncoder().encode(path);
    const buf = await crypto.subtle.digest('SHA-256', data);
    const hex = Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const id = hex.slice(0, 12);
    idCache.set(path, id);
    return id;
  } catch (e) {
    logger.warn('[projectIdentity] sha256 failed, falling back to fnv1a', { error: String(e) });
    let h = 2166136261;
    for (let i = 0; i < path.length; i++) {
      h ^= path.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const id = (h >>> 0).toString(16).padStart(8, '0');
    idCache.set(path, id);
    return id;
  }
}

/** Sync read of the cached project_id. Returns undefined if not yet warmed. */
export function getCachedProjectId(path: string): string | undefined {
  return idCache.get(path);
}
