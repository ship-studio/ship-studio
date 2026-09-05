import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFrameRebind } from './useFrameRebind';

type FrameRef = { current: HTMLIFrameElement | null };

function setup(initialRef: FrameRef) {
  const onRebind = vi.fn();
  const view = renderHook(
    (props: { frameRef: FrameRef }) => useFrameRebind(props.frameRef, onRebind),
    {
      initialProps: { frameRef: initialRef },
    }
  );
  return { ...view, onRebind };
}

describe('useFrameRebind', () => {
  it('does not fire on the first bind', () => {
    const { onRebind } = setup({ current: null });
    expect(onRebind).not.toHaveBeenCalled();
  });

  it('fires when the ref object identity changes', () => {
    const { rerender, onRebind } = setup({ current: null });
    rerender({ frameRef: { current: null } });
    expect(onRebind).toHaveBeenCalledTimes(1);
  });

  it('does not fire on a re-render with the same ref', () => {
    const frameRef: FrameRef = { current: null };
    const { rerender, onRebind } = setup(frameRef);
    rerender({ frameRef });
    rerender({ frameRef });
    expect(onRebind).not.toHaveBeenCalled();
  });

  it('does not fire when only the ref CONTENTS change', () => {
    const frameRef: FrameRef = { current: null };
    const { rerender, onRebind } = setup(frameRef);
    frameRef.current = {} as HTMLIFrameElement;
    rerender({ frameRef });
    expect(onRebind).not.toHaveBeenCalled();
  });

  it('fires once per move', () => {
    const { rerender, onRebind } = setup({ current: null });
    rerender({ frameRef: { current: null } });
    rerender({ frameRef: { current: null } });
    expect(onRebind).toHaveBeenCalledTimes(2);
  });

  it('uses the latest callback', () => {
    const first = vi.fn();
    const second = vi.fn();
    const frameRef: FrameRef = { current: null };
    const { rerender } = renderHook(
      (props: { frameRef: FrameRef; cb: () => void }) => useFrameRebind(props.frameRef, props.cb),
      { initialProps: { frameRef, cb: first } }
    );
    rerender({ frameRef: { current: null }, cb: second });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
