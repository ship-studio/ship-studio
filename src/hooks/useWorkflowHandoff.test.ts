import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFindingHandoff } from './useWorkflowHandoff';
import { clearHandoff, queueHandoff, peekHandoff } from '../lib/workflowHandoff';

describe('useFindingHandoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearHandoff();
  });
  afterEach(() => vi.useRealTimers());

  const setup = (overrides: { tabCount?: number; maxTabs?: number; path?: string } = {}) => {
    const addTerminalTab = vi.fn();
    const showToast = vi.fn();
    const props = {
      path: overrides.path ?? '/p/demo',
      terminals: {
        terminalTabs: new Array<unknown>(overrides.tabCount ?? 1).fill(null),
        maxTerminalTabs: overrides.maxTabs ?? 6,
        addTerminalTab,
      },
    };
    const view = renderHook(
      (p: typeof props) => useFindingHandoff(p.path, p.terminals, showToast),
      { initialProps: props }
    );
    return { addTerminalTab, showToast, view, props };
  };

  it('starts a new agent with the finding in its argv', () => {
    // The delivery is a spawn, not a paste: the prompt reaches the CLI as an
    // argument, so there is no window where the terminal exists but the agent
    // is not yet listening, and nothing has to press Return.
    queueHandoff('/p/demo', 'Fix the checkout route');
    const { addTerminalTab, showToast } = setup();

    act(() => void vi.advanceTimersByTime(500));

    expect(addTerminalTab).toHaveBeenCalledWith(undefined, {
      initialPrompt: 'Fix the checkout route',
      projectPath: '/p/demo',
    });
    expect(peekHandoff('/p/demo')).toBeNull();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('on it'), 'success');
  });

  it('waits for the project to finish opening rather than dropping the prompt', () => {
    queueHandoff('/p/demo', 'Fix it');
    // No tabs yet — the workspace is still mounting.
    const { addTerminalTab, view, props } = setup({ tabCount: 0 });

    act(() => void vi.advanceTimersByTime(2000));
    expect(addTerminalTab).not.toHaveBeenCalled();
    expect(peekHandoff('/p/demo')).toBe('Fix it');

    view.rerender({ ...props, terminals: { ...props.terminals, terminalTabs: [null] } });
    act(() => void vi.advanceTimersByTime(500));
    expect(addTerminalTab).toHaveBeenCalled();
  });

  it('never delivers a prompt into a different project', () => {
    queueHandoff('/p/other', 'Not for this one');
    const { addTerminalTab } = setup();
    act(() => void vi.advanceTimersByTime(2000));
    expect(addTerminalTab).not.toHaveBeenCalled();
  });

  it('gives up out loud rather than leaving the prompt queued', () => {
    // A prompt left in the queue would ambush whatever terminal appeared next.
    queueHandoff('/p/demo', 'Fix it');
    const { addTerminalTab, showToast } = setup({ tabCount: 0 });

    act(() => void vi.advanceTimersByTime(61_000));

    expect(addTerminalTab).not.toHaveBeenCalled();
    expect(peekHandoff('/p/demo')).toBeNull();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Copy prompt'), 'error');
  });

  it('delivers once, not once per retry', () => {
    queueHandoff('/p/demo', 'Fix it');
    const { addTerminalTab } = setup();
    act(() => void vi.advanceTimersByTime(5000));
    expect(addTerminalTab).toHaveBeenCalledTimes(1);
  });

  it('says there is no room rather than retrying a blocker that cannot clear', () => {
    // At the cap `addTerminalTab` no-ops; consuming the prompt on a call that
    // did nothing is how a finding silently disappears.
    queueHandoff('/p/demo', 'Fix it');
    const { addTerminalTab, showToast } = setup({ tabCount: 6, maxTabs: 6 });

    act(() => void vi.advanceTimersByTime(1000));

    expect(addTerminalTab).not.toHaveBeenCalled();
    expect(peekHandoff('/p/demo')).toBeNull();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('maximum number'), 'error');
  });
});
