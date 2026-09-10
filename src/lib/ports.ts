/**
 * Dev-server port helpers.
 *
 * Two jobs, one theme — keeping the port Harbr *believes* a project is
 * on tied to the server that's actually running:
 *
 * - `preferredPortForProject` spreads projects across a deterministic port
 *   range instead of having every project fight over 3000. Same path → same
 *   port, every launch, no persistence needed.
 * - `extractAnnouncedPort` reads the port a dev server *says* it bound from
 *   its own startup output. Frameworks silently auto-increment when their
 *   requested port is taken (Next/Vite bind 3001 when 3000 is busy), so the
 *   announced URL is the only ground truth — trusting the requested port is
 *   how previews and thumbnails end up pointed at a different project's
 *   server.
 *
 * @module lib/ports
 */

/** Start of the auto-assigned dev port range. Deliberately clear of 3000 —
 *  the port user- and agent-started servers grab by convention — so Ship
 *  Studio's own servers don't race them for it. */
export const DEV_PORT_RANGE_START = 3100;
/** Ports DEV_PORT_RANGE_START .. START+SIZE-1 are handed out by hash. */
export const DEV_PORT_RANGE_SIZE = 900;

/**
 * Deterministic preferred dev-server port for a project, derived from its
 * path (FNV-1a, same scheme as `lib/projectIdentity`). Collisions between
 * two projects are possible (~900 slots) but harmless — `findAndReservePort`
 * still probes upward from the preference and guarantees uniqueness among
 * live servers.
 */
export function preferredPortForProject(projectPath: string): number {
  let h = 2166136261;
  for (let i = 0; i < projectPath.length; i++) {
    h ^= projectPath.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return DEV_PORT_RANGE_START + ((h >>> 0) % DEV_PORT_RANGE_SIZE);
}

/* Matches the localhost URL in a dev server's startup banner, anchored on the
   "Local" label so request logs and proxy chatter that merely *mention* a
   localhost URL don't match:
     Next.js   `- Local:        http://localhost:3000`
     Vite      `➜  Local:   http://localhost:5173/`
     Astro     `┃ Local    http://localhost:4321/`
     CRA       `Local:            http://localhost:3000`
   `\blocal` cannot match inside "localhost" because the required `:? \s+`
   separator fails against the trailing "host". */
const ANNOUNCED_LOCAL_URL =
  /\blocal:?\s+https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{1,5})(?=[/\s]|$)/i;

/* Next.js ≤12 banner has no "Local" label:
   `ready - started server on 0.0.0.0:3000, url: http://localhost:3000` */
const ANNOUNCED_URL_FIELD =
  /\bstarted server on\s+\S+,\s*url:\s*https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{1,5})(?=[/\s]|$)/i;

/**
 * Extract the port a dev server announces it actually bound, from one line of
 * its (ANSI-stripped) output. Returns null when the line announces nothing.
 */
export function extractAnnouncedPort(line: string): number | null {
  const match = ANNOUNCED_LOCAL_URL.exec(line) ?? ANNOUNCED_URL_FIELD.exec(line);
  if (!match) return null;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535 ? port : null;
}
