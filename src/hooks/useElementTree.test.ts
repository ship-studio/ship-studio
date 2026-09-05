import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useElementTree } from './useElementTree';

describe('useElementTree', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('retries the initial request with backoff until the preview returns a tree', async () => {
    vi.useFakeTimers();
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const previewWindow = iframe.contentWindow;
    expect(previewWindow).not.toBeNull();
    const postMessage = vi.spyOn(previewWindow!, 'postMessage').mockImplementation(() => {});
    const iframeRef = { current: iframe };

    const { result } = renderHook(() => useElementTree({ iframeRef, enabled: true }));

    expect(postMessage).toHaveBeenCalledWith({ type: 'ss:requestTree' }, '*');
    expect(postMessage).toHaveBeenCalledTimes(1);
    // Unanswered requests back off (retries at ~1s, ~3s, ~7s) rather than repeating
    // on a fixed 500ms interval for as long as the panel stays open.
    const tick = async (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 500) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(500);
        });
      }
    };
    await tick(1_000);
    expect(postMessage).toHaveBeenCalledTimes(2);
    await tick(1_000);
    expect(postMessage).toHaveBeenCalledTimes(2); // still backing off
    await tick(1_000);
    expect(postMessage).toHaveBeenCalledTimes(3);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: previewWindow,
          data: {
            type: 'ss:tree',
            tree: { i: 1, t: 'body', c: '', x: '', k: [] },
            truncated: false,
          },
        })
      );
    });

    expect(result.current.tree).toEqual({
      id: 1,
      tag: 'body',
      cls: '',
      text: '',
      children: [],
    });
    // The snapshot arrived — retrying stops entirely.
    const settled = postMessage.mock.calls.length;
    await tick(10_000);
    expect(postMessage).toHaveBeenCalledTimes(settled);
  });

  it('tracks same-source elements separately from the primary selection', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const previewWindow = iframe.contentWindow;
    expect(previewWindow).not.toBeNull();
    vi.spyOn(previewWindow!, 'postMessage').mockImplementation(() => {});
    const iframeRef = { current: iframe };

    const { result } = renderHook(() => useElementTree({ iframeRef, enabled: true }));

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: previewWindow,
          data: { type: 'ss:select', nodeId: 7, affectedNodeIds: [8, 9] },
        })
      );
    });

    expect(result.current.selectedId).toBe(7);
    expect(result.current.affectedIds).toEqual([8, 9]);
  });

  it('tracks hover messages from the preview separately from selection', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const previewWindow = iframe.contentWindow;
    expect(previewWindow).not.toBeNull();
    vi.spyOn(previewWindow!, 'postMessage').mockImplementation(() => {});
    const iframeRef = { current: iframe };

    const { result } = renderHook(() => useElementTree({ iframeRef, enabled: true }));

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: previewWindow,
          data: { type: 'ss:hover', nodeId: 12 },
        })
      );
    });
    expect(result.current.hoveredId).toBe(12);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: previewWindow,
          data: { type: 'ss:hover', nodeId: null },
        })
      );
    });
    expect(result.current.hoveredId).toBeNull();
  });
});
