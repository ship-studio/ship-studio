/**
 * Tests for the plugin context built by PluginSlot — async rejections from
 * shell.exec / storage.* / invoke.call must surface as an error toast naming
 * the plugin, then re-throw so plugins handling their own errors still can.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockIPC } from '@tauri-apps/api/mocks';
import { buildContext } from './PluginSlot';
import type { PluginAppActions, PluginThemeData } from '../../contexts/PluginContext';

const theme: PluginThemeData = {
  bgPrimary: '',
  bgSecondary: '',
  bgTertiary: '',
  textPrimary: '',
  textSecondary: '',
  textMuted: '',
  border: '',
  accent: '',
  accentHover: '',
  action: '',
  actionHover: '',
  actionText: '',
  error: '',
  success: '',
};

function makeActions() {
  const showToast = vi.fn();
  const actions: PluginAppActions = {
    showToast,
    refreshGitStatus: vi.fn(),
    refreshBranches: vi.fn(),
    focusTerminal: vi.fn(),
    openUrl: vi.fn(),
    openTerminal: vi.fn(() => Promise.resolve(null)),
  };
  return { actions, showToast };
}

const project = {
  name: 'demo',
  path: '/p/demo',
  currentBranch: 'main',
  hasUncommittedChanges: false,
};

describe('buildContext failure reporting', () => {
  beforeEach(() => {
    // Every backend call rejects — simulates e.g. a failing CLI.
    mockIPC(() => {
      throw new Error('boom from backend');
    });
  });

  it('toasts and re-throws when shell.exec rejects', async () => {
    const { actions, showToast } = makeActions();
    const ctx = buildContext('sanity', 'Sanity', project, actions, theme, []);

    await expect(ctx.shell.exec('sanity', ['deploy'])).rejects.toThrow('boom from backend');
    expect(showToast).toHaveBeenCalledTimes(1);
    const message = showToast.mock.calls[0][0] as string;
    expect(message).toContain('Plugin "Sanity"');
    expect(message).toContain('boom from backend');
    expect(showToast.mock.calls[0][1]).toBe('error');
  });

  it('toasts and re-throws when storage.read / storage.write reject', async () => {
    const { actions, showToast } = makeActions();
    const ctx = buildContext('sanity', 'Sanity', project, actions, theme, []);

    await expect(ctx.storage.read()).rejects.toThrow('boom from backend');
    await expect(ctx.storage.write({ a: 1 })).rejects.toThrow('boom from backend');
    expect(showToast).toHaveBeenCalledTimes(2);
  });

  it('toasts the allowlist rejection for non-allowlisted invoke.call', async () => {
    const { actions, showToast } = makeActions();
    const ctx = buildContext('sanity', 'Sanity', project, actions, theme, ['allowed_cmd']);

    await expect(ctx.invoke.call('forbidden_cmd')).rejects.toThrow(
      'Plugin "sanity" is not allowed to call "forbidden_cmd"'
    );
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0][0]).toContain('not allowed to call "forbidden_cmd"');
    expect(showToast.mock.calls[0][1]).toBe('error');
  });

  it('toasts and re-throws when an allowlisted invoke.call rejects', async () => {
    const { actions, showToast } = makeActions();
    const ctx = buildContext('sanity', 'Sanity', project, actions, theme, ['allowed_cmd']);

    await expect(ctx.invoke.call('allowed_cmd')).rejects.toThrow('boom from backend');
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0][0]).toContain('Plugin "Sanity"');
  });

  it('does not toast when the call succeeds', async () => {
    mockIPC((cmd) => {
      if (cmd === 'read_plugin_storage') return { key: 'value' };
      return undefined;
    });
    const { actions, showToast } = makeActions();
    const ctx = buildContext('sanity', 'Sanity', project, actions, theme, []);

    await expect(ctx.storage.read()).resolves.toEqual({ key: 'value' });
    expect(showToast).not.toHaveBeenCalled();
  });
});
