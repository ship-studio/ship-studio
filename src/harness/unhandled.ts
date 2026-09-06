/**
 * The harness's own "never assume data" guard.
 *
 * A fake backend that answers every command with a plausible-looking default
 * is worse than no harness at all: the screenshot looks fine, the agent
 * reports "works", and the missing data is invisible. So every command with
 * no explicit fixture is recorded here and rendered as a visible badge, and
 * `window.__harness.unhandled` lists them for a scripted run to assert on.
 *
 * The rule mirrors `docs`' first principle — if we didn't define it, we don't
 * claim it. `undefined` is returned so the caller degrades naturally, but the
 * omission is never silent.
 */

export interface UnhandledCall {
  cmd: string;
  count: number;
  firstArgs: unknown;
}

const calls = new Map<string, UnhandledCall>();
const listeners = new Set<() => void>();
/**
 * `useSyncExternalStore` requires a stable snapshot: returning a freshly built
 * array on every read makes React throw "getSnapshot should be cached" and the
 * subscriber never mounts. Rebuilt only when the set actually changes.
 */
let snapshot: UnhandledCall[] = [];

function rebuild(): void {
  snapshot = [...calls.values()].sort((a, b) => b.count - a.count);
  listeners.forEach((l) => l());
}

export function recordUnhandled(cmd: string, args: unknown): void {
  const existing = calls.get(cmd);
  if (existing) {
    // Repeat polls of the same missing command must not re-render the badge.
    existing.count += 1;
    return;
  }
  calls.set(cmd, { cmd, count: 1, firstArgs: args });
  rebuild();
}

export function unhandledCalls(): UnhandledCall[] {
  return snapshot;
}

export function subscribeUnhandled(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetUnhandled(): void {
  calls.clear();
  rebuild();
}
