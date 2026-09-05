import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PreviewCanvas, type CanvasZoom } from './PreviewCanvas';
import {
  CANVAS_LABEL_PX,
  CANVAS_PADDING_PX,
  MAX_ZOOM,
  PAN_SLACK_RATIO,
  anchorScroll,
  stepZoom,
  wheelZoom,
  type CanvasFrame,
} from '../../lib/previewCanvas';

const FRAMES: CanvasFrame[] = [
  { id: 'desktop', label: 'Desktop', width: 1440, height: 900 },
  { id: 'laptop', label: 'Laptop', width: 1024, height: 700 },
  { id: 'tablet', label: 'Tablet', width: 768, height: 1024 },
  { id: 'mobile', label: 'Mobile', width: 375, height: 812 },
];

/** ResizeObserver callbacks registered by the component, so a test can play a
 *  pane resize. */
const resizeObserverCallbacks: (() => void)[] = [];

class TestResizeObserver {
  constructor(private readonly callback: () => void) {
    resizeObserverCallbacks.push(callback);
  }
  observe() {}
  disconnect() {
    const index = resizeObserverCallbacks.indexOf(this.callback);
    if (index >= 0) resizeObserverCallbacks.splice(index, 1);
  }
  unobserve() {}
}

/** jsdom reports 0 for every layout box; give the scroll container a size so the
 *  canvas computes a real fit scale instead of the unmeasured fallback. */
function stubCanvasSize(width: number, height: number) {
  const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('preview-canvas') ? width : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('preview-canvas') ? height : 0;
    },
  });
  return () => {
    if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
    if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight);
  };
}

function renderCanvas(overrides: Partial<Parameters<typeof PreviewCanvas>[0]> = {}) {
  const props = {
    frames: FRAMES,
    url: 'http://localhost:3000/',
    navSignal: '/',
    activeFrameId: 'desktop',
    reloadToken: 0,
    zoom: 'fit' as const,
    onZoomChange: vi.fn(),
    onActivateFrame: vi.fn(),
    onActiveFrameElement: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<PreviewCanvas {...props} />) };
}

let restoreSize: (() => void) | null = null;

beforeEach(() => {
  restoreSize = stubCanvasSize(1200, 800);
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
});

afterEach(() => {
  restoreSize?.();
  restoreSize = null;
  resizeObserverCallbacks.length = 0;
  vi.unstubAllGlobals();
});

