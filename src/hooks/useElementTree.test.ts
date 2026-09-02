import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useElementTree } from './useElementTree';

describe('useElementTree', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('retries the initial request until the preview returns a tree', () => {
    vi.useFakeTimers();
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const previewWindow = iframe.contentWindow;
    expect(previewWindow).not.toBeNull();
    const postMessage = vi.spyOn(previewWindow!, 'postMessage').mockImplementation(() => {});
    const iframeRef = { current: iframe };

    const { result } = renderHook(() => useElementTree({ iframeRef, enabled: true }));

    expect(postMessage).toHaveBeenCalledWith({ type: 'ss:requestTree' }, '*');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(postMessage).toHaveBeenCalledTimes(2);

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
    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    expect(postMessage).toHaveBeenCalledTimes(2);
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
});
