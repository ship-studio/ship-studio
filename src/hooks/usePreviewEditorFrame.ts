/**
 * Which preview frame everything frame-bound points at.
 *
 * The preview shows either ONE resizable frame (focus mode) or one frame per
 * breakpoint (the canvas), and on the canvas the user can move between them.
 * Four things follow that choice, and they are here together because they must
 * never disagree about which frame is live:
 *
 * 1. The visual editor. Every editor hook posts to `ref.current.contentWindow`
 *    and validates inbound messages against the same window, so re-binding is
 *    just handing them a ref whose OBJECT IDENTITY changes with the frame —
 *    that is what re-runs their setup effects. Focus mode passes the single
 *    iframe's own stable ref, so nothing about it changes.
 * 2. The frame being left behind, which is still showing the editor's selection
 *    layer and will never hear from those hooks again — it gets an explicit
 *    `ss:deactivate`.
 * 3. The inspector, pinned to the active frame so several live frames don't
 *    produce several copies of every console line.
 * 4. Screenshot cropping, which otherwise targets an iframe wrapper that only
 *    exists in focus mode.
 *
 * @module hooks/usePreviewEditorFrame
 */

import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { setInspectSource } from '../lib/inspectStore';

interface UsePreviewEditorFrameParams {
  /** True while the breakpoint canvas is showing. */
  canvasMode: boolean;
  /** The canvas's active frame (null while it isn't mounted). */
  canvasFrameEl: HTMLIFrameElement | null;
  /** Focus mode's single preview iframe. */
  focusFrameRef: RefObject<HTMLIFrameElement | null>;
  /** The element screenshots are cropped to. Repointed at the active canvas
   *  frame; focus mode's own wrapper ref callback takes it back. */
  captureTargetRef: RefObject<HTMLElement | null>;
}

export function usePreviewEditorFrame({
  canvasMode,
  canvasFrameEl,
  focusFrameRef,
  captureTargetRef,
}: UsePreviewEditorFrameParams): RefObject<HTMLIFrameElement | null> {
  const editorFrameRef = useMemo<RefObject<HTMLIFrameElement | null>>(
    () => (canvasMode ? { current: canvasFrameEl } : focusFrameRef),
    [canvasMode, canvasFrameEl, focusFrameRef]
  );

  const previousFrameRef = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    const next = canvasMode ? canvasFrameEl : focusFrameRef.current;
    const previous = previousFrameRef.current;
    previousFrameRef.current = next;
    if (!previous || previous === next) return;
    try {
      previous.contentWindow?.postMessage({ type: 'ss:deactivate' }, '*');
    } catch {
      // The frame may already be gone — nothing left to deactivate.
    }
  }, [canvasMode, canvasFrameEl, focusFrameRef]);

  useEffect(() => {
    if (!canvasMode || !canvasFrameEl) return;
    captureTargetRef.current = canvasFrameEl;
  }, [canvasMode, canvasFrameEl, captureTargetRef]);

  useEffect(() => {
    if (!canvasMode) {
      setInspectSource(null);
      return;
    }
    setInspectSource(canvasFrameEl?.contentWindow ?? null);
    return () => setInspectSource(null);
  }, [canvasMode, canvasFrameEl]);

  return editorFrameRef;
}
