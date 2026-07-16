import { invoke } from '@tauri-apps/api/core';
import type { InvokeArgs } from '@tauri-apps/api/core';
import { useCallback, useMemo } from 'react';
import { logger } from '../lib/logger';
import { asCommandError, formatCommandError } from '../lib/errors';
import { useAsyncState, type UseAsyncStateReturn } from './useAsyncState';

interface Options<T> {
  /** Initial value of `data`. */
  initial?: T | null;
  /** Called on success. */
  onSuccess?: (value: T) => void;
  /** Called on failure (after logging). */
  onError?: (error: Error) => void;
  /** If true, call the command immediately on mount (no args). */
  immediate?: boolean;
}

/**
 * Wraps `useAsyncState` around `invoke(command, args)`. Prefer this in
 * components over calling `@tauri-apps/api/core` directly — it captures
 * structured errors via the logger and centralizes the loading state.
 */
export function useInvoke<T>(
  command: string,
  options: Options<T> = {}
): UseAsyncStateReturn<T, [InvokeArgs?]> {
  const { initial, onSuccess, onError, immediate } = options;

  const fn = useCallback(
    async (args?: InvokeArgs): Promise<T> => {
      try {
        return await invoke<T>(command, args);
      } catch (e) {
        // A rejected Tauri command is a `CommandError` object, not an Error —
        // `String(e)` would yield "[object Object]". Format it to its message.
        const err = e instanceof Error ? e : new Error(formatCommandError(asCommandError(e)));
        logger.error(`invoke '${command}' failed`, { error: err.message });
        throw err;
      }
    },
    [command]
  );

  return useAsyncState<T, [InvokeArgs?]>(
    fn,
    useMemo(
      () => ({ initial, onSuccess, onError, immediate }),
      [initial, onSuccess, onError, immediate]
    )
  );
}
