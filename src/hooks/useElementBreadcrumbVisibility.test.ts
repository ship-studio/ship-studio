import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ELEMENT_BREADCRUMB_ENABLED_CHANGED_EVENT } from '../lib/settings';
import { useElementBreadcrumbVisibility } from './useElementBreadcrumbVisibility';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('useElementBreadcrumbVisibility', () => {
  const invokeMock = vi.mocked(invoke);

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(true);
  });

  it('loads the persisted preference and responds to live setting changes', async () => {
    const { result } = renderHook(() => useElementBreadcrumbVisibility());

    await waitFor(() => expect(result.current[0]).toBe(true));
    expect(invokeMock).toHaveBeenCalledWith('get_element_breadcrumb_enabled');

    act(() => {
      window.dispatchEvent(
        new CustomEvent<boolean>(ELEMENT_BREADCRUMB_ENABLED_CHANGED_EVENT, { detail: false })
      );
    });

    expect(result.current[0]).toBe(false);
  });

  it('updates the local value and persists changes', async () => {
    const { result } = renderHook(() => useElementBreadcrumbVisibility());

    await waitFor(() => expect(result.current[0]).toBe(true));

    act(() => result.current[1](false));

    expect(result.current[0]).toBe(false);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('set_element_breadcrumb_enabled', { enabled: false })
    );
  });
});
