/**
 * When the breakpoint canvas is allowed to be seen.
 *
 * A frame has to be mounted at SOME height before the page inside it can be
 * measured, and the only honest starting guess is the device's own height. So
 * the first real measurement moves a frame from one screen to a whole page —
 * at Fit, from a couple of centimetres to the height of the pane — and every
 * frame does it at once, and the canvas re-centres underneath them. Correct,
 * and it looks like the feature glitching on open.
 *
 * It cannot be measured earlier and it should not be animated: growing a frame
 * over 300ms is the same jump, drawn out, and it costs a re-raster of four
 * enormous layers on every frame of it. So the canvas simply is not shown until
 * the frames know how tall they are — appearing once, correct, the way opening
 * a file looks.
 *
 * The wait has a deadline. A page that never reports (one that fails to load,
 * a frame the mount window culled before it settled) must not be able to hold
 * the whole canvas blank, so after the deadline the canvas shows whatever it
 * has. Being visibly wrong beats being empty.
 *
 * @module hooks/useCanvasReveal
 */

import { useEffect, useState } from 'react';

/** How long the canvas may stay blank waiting to be told its frames' heights.
 *  Comfortably past a normal settle (~2s on a real marketing page) and short
 *  enough that a page which never answers is not felt as a hang. */
const REVEAL_DEADLINE_MS = 3000;

/**
 * @param waitingFor  Frames whose height is still unknown. Empty means ready.
 * @param resetToken  Changes when the canvas starts over (a reload, a new page)
 *                    so the deadline is served fresh rather than already spent.
 */
export function useCanvasReveal(waitingFor: number, resetToken: unknown): boolean {
  // Which reset the deadline has been served for, rather than a plain flag:
  // that way the state is only ever written from the timer, and starting a new
  // wait is just the token no longer matching. Writing a flag back to `false`
  // when the token changes would be a synchronous set inside an effect, which
  // is a cascading render for no gain.
  const [servedFor, setServedFor] = useState<unknown>(() => Symbol('unserved'));
  useEffect(() => {
    const timer = window.setTimeout(() => setServedFor(resetToken), REVEAL_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, [resetToken]);

  // No latch is needed to keep the canvas from blanking once it is up: a
  // measured height is never forgotten, so a frame that remounts — the mount
  // window, a frame becoming active, a refresh — is already accounted for and
  // `waitingFor` stays at zero.
  return waitingFor === 0 || servedFor === resetToken;
}
