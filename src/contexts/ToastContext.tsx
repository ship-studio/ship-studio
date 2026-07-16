import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useToasts, type UseToastsReturn, type ToastType } from '../hooks/useToasts';

export const ToastContext = createContext<UseToastsReturn | null>(null);

interface ProviderProps {
  children: ReactNode;
}

export function ToastProvider({ children }: ProviderProps) {
  const { toasts, showToast, dismissToast } = useToasts();
  // Memoize the context value so consumers only re-render when toast state
  // actually changes (not when an ancestor re-renders the provider). The
  // `showToast` / `dismissToast` functions are useCallback-stable inside
  // `useToasts`, so effects and callbacks may safely list them as deps.
  const value = useMemo(
    () => ({ toasts, showToast, dismissToast }),
    [toasts, showToast, dismissToast]
  );
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

/**
 * Access the global toast notification system. Must be called inside a `<ToastProvider>`.
 * Prefer this over passing `onToast` props down the tree — it avoids prop drilling and
 * keeps a single source of toast state that the global `<ToastContainer>` reads from.
 */
export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used inside a <ToastProvider>');
  }
  return ctx;
}

/**
 * Stable no-op fallback for `useOptionalToast` outside a provider. Must be a
 * module-level singleton — a fresh object/function on every render would
 * break referential equality for any `useCallback`/`useEffect` that depends
 * on `showToast`, causing infinite re-render loops.
 */
const NOOP_TOAST = {
  showToast: () => {
    /* no provider in scope — silently drop */
  },
};

/**
 * Optional variant for code paths that may render outside the provider (tests, isolated
 * stories). Returns a no-op `showToast` so call sites don't need to special-case absence.
 */
export function useOptionalToast(): { showToast: (message: string, type?: ToastType) => void } {
  const ctx = useContext(ToastContext);
  if (ctx) return ctx;
  return NOOP_TOAST;
}
