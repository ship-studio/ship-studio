/**
 * Dismiss-on-outside-pointer for hand-rolled popovers (visual editor).
 *
 * Registers a CAPTURE-phase document listener while `open` is true, and calls
 * `onDismiss` when the event lands outside the popover. On some engines
 * (WKWebView on macOS Sequoia, issue #172; Ventura/Intel, issue #236) the
 * opening gesture's pointerdown can be dispatched AFTER the effect that
 * registers the listener runs, so a listener attached synchronously sees the
 * very gesture that opened the popover and closes it instantly. Two guards
 * prevent that: registration is deferred by one animation frame, and events
 * whose timeStamp predates the open are ignored (timeStamps are creation-time,
 * so a late-dispatched opening gesture is still recognizable). WebKit can
 * report epoch-based event timestamps while `performance.now()` is monotonic;
 * normalize those timestamps before comparing them.
 *
 * This deliberately does NOT replace `useClickOutside` (bubble-phase `click`
 * semantics) — it's the shared home for the capture-phase
 * `pointerdown`/`mousedown` pattern the edit-panel popovers use.
 *
 * @module hooks/useDismissOnOutsidePointer
 */

import { useEffect, useRef, type RefObject } from 'react';

interface Options {
  /** Which pointer event to dismiss on (default `'pointerdown'`). */
  event?: 'pointerdown' | 'mousedown';
  /**
   * Override the containment check for popovers whose "inside" spans more than
   * `containerRef` (e.g. a separate trigger, an anchor element, or portaled
   * sub-menus). Return true when the target counts as outside. When provided,
   * this fully replaces the default `containerRef.contains` check.
   */
  isOutside?: (target: Node) => boolean;
}

/**
 * Call `onDismiss` on a capture-phase outside `pointerdown`/`mousedown` while
 * `open` is true. The listener attaches one animation frame after `open`
 * flips true so the opening gesture can never dismiss the popover.
 */
export function useDismissOnOutsidePointer(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  opts: Options = {}
): void {
  const { event = 'pointerdown' } = opts;

  // Keep the latest callbacks in refs so the listener effect only re-runs when
  // `open` (or the event type) changes — re-registering would re-defer it.
  const onDismissRef = useRef(onDismiss);
  const isOutsideRef = useRef(opts.isOutside);
  useEffect(() => {
    onDismissRef.current = onDismiss;
    isOutsideRef.current = opts.isOutside;
  });

  useEffect(() => {
    if (!open) return;

    // The rAF defer alone lost the race on slow machines (issue #236, Intel
    // Ventura): the engine can dispatch the opening gesture's pointerdown even
    // later than the next frame. Event timeStamps are creation-time (when the
    // user acted), so any event minted before the popover opened is part of
    // the opening gesture no matter how late it's dispatched — drop it.
    // Normalize epoch-based WebKit timestamps to the same clock as openedAt.
    const openedAt = performance.now();

    const onDown = (e: Event) => {
      const timestamp = e.timeStamp;
      const normalizedTimestamp =
        timestamp > 1_000_000_000_000
          ? timestamp - (performance.timeOrigin || Date.now() - performance.now())
          : timestamp;
      if (normalizedTimestamp <= openedAt) return;
      const target = e.target as Node;
      const outside = isOutsideRef.current
        ? isOutsideRef.current(target)
        : !containerRef.current?.contains(target);
      if (outside) onDismissRef.current();
    };

    const raf = requestAnimationFrame(() => {
      document.addEventListener(event, onDown, true);
    });
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener(event, onDown, true);
    };
  }, [open, event, containerRef]);
}
