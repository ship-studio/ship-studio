import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTerminalManagement } from './useTerminalManagement';

describe('adoptTerminalTab', () => {
  it('adds a running background tab without changing the active tab', () => {
    const { result } = renderHook(() => useTerminalManagement('/a'));
    expect(result.current.adoptTerminalTab('/b', { agentId: 'x', sessionId: 's' })).toBe(false);
    act(() => result.current.ensureProjectSeeded('/b'));
    let adopted = false;
    act(() => {
      adopted = result.current.adoptTerminalTab('/b', { agentId: 'claude-code', sessionId: 's' });
    });
    expect(adopted).toBe(true);
    const b = result.current.allSessions.find((s) => s.projectPath === '/b');
    expect(b?.tabs).toHaveLength(2);
    expect(b?.tabs[1]).toMatchObject({ sessionId: 's', shouldResume: true });
    expect(b?.activeTabId).toBe(b?.tabs[0].id);
    // Adopting the same session twice is one tab.
    act(() => void result.current.adoptTerminalTab('/b', { agentId: 'x', sessionId: 's' }));
    expect(result.current.tabsForProject('/b')).toHaveLength(2);
  });

  it('closes a tab of a project that is not the current one', () => {
    const { result } = renderHook(() => useTerminalManagement('/a'));
    act(() => result.current.ensureProjectSeeded('/b'));
    act(() => void result.current.adoptTerminalTab('/b', { agentId: 'x', sessionId: 's' }));
    const id = result.current.tabsForProject('/b')?.[1].id ?? -1;
    act(() => result.current.closeTerminalTab(id, '/b'));
    expect(result.current.tabsForProject('/b')).toHaveLength(1);
  });
});
