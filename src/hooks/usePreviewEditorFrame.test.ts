import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePreviewEditorFrame } from './usePreviewEditorFrame';
import { inspectStore, setInspectSource } from '../lib/inspectStore';

/** A stand-in for a preview iframe: only `contentWindow.postMessage` matters. */
function fakeFrame(): { el: HTMLIFrameElement; post: ReturnType<typeof vi.fn> } {
  const post = vi.fn();
  const el = {
    contentWindow: { postMessage: post } as unknown as Window,
  } as HTMLIFrameElement;
  return { el, post };
}

function setup(canvasFrameEl: HTMLIFrameElement | null, canvasMode = true) {
  const focusFrameRef = { current: null as HTMLIFrameElement | null };
  const captureTargetRef = { current: null as HTMLElement | null };
  const view = renderHook(
    (props: { canvasMode: boolean; canvasFrameEl: HTMLIFrameElement | null }) =>
      usePreviewEditorFrame({ ...props, focusFrameRef, captureTargetRef }),
    { initialProps: { canvasMode, canvasFrameEl } }
  );
  return { ...view, focusFrameRef, captureTargetRef };
}

beforeEach(() => {
  setInspectSource(null);
});

afterEach(() => {
  setInspectSource(null);
});

describe('usePreviewEditorFrame', () => {
  it('hands focus mode the single preview iframe ref, unchanged', () => {
    const focusFrameRef = { current: null as HTMLIFrameElement | null };
    const captureTargetRef = { current: null as HTMLElement | null };
    const { result, rerender } = renderHook(
      (props: { canvasFrameEl: HTMLIFrameElement | null }) =>
        usePreviewEditorFrame({
          canvasMode: false,
          focusFrameRef,
          captureTargetRef,
          ...props,
        }),
      { initialProps: { canvasFrameEl: null as HTMLIFrameElement | null } }
    );
    expect(result.current).toBe(focusFrameRef);
    // A canvas frame appearing must not disturb focus mode's binding.
    rerender({ canvasFrameEl: fakeFrame().el });
    expect(result.current).toBe(focusFrameRef);
  });

  it('points at the active canvas frame', () => {
    const { el } = fakeFrame();
    const { result } = setup(el);
    expect(result.current.current).toBe(el);
  });

  it('changes ref identity when the active frame changes, so hooks re-bind', () => {
    const first = fakeFrame();
    const second = fakeFrame();
    const { result, rerender } = setup(first.el);
    const before = result.current;
    rerender({ canvasMode: true, canvasFrameEl: second.el });
    expect(result.current).not.toBe(before);
    expect(result.current.current).toBe(second.el);
  });

  it('deactivates the frame it leaves behind', () => {
    const first = fakeFrame();
    const second = fakeFrame();
    const { rerender } = setup(first.el);
    expect(first.post).not.toHaveBeenCalled();

    rerender({ canvasMode: true, canvasFrameEl: second.el });
    expect(first.post).toHaveBeenCalledWith({ type: 'ss:deactivate' }, '*');
    expect(second.post).not.toHaveBeenCalled();
  });

  it('deactivates the canvas frame when the canvas is turned off', () => {
    const { el, post } = fakeFrame();
    const { rerender } = setup(el);
    rerender({ canvasMode: false, canvasFrameEl: el });
    expect(post).toHaveBeenCalledWith({ type: 'ss:deactivate' }, '*');
  });

  it('survives a frame whose window has already gone away', () => {
    const first = { el: {} as HTMLIFrameElement };
    const second = fakeFrame();
    const { rerender } = setup(first.el);
    expect(() => rerender({ canvasMode: true, canvasFrameEl: second.el })).not.toThrow();
  });

  it('points screenshot cropping at the active canvas frame', () => {
    const { el } = fakeFrame();
    const { captureTargetRef } = setup(el);
    expect(captureTargetRef.current).toBe(el);
  });

  it('leaves the capture target alone in focus mode', () => {
    const { el } = fakeFrame();
    const { captureTargetRef } = setup(el, false);
    expect(captureTargetRef.current).toBeNull();
  });

  it('pins the inspector to the active frame and releases it on unmount', () => {
    const { el } = fakeFrame();
    const { unmount } = setup(el);

    // Telemetry from a DIFFERENT preview frame is now ignored.
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'http://localhost:3000',
        source: window,
        data: { source: 'shipstudio-inspect', type: 'console', level: 'log', args: ['other'] },
      })
    );
    expect(inspectStore.getConsoleEntries()).toHaveLength(0);

    unmount();
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'http://localhost:3000',
        source: window,
        data: { source: 'shipstudio-inspect', type: 'console', level: 'log', args: ['after'] },
      })
    );
    expect(inspectStore.getConsoleEntries().map((entry) => entry.args[0])).toEqual(['after']);
  });
});
