import { createContext, useContext, type ReactNode } from 'react';
import { useToasts, type UseToastsReturn, type ToastType } from '../hooks/useToasts';

export const ToastContext = createContext<UseToastsReturn | null>(null);

interface ProviderProps {
  children: ReactNode;
}

export function ToastProvider({ children }: ProviderProps) {
  const value = useToasts();
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
 * Optional variant for code paths that may render outside the provider (tests, isolated
 * stories). Returns a no-op `showToast` so call sites don't need to special-case absence.
 */
export function useOptionalToast(): { showToast: (message: string, type?: ToastType) => void } {
  const ctx = useContext(ToastContext);
  if (ctx) return ctx;
  return {
    showToast: () => {
      /* no provider in scope — silently drop */
    },
  };
}
