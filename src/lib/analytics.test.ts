import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  trackEvent,
  trackPageview,
  setActiveScreen,
  setActiveProject,
  trackError,
  trackSearch,
  cancelTrackedSearch,
} from './analytics';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

describe('analytics', () => {
  const invokeMock = vi.mocked(invoke);

  beforeEach(() => {
    invokeMock.mockClear();
    setActiveScreen(null);
    setActiveProject(null);
  });

  afterEach(() => {
    setActiveScreen(null);
    setActiveProject(null);
  });

  /** Pull the props bag the most recent track_event invocation shipped. */
  function lastEventProps(): Record<string, unknown> {
    const calls = invokeMock.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[0]).toBe('track_event');
    const args = lastCall?.[1] as { properties: Record<string, unknown> };
    return args.properties;
  }

  describe('enrichProperties (via trackEvent)', () => {
    it('attaches $session_id to every event', async () => {
      await trackEvent('test_event');
      const props = lastEventProps();
      expect(typeof props.$session_id).toBe('string');
      expect((props.$session_id as string).length).toBeGreaterThan(0);
    });

    it('attaches the active screen when one is set', async () => {
      setActiveScreen('Dashboard');
      await trackEvent('test_event');
      expect(lastEventProps().$screen_name).toBe('Dashboard');
    });

    it('does not overwrite an explicit $screen_name', async () => {
      setActiveScreen('Dashboard');
      await trackEvent('test_event', { $screen_name: 'Override' });
      expect(lastEventProps().$screen_name).toBe('Override');
    });

    it('omits $screen_name when no screen is active', async () => {
      await trackEvent('test_event');
      expect(lastEventProps().$screen_name).toBeUndefined();
    });

    it('attaches project context when set', async () => {
      setActiveProject({ id: 'abc12345', name: 'demo', type: 'next', ageDays: 7 });
      await trackEvent('test_event');
      const props = lastEventProps();
      expect(props.project_id).toBe('abc12345');
      expect(props.project_name).toBe('demo');
      expect(props.project_type).toBe('next');
      expect(props.project_age_days).toBe(7);
    });

    it('omits project fields after setActiveProject(null)', async () => {
      setActiveProject({ id: 'abc12345', name: 'demo' });
      setActiveProject(null);
      await trackEvent('test_event');
      const props = lastEventProps();
      expect(props.project_id).toBeUndefined();
      expect(props.project_name).toBeUndefined();
    });

    it('preserves caller properties verbatim', async () => {
      await trackEvent('test_event', { custom_prop: 'value', count: 42 });
      const props = lastEventProps();
      expect(props.custom_prop).toBe('value');
      expect(props.count).toBe(42);
    });
  });

  describe('trackPageview', () => {
    it('emits $pageview with synthetic URL and pathname', async () => {
      trackPageview('Workspace - Code');
      // trackPageview internally awaits invoke; small tick to settle.
      await Promise.resolve();
      const props = lastEventProps();
      expect(props.$current_url).toBe('app://ship-studio/workspace-code');
      expect(props.$pathname).toBe('/workspace-code');
      expect(props.$screen_name).toBe('Workspace - Code');
    });

    it('collapses runs of non-alphanumerics into a single hyphen', async () => {
      trackPageview('Onboarding - Package Manager & Node.js');
      await Promise.resolve();
      const props = lastEventProps();
      expect(props.$pathname).toBe('/onboarding-package-manager-node-js');
    });
  });

  describe('trackError', () => {
    it('caps error_message at 500 chars', () => {
      const huge = 'x'.repeat(2000);
      trackError('cmd', new Error(huge));
      const props = lastEventProps();
      expect((props.error_message as string).length).toBe(500);
    });

    it('records error_type from the Error name', () => {
      trackError('cmd', new TypeError('bad'));
      expect(lastEventProps().error_type).toBe('TypeError');
    });
  });

  describe('trackSearch', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('debounces and fires the trimmed query after 1s', () => {
      trackSearch('palette', 'gi');
      trackSearch('palette', 'git');
      vi.advanceTimersByTime(1000);
      const props = lastEventProps();
      expect(props.search_type).toBe('palette');
      expect(props.query).toBe('git');
      expect(props.query_length).toBe(3);
    });

    it('caps the query at 100 chars', () => {
      const huge = 'a'.repeat(500);
      trackSearch('palette', huge);
      vi.advanceTimersByTime(1000);
      const props = lastEventProps();
      expect((props.query as string).length).toBe(100);
      expect(props.query_length).toBe(500);
    });

    it('cancelTrackedSearch drops a pending fire', () => {
      trackSearch('palette', 'foo');
      cancelTrackedSearch('palette');
      vi.advanceTimersByTime(2000);
      // No track_event call should have happened.
      expect(invokeMock).not.toHaveBeenCalled();
    });

    it('skips empty queries', () => {
      trackSearch('palette', '   ');
      vi.advanceTimersByTime(2000);
      expect(invokeMock).not.toHaveBeenCalled();
    });
  });
});