describe('PreviewCanvas', () => {
  it('renders one live frame per breakpoint, all pointed at the same page', () => {
    const { container } = renderCanvas();
    const iframes = container.querySelectorAll('iframe');
    expect(iframes).toHaveLength(FRAMES.length);
    for (const iframe of iframes) {
      expect(iframe.getAttribute('src')).toBe('http://localhost:3000/');
    }
    expect(Array.from(iframes).map((frame) => frame.getAttribute('data-frame-id'))).toEqual([
      'desktop',
      'laptop',
      'tablet',
      'mobile',
    ]);
  });

  it('lays each frame out at its true CSS width so media queries fire there', () => {
    const { container } = renderCanvas();
    const stages = container.querySelectorAll<HTMLElement>('.preview-canvas-stage');
    expect(stages[0].style.width).toBe('1440px');
    expect(stages[3].style.width).toBe('375px');
    expect(stages[0].style.left).toBe('0px');
  });

  it("gives each frame its own device height, never the pane's", () => {
    // The frame IS the viewport the page reports: a 100vh hero is exactly this
    // tall. Deriving it from the pane or the zoom would make every vh unit lie.
    const { container } = renderCanvas();
    const stages = container.querySelectorAll<HTMLElement>('.preview-canvas-stage');
    expect(stages[0].style.height).toBe('900px');
    expect(stages[2].style.height).toBe('1024px');
    expect(stages[3].style.height).toBe('812px');
  });

  it('reports the ACTIVE frame height for host chrome to clamp to', () => {
    const onStageHeightChange = vi.fn();
    renderCanvas({ activeFrameId: 'mobile', onStageHeightChange });
    expect(onStageHeightChange).toHaveBeenLastCalledWith(812);
  });

  it('scales the surface down to fit rather than reflowing the pages', () => {
    const { container } = renderCanvas();
    const scaled = container.querySelector<HTMLElement>('.preview-canvas-scaled');
    // 1440+1024+768+375 + 3 gaps = 3751 canvas px into 1200 - 2×32 screen px.
    const expected = (1200 - CANVAS_PADDING_PX * 2) / 3751;
    expect(scaled?.style.transform).toBe(`scale(${expected})`);
  });

  it('opens with room to pan on every side, and the frames centred in the pane', () => {
    const { container } = renderCanvas();
    const scaled = container.querySelector<HTMLElement>('.preview-canvas-scaled')!;
    const scroller = container.querySelector<HTMLElement>('.preview-canvas')!;
    // Half a screen of slack either side (PAN_SLACK_RATIO)...
    expect(scaled.style.left).toBe('600px');
    // ...and the canvas resting on the frames with the leftover pane split
    // evenly around them, rather than jammed against the top-left corner.
    // Fit puts 1136px of content in a 1200px pane, so 32px each side.
    expect(scroller.scrollLeft).toBe(600 - 32);
  });

  it('keeps the view put when the pane resizes under it', () => {
    const { container } = renderCanvas();
    const scroller = container.querySelector<HTMLElement>('.preview-canvas')!;
    scroller.scrollLeft = 900;

    // The pane narrows: the slack shrinks with it, moving the frames within the
    // surface. The scroll position has to follow, or the canvas drifts.
    act(() => {
      restoreSize?.();
      restoreSize = stubCanvasSize(800, 800);
      resizeObserverCallbacks.forEach((run) => run());
    });
    expect(scroller.scrollLeft).toBe(900 + (400 - 600));
  });

  it('labels every frame with its device name and size', () => {
    renderCanvas();
    expect(screen.getByText('Desktop')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zoom to Desktop' })).toHaveAttribute(
      'title',
      'Desktop — 1440 × 900. Click to work at this size.'
    );
    expect(screen.getByRole('button', { name: 'Zoom to Mobile' })).toHaveAttribute(
      'title',
      'Mobile — 375 × 812. Click to work at this size.'
    );
  });

  it('brings a frame up to a workable size when its label is clicked', async () => {
    const onZoomChange = vi.fn();
    const onActivateFrame = vi.fn();
    renderCanvas({ onZoomChange, onActivateFrame });
    await userEvent.click(screen.getByRole('button', { name: 'Zoom to Mobile' }));
    expect(onActivateFrame).toHaveBeenCalledWith('mobile');
    // 375px fits a 1200px pane easily, so it goes to true size.
    expect(onZoomChange).toHaveBeenCalledWith(1);
  });

  it('fits a frame too wide for the pane instead of overflowing it', async () => {
    const onZoomChange = vi.fn();
    renderCanvas({ onZoomChange });
    await userEvent.click(screen.getByRole('button', { name: 'Zoom to Desktop' }));
    expect(onZoomChange).toHaveBeenCalledWith((1200 - CANVAS_PADDING_PX * 2) / 1440);
  });

  it('outlines the active frame and puts an activation target on the others', () => {
    const { container } = renderCanvas({ activeFrameId: 'tablet' });
    expect(container.querySelectorAll('.preview-canvas-outline')).toHaveLength(1);
    const buttons = screen.getAllByRole('button', { name: /^Work at/ });
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Work at Desktop, 1440 pixels',
      'Work at Laptop, 1024 pixels',
      'Work at Mobile, 375 pixels',
    ]);
  });

  it('activates the clicked frame, and reports where the click landed in it', async () => {
    const onActivateFrame = vi.fn();
    renderCanvas({ onActivateFrame });
    await userEvent.click(screen.getByRole('button', { name: 'Work at Mobile, 375 pixels' }));
    const [frameId, point] = onActivateFrame.mock.calls[0] as [
      string,
      { x: number; y: number } | undefined,
    ];
    expect(frameId).toBe('mobile');
    expect(typeof point?.x).toBe('number');
    expect(typeof point?.y).toBe('number');
  });

  it('reports no point for a keyboard activation', async () => {
    const onActivateFrame = vi.fn();
    renderCanvas({ onActivateFrame });
    screen.getByRole('button', { name: 'Work at Mobile, 375 pixels' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(onActivateFrame).toHaveBeenCalledWith('mobile', undefined);
  });

  it('reports the active frame element so the editor can bind to it', () => {
    const onActiveFrameElement = vi.fn();
    const { container } = renderCanvas({ activeFrameId: 'laptop', onActiveFrameElement });
    const laptop = container.querySelector('iframe[data-frame-id="laptop"]');
    expect(onActiveFrameElement).toHaveBeenLastCalledWith(laptop);
  });

  it('rebinds to the newly activated frame', () => {
    const onActiveFrameElement = vi.fn();
    const { rerender, container, props } = renderCanvas({ onActiveFrameElement });
    rerender(<PreviewCanvas {...props} activeFrameId="mobile" />);
    expect(onActiveFrameElement).toHaveBeenLastCalledWith(
      container.querySelector('iframe[data-frame-id="mobile"]')
    );
  });

  it('drops the binding when the canvas unmounts', () => {
    const onActiveFrameElement = vi.fn();
    const { unmount } = renderCanvas({ onActiveFrameElement });
    unmount();
    expect(onActiveFrameElement).toHaveBeenLastCalledWith(null);
  });

  it('remounts every frame when the preview is refreshed', () => {
    const { container, rerender, props } = renderCanvas();
    const before = container.querySelector('iframe[data-frame-id="desktop"]');
    rerender(<PreviewCanvas {...props} reloadToken={1} />);
    const after = container.querySelector('iframe[data-frame-id="desktop"]');
    expect(after).not.toBe(before);
  });

  it('unmounts frames scrolled far out of view but never the active one', () => {
    // At 100% zoom on a 1200px pane only the leftmost frames are near the window.
    const { container } = renderCanvas({ zoom: 1, activeFrameId: 'mobile' });
    expect(container.querySelector('iframe[data-frame-id="desktop"]')).toBeTruthy();
    expect(container.querySelector('iframe[data-frame-id="tablet"]')).toBeNull();
    // Active frame stays mounted even though it is off screen.
    expect(container.querySelector('iframe[data-frame-id="mobile"]')).toBeTruthy();
    expect(container.querySelectorAll('.preview-canvas-placeholder').length).toBeGreaterThan(0);
  });

  it('follows an in-frame navigation in the passive frames but not the active one', () => {
    const { container, rerender, props } = renderCanvas({ activeFrameId: 'desktop' });
    // The active frame navigated itself: `url` moves on, `navSignal` does not.
    rerender(<PreviewCanvas {...props} url="http://localhost:3000/pricing" />);
    expect(container.querySelector('iframe[data-frame-id="desktop"]')?.getAttribute('src')).toBe(
      'http://localhost:3000/'
    );
    expect(container.querySelector('iframe[data-frame-id="mobile"]')?.getAttribute('src')).toBe(
      'http://localhost:3000/pricing'
    );
  });

  it('moves every frame on a deliberate navigation', () => {
    const { container, rerender, props } = renderCanvas({ activeFrameId: 'desktop' });
    act(() => {
      rerender(
        <PreviewCanvas {...props} url="http://localhost:3000/pricing" navSignal="/pricing" />
      );
    });
    for (const frame of container.querySelectorAll('iframe')) {
      expect(frame.getAttribute('src')).toBe('http://localhost:3000/pricing');
    }
  });

  it('walks every other frame to the same point in the page', () => {
    const { container } = renderCanvas();
    const frames = [...container.querySelectorAll<HTMLIFrameElement>('iframe')];
    const source = frames[0];
    const posts = frames.map((frame) => {
      const post = vi.fn();
      Object.defineProperty(frame, 'contentWindow', {
        configurable: true,
        value: frame === source ? source.contentWindow : { postMessage: post },
      });
      return post;
    });

    window.dispatchEvent(
      new MessageEvent('message', {
        source: source.contentWindow,
        data: { type: 'ss:scroll', top: 900, fraction: 0.42 },
      })
    );

    // Every frame but the one that moved — sending it back where it already is
    // would fight the user's own scrolling.
    expect(posts[0]).not.toHaveBeenCalled();
    for (const post of posts.slice(1)) {
      expect(post).toHaveBeenCalledWith({ type: 'ss:scrollTo', fraction: 0.42 }, '*');
    }
  });

  it('drops its own echo instead of looping frames back and forth', () => {
    const { container } = renderCanvas();
    const frames = [...container.querySelectorAll<HTMLIFrameElement>('iframe')];
    const posts = frames.map((frame) => {
      const post = vi.fn();
      Object.defineProperty(frame, 'contentWindow', {
        configurable: true,
        value: { postMessage: post },
      });
      return post;
    });

    const report = (source: unknown, fraction: number) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: source as MessageEventSource,
          data: { type: 'ss:scroll', fraction },
        })
      );

    report(frames[0].contentWindow, 0.42);
    expect(posts[1]).toHaveBeenCalledTimes(1);

    // The frames we just drove report back the position we sent them. That is
    // our own echo, not a new scroll.
    report(frames[1].contentWindow, 0.42);
    report(frames[2].contentWindow, 0.4200001);
    expect(posts[0]).not.toHaveBeenCalled();
    expect(posts[1]).toHaveBeenCalledTimes(1);

    // A real move still gets through.
    report(frames[1].contentWindow, 0.8);
    expect(posts[0]).toHaveBeenCalledWith({ type: 'ss:scrollTo', fraction: 0.8 }, '*');
  });

  it('ignores a scroll report without a position', () => {
    const { container } = renderCanvas();
    const frame = container.querySelector<HTMLIFrameElement>('iframe')!;
    const post = vi.fn();
    Object.defineProperty(container.querySelectorAll('iframe')[1], 'contentWindow', {
      configurable: true,
      value: { postMessage: post },
    });
    window.dispatchEvent(
      new MessageEvent('message', { source: frame.contentWindow, data: { type: 'ss:scroll' } })
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('reads out the current zoom, and returns to true size when it is clicked', async () => {
    const onZoomChange = vi.fn();
    renderCanvas({ zoom: 0.5, onZoomChange });
    await userEvent.click(screen.getByRole('button', { name: '50%' }));
    expect(onZoomChange).toHaveBeenCalledWith(1);
  });

  it('re-centres on Fit even when it is already fitting', async () => {
    const { container } = renderCanvas({ zoom: 'fit' });
    const scroller = container.querySelector<HTMLElement>('.preview-canvas')!;
    const rested = { left: scroller.scrollLeft, top: scroller.scrollTop };

    // Drift the canvas away, as a stray pan or a resize could.
    scroller.scrollLeft = 2000;
    scroller.scrollTop = 2000;

    await userEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expect(scroller.scrollLeft).toBe(rested.left);
    expect(scroller.scrollTop).toBe(rested.top);
  });

  it('steps the zoom in and out', async () => {
    const onZoomChange = vi.fn();
    renderCanvas({ zoom: 0.5, onZoomChange });
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(onZoomChange).toHaveBeenLastCalledWith(0.625);
    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(onZoomChange).toHaveBeenLastCalledWith(0.4);
  });

  it('stops stepping at the ends of the zoom range', () => {
    renderCanvas({ zoom: MAX_ZOOM });
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeEnabled();
  });

  it('marks Fit as pressed only while fitting', () => {
    const { unmount } = renderCanvas({ zoom: 'fit' });
    expect(screen.getByRole('button', { name: 'Fit' })).toHaveAttribute('aria-pressed', 'true');
    unmount();
    renderCanvas({ zoom: 0.5 });
    expect(screen.getByRole('button', { name: 'Fit' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('zooms on ⌘+wheel, keeping the point under the pointer in place', () => {
    const onZoomChange = vi.fn();
    const { container } = renderCanvas({ zoom: 0.5, onZoomChange });
    const scroller = container.querySelector<HTMLElement>('.preview-canvas')!;
    const event = new WheelEvent('wheel', {
      deltaY: -120,
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    scroller.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onZoomChange).toHaveBeenCalledWith(0.625);
  });

  it('anchors the zoom past the label row, not at the top of the surface', () => {
    // The frames sit below an unscaled label row. Anchoring at the surface top
    // instead drifts vertically by labelHeight × (1 − newScale / oldScale) —
    // small, constant, and maddening. Needs a real zoom to land, so the zoom
    // state lives in a wrapper the way it does in the preview.
    function Stateful() {
      const [zoom, setZoom] = useState<CanvasZoom>(0.5);
      return (
        <PreviewCanvas
          frames={FRAMES}
          url="http://localhost:3000/"
          navSignal="/"
          activeFrameId="desktop"
          reloadToken={0}
          zoom={zoom}
          onZoomChange={setZoom}
          onActivateFrame={() => {}}
          onActiveFrameElement={() => {}}
        />
      );
    }
    const { container } = render(<Stateful />);
    const scroller = container.querySelector<HTMLElement>('.preview-canvas')!;
    scroller.scrollLeft = 700;
    scroller.scrollTop = 200;

    act(() => {
      scroller.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: -120,
          metaKey: true,
          bubbles: true,
          cancelable: true,
          clientX: 400,
          clientY: 300,
        })
      );
    });

    const expected = anchorScroll({
      scrollLeft: 700,
      scrollTop: 200,
      pointerX: 400,
      pointerY: 300,
      fromScale: 0.5,
      toScale: stepZoom(0.5, 'in'),
      originX: 1200 * PAN_SLACK_RATIO,
      originY: 800 * PAN_SLACK_RATIO + CANVAS_LABEL_PX,
    });
    expect(scroller.scrollLeft).toBe(expected.scrollLeft);
    expect(scroller.scrollTop).toBe(expected.scrollTop);
  });

  it('leaves a plain wheel alone so the canvas scrolls normally', () => {
    const onZoomChange = vi.fn();
    const { container } = renderCanvas({ zoom: 0.5, onZoomChange });
    const scroller = container.querySelector<HTMLElement>('.preview-canvas')!;
    const event = new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true });
    scroller.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(onZoomChange).not.toHaveBeenCalled();
  });

  it('zooms with ⌘+ / ⌘- and fits with ⌘0', () => {
    const onZoomChange = vi.fn();
    renderCanvas({ zoom: 0.5, onZoomChange });
    fireEvent.keyDown(window, { key: '=', metaKey: true });
    expect(onZoomChange).toHaveBeenLastCalledWith(0.625);
    fireEvent.keyDown(window, { key: '-', metaKey: true });
    expect(onZoomChange).toHaveBeenLastCalledWith(0.4);
    fireEvent.keyDown(window, { key: '0', metaKey: true });
    expect(onZoomChange).toHaveBeenLastCalledWith('fit');
  });

  it('ignores zoom shortcuts while the user is typing', () => {
    const onZoomChange = vi.fn();
    renderCanvas({ zoom: 0.5, onZoomChange });
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: '=', metaKey: true });
    expect(onZoomChange).not.toHaveBeenCalled();
    input.remove();
  });

  it('arms panning while space is held, and drags the canvas', () => {
    const { container } = renderCanvas({ zoom: 1 });
    const root = container.querySelector<HTMLElement>('.preview-canvas-root')!;
    const scroller = container.querySelector<HTMLElement>('.preview-canvas')!;
    scroller.scrollLeft = 400;

    fireEvent.keyDown(window, { code: 'Space' });
    expect(root.className).toContain('is-pannable');

    fireEvent.mouseDown(scroller, { button: 0, clientX: 300, clientY: 100 });
    expect(root.className).toContain('is-panning');
    fireEvent.mouseMove(document, { clientX: 250, clientY: 100 });
    expect(scroller.scrollLeft).toBe(450);
    fireEvent.mouseUp(document);
    expect(root.className).not.toContain('is-panning');

    fireEvent.keyUp(window, { code: 'Space' });
    expect(root.className).not.toContain('is-pannable');
  });

  it('does not start a pan on a plain click', () => {
    const { container } = renderCanvas({ zoom: 1 });
    const root = container.querySelector<HTMLElement>('.preview-canvas-root')!;
    const scroller = container.querySelector<HTMLElement>('.preview-canvas')!;
    fireEvent.mouseDown(scroller, { button: 0, clientX: 300, clientY: 100 });
    expect(root.className).not.toContain('is-panning');
  });

  it('zooms at a gesture a frame forwards up, mapped back to where it happened', () => {
    const onZoomChange = vi.fn();
    const { container } = renderCanvas({ zoom: 0.5, onZoomChange });
    const frame = container.querySelector<HTMLIFrameElement>('iframe[data-frame-id="desktop"]')!;
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: { type: 'ss:wheelZoom', deltaY: -10, x: 100, y: 50 },
      })
    );
    expect(onZoomChange).toHaveBeenCalledWith(wheelZoom(0.5, -10));
  });

  it('ignores a forwarded gesture from a window that is not one of its frames', () => {
    const onZoomChange = vi.fn();
    renderCanvas({ zoom: 0.5, onZoomChange });
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: { type: 'ss:wheelZoom', deltaY: -10, x: 0, y: 0 },
      })
    );
    expect(onZoomChange).not.toHaveBeenCalled();
  });

  it('renders host chrome over the active frame, with the canvas scale', () => {
    renderCanvas({
      zoom: 0.5,
      activeFrameOverlay: (scale: number) => <div data-testid="overlay">{scale}</div>,
    });
    expect(screen.getByTestId('overlay')).toHaveTextContent('0.5');
  });

  it('centres the active frame when the zoom level changes', () => {
    const { container, rerender, props } = renderCanvas({ activeFrameId: 'mobile' });
    const scroller = container.querySelector<HTMLElement>('.preview-canvas')!;
    const scrollTo = vi.spyOn(scroller, 'scrollLeft', 'set');
    act(() => {
      rerender(<PreviewCanvas {...props} activeFrameId="mobile" zoom={1} />);
    });
    expect(scrollTo).toHaveBeenCalled();
    expect(scrollTo.mock.calls[0][0]).toBeGreaterThan(0);
  });
});
