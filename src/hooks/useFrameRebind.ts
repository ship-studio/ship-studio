/**
 * Notice when an editor hook is pointed at a DIFFERENT preview frame.
 *
 * The breakpoint canvas runs one frame per breakpoint and moves the editor
 * between them by handing its hooks a ref with a new object identity (see
 * `usePreviewEditorFrame`). Anything the hook remembers about the *element* it
 * had selected describes the old frame's DOM: the new frame has no marked
 * element, so a live preview mutation would silently do nothing. This runs the
 * hook's own reset at exactly that moment — and never on the first bind, which
 * is not a move.
 *
 * @module hooks/useFrameRebind
 */

import { useEffect, useRef, type RefObject } from 'react';

export function useFrameRebind(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  onRebind: () => void
): void {
  const boundRef = useRef<RefObject<HTMLIFrameElement | null> | null>(null);
  // Mirror the callback so a caller passing an inline function doesn't turn
  // every render into a "rebind".
  const onRebindRef = useRef(onRebind);
  useEffect(() => {
    onRebindRef.current = onRebind;
  }, [onRebind]);

  useEffect(() => {
    const bound = boundRef.current;
    boundRef.current = iframeRef;
    if (bound === null || bound === iframeRef) return;
    onRebindRef.current();
  }, [iframeRef]);
}
