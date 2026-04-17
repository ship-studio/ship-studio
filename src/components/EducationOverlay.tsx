/**
 * Education Mode overlay component.
 *
 * Provides an interactive x-ray overlay where users can hover over UI elements
 * to learn what they do. Shows a highlight ring around educatable elements and
 * displays tooltips with titles and descriptions.
 *
 * @module components/EducationOverlay
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { educationContent } from '../lib/educationContent';
import { GraduationCapIcon } from './icons';

interface EducationOverlayProps {
  /** Callback to close the overlay */
  onClose: () => void;
}

interface HighlightedElement {
  /** The education content ID */
  id: string;
  /** Bounding rect of the element */
  rect: DOMRect;
}

export function EducationOverlay({ onClose }: EducationOverlayProps) {
  const [highlighted, setHighlighted] = useState<HighlightedElement | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ top: number; left: number } | null>(
    null
  );
  const overlayRef = useRef<HTMLDivElement>(null);

  // Find element under cursor with data-education-id
  const findEducatableElement = useCallback((x: number, y: number): HighlightedElement | null => {
    // Temporarily hide overlay to detect element beneath
    const overlay = overlayRef.current;
    if (overlay) {
      overlay.style.pointerEvents = 'none';
    }

    const element = document.elementFromPoint(x, y);

    if (overlay) {
      overlay.style.pointerEvents = 'auto';
    }

    if (!element) return null;

    // Find closest ancestor with data-education-id
    const educatable = element.closest<HTMLElement>('[data-education-id]');
    if (!educatable) return null;

    const id = educatable.getAttribute('data-education-id');
    if (!id || !educationContent[id]) return null;

    return {
      id,
      rect: educatable.getBoundingClientRect(),
    };
  }, []);

  // Calculate tooltip position based on element rect
  const calculateTooltipPosition = useCallback((rect: DOMRect): { top: number; left: number } => {
    const tooltipWidth = 280;
    const tooltipHeight = 120; // Approximate
    const padding = 12;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let top: number;
    let left: number;

    // Try to position below the element
    if (rect.bottom + tooltipHeight + padding < viewportHeight) {
      top = rect.bottom + padding;
    }
    // Otherwise position above
    else if (rect.top - tooltipHeight - padding > 0) {
      top = rect.top - tooltipHeight - padding;
    }
    // Fallback to just below with clamping
    else {
      top = Math.min(rect.bottom + padding, viewportHeight - tooltipHeight - padding);
    }

    // Horizontal positioning - try to center on element, but keep in viewport
    left = rect.left + rect.width / 2 - tooltipWidth / 2;
    left = Math.max(padding, Math.min(left, viewportWidth - tooltipWidth - padding));

    return { top, left };
  }, []);

  // Handle mouse movement
  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      const element = findEducatableElement(e.clientX, e.clientY);
      setHighlighted(element);

      if (element) {
        setTooltipPosition(calculateTooltipPosition(element.rect));
      } else {
        setTooltipPosition(null);
      }
    },
    [findEducatableElement, calculateTooltipPosition]
  );

  // Handle click to exit
  const handleClick = useCallback(() => {
    onClose();
  }, [onClose]);

  // Handle escape key to exit
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    },
    [onClose]
  );

  // Set up event listeners
  useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleMouseMove, handleClick, handleKeyDown]);

  // Auto-exit when window shrinks below compact mode threshold
  useEffect(() => {
    const COMPACT_BREAKPOINT = 550;

    const handleResize = () => {
      if (window.innerWidth <= COMPACT_BREAKPOINT) {
        onClose();
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [onClose]);

  const content = highlighted ? educationContent[highlighted.id] : null;

  return (
    <div className="education-overlay" ref={overlayRef}>
      {/* Highlight ring */}
      {highlighted && (
        <div
          className="education-highlight"
          style={{
            top: highlighted.rect.top - 4,
            left: highlighted.rect.left - 4,
            width: highlighted.rect.width + 8,
            height: highlighted.rect.height + 8,
          }}
        />
      )}

      {/* Tooltip */}
      {content && tooltipPosition && (
        <div
          className="education-tooltip"
          style={{
            top: tooltipPosition.top,
            left: tooltipPosition.left,
          }}
        >
          <h4 className="education-tooltip-title">
            <GraduationCapIcon size={16} />
            {content.title}
          </h4>
          <p className="education-tooltip-description">{content.description}</p>
        </div>
      )}

      {/* Exit hint */}
      <div className="education-exit-hint">
        Press <kbd>Esc</kbd> or click anywhere to exit Learn Mode
      </div>
    </div>
  );
}
