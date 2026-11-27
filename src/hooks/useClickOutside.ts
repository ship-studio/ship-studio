/**
 * Custom React hooks for common UI patterns.
 *
 * @module hooks/useClickOutside
 */

import { useEffect, RefObject } from 'react';

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
 */
export function useClickOutside<T extends HTMLElement>(
  ref: RefObject<T | null>,
  callback: () => void,
  enabled = true,
  excludeSelector?: string,
  excludeRefs: readonly RefObject<HTMLElement | null>[] = []
): void {
  useEffect(() => {
    if (!enabled) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (excludeRefs.some((excluded) => excluded.current?.contains(target))) return;
      if (ref.current && !ref.current.contains(target)) {
        // A modal is a layer *above* whatever is watching for outside clicks,
        // not a sibling of it. ModalFrame already marks every other body child
        // `inert` while a dialog is open, but a document-level listener is not
        // subject to `inert` — so without this, filling in a dialog dismisses
        // the popover underneath it. When that popover owns the dialog's mount
        // (a dropdown rendering a modal in its own subtree) the dialog goes
        // with it, and the feature is simply unusable: this is what made the
        // Create GitHub Repository dialog close on its first click.
        if ((target as Element).closest?.('[data-modal-root]')) {
          return;
        }
        // Check if click is on an excluded element
        if (excludeSelector && (target as Element).closest?.(excludeSelector)) {
          return;
        }
        callback();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [ref, callback, enabled, excludeSelector, excludeRefs]);
}
