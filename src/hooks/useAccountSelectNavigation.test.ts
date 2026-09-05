import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAccountSelectNavigation } from './useAccountSelectNavigation';
import type { AppView } from '../lib/types';

describe('useAccountSelectNavigation', () => {
  it('returns to the screen the switcher was opened from', () => {
    const setView = vi.fn();
    const { result, rerender } = renderHook(
      ({ view }: { view: AppView }) => useAccountSelectNavigation(view, setView),
      { initialProps: { view: 'inbox' as AppView } }
    );
    act(() => result.current.openAccountSelect());
    expect(setView).toHaveBeenLastCalledWith('account-select');
    rerender({ view: 'account-select' });
    act(() => result.current.accountSelectProps.onBack());
    expect(setView).toHaveBeenLastCalledWith('inbox');
  });

  it('falls back to Home for screens that are not worth returning to', () => {
    const setView = vi.fn();
    const { result } = renderHook(() => useAccountSelectNavigation('loading', setView));
    act(() => result.current.openAccountSelect());
    act(() => result.current.accountSelectProps.onBack());
    expect(setView).toHaveBeenLastCalledWith('projects');
  });

  it('continues to Home after a switch', () => {
    const setView = vi.fn();
    const { result } = renderHook(() => useAccountSelectNavigation('workspace', setView));
    act(() => result.current.accountSelectProps.onContinue());
    expect(setView).toHaveBeenLastCalledWith('projects');
  });
});
