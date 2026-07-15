/**
 * Hook for managing responsive viewport resizing and breakpoint switching.
 *
 * Handles: breakpoint detection, manual resize drag, ResizeObserver for
 * auto-switching breakpoints when the viewport container changes size,
 * and breakpoint button click handling.
 *
 * @module hooks/usePreviewResize
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { trackEvent } from '../lib/analytics';

/** Responsive breakpoint options */
export type Breakpoint = 'full' | 'desktop' | 'laptop' | 'tablet' | 'mobile';

export const BREAKPOINTS: Record<Breakpoint, { width: string; label: string }> = {
  full: { width: '100%', label: 'Full' },
  desktop: { width: '1440px', label: 'Desktop' },
  laptop: { width: '1024px', label: 'Laptop' },
  tablet: { width: '768px', label: 'Tablet' },
  mobile: { width: '375px', label: 'Mobile' },
};

/** Space reserved for the resize handle on the right side of the viewport */
const VIEWPORT_PADDING_PX = 12;

/** Resize handle thickness in pixels. MUST stay in sync with the
 *  `--handle-size` custom property in `src/styles/features/preview.css`
 *  — JS uses it for drag math, CSS uses it for grid track sizing. */
export const RESIZE_HANDLE_PX = 8;

interface UsePreviewResizeParams {
  /** Ref to the iframe wrapper element, used to read its offsetWidth during resize drag */
  iframeWrapperRef: React.RefObject<HTMLDivElement | null>;
  /** Fired when the USER changes the canvas width (drag, device preset, or the
   *  pane auto-fitting) — but NOT when `previewAtWidth` sets it programmatically.
   *  Lets the editor drop a pinned breakpoint so it follows the width again. */
  onUserResize?: () => void;
}

