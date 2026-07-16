/**
 * Tests for useDismissOnOutsidePointer — the rAF-deferred capture-phase
 * outside-pointer dismissal used by the visual editor's popovers (issue #172).
 *
 * requestAnimationFrame is stubbed with a manually-flushed queue so the tests
 * can observe the window BETWEEN the effect running and the listener attaching
 * — exactly where the WKWebView instant-close bug lived.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { RefObject } from 'react';
import { useDismissOnOutsidePointer } from './useDismissOnOutsidePointer';

let rafCallbacks: Map<number, FrameRequestCallback>;
let nextRafId: number;

/** Run every queued animation-frame callback (one "frame"). */
function flushAnimationFrame() {
  const pending = Array.from(rafCallbacks.values());
  rafCallbacks.clear();
  pending.forEach((cb) => cb(0));
}

function dispatch(el: Element, type: string) {
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

describe('useDismissOnOutsidePointer', () => {
  let container: HTMLDivElement;
  let inside: HTMLButtonElement;
  let outside: HTMLDivElement;
  let containerRef: RefObject<HTMLElement | null>;

  beforeEach(() => {
    rafCallbacks = new Map();
    nextRafId = 1;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafCallbacks.delete(id);
    });

    container = document.createElement('div');
    inside = document.createElement('button');
    container.appendChild(inside);
    outside = document.createElement('div');
    document.body.append(container, outside);
    containerRef = { current: container };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('ignores a pointerdown dispatched in the same frame the popover opened (the opening gesture)', () => {
    const onDismiss = vi.fn();
    renderHook(() => useDismissOnOutsidePointer(true, containerRef, onDismiss));

    // The opening gesture's pointerdown arrives after the effect ran but
    // before the next frame — it must never reach the listener.
    dispatch(outside, 'pointerdown');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('dismisses on an outside pointerdown after a frame has passed', () => {
    const onDismiss = vi.fn();
    renderHook(() => useDismissOnOutsidePointer(true, containerRef, onDismiss));

    flushAnimationFrame();
    dispatch(outside, 'pointerdown');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not dismiss on a pointerdown inside the container', () => {
    const onDismiss = vi.fn();
    renderHook(() => useDismissOnOutsidePointer(true, containerRef, onDismiss));

    flushAnimationFrame();
    dispatch(inside, 'pointerdown');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('does nothing while closed', () => {
    const onDismiss = vi.fn();
    renderHook(() => useDismissOnOutsidePointer(false, containerRef, onDismiss));

    expect(rafCallbacks.size).toBe(0);
    flushAnimationFrame();
    dispatch(outside, 'pointerdown');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('removes the listener when open flips back to false', () => {
    const onDismiss = vi.fn();
    const { rerender } = renderHook(
      ({ open }) => useDismissOnOutsidePointer(open, containerRef, onDismiss),
      { initialProps: { open: true } }
    );

    flushAnimationFrame();
    rerender({ open: false });
    dispatch(outside, 'pointerdown');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('cancels the pending frame if closed before the listener attached', () => {
    const onDismiss = vi.fn();
    const { rerender } = renderHook(
      ({ open }) => useDismissOnOutsidePointer(open, containerRef, onDismiss),
      { initialProps: { open: true } }
    );

    rerender({ open: false });
    expect(rafCallbacks.size).toBe(0); // rAF was cancelled, not just orphaned
    flushAnimationFrame();
    dispatch(outside, 'pointerdown');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('removes the listener on unmount', () => {
    const onDismiss = vi.fn();
    const { unmount } = renderHook(() => useDismissOnOutsidePointer(true, containerRef, onDismiss));

    flushAnimationFrame();
    unmount();
    dispatch(outside, 'pointerdown');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('listens for mousedown instead when configured', () => {
    const onDismiss = vi.fn();
    renderHook(() =>
      useDismissOnOutsidePointer(true, containerRef, onDismiss, { event: 'mousedown' })
    );

    flushAnimationFrame();
    dispatch(outside, 'pointerdown');
    expect(onDismiss).not.toHaveBeenCalled();
    dispatch(outside, 'mousedown');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('respects an isOutside override (e.g. a separate trigger counts as inside)', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    const onDismiss = vi.fn();
    renderHook(() =>
      useDismissOnOutsidePointer(true, containerRef, onDismiss, {
        isOutside: (t) => !container.contains(t) && !trigger.contains(t),
      })
    );

    flushAnimationFrame();
    dispatch(trigger, 'pointerdown');
    dispatch(inside, 'pointerdown');
    expect(onDismiss).not.toHaveBeenCalled();
    dispatch(outside, 'pointerdown');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('uses the latest onDismiss without re-deferring the listener', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ cb }) => useDismissOnOutsidePointer(true, containerRef, cb),
      { initialProps: { cb: first } }
    );

    flushAnimationFrame();
    rerender({ cb: second });
    // No new rAF was scheduled — the listener stayed attached.
    expect(rafCallbacks.size).toBe(0);
    dispatch(outside, 'pointerdown');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
