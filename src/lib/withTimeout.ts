/**
 * Promise timeout helpers.
 *
 * Boot gates (setup checks, CLI status probes) await Tauri invokes that shell
 * out to external binaries. A rejection routes to existing error handling, but
 * a *hang* used to mean an eternal spinner or a black window (#173). These
 * helpers convert a hang into either a rejection ({@link withTimeout}) or a
 * fallback value ({@link withTimeoutFallback}) so callers always make progress.
 *
 * @module lib/withTimeout
 */

/** Error thrown by {@link withTimeout} when the wrapped promise doesn't settle in time. */
export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Reject with a {@link TimeoutError} if `promise` doesn't settle within `ms`.
 *
 * Resolution and rejection of the original promise before the deadline pass
 * through unchanged, so existing catch-based routing keeps working — a hang
 * simply becomes one more rejection.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Resolve `fallback` if `promise` doesn't settle within `ms`.
 *
 * This is the historical dev-server restart pattern (extracted from
 * `useDevServer`): the caller prefers a degraded-but-known value over an
 * error. Rejections of the original promise before the deadline still
 * propagate unchanged.
 */
export function withTimeoutFallback<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
