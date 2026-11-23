/**
 * Custom React hooks for common UI patterns.
 *
 * @module hooks/useClickOutside
 */

import { useEffect, type RefObject } from 'react';

type ClickOutsideRef = RefObject<HTMLElement | null>;
const NO_INSIDE_REFS: readonly ClickOutsideRef[] = [];

/**
 * Hook that detects clicks outside a referenced element.
 *
 * Useful for closing dropdowns, modals, and popovers when the user
 * clicks outside of them. The callback is only fired when enabled is true.
 *
 * @example
 * ```tsx
 * const dropdownRef = useRef<HTMLDivElement>(null);
 * const [isOpen, setIsOpen] = useState(false);
 *
 * useClickOutside(dropdownRef, () => setIsOpen(false), isOpen);
 * ```
 *
 * @param ref - Reference to the element to monitor
 * @param callback - Function to call when clicking outside
 * @param enabled - Whether the hook is active (default: true)
 * @param excludeSelector - Optional CSS selector for elements to exclude from outside detection
 * @param insideRefs - Additional element refs treated as part of the boundary (for portals)
 */
export function useClickOutside<T extends HTMLElement>(
  ref: RefObject<T | null>,
  callback: () => void,
  enabled = true,
  excludeSelector?: string,
  insideRefs: readonly ClickOutsideRef[] = NO_INSIDE_REFS
): void {
  useEffect(() => {
    if (!enabled) return;
    let frameFocusTimer: number | undefined;

    const isInsideBoundary = (target: Node) =>
      Boolean(
        ref.current?.contains(target) ||
        insideRefs.some((insideRef) => insideRef.current?.contains(target))
      );

    const isDismissalExempt = (target: EventTarget | null): boolean => {
      if (!(target instanceof Node)) return false;
      if (isInsideBoundary(target)) return true;

      const element = target instanceof Element ? target : target.parentElement;
      if (!element) return false;

      // A modal is a layer *above* whatever is watching for outside clicks,
      // not a sibling of it. ModalFrame already marks every other body child
      // `inert` while a dialog is open, but a document-level listener is not
      // subject to `inert` — so without this, filling in a dialog dismisses
      // the popover underneath it. When that popover owns the dialog's mount
      // (a dropdown rendering a modal in its own subtree) the dialog goes
      // with it, and the feature is simply unusable.
      if (element.closest('[data-modal-root]')) return true;

      if (
        target instanceof HTMLIFrameElement &&
        document.querySelector('[data-modal-root] [data-modal-id]')
      ) {
        // A modal focus trap may briefly move focus through an inert iframe;
        // the modal is the active layer and must keep the underlying menu open.
        return true;
      }

      // Check if the interaction is on an excluded element.
      return Boolean(excludeSelector && element.closest(excludeSelector));
    };

    const handleClickOutside = (event: MouseEvent) => {
      if (ref.current && !isDismissalExempt(event.target)) callback();
    };

    const dismissOutsideFrame = (target: EventTarget | null) => {
      if (ref.current && target instanceof HTMLIFrameElement && !isDismissalExempt(target)) {
        callback();
      }
    };

    const handleFocusIn = (event: FocusEvent) => dismissOutsideFrame(event.target);

    // A pointer click inside a frame may blur the parent window without a
    // focusin event. Wait for the parent document's active element to settle.
    const handleWindowBlur = () => {
      window.clearTimeout(frameFocusTimer);
      frameFocusTimer = window.setTimeout(() => dismissOutsideFrame(document.activeElement), 0);
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('focusin', handleFocusIn, true);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('focusin', handleFocusIn, true);
      window.removeEventListener('blur', handleWindowBlur);
      window.clearTimeout(frameFocusTimer);
    };
  }, [ref, callback, enabled, excludeSelector, insideRefs]);
}
