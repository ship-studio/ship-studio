import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useToasts } from './useToasts';

describe('useToasts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with empty toasts array', () => {
    const { result } = renderHook(() => useToasts());
    expect(result.current.toasts).toEqual([]);
  });

  it('adds a toast with default success type', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('Hello');
    });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0]).toMatchObject({
      message: 'Hello',
      type: 'success',
    });
  });

  it('adds a toast with specified type', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('Error occurred', 'error');
    });

    expect(result.current.toasts[0].type).toBe('error');
  });

  it('assigns unique incrementing IDs', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('First');
      result.current.showToast('Second');
    });

    expect(result.current.toasts[0].id).toBeLessThan(result.current.toasts[1].id);
  });

  it('dismisses a toast by ID', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('Keep me');
      result.current.showToast('Remove me');
    });

    const toRemove = result.current.toasts[1].id;

    act(() => {
      result.current.dismissToast(toRemove);
    });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].message).toBe('Keep me');
  });

  it('auto-dismisses after 4000ms', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('Temporary');
    });
    expect(result.current.toasts).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(3999);
    });
    expect(result.current.toasts).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.toasts).toHaveLength(0);
  });

  it('auto-dismisses info toasts after 4000ms', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('FYI', 'info');
    });

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(result.current.toasts).toHaveLength(0);
  });

  it('never auto-dismisses error toasts', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('Something broke: detail here', 'error');
    });
    expect(result.current.toasts).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].type).toBe('error');
  });

  it('error toasts can still be dismissed manually', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('Something broke', 'error');
    });
    const id = result.current.toasts[0].id;

    act(() => {
      result.current.dismissToast(id);
    });
    expect(result.current.toasts).toHaveLength(0);
  });

  it('success toasts auto-dismiss while an error toast persists', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('Something broke', 'error');
      result.current.showToast('All good');
    });
    expect(result.current.toasts).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].type).toBe('error');
  });

  it('keeps max 5 toasts, removing oldest first', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      for (let i = 1; i <= 6; i++) {
        result.current.showToast(`Toast ${i}`);
      }
    });

    expect(result.current.toasts).toHaveLength(5);
    expect(result.current.toasts[0].message).toBe('Toast 2');
    expect(result.current.toasts[4].message).toBe('Toast 6');
  });

  it('does nothing when dismissing non-existent ID', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('Stays');
    });

    act(() => {
      result.current.dismissToast(9999);
    });

    expect(result.current.toasts).toHaveLength(1);
  });

  it('handles multiple auto-dismiss timers independently', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('First');
    });

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    act(() => {
      result.current.showToast('Second');
    });

    // First toast should dismiss at 4000ms total
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].message).toBe('Second');

    // Second toast should dismiss at 6000ms total
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.toasts).toHaveLength(0);
  });
});
