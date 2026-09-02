import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  COMPACT_WORKSPACE_TOOLBAR_CHANGED_EVENT,
  DASHBOARD_VISIBILITY_CHANGED_EVENT,
  getAppIcon,
  setCalendarHidden,
  setCompactWorkspaceToolbarEnabled,
  setDashboardHeaderHidden,
  setAppIcon,
  setSlackCtaHidden,
} from './settings';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('dashboard visibility settings', () => {
  const invokeMock = vi.mocked(invoke);

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it.each([
    ['calendar', 'set_calendar_hidden', setCalendarHidden],
    ['slackCta', 'set_slack_cta_hidden', setSlackCtaHidden],
    ['dashboardHeader', 'set_dashboard_header_hidden', setDashboardHeaderHidden],
  ] as const)('notifies the home screen when %s is persisted', async (key, command, setter) => {
    const listener = vi.fn();
    window.addEventListener(DASHBOARD_VISIBILITY_CHANGED_EVENT, listener);

    await setter(true);

    expect(invokeMock).toHaveBeenCalledWith(command, { hidden: true });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      detail: { key, hidden: true },
    });

    window.removeEventListener(DASHBOARD_VISIBILITY_CHANGED_EVENT, listener);
  });
});

describe('workspace toolbar setting', () => {
  const invokeMock = vi.mocked(invoke);

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it('persists and broadcasts the compact workspace toolbar preference', async () => {
    const listener = vi.fn();
    window.addEventListener(COMPACT_WORKSPACE_TOOLBAR_CHANGED_EVENT, listener);

    await setCompactWorkspaceToolbarEnabled(true);

    expect(invokeMock).toHaveBeenCalledWith('set_compact_workspace_toolbar_enabled', {
      enabled: true,
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ detail: true });

    window.removeEventListener(COMPACT_WORKSPACE_TOOLBAR_CHANGED_EVENT, listener);
  });
});

describe('app icon setting', () => {
  const invokeMock = vi.mocked(invoke);

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it('reads a valid persisted icon', async () => {
    invokeMock.mockResolvedValueOnce('dark');

    await expect(getAppIcon()).resolves.toBe('dark');
    expect(invokeMock).toHaveBeenCalledWith('get_app_icon');
  });

  it('falls back to the brand icon for an unknown persisted value', async () => {
    invokeMock.mockResolvedValueOnce('unknown');

    await expect(getAppIcon()).resolves.toBe('brand');
  });

  it('persists the selected icon', async () => {
    await setAppIcon('light');

    expect(invokeMock).toHaveBeenCalledWith('set_app_icon', { icon: 'light' });
  });
});