export function usePreviewResize({ iframeWrapperRef, onUserResize }: UsePreviewResizeParams) {
  const [customWidth, setCustomWidth] = useState<number | null>(null); // null = 100% (desktop)
  const [customHeight, setCustomHeight] = useState<number | null>(null); // null = full available height

  const viewportRef = useRef<HTMLDivElement | null>(null);

  // Mirror the callback so resize handlers can call the latest without re-creating.
  const onUserResizeRef = useRef(onUserResize);
  useEffect(() => {
    onUserResizeRef.current = onUserResize;
  }, [onUserResize]);

  // Ref mirrors customWidth state so the ResizeObserver callback can read the latest value
  const customWidthRef = useRef<number | null>(null);
  useEffect(() => {
    customWidthRef.current = customWidth;
  }, [customWidth]);

  // Determine which breakpoint matches the current width
  const getActiveBreakpoint = useCallback((): Breakpoint => {
    if (customWidth === null) return 'full';
    if (customWidth <= 375) return 'mobile';
    if (customWidth <= 768) return 'tablet';
    if (customWidth <= 1024) return 'laptop';
    if (customWidth <= 1440) return 'desktop';
    return 'full';
  }, [customWidth]);

  // Resize state
  const [isResizing, setIsResizing] = useState(false);
  const [isVerticalResizing, setIsVerticalResizing] = useState(false);

  // Track viewport width to hide breakpoints that won't fit
  // ResizeObserver fires efficiently (not on every frame) so no debouncing needed
  const [viewportWidth, setViewportWidth] = useState<number>(0);
  const observerRef = useRef<ResizeObserver | null>(null);

  // Callback ref to set up ResizeObserver when viewport element mounts/unmounts
  const setViewportRefs = useCallback((node: HTMLDivElement | null) => {
    // Update the regular ref for other code that uses viewportRef
    viewportRef.current = node;

    // Clean up previous observer
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    if (node) {
      // Set initial width (subtract padding for resize handle)
      setViewportWidth(node.offsetWidth - VIEWPORT_PADDING_PX);

      // Observe future size changes. A selected width WIDER than the pane is
      // kept (not auto-shrunk): the frame renders at the true width and is
      // visually scaled down to fit (`previewScale`), so media queries keep
      // firing at the labeled breakpoint — matching what a real browser at
      // that width shows.
      observerRef.current = new ResizeObserver((entries) => {
        for (const entry of entries) {
          setViewportWidth(entry.contentRect.width - VIEWPORT_PADDING_PX);
        }
      });
      observerRef.current.observe(node);
    }
  }, []);

  // Handle resize drag - like SplitPane
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';

      const startX = e.clientX;
      const startWidth = iframeWrapperRef.current?.offsetWidth || 0;

      let rafId: number | null = null;
      const handleMouseMove = (e: MouseEvent) => {
        if (!viewportRef.current) return;
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          if (!viewportRef.current) return;

          const deltaX = e.clientX - startX;
          // Multiply by 2 because preview is centered (handle moves half of width change)
          const newWidth = startWidth + deltaX * 2;
          const maxWidth = viewportRef.current.offsetWidth - 12; // Leave space for handle

          onUserResizeRef.current?.(); // manual drag — the breakpoint should follow

          if (newWidth >= maxWidth - 10) {
            // Snap to full width (desktop)
            setCustomWidth(null);
          } else {
            setCustomWidth(Math.max(320, Math.min(newWidth, maxWidth)));
          }
        });
      };

      const handleMouseUp = () => {
        if (rafId !== null) cancelAnimationFrame(rafId);
        setIsResizing(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [iframeWrapperRef]
  );

  // Handle vertical (height) resize drag. The `* 2` is required because
  // `.preview-viewport` uses `align-items: center` (preview.css) — the iframe
  // grows centered, so the bottom handle's screen-Y only shifts by half the
  // height delta. If the CSS centering changes, this math changes too.
  // Min height is lower than the horizontal min (320) because portrait mobile
  // viewports are taller than they are wide, so 200 is a fair small-screen floor.
  const handleVerticalResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsVerticalResizing(true);
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';

      const startY = e.clientY;
      const startHeight = iframeWrapperRef.current?.offsetHeight || 0;

      let rafId: number | null = null;
      const handleMouseMove = (e: MouseEvent) => {
        if (!viewportRef.current) return;
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          if (!viewportRef.current) return;

          const deltaY = e.clientY - startY;
          const newHeight = startHeight + deltaY * 2;
          const maxHeight = viewportRef.current.offsetHeight - RESIZE_HANDLE_PX;

          if (newHeight >= maxHeight - 10) {
            setCustomHeight(null);
          } else {
            setCustomHeight(Math.max(200, Math.min(newHeight, maxHeight)));
          }
        });
      };

      const handleMouseUp = () => {
        if (rafId !== null) cancelAnimationFrame(rafId);
        setIsVerticalResizing(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [iframeWrapperRef]
  );

  // Resize the canvas to an exact pixel width. Used by the editor's Tailwind
  // breakpoint selector so picking a breakpoint sets the preview to that width
  // (and the editor's derived active breakpoint follows). Deliberately NOT
  // clamped to the viewport — a width wider than the pane renders at true size
  // and is scaled down to fit (`previewScale`).
  const previewAtWidth = useCallback((px: number) => {
    setCustomWidth(px);
  }, []);

  // Exact size typed by the USER (dimensions popover). Unlike previewAtWidth
  // this counts as a user resize, so a pinned editor breakpoint follows the
  // new width. Height null = auto (full available height).
  const previewAtSize = useCallback((width: number, height: number | null) => {
    onUserResizeRef.current?.();
    setCustomWidth(width);
    setCustomHeight(height);
  }, []);

  // How much the frame must shrink visually so the selected width fits the
  // pane (1 = no scaling). The iframe always renders at the true CSS width —
  // Chrome-DevTools-style — so a "Desktop 1440" preview really lays out at
  // 1440px instead of silently reflowing at whatever the pane allows.
  const previewScale =
    customWidth !== null && viewportWidth > 0 && customWidth > viewportWidth
      ? viewportWidth / customWidth
      : 1;

  // Handle breakpoint button click
  const handleBreakpointClick = useCallback((bp: Breakpoint) => {
    onUserResizeRef.current?.(); // device preset — the editor breakpoint should follow
    if (bp === 'full') {
      setCustomWidth(null);
      setCustomHeight(null);
    } else if (bp === 'desktop') {
      setCustomWidth(1440);
    } else if (bp === 'laptop') {
      setCustomWidth(1024);
    } else if (bp === 'tablet') {
      setCustomWidth(768);
    } else {
      setCustomWidth(375);
    }
    void trackEvent('preview_breakpoint_changed', { breakpoint: bp, $screen_name: 'Workspace' });
  }, []);

  return {
    customWidth,
    customHeight,
    isResizing,
    isVerticalResizing,
    viewportWidth,
    previewScale,
    getActiveBreakpoint,
    setViewportRefs,
    handleResizeStart,
    handleVerticalResizeStart,
    handleBreakpointClick,
    previewAtWidth,
    previewAtSize,
  };
}
