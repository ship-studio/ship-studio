/**
 * Auto-save behavior for the visual editor hook.
 *
 * Focus: a burst of rapid edits (like a drag) debounces into a SINGLE source
 * write, and only when auto-save is on. The grammar is exercised for real; only
 * the two Tauri-backed calls (resolve + write-back) are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../lib/edit', async (importActual) => {
  const actual = await importActual<typeof import('../lib/edit')>();
  return { ...actual, resolveClassnameSource: vi.fn(), applyClassnameEdit: vi.fn() };
});

import { useVisualEditor } from './useVisualEditor';
import {
  resolveClassnameSource,
  applyClassnameEdit,
  BASE_BREAKPOINT,
  DEFAULT_BREAKPOINTS,
} from '../lib/edit';

const BREAKPOINTS = [BASE_BREAKPOINT, ...DEFAULT_BREAKPOINTS];

/** A minimal iframe ref: swallows postMessage and the `load` listener the hook
 *  attaches to re-activate across HMR reloads. */
function fakeIframeRef() {
  return {
    current: {
      contentWindow: { postMessage: vi.fn() },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  } as unknown as React.RefObject<HTMLIFrameElement | null>;
}

function setup() {
  const iframeRef = fakeIframeRef();
  const hook = renderHook(() =>
    useVisualEditor({
      iframeRef,
      projectPath: '/proj',
      enabled: true,
      activeBreakpoint: BASE_BREAKPOINT,
      breakpoints: BREAKPOINTS,
    })
  );
  return { ...hook, iframeRef };
}

/** Flush pending microtasks (e.g. the async resolve) under act. */
const flush = () => act(async () => void (await Promise.resolve()));
/** Advance fake timers and flush the work they trigger. */
const advance = (ms: number) =>
  act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });

/** Drive a selection through the in-window message bridge and resolve it.
 *  `source` mirrors the real preview iframe's contentWindow — the hook now
 *  rejects messages from any other source as a security measure. */
async function select(className: string, source: MessageEventSource) {
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source,
        data: {
          type: 'ss:select',
          signature: { className, tagName: 'div', ancestorClasses: [] },
          count: 1,
        },
      })
    );
    await Promise.resolve();
  });
  await flush(); // resolveClassnameSource → setSelection
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  (resolveClassnameSource as ReturnType<typeof vi.fn>).mockImplementation(
    (_p: string, sig: { className: string }) =>
      Promise.resolve({
        status: 'resolved',
        file: 'app/page.tsx',
        line: 1,
        column: 1,
        class_name: sig.className, // a fresh selection is clean (live == source)
        confidence: 'unique',
      })
  );
  (applyClassnameEdit as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('useVisualEditor auto-save', () => {
  it('does NOT save automatically when auto-save is off', async () => {
    const { result, iframeRef } = setup();
    act(() => result.current.toggleEditMode());
    await select('p-3', iframeRef.current!.contentWindow!);

    act(() => result.current.applyEnum('p-8', { padding: '2rem' }));
    await advance(2000);
    expect(applyClassnameEdit).not.toHaveBeenCalled();
  });

  it('debounces a burst of edits into ONE save when auto-save is on', async () => {
    const { result, iframeRef } = setup();
    act(() => result.current.toggleAutoSave()); // turn on
    act(() => result.current.toggleEditMode());
    await select('p-3', iframeRef.current!.contentWindow!);

    // Simulate a drag: many rapid mutations, each well within the debounce window.
    act(() => {
      result.current.setBoxSide('padding', 'top', { kind: 'scale', n: 4 });
      result.current.setBoxSide('padding', 'top', { kind: 'scale', n: 5 });
      result.current.setBoxSide('padding', 'top', { kind: 'scale', n: 6 });
      result.current.setBoxSide('padding', 'top', { kind: 'scale', n: 7 });
    });

    // Before the debounce elapses: nothing saved yet.
    await advance(400);
    expect(applyClassnameEdit).not.toHaveBeenCalled();

    // After it settles: exactly one write, carrying the final value.
    await advance(700);
    expect(applyClassnameEdit).toHaveBeenCalledTimes(1);
    const call = (applyClassnameEdit as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
      number,
      string,
      string,
    ];
    expect(call[3]).toBe('p-3'); // oldClass (drift baseline)
    expect(call[4]).toContain('pt-7'); // newClass carries the final drag value
  });

  it('persists the toggle choice to localStorage', () => {
    const { result } = setup();
    act(() => result.current.toggleAutoSave());
    expect(localStorage.getItem('ss:visualEditor:autoSave')).toBe('1');
    act(() => result.current.toggleAutoSave());
    expect(localStorage.getItem('ss:visualEditor:autoSave')).toBe('0');
  });
});
