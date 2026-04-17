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

/** Pixel widths for fixed breakpoints (excludes 'full' which is 100%) */
const BREAKPOINT_WIDTHS: number[] = [1440, 1024, 768, 375];

/** Space reserved for the resize handle on the right side of the viewport */
const VIEWPORT_PADDING_PX = 12;

interface UsePreviewResizeParams {
  /** Ref to the iframe wrapper element, used to read its offsetWidth during resize drag */
  iframeWrapperRef: React.RefObject<HTMLDivElement | null>;
}

export function usePreviewResize({ iframeWrapperRef }: UsePreviewResizeParams) {
  const [customWidth, setCustomWidth] = useState<number | null>(null); // null = 100% (desktop)

  const viewportRef = useRef<HTMLDivElement | null>(null);

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

      // Observe future size changes — also auto-switch breakpoint if current no longer fits
      observerRef.current = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const newWidth = entry.contentRect.width - VIEWPORT_PADDING_PX;
          setViewportWidth(newWidth);

          const currentCustom = customWidthRef.current;
          if (currentCustom !== null && currentCustom > newWidth) {
            const fittingWidth = BREAKPOINT_WIDTHS.find((w) => w <= newWidth);
            setCustomWidth(fittingWidth ?? null);
          }
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

  // Handle breakpoint button click
  const handleBreakpointClick = useCallback((bp: Breakpoint) => {
    if (bp === 'full') {
      setCustomWidth(null);
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
    isResizing,
    viewportWidth,
    getActiveBreakpoint,
    setViewportRefs,
    handleResizeStart,
    handleBreakpointClick,
  };
}
