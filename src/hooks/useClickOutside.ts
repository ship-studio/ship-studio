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
 */
export function useClickOutside<T extends HTMLElement>(
  ref: RefObject<T | null>,
  callback: () => void,
  enabled = true
): void {
  useEffect(() => {
    if (!enabled) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        callback();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [ref, callback, enabled]);
}
