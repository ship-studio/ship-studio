/**
 * Dragging the breakpoint canvas around: space-drag and middle-drag, the two
 * canvas idioms. Two-finger scrolling is the browser's own and needs nothing
 * from us.
 *
 * Space is tracked as a held state rather than handled on the drag itself,
 * because holding it also has to lift the frames out of the way (a live page
 * would otherwise swallow a drag that crossed into it) and change the cursor —
 * both of which have to happen before the mouse goes down.
 *
 * @module hooks/useCanvasPan
 */

import { useCallback, useEffect, useState, type RefObject } from 'react';

/** Space must not arm panning while the user is typing somewhere. */
const isTypingTarget = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  if (!element) return false;
  if (element.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName ?? '');
};

interface UseCanvasPanParams {
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Called with the resting scroll position when a drag ends. */
  onScrollSettled: (scrollLeft: number) => void;
  /** The user has taken the canvas position into their own hands. */
  onPan?: () => void;
}

export interface CanvasPan {
  /** Space is down: the canvas is ready to be dragged. */
  spaceHeld: boolean;
  /** A drag is in progress. */
  panning: boolean;
  /** Mouse-down handler for the canvas. */
  handlePanStart: (event: React.MouseEvent) => void;
}

export function useCanvasPan({ scrollRef, onScrollSettled, onPan }: UseCanvasPanParams): CanvasPan {
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat) return;
      if (isTypingTarget(event.target)) return;
      setSpaceHeld(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceHeld(false);
    };
    // A window that loses focus mid-drag never delivers the keyup.
    const onBlur = () => setSpaceHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const handlePanStart = useCallback(
    (event: React.MouseEvent) => {
      const node = scrollRef.current;
      if (!node) return;
      const middleButton = event.button === 1;
      if (!middleButton && !(spaceHeld && event.button === 0)) return;
      event.preventDefault();
      setPanning(true);

      const startX = event.clientX;
      const startY = event.clientY;
      const startLeft = node.scrollLeft;
      const startTop = node.scrollTop;
      const onMove = (move: MouseEvent) => {
        // Reported as it happens, not on release: a drag in progress is already
        // the user placing the canvas, and something that resizes the pane
        // mid-drag must not put it back.
        onPan?.();
        node.scrollLeft = startLeft - (move.clientX - startX);
        node.scrollTop = startTop - (move.clientY - startY);
      };
      const onUp = () => {
        setPanning(false);
        onScrollSettled(node.scrollLeft);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [spaceHeld, scrollRef, onScrollSettled, onPan]
  );

  return { spaceHeld, panning, handlePanStart };
}
