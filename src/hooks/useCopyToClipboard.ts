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
    return 'clipboard access was denied — click the Ship Studio window, then try again';
  }
  return error.message;
}

/** How long to wait for the window to regain focus before retrying. */
const FOCUS_RETRY_MS = 1000;
/** Further pauses before each extra retry while the write is still denied. */
const DENIED_BACKOFF_MS = [150, 500];

function isNotAllowed(e: unknown): boolean {
  return e instanceof Error && e.name === 'NotAllowedError';
}

/**
 * `navigator.clipboard.writeText` throws NotAllowedError when the document
 * isn't focused at the moment of the call — which happens routinely when a
 * click lands while another window was frontmost (issue #753). Rather than
 * making the user click twice, wait for focus and retry; a real permission
 * denial still surfaces once the retries run out.
 *
 * One retry after at most 400ms of waiting kept failing on macOS across four
 * releases (issue #1010): the focus event can arrive before the webview will
 * actually grant the write. So wait longer for focus, then back off a couple
 * of times more, and record whether the window had focus when it still
 * failed — which says whether this is timing or a genuine denial.
 */
export async function writeTextWithFocusRetry(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch (e) {
    if (!isNotAllowed(e)) throw e;
  }
  window.focus();
  if (!document.hasFocus()) await waitForFocus(FOCUS_RETRY_MS);
  for (let attempt = 0; ; attempt++) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (e) {
      if (!isNotAllowed(e)) throw e;
      if (attempt >= DENIED_BACKOFF_MS.length) {
        logger.warn('[Clipboard] write still denied after retries', {
          hasFocus: document.hasFocus(),
          attempts: attempt + 2,
        });
        throw e;
      }
      await new Promise((resolve) => setTimeout(resolve, DENIED_BACKOFF_MS[attempt]));
    }
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
