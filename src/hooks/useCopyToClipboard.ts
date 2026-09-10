import { useCallback, useEffect, useRef, useState } from 'react';
import { logger } from '../lib/logger';
import { asCommandError, formatCommandError } from '../lib/errors';

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
 * Human-readable reason for a clipboard write failure, suitable for a toast.
 * The webview's NotAllowedError text is long and technical; the practical
 * cause is almost always a missing user-activation or an unfocused window
 * (issue #357), so map it to something the user can act on.
 */
export function describeClipboardError(error: Error): string {
  if (error.name === 'NotAllowedError' || error.message.includes('not allowed')) {
    return 'clipboard access was denied — click the Harbr window, then try again';
  }
  return error.message;
}

/** How long to wait for the window to regain focus before giving up. */
const FOCUS_RETRY_MS = 400;

/**
 * `navigator.clipboard.writeText` throws NotAllowedError when the document
 * isn't focused at the moment of the call — which happens routinely when a
 * click lands while another window was frontmost (issue #753). Rather than
 * making the user click twice, wait briefly for focus and retry once; a real
 * permission denial still surfaces on the second attempt.
 */
export async function writeTextWithFocusRetry(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const notAllowed = e instanceof Error && e.name === 'NotAllowedError';
    if (!notAllowed) throw e;
    window.focus();
    if (!document.hasFocus()) await waitForFocus(FOCUS_RETRY_MS);
    await navigator.clipboard.writeText(text);
  }
}

function waitForFocus(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener('focus', done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    window.addEventListener('focus', done, { once: true });
  });
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
        await writeTextWithFocusRetry(text);
        setIsCopied(true);
        setError(null);
        onCopy?.(text);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setIsCopied(false), resetMs);
        return true;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(formatCommandError(asCommandError(e)));
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
