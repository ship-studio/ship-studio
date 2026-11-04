/**
 * The pace a streaming reply is shown at. Kept apart from the rows that use
 * it so it can be tested without a renderer for animations.
 */

import { useEffect, useState } from 'react';

/**
 * How far each reply has been revealed, by message id. It outlives the row:
 * when the finished message replaces its draft (a different component, same
 * id) the reveal carries on from here instead of snapping to the end.
 */
const revealed = new Map<string, number>();

/** Never slower than this (characters per second), even with nothing queued. */
const MIN_RATE = 45;
/** Whatever is queued is shown over about this long: steady, never far behind. */
const CATCH_UP_MS = 260;

/**
 * Follows `target` one display frame at a time. Text arrives from the Mac
 * in ~100 ms chunks; this spreads each chunk over the frames until the
 * next, so the reply flows instead of stepping. Anything that isn't an
 * append (a restart, a final text that differs) keeps what both share and
 * reveals the rest.
 */
export function useReveal(id: string, target: string, streaming: boolean): string {
  const [state, setState] = useState(() => ({
    target,
    count: Math.min(revealed.get(id) ?? (streaming ? 0 : target.length), target.length),
  }));
  let count = Math.min(state.count, target.length);
  if (state.target !== target) {
    // React's derived-state pattern: adjusted here, before this render commits.
    if (!target.startsWith(state.target.slice(0, count))) {
      count = sharedPrefix(state.target, target, count);
    }
    setState({ target, count });
  }

  useEffect(() => {
    let shown = count;
    if (shown >= target.length) {
      if (!streaming) revealed.delete(id);
      return;
    }
    let frame = 0;
    let last = 0;
    let carry = 0;
    const tick = (now: number) => {
      const dt = last ? Math.min(50, now - last) : 16;
      last = now;
      carry += Math.max((MIN_RATE * dt) / 1000, ((target.length - shown) * dt) / CATCH_UP_MS);
      const n = Math.floor(carry);
      if (n > 0) {
        carry -= n;
        shown = Math.min(target.length, shown + n);
        revealed.set(id, shown);
        setState({ target, count: shown });
      }
      if (shown < target.length) frame = requestAnimationFrame(tick);
      else if (!streaming) revealed.delete(id);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // The loop owns `count` from here; following it would restart the loop every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, id, streaming]);

  return target.slice(0, count);
}

function sharedPrefix(a: string, b: string, max: number) {
  let i = 0;
  while (i < max && i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
