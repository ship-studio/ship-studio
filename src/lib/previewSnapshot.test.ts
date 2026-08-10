import { describe, it, expect, afterEach } from 'vitest';
import { previewSnapshotRect } from './previewSnapshot';

function mountPreviewIframe(rect: Partial<DOMRect>): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.className = 'preview-iframe';
  iframe.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      x: rect.left ?? 0,
      y: rect.top ?? 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
      ...rect,
    }) as DOMRect;
  document.body.appendChild(iframe);
  return iframe;
}

afterEach(() => {
  document.body.innerHTML = '';
  // jsdom lacks elementFromPoint by default; individual tests stub it.
  // @ts-expect-error test cleanup of an optional stub
  delete document.elementFromPoint;
});

describe('previewSnapshotRect', () => {
  it('returns null when no preview iframe is mounted', () => {
    expect(previewSnapshotRect(document)).toBeNull();
  });

  it('returns null for a collapsed preview pane', () => {
    mountPreviewIframe({ left: 100, top: 50, width: 120, height: 80 });
    expect(previewSnapshotRect(document)).toBeNull();
  });

  it('returns the on-screen rect for a visible, unobstructed preview', () => {
    const iframe = mountPreviewIframe({ left: 320, top: 48, width: 400, height: 300 });
    document.elementFromPoint = () => iframe;
    expect(previewSnapshotRect(document)).toEqual({
      x: 320,
      y: 48,
      width: 400,
      height: 300,
    });
  });

  it('returns null when an overlay covers the preview center', () => {
    mountPreviewIframe({ left: 320, top: 48, width: 400, height: 300 });
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    document.elementFromPoint = () => overlay;
    expect(previewSnapshotRect(document)).toBeNull();
  });

  it('treats a null elementFromPoint probe as unobstructed', () => {
    mountPreviewIframe({ left: 320, top: 48, width: 400, height: 300 });
    document.elementFromPoint = () => null;
    expect(previewSnapshotRect(document)).not.toBeNull();
  });

  it('returns null when the preview center is scrolled off-screen', () => {
    const iframe = mountPreviewIframe({
      left: window.innerWidth + 10,
      top: 48,
      width: 400,
      height: 300,
    });
    document.elementFromPoint = () => iframe;
    expect(previewSnapshotRect(document)).toBeNull();
  });
});
