import { useEffect, useLayoutEffect, useRef } from 'react';
import { ExponentialPoller } from '../lib/polling';

interface UsePollingOptions {
  /** Polling interval in ms. Defaults to 3000. */
  intervalMs?: number;
  /** Upper bound for exponential backoff. Defaults to 10× intervalMs. */
  maxIntervalMs?: number;
  /** Whether polling is active. Flipping to false stops polling + cleans up. */
  enabled?: boolean;
  /** Optional name for structured logging. */
  name?: string;
}

/**
 * Poll an async function with exponential backoff. Auto-cleans up on unmount
 * or when `enabled` flips to false. Prefer this over raw setInterval loops —
 * it handles backoff on error, teardown, and logging in one place.
 */
export function usePolling<T>(
  fn: () => Promise<T>,
  { intervalMs = 3000, maxIntervalMs, enabled = true, name }: UsePollingOptions = {}
): void {
  const fnRef = useRef(fn);
  useLayoutEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  useEffect(() => {
    if (!enabled) return;
    const poller = new ExponentialPoller<T>(
      () => fnRef.current(),
      () => {
        /* result handled by fn side-effects; caller can close over state */
      },
      {
        initialInterval: intervalMs,
        maxInterval: maxIntervalMs ?? intervalMs * 10,
        name: name ?? 'usePolling',
      }
    );
    poller.start();
    return () => poller.stop();
  }, [enabled, intervalMs, maxIntervalMs, name]);
}
