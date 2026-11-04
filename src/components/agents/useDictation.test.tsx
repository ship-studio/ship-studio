import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DictationEvent, DictationStart } from '../../lib/dictation';

let emit: (event: DictationEvent) => void = () => {};
const start = vi.fn<(vocabulary: string[]) => Promise<DictationStart>>();
const stop = vi.fn((_session: number) => Promise.resolve());
const cancel = vi.fn((_session: number) => Promise.resolve());

vi.mock('../../lib/dictation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/dictation')>()),
  startDictation: (vocabulary: string[]) => start(vocabulary),
  stopDictation: (s: number) => stop(s),
  cancelDictation: (s: number) => cancel(s),
  onDictationEvent: (handler: (event: DictationEvent) => void) => {
    emit = handler;
    return Promise.resolve(() => {});
  },
}));

import { useDictation } from './useDictation';

function setup(initial = 'Hi') {
  let draft = initial;
  const setDraft = vi.fn((text: string) => {
    draft = text;
  });
  const hook = renderHook(() =>
    useDictation({
      getDraft: () => draft,
      setDraft,
      vocabulary: ['Finance'],
      meterRef: { current: null },
      enabled: true,
    })
  );
  return { hook, draft: () => draft };
}

describe('useDictation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    start.mockResolvedValue({ status: 'listening', session: 7 });
  });

  it('writes partials after the existing draft and keeps the final text on stop', async () => {
    const { hook, draft } = setup();
    await act(async () => {
      hook.result.current.toggle();
      await Promise.resolve();
    });
    expect(start).toHaveBeenCalledWith(['Finance']);
    expect(hook.result.current.phase).toBe('listening');

    act(() => emit({ kind: 'partial', session: 7, text: 'call' }));
    expect(draft()).toBe('Hi call');
    act(() => emit({ kind: 'partial', session: 99, text: 'stale' }));
    expect(draft()).toBe('Hi call');

    act(() => hook.result.current.toggle());
    expect(stop).toHaveBeenCalledWith(7);
    expect(hook.result.current.phase).toBe('finishing');
    act(() => emit({ kind: 'final', session: 7, text: 'call Finance' }));
    act(() => emit({ kind: 'ended', session: 7, cancelled: false }));
    expect(draft()).toBe('Hi call Finance');
    expect(hook.result.current.phase).toBe('idle');
  });

  it('cancel puts the typed draft back', async () => {
    const { hook, draft } = setup();
    await act(async () => {
      hook.result.current.toggle();
      await Promise.resolve();
    });
    act(() => emit({ kind: 'partial', session: 7, text: 'oops' }));
    act(() => hook.result.current.cancel());
    expect(cancel).toHaveBeenCalledWith(7);
    expect(draft()).toBe('Hi');
    expect(hook.result.current.phase).toBe('idle');
  });

  it('reports a denied permission instead of listening', async () => {
    start.mockResolvedValue({ status: 'blocked', reason: 'microphone' });
    const { hook } = setup();
    await act(async () => {
      hook.result.current.toggle();
      await Promise.resolve();
    });
    expect(hook.result.current.blocked).toBe('microphone');
    expect(hook.result.current.phase).toBe('idle');
  });
});
