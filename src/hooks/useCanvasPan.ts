/**
 * Dragging the breakpoint canvas around: space-drag and middle-drag, the two
 * canvas idioms. Wheel and trackpad panning is `useCanvasGestures`.
 *
 * Space is tracked as a held state rather than handled on the drag itself,
 * because holding it also has to lift the frames out of the way (a live page
 * would otherwise swallow a drag that crossed into it) and change the cursor —
 * both of which have to happen before the mouse goes down.
 *
 * The drag moves the camera by the delta since the LAST move event rather than
 * by the distance from where the drag began. Both describe the same path, but
 * only the incremental form composes with a camera that is also being clamped
 * at the canvas edges: measured from the start, a drag that ran into an edge
 * and came back would jump by however far it had been held.
 *
 * @module hooks/useCanvasPan
 */

import { useCallback, useEffect, useState } from 'react';
import type { CanvasCameraControls } from './useCanvasCamera';

/** Space must not arm panning while the user is typing somewhere. */
const isTypingTarget = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  if (!element) return false;
  if (element.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName ?? '');
};

interface UseCanvasPanParams {
  /** The camera the drag moves. */
  camera: CanvasCameraControls;
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

export function useCanvasPan({ camera, onPan }: UseCanvasPanParams): CanvasPan {
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
      const middleButton = event.button === 1;
      if (!middleButton && !(spaceHeld && event.button === 0)) return;
      event.preventDefault();
      setPanning(true);

      let lastX = event.clientX;
      let lastY = event.clientY;
      const onMove = (move: MouseEvent) => {
        // Reported as it happens, not on release: a drag in progress is already
        // the user placing the canvas, and something that resizes the pane
        // mid-drag must not put it back.
        onPan?.();
        camera.panBy(lastX - move.clientX, lastY - move.clientY);
        lastX = move.clientX;
        lastY = move.clientY;
      };
      const onUp = () => {
        setPanning(false);
        camera.commit();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [spaceHeld, camera, onPan]
  );

  return { spaceHeld, panning, handlePanStart };
}
