/**
 * The decision the global `unhandledrejection` handler makes, extracted from
 * `src/main.tsx` so it can be tested without booting the app.
 *
 * `main.tsx` is the last line of defence for a promise nobody caught. It has
 * three jobs and they are easy to confuse: suppress third-party plugin noise,
 * suppress one known Tauri runtime race, and — the part this module exists
 * for — refuse to file a bug report for an error the *backend already said
 * was not a bug*.
 *
 * A `CommandError::Expected` is a recognized environment state with a
 * user-side fix (a folder that was moved, a PTY that already exited, a plugin
 * whose files are gone). It crosses IPC as `{ type: 'Other', expected: true }`
 * precisely so the frontend can tell the difference. Every *local* catch site
 * has had to learn that one at a time; this handler never did, so any
 * fire-and-forget `void invoke(...)` that rejected Expected was auto-filed as
 * a malfunction (issue #916, and the repeat telemetry behind #923).
 *
 * @module lib/globalErrorFilters
 */

import { isExpectedCommandError } from './errors';

/** What `main.tsx` should do with an unhandled promise rejection. */
export type RejectionDisposition =
  /** Third-party plugin code — swallow it; the plugin host handles removal. */
  | 'plugin'
  /** A known Tauri runtime race — swallow it, it means nothing to anyone. */
  | 'tauri-race'
  /** Backend-classified `Expected` — log locally, never file a bug report. */
  | 'expected'
  /** A genuine unhandled rejection from app code — report it. */
  | 'report';

/**
 * Promises are often rejected with plain objects rather than Errors (Tauri IPC
 * error payloads especially) — `String()` renders those as "[object Object]",
 * which both destroys the diagnostic and collapses every such rejection onto
 * one dedupe fingerprint (issue #333). Serialize the shape instead.
 */
export function describeRejectionReason(r: unknown): string {
  if (typeof r === 'string') return r;
  try {
    const json = JSON.stringify(r);
    // JSON only sees own enumerable data properties. A DOMException, a Map, or
    // any class exposing state through getters serializes to "{}" — as empty
    // as "[object Object]" was, and it collapses distinct causes onto one
    // dedupe key (issue #1114). Name the type and read the common accessors.
    if (json === '{}' && typeof r === 'object' && r !== null) {
      return describeOpaqueObject(r);
    }
    return json ?? String(r);
  } catch {
    return String(r); // circular structures, throwing getters, …
  }
}

function describeOpaqueObject(r: object): string {
  const proto: unknown = Object.getPrototypeOf(r);
  // A genuinely empty plain object really is "{}".
  if (proto === Object.prototype || proto === null) return '{}';
  const typeName = (r as { constructor?: { name?: unknown } }).constructor?.name;
  const label = typeof typeName === 'string' && typeName ? typeName : 'Object';
  const fields: Record<string, string | number> = {};
  for (const key of ['name', 'message', 'code'] as const) {
    const value = (r as Record<string, unknown>)[key];
    if ((typeof value === 'string' && value) || typeof value === 'number') fields[key] = value;
  }
  if (Object.keys(fields).length > 0) return `${label} ${JSON.stringify(fields)}`;
  const rendered = String(r);
  return rendered === '[object Object]' ? `${label} {}` : rendered;
}

/**
 * Classify an unhandled rejection.
 *
 * Order matters. Plugin code is checked first because a plugin that bundles
 * its own React can reject with anything at all and none of it is ours. The
 * Tauri race is next because it is a specific, known-inert shape. `Expected`
 * comes before the reporting default because the backend's classification
 * outranks this handler's ignorance of the call site.
 */
export function classifyRejection(reason: unknown): RejectionDisposition {
  const stack = reason instanceof Error ? reason.stack || '' : describeRejectionReason(reason);
  const message = reason instanceof Error ? reason.message : describeRejectionReason(reason);

  if (stack.includes('blob:')) return 'plugin';

  // Tauri's internal race: when a `plugin:pty|read` invoke's response arrives
  // after the component that issued it unmounted (common during rapid project
  // switches), the runtime looks up a listener that was already garbage
  // collected and throws a TypeError reading `listeners[eventId].handlerId`
  // from its injected bootstrap script. A Tauri v2 runtime bug, not ours, and
  // it affects nothing.
  if (
    message.includes('listeners[eventId]') ||
    stack.includes('listeners[eventId]') ||
    (message.includes('handlerId') && stack.includes('user-script'))
  ) {
    return 'tauri-race';
  }

  if (isExpectedCommandError(reason)) return 'expected';

  return 'report';
}
