/**
 * Keeps the breakpoint canvas's frames at the same point in the page.
 *
 * Each frame is a real viewport, so seeing past the fold means scrolling — and
 * scrolling four frames by hand to compare the same section is the thing the
 * canvas exists to avoid. The injected preview script reports each frame's
 * position and accepts one back; this is the exchange between them.
 *
 * Position travels as a FRACTION of each page's scrollable range, because the
 * same page is a different length at every width.
 *
 * @module hooks/useFrameScrollSync
 */

import { useEffect, useRef, type RefObject } from 'react';

/** How close two fractions have to be to count as the same position. At 0.0005
 *  that is half a pixel on a 1000px scroll range. */
const ECHO_EPSILON = 0.0005;

/** How long a broadcast position stays recognisable as our own echo. */
const ECHO_WINDOW_MS = 500;

export function useFrameScrollSync(
  frameElsRef: RefObject<Map<string, HTMLIFrameElement | null>>,
  enabled = true
): void {
  const lastBroadcastRef = useRef({ fraction: -1, at: 0 });

  useEffect(() => {
    if (!enabled) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; fraction?: number } | null;
      if (data?.type !== 'ss:scroll' || typeof data.fraction !== 'number') return;
      const fraction = data.fraction;

      // A driven frame reports its new position once it settles, which is the
      // position we just sent it. Rebroadcasting that is a loop that damps out
      // but never quite stops, so recognise our own echo and drop it.
      const last = lastBroadcastRef.current;
      const echo =
        Math.abs(fraction - last.fraction) < ECHO_EPSILON && Date.now() - last.at < ECHO_WINDOW_MS;
      if (echo) return;
      lastBroadcastRef.current = { fraction, at: Date.now() };

      for (const element of frameElsRef.current?.values() ?? []) {
        // Not back to the frame that just moved — it is already there, and the
        // round trip would fight the user's own scrolling.
        if (!element || element.contentWindow === event.source) continue;
        try {
          element.contentWindow?.postMessage({ type: 'ss:scrollTo', fraction }, '*');
        } catch {
          // A frame mid-navigation can refuse; the next scroll catches it up.
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frameElsRef, enabled]);
}
