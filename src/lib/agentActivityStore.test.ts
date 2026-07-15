import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { agentActivityStore, beginAgentActivity } from './agentActivityStore';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // Drain lingering timers so state resets to idle between tests.
  vi.runAllTimers();
  vi.useRealTimers();
});

describe('agentActivityStore', () => {
  it('is idle by default', () => {
    expect(agentActivityStore.getState().visible).toBe(false);
  });

  it('shows busy state with a tool-specific label while a call is in flight', () => {
    const end = beginAgentActivity('preview_console', undefined);
    const state = agentActivityStore.getState();
    expect(state.visible).toBe(true);
    expect(state.busy).toBe(true);
    expect(state.label).toContain('console');
    end();
  });

  it('includes the path in the navigate label', () => {
    const end = beginAgentActivity('preview_navigate', { path: '/pricing' });
    expect(agentActivityStore.getState().label).toContain('/pricing');
    end();
  });

  it('lingers after the call ends, plays the exit phase, then goes idle', () => {
    const end = beginAgentActivity('preview_network', undefined);
    end();
    // Still visible (linger window), no longer busy.
    expect(agentActivityStore.getState().visible).toBe(true);
    expect(agentActivityStore.getState().busy).toBe(false);
    vi.advanceTimersByTime(2300); // past the linger, inside the exit window
    expect(agentActivityStore.getState().visible).toBe(false);
    expect(agentActivityStore.getState().exiting).toBe(true);
    vi.advanceTimersByTime(300);
    expect(agentActivityStore.getState().exiting).toBe(false);
  });

  it('a call arriving mid-exit cancels the exit and shows immediately', () => {
    const endA = beginAgentActivity('preview_console', undefined);
    endA();
    vi.advanceTimersByTime(2300); // into the exit window
    expect(agentActivityStore.getState().exiting).toBe(true);
    const endB = beginAgentActivity('preview_dom', undefined);
    expect(agentActivityStore.getState().visible).toBe(true);
    expect(agentActivityStore.getState().exiting).toBe(false);
    endB();
  });

  it('emits a cursor effect for navigate and a flash for screenshot', () => {
    const endNav = beginAgentActivity('preview_navigate', { path: '/a' });
    expect(agentActivityStore.getState().effect?.kind).toBe('cursor');
    endNav();
    const endShot = beginAgentActivity('preview_screenshot', undefined);
    expect(agentActivityStore.getState().effect?.kind).toBe('flash');
    endShot();
  });

  it('clears the effect after its animation window', () => {
    const end = beginAgentActivity('preview_navigate', { path: '/a' });
    vi.advanceTimersByTime(2000);
    expect(agentActivityStore.getState().effect).toBeNull();
    end();
  });

  it('stays busy while overlapping calls are in flight', () => {
    const endA = beginAgentActivity('preview_console', undefined);
    const endB = beginAgentActivity('preview_dom', undefined);
    endA();
    expect(agentActivityStore.getState().busy).toBe(true);
    endB();
    expect(agentActivityStore.getState().busy).toBe(false);
  });

  it('a fresh call cancels the pending linger-out', () => {
    const endA = beginAgentActivity('preview_console', undefined);
    endA();
    vi.advanceTimersByTime(1000);
    const endB = beginAgentActivity('preview_dom', undefined);
    vi.advanceTimersByTime(2500); // past the first call's linger deadline
    expect(agentActivityStore.getState().visible).toBe(true);
    endB();
  });

  it('double-ending a call does not corrupt the count', () => {
    const endA = beginAgentActivity('preview_console', undefined);
    const endB = beginAgentActivity('preview_dom', undefined);
    endA();
    endA();
    expect(agentActivityStore.getState().busy).toBe(true);
    endB();
    expect(agentActivityStore.getState().busy).toBe(false);
  });

  it('notifies subscribers on changes', () => {
    const listener = vi.fn();
    const unsubscribe = agentActivityStore.subscribe(listener);
    const end = beginAgentActivity('preview_console', undefined);
    expect(listener).toHaveBeenCalled();
    end();
    unsubscribe();
  });
});
