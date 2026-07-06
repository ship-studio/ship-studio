/**
 * Tests for ToastContext (issue #48).
 *
 * The app mounts <ToastProvider> at the root, so `useOptionalToast()` must
 * return the real context (not the no-op fallback) and its `showToast` must
 * be referentially stable across re-renders — components put it in
 * useCallback/useEffect dep arrays.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ToastProvider, useToast, useOptionalToast } from './ToastContext';

/** Fires a toast through the optional hook — the path that used to no-op. */
function OptionalToastTrigger() {
  const { showToast } = useOptionalToast();
  return (
    <button onClick={() => showToast('Saved via optional hook', 'success')}>Trigger toast</button>
  );
}

/** Renders the shared toast stack the way App.tsx does (from `useToast().toasts`). */
function ToastStack() {
  const { toasts } = useToast();
  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <ToastProvider>{children}</ToastProvider>
);

describe('ToastContext', () => {
  it('useOptionalToast inside the provider shows a toast in the shared stack', () => {
    render(
      <ToastProvider>
        <OptionalToastTrigger />
        <ToastStack />
      </ToastProvider>
    );

    expect(screen.queryByText('Saved via optional hook')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Trigger toast' }));

    expect(screen.getByText('Saved via optional hook')).toBeInTheDocument();
  });

  it('useOptionalToast returns a stable showToast identity across re-renders', () => {
    const { result, rerender } = renderHook(() => useOptionalToast(), { wrapper });
    const first = result.current.showToast;

    rerender();
    rerender();

    expect(result.current.showToast).toBe(first);
  });

  it('showToast identity survives toast state changes', () => {
    const { result } = renderHook(() => useToast(), { wrapper });
    const first = result.current.showToast;

    // Adding a toast re-renders the provider — showToast must not change.
    act(() => {
      result.current.showToast('A toast', 'info');
    });

    expect(result.current.showToast).toBe(first);
    expect(result.current.toasts).toHaveLength(1);
  });

  it('useOptionalToast outside a provider returns the stable no-op singleton', () => {
    const { result, rerender } = renderHook(() => useOptionalToast());
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
    expect(() => result.current.showToast('dropped')).not.toThrow();
  });
});
