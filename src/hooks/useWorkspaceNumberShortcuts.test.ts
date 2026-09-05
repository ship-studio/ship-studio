import { fireEvent, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '../lib/accounts';
import { isMac } from '../lib/setup';
import { useWorkspaceNumberShortcuts } from './useWorkspaceNumberShortcuts';

const { nativeListeners } = vi.hoisted(() => ({
  nativeListeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, callback: (event: { payload: unknown }) => void) => {
    nativeListeners.set(event, callback);
    return Promise.resolve(() => nativeListeners.delete(event));
  }),
}));

vi.mock('../lib/setup', () => ({
  isMac: vi.fn(() => true),
}));

const mockedIsMac = vi.mocked(isMac);

const account = (id: string, name: string): Account => ({
  id,
  name,
  color: '#000000',
  isDefault: id === 'default',
  createdAt: 0,
});

describe('useWorkspaceNumberShortcuts', () => {
  beforeEach(() => {
    nativeListeners.clear();
    mockedIsMac.mockReturnValue(true);
  });

  it('maps the native workspace shortcut to account-picker order', () => {
    const accounts = [account('default', 'Default'), account('client', 'Client')];
    const handleSelectWorkspace = vi.fn();
    renderHook(() =>
      useWorkspaceNumberShortcuts({
        accounts,
        activeAccountId: 'default',
        handleSelectWorkspace,
      })
    );

    nativeListeners.get('switch-workspace-shortcut')?.({ payload: 2 });

    expect(handleSelectWorkspace).toHaveBeenCalledWith(accounts[1]);
  });

  it('supports Alt+number as the non-macOS equivalent', () => {
    mockedIsMac.mockReturnValue(false);
    const accounts = [account('default', 'Default'), account('client', 'Client')];
    const handleSelectWorkspace = vi.fn();
    renderHook(() =>
      useWorkspaceNumberShortcuts({
        accounts,
        activeAccountId: 'default',
        handleSelectWorkspace,
      })
    );

    fireEvent.keyDown(window, { key: '2', altKey: true });

    expect(handleSelectWorkspace).toHaveBeenCalledWith(accounts[1]);
  });

  it('uses the physical number-row code when Option changes the key value', () => {
    const accounts = [account('default', 'Default'), account('client', 'Client')];
    const handleSelectWorkspace = vi.fn();
    renderHook(() =>
      useWorkspaceNumberShortcuts({
        accounts,
        activeAccountId: 'default',
        handleSelectWorkspace,
      })
    );

    fireEvent.keyDown(window, { key: '™', code: 'Digit2', altKey: true });

    expect(handleSelectWorkspace).toHaveBeenCalledWith(accounts[1]);
  });

  it('handles workspace shortcuts forwarded from the focused preview iframe', () => {
    const accounts = [account('default', 'Default'), account('client', 'Client')];
    const handleSelectWorkspace = vi.fn();
    renderHook(() =>
      useWorkspaceNumberShortcuts({
        accounts,
        activeAccountId: 'default',
        handleSelectWorkspace,
      })
    );

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          source: 'shipstudio-inspect',
          type: 'ss:workspaceShortcut',
          index: 1,
        },
      })
    );

    expect(handleSelectWorkspace).toHaveBeenCalledWith(accounts[1]);
  });
});
