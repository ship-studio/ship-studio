/**
 * Custom hook for managing toast notifications.
 *
 * Extracted from App.tsx to reduce component complexity and improve reusability.
 * This hook is completely self-contained with no external dependencies, making it
 * an ideal candidate for extraction.
 *
 * Provides a simple API for showing and dismissing toast notifications
 * with automatic cleanup after a timeout.
 *
 * @module hooks/useToasts
 */

import { useState, useRef, useCallback, useEffect } from 'react';

/** Toast notification type */
export type ToastType = 'success' | 'error' | 'info';

/** Toast notification data */
export interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

/** Return type for useToasts hook */
export interface UseToastsReturn {
  /** Array of active toast notifications */
  toasts: Toast[];
  /** Show a new toast notification */
  showToast: (message: string, type?: ToastType) => void;
  /** Dismiss a toast by ID */
  dismissToast: (id: number) => void;
}

/** Maximum number of toasts to display at once */
const MAX_TOASTS = 5;
/** Time in ms before a success/info toast auto-dismisses. Error toasts never
 *  auto-dismiss — the user needs time to read (and copy) the full detail, so
 *  they persist until manually dismissed via the ✕ button. */
const TOAST_DURATION_MS = 4000;

/**
 * Hook for managing toast notifications.
 *
 * @example
 * ```tsx
 * const { toasts, showToast, dismissToast } = useToasts();
 *
 * // Show a success toast
 * showToast('Operation completed', 'success');
 *
 * // Show an error toast
 * showToast('Something went wrong', 'error');
 *
 * // Dismiss a specific toast
 * dismissToast(toastId);
 * ```
 *
 * @returns Toast state and control functions
 */
export function useToasts(): UseToastsReturn {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);
  const timerMap = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  // Clear all toast timers on unmount
  useEffect(() => {
    const map = timerMap.current;
    return () => {
      map.forEach(clearTimeout);
      map.clear();
    };
  }, []);

  const showToast = useCallback((message: string, type: ToastType = 'success') => {
    const id = ++toastIdRef.current;
    setToasts((prev) => {
      // Keep max toasts, remove oldest if needed
      const updated = [...prev, { id, message, type }];
      return updated.slice(-MAX_TOASTS);
    });
    // Auto-dismiss after timeout — except errors, which persist until the
    // user dismisses them (they carry detail worth reading/copying).
    if (type !== 'error') {
      const timer = setTimeout(() => {
        timerMap.current.delete(id);
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, TOAST_DURATION_MS);
      timerMap.current.set(id, timer);
    }
  }, []);

  const dismissToast = useCallback((id: number) => {
    const timer = timerMap.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timerMap.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, showToast, dismissToast };
}
