import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface UseAsyncStateReturn<T, Args extends unknown[]> {
  data: T | null;
  isLoading: boolean;
  error: Error | null;
  execute: (...args: Args) => Promise<T | null>;
  reset: () => void;
  setData: (value: T | null) => void;
}

interface Options<T> {
  /** Initial value of `data`. */
  initial?: T | null;
  /** Called on success. */
  onSuccess?: (value: T) => void;
  /** Called on failure. */
  onError?: (error: Error) => void;
  /** If true, execute immediately on mount using empty args. */
  immediate?: boolean;
}

/**
 * Replaces the `useState(isLoading)` + `useState(error)` + `useState(data)` triple
 * that appears across the codebase. Handles the canonical try/catch/finally loop
 * and guards against updating state after unmount.
 *
 * The returned `execute` is **referentially stable** across renders — it reads
 * the current `fn` / callbacks from refs internally. This means callers can
 * safely use `execute` (or anything that closes over it) in `useEffect`
 * dependency arrays without triggering an infinite re-fetch loop when an
 * inline arrow function is passed as `fn`.
 */
export function useAsyncState<T, Args extends unknown[] = []>(
  fn: (...args: Args) => Promise<T>,
  options: Options<T> = {}
): UseAsyncStateReturn<T, Args> {
  const { initial = null, onSuccess, onError, immediate } = options;
  const [data, setData] = useState<T | null>(initial);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);

  // Latest-value refs so `execute` can stay stable while callers pass inline
  // closures for `fn`, `onSuccess`, `onError` (the common case).
  const fnRef = useRef(fn);
  const onSuccessRef = useRef(onSuccess);
  const onErrorRef = useRef(onError);
  useLayoutEffect(() => {
    fnRef.current = fn;
    onSuccessRef.current = onSuccess;
    onErrorRef.current = onError;
  }, [fn, onSuccess, onError]);

  // Reset mountedRef on (re-)mount so StrictMode's double-effect cycle
  // (mount → cleanup → remount) doesn't leave it permanently false.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const execute = useCallback(async (...args: Args): Promise<T | null> => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await fnRef.current(...args);
      if (mountedRef.current) {
        setData(result);
        onSuccessRef.current?.(result);
      }
      return result;
    } catch (e) {
      const err =
        e instanceof Error
          ? e
          : new Error(
              typeof e === 'object' && e !== null && 'message' in e
                ? String((e as { message: unknown }).message)
                : String(e)
            );
      if (mountedRef.current) {
        setError(err);
        onErrorRef.current?.(err);
      }
      return null;
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    setData(initial);
    setError(null);
    setIsLoading(false);
  }, [initial]);

  useEffect(() => {
    if (immediate) void execute(...([] as unknown as Args));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { data, isLoading, error, execute, reset, setData };
}
