import { fireEvent, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewHandle } from '../components/preview/Preview';
import { isMac } from '../lib/setup';
import { useWorkspaceShortcutControls } from './useWorkspaceShortcutControls';

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

function addPanelButtons(labels: string[]) {
  const group = document.createElement('div');
  group.className = 'workspace-panel-group';
  const clicks = labels.map(() => vi.fn());
  const buttons = labels.map((label, index) => {
    const button = document.createElement('button');
    button.dataset.workspacePanel = label.toLowerCase();
    button.setAttribute('aria-label', label);
    button.addEventListener('click', clicks[index]);
    group.append(button);
    return button;
  });
  document.body.append(group);
  return { group, buttons, clicks };
}

function renderControls(
  overrides: Partial<Parameters<typeof useWorkspaceShortcutControls>[0]> = {}
) {
  return renderHook(() =>
    useWorkspaceShortcutControls({
      previewRef: { current: null },
      hasPreview: true,
      projectTypeResolved: true,
      setIsPreviewHidden: vi.fn(),
      setIsAgentPanelHidden: vi.fn(),
      setWorkspaceTab: vi.fn(),
      togglePreviewLogs: vi.fn(),
      ...overrides,
    })
  );
}

describe('useWorkspaceShortcutControls', () => {
  beforeEach(() => {
    nativeListeners.clear();
    document.body.innerHTML = '';
    mockedIsMac.mockReturnValue(true);
  });

  it('maps plain numbers to the rendered panel order', () => {
    const { group, buttons, clicks } = addPanelButtons([
      'Agent',
      'Elements',
      'Variables',
      'Assets',
      'Plugins',
    ]);
    renderControls();

    fireEvent.keyDown(window, { key: '2' });
    expect(clicks[1]).toHaveBeenCalledTimes(1);

    const reordered = [...buttons].reverse();
    group.replaceChildren(...reordered);
    fireEvent.keyDown(window, { key: '1' });
    expect(clicks[4]).toHaveBeenCalledTimes(1);
  });

  it('leaves number entry in text fields alone', () => {
    const { clicks } = addPanelButtons(['Agent']);
    const input = document.createElement('input');
    document.body.append(input);
    renderControls();

    fireEvent.keyDown(input, { key: '1', bubbles: true });
    expect(clicks[0]).not.toHaveBeenCalled();
  });

  it('handles native mode and Edit events on macOS', () => {
    const setIsPreviewHidden = vi.fn();
    const setIsAgentPanelHidden = vi.fn();
    const setWorkspaceTab = vi.fn();
    const toggleEditMode = vi.fn();
    renderControls({
      previewRef: {
        current: { toggleEditMode } as unknown as PreviewHandle,
      },
      setIsPreviewHidden,
      setIsAgentPanelHidden,
      setWorkspaceTab,
    });

    nativeListeners.get('switch-workspace-mode-shortcut')?.({ payload: 2 });
    expect(setIsAgentPanelHidden).toHaveBeenCalledWith(false);
    expect(setIsPreviewHidden).toHaveBeenCalledWith(true);

    nativeListeners.get('toggle-edit-mode-shortcut')?.({ payload: undefined });
    expect(toggleEditMode).toHaveBeenCalledTimes(1);

    const togglePreviewLogs = vi.fn();
    renderControls({ togglePreviewLogs });
    nativeListeners.get('toggle-inspector-shortcut')?.({ payload: undefined });
    expect(togglePreviewLogs).toHaveBeenCalledTimes(1);
  });

  it('uses Ctrl+E as the primary-modifier equivalent off macOS', () => {
    mockedIsMac.mockReturnValue(false);
    const toggleEditMode = vi.fn();
    renderControls({
      previewRef: {
        current: { toggleEditMode } as unknown as PreviewHandle,
      },
    });

    fireEvent.keyDown(window, { key: 'e', ctrlKey: true });
    expect(toggleEditMode).toHaveBeenCalledTimes(1);
  });
});
