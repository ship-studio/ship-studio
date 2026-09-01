/**
 * Guarded loader for xterm's WebGL renderer addon.
 *
 * The WebGL glyph atlas calls `getImageData` on canvases sized from the
 * terminal's layout; when the pane has zero size (collapsed split, hidden
 * ancestor) the canvas is zero-sized and `getImageData` throws an uncaught
 * `InvalidStateError` from inside the addon's render path — which the global
 * error handler then auto-reports as a bug (issue #383). Ship Studio keeps
 * background terminals mounted (and streaming PTY output) while not laid
 * out, so this is a reachable state, not an edge case.
 *
 * `attachWebglRenderer` therefore only keeps the WebGL addon loaded while
 * the container actually has layout: it defers loading until the container
 * has non-zero size, disposes the addon (falling back to xterm's DOM/canvas
 * renderer) whenever the container collapses to zero, and reloads it when
 * layout returns. WebGL being unavailable, or a GPU context loss, falls back
 * to the non-WebGL renderer permanently — same behavior the call sites had
 * before this guard existed. Context loss drops the addon immediately rather
 * than riding out the addon's restore attempt, whose re-initialization can
 * throw uncaught from a native event listener (issue #716).
 */

import type { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { logger } from './logger';

/**
 * Keep a WebGL renderer attached to `term` only while `container` has
 * non-zero layout. Returns a dispose function — call it on teardown (before
 * or after `term.dispose()`, both are safe).
 */
export function attachWebglRenderer(term: Terminal, container: HTMLElement): () => void {
  let addon: WebglAddon | null = null;
  /** WebGL failed to initialize or lost its context — stop trying. */
  let unavailable = false;
  let disposed = false;

  const disposeAddon = () => {
    const current = addon;
    addon = null;
    if (!current) return;
    try {
      current.dispose();
    } catch {
      /* already disposed (context loss, terminal teardown) */
    }
  };

  const sync = () => {
    if (disposed || unavailable) return;
    const hasLayout = container.offsetWidth > 0 && container.offsetHeight > 0;
    if (!hasLayout) {
      // Zero-size/hidden pane: drop to the DOM renderer so the glyph atlas
      // never draws against a zero-sized canvas.
      disposeAddon();
      return;
    }
    if (addon) return;
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        // GPU context lost — permanent fallback, matching the pre-guard
        // behavior at both call sites.
        unavailable = true;
        if (addon === webgl) addon = null;
        webgl.dispose();
        observer.disconnect();
      });
      term.loadAddon(webgl);
      addon = webgl;
    } catch {
      unavailable = true;
      observer.disconnect();
      logger.warn('[Terminal] WebGL not available, using canvas renderer');
    }
  };

  const observer = new ResizeObserver(sync);

  // GPU context loss: fall back to the DOM renderer the moment the context
  // goes away, instead of letting the addon try to restore it.
  //
  // `@xterm/addon-webgl` answers `webglcontextlost` by scheduling a restore,
  // and its `webglcontextrestored` listener calls `_initializeWebGLState()`
  // again. That runs inside a native event dispatch — outside any call stack
  // this module controls — so when a driver hiccup makes one of the WebGL
  // program/uniform lookups come back null, xterm's `throwIfFalsy` throws
  // "value must not be falsy" uncaught, straight into the global error
  // handler (issue #716). Disposing on loss removes the addon's own restore
  // listener, so that path can never run.
  //
  // The listener sits on the container in CAPTURE phase: `webglcontextlost`
  // is dispatched on the addon's canvas and does not bubble, but capturing
  // ancestors still see it — and see it BEFORE the addon's own target-phase
  // listener, which is the one that schedules the restore.
  const onContextLost = () => {
    if (unavailable) return;
    unavailable = true;
    observer.disconnect();
    disposeAddon();
    logger.warn('[Terminal] WebGL context lost, using canvas renderer');
  };
  container.addEventListener('webglcontextlost', onContextLost, true);

  observer.observe(container);
  sync();

  return () => {
    disposed = true;
    container.removeEventListener('webglcontextlost', onContextLost, true);
    observer.disconnect();
    disposeAddon();
  };
}
