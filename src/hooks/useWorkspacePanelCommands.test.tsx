import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSnapshot, _reset } from '../commands/registry';
import { useWorkspacePanelCommands } from './useWorkspacePanelCommands';

beforeEach(() => _reset());
afterEach(() => _reset());

describe('useWorkspacePanelCommands', () => {
  it('registers the panel-link action and toggles the linked-mode preference', async () => {
    const togglePanelLinking = vi.fn();
    const { rerender } = renderHook(
      ({ panelLinkingEnabled }) =>
        useWorkspacePanelCommands({
          isAgentPanelHidden: false,
          toggleAgentPanel: vi.fn(),
          agentPanelDocked: true,
          toggleAgentPanelDocked: vi.fn(),
          elementTreeDocked: true,
          toggleElementTreeDocked: vi.fn(),
          variablesPanelDocked: true,
          toggleVariablesPanelDocked: vi.fn(),
          isWebProject: true,
          variablesPanelOpen: false,
          toggleVariablesPanel: vi.fn(),
          panelLinkingEnabled,
          togglePanelLinking,
          showPreviewLogs: false,
          togglePreviewLogs: vi.fn(),
        }),
      { initialProps: { panelLinkingEnabled: false } }
    );

    await waitFor(() =>
      expect(
        getSnapshot().find((command) => command.id === 'workspace.togglePanelLinking')
      ).toBeDefined()
    );
    const command = getSnapshot().find((item) => item.id === 'workspace.togglePanelLinking');
    expect(command?.title).toBe('Link workspace panels');
    expect(command?.when).toBe('project');
    act(() => void command?.run());
    expect(togglePanelLinking).toHaveBeenCalledTimes(1);

    rerender({ panelLinkingEnabled: true });
    await waitFor(() =>
      expect(getSnapshot().find((item) => item.id === 'workspace.togglePanelLinking')?.title).toBe(
        'Allow multiple workspace panels'
      )
    );
  });
});
