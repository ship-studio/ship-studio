import { useCallback, useEffect, useRef, useState } from 'react';
import { logger } from '../lib/logger';

export interface UseCopyToClipboardReturn {
  copy: (text: string) => Promise<boolean>;
  isCopied: boolean;
  error: Error | null;
}

interface Options {
  /** Reset window for isCopied flag. */
  resetMs?: number;
  /** Optional hook: called on successful copy (e.g. to show a toast). */
  onCopy?: (text: string) => void;
  /** Optional hook: called on failure. */
  onError?: (error: Error) => void;
}

/**
 * Copy text to the OS clipboard. Prefer this over calling `navigator.clipboard`
 * directly — it centralizes error handling, tracking, and the "copied!" flag.
 */
export function useCopyToClipboard({
  resetMs = 2000,
  onCopy,
  onError,
}: Options = {}): UseCopyToClipboardReturn {
  const [isCopied, setIsCopied] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      try {
        if (!navigator?.clipboard?.writeText) {
          throw new Error('Clipboard API unavailable');
        }
        await navigator.clipboard.writeText(text);
        setIsCopied(true);
        setError(null);
        onCopy?.(text);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setIsCopied(false), resetMs);
        return true;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        setIsCopied(false);
        logger.warn('copy-to-clipboard failed', { error: err.message });
        onError?.(err);
        return false;
      }
    },
    [resetMs, onCopy, onError]
  );

  return { copy, isCopied, error };
}
