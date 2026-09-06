import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
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
      return this.classList.contains('preview-canvas') ||
        this.classList.contains('preview-canvas-root')
        ? width
        : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('preview-canvas') ||
        this.classList.contains('preview-canvas-root')
        ? height
        : 0;
    },
  });
  return () => {
    if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
    if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight);
  };
}

/** The camera, read back out of the transform the canvas actually wrote.
 *  There is no scroll position to inspect any more: the canvas does not
 *  scroll, it moves one transformed layer, and `x`/`y` mean exactly what
 *  `scrollLeft`/`scrollTop` used to. */
function cameraOf(container: HTMLElement, pane = { width: 1200, height: 800 }) {
  const world = container.querySelector<HTMLElement>('.preview-canvas-world')!;
  const match = /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(world.style.transform);
  const tx = match ? Number(match[1]) : 0;
  const ty = match ? Number(match[2]) : 0;
  return {
    x: pane.width * PAN_SLACK_RATIO - tx,
    y: pane.height * PAN_SLACK_RATIO + CANVAS_LABEL_PX - ty,
  };
}

/** A gesture writes the transform on the next animation frame — that
 *  coalescing is the point of the camera, so a test that reads the DOM has to
 *  wait for it the same way the screen does. */
async function nextFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

/** Move the canvas the way a trackpad does. Nothing can be assigned any more:
 *  a position is either gestured or decided by the canvas itself. */
async function panCanvas(container: HTMLElement, dx: number, dy: number) {
  const viewport = container.querySelector<HTMLElement>('.preview-canvas')!;
  act(() => {
    viewport.dispatchEvent(
      new WheelEvent('wheel', { deltaX: dx, deltaY: dy, bubbles: true, cancelable: true })
    );
  });
  await nextFrame();
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
  // The canvas clamps its measurement to the window, so the stubbed pane has to
  // fit inside one — jsdom's default is 1024x768.
  window.innerWidth = 2400;
  window.innerHeight = 1600;
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
    // Half a screen of slack either side (PAN_SLACK_RATIO) is 600px, and the
    // canvas rests 32px short of it: Fit puts 1136px of content in a 1200px
    // pane, so the leftover is split evenly around the frames rather than the
    // canvas being jammed against the top-left corner.
    expect(cameraOf(container).x).toBe(600 - 32);
  });

  it('re-centres on every measurement until the user moves it', () => {
    // The pane's FIRST measured size cannot be trusted — a webview commits the
    // mount before the pane has settled — so a canvas nobody has touched is
    // centred again every time it is told a size, not once at the beginning.
    const { container } = renderCanvas();
    expect(cameraOf(container).x).toBe(600 - 32);

    act(() => {
      restoreSize?.();
      restoreSize = stubCanvasSize(800, 800);
      resizeObserverCallbacks.forEach((run) => run());
    });
    // Centred again for the new pane: 400px of slack, 800px of pane, and Fit
    // puts 736px of content in it.
    expect(cameraOf(container, { width: 800, height: 800 }).x).toBe(400 - 32);
  });

  it('stays hidden until the frames know how tall they are', async () => {
    // A frame opens at its device height because nothing else is knowable yet,
    // so the first measurement moves all four from one screen to a whole page
    // at once. Showing that correction is what reads as a glitch on open.
    const { container } = renderCanvas();
    const surface = container.querySelector<HTMLElement>('.preview-canvas-root')!;
    expect(surface.className).toContain('is-measuring');

    const frames = container.querySelectorAll<HTMLIFrameElement>('.preview-canvas-iframe');
    act(() => {
      frames.forEach((frame, index) => {
        Object.defineProperty(frame, 'contentWindow', { value: {}, configurable: true });
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'ss:pageHeight', height: 4000 + index },
            source: frame.contentWindow,
          })
        );
      });
    });
    await waitFor(() => expect(surface.className).not.toContain('is-measuring'));
  });

  it('shows itself anyway if a frame never reports', async () => {
    // A page that fails to load must not be able to hold the whole canvas
    // blank. Visibly wrong beats empty.
    const { container } = renderCanvas();
    const surface = container.querySelector<HTMLElement>('.preview-canvas-root')!;
    expect(surface.className).toContain('is-measuring');
    await waitFor(() => expect(surface.className).not.toContain('is-measuring'), {
      timeout: 5000,
    });
  });

  const panALittle = async (container: HTMLElement) => {
    const viewport = container.querySelector<HTMLElement>('.preview-canvas')!;
    fireEvent.keyDown(window, { code: 'Space' });
    fireEvent.mouseDown(viewport, { button: 0, clientX: 350, clientY: 300 });
    fireEvent.mouseMove(document, { clientX: 340, clientY: 290 });
    fireEvent.mouseUp(document);
    fireEvent.keyUp(window, { code: 'Space' });
    await nextFrame();
  };

  it('gives an axis back when a zoom stops needing it', async () => {
    // Zoom is anchored to the pointer, which says where one point goes and
    // nothing about the axis the frames have stopped filling. Zoomed out far
    // enough they no longer need the pane's width, and without this they stay
    // where the arithmetic left them — against an edge, most of the canvas
    // empty beside them. Rule 3 stays quiet because nothing is LOST; the
    // canvas is merely useless, which it has no rule against.
    const { props, container, rerender } = renderCanvas({ zoom: 0.6 });
    await panALittle(container); // the position is now the user's, so rule 1 is off

    act(() => {
      rerender(<PreviewCanvas {...props} zoom={0.05} />);
    });

    // 3751 canvas px at 5% is 188px of content in a 1200px pane, so the frames
    // sit in the middle of it rather than jammed against the left edge.
    const contentWidth = 3751 * 0.05;
    const expected = 1200 * PAN_SLACK_RATIO - (1200 - contentWidth) / 2;
    await waitFor(() => expect(cameraOf(container).x).toBeCloseTo(expected, 1));
  });

  it('leaves an axis alone while the frames still fill it', async () => {
    // The pages stay far taller than the pane, so a zoom must not throw away
    // whatever part of them the user had come to look at.
    const { props, container, rerender } = renderCanvas({ zoom: 1 });
    await panALittle(container);
    const before = cameraOf(container);

    act(() => {
      rerender(<PreviewCanvas {...props} zoom={0.9} />);
    });

    // 1024px tall at 90% still overflows an 800px pane, so nothing moves.
    await nextFrame();
    expect(cameraOf(container).y).toBeCloseTo(before.y, 5);
  });

  it("keeps the view put once the position is the user's", async () => {
    // Not at Fit: Fit is a standing instruction to show everything, so it
    // re-fits through a resize no matter who moved the canvas last.
    const { container } = renderCanvas({ zoom: 0.2 });
    // A pan is the user taking the canvas position into their own hands.
    await panALittle(container);
    const before = cameraOf(container);

    // The pane narrows: the slack shrinks with it, moving the frames within the
    // surface. The camera follows, rather than being reset.
    act(() => {
      restoreSize?.();
      restoreSize = stubCanvasSize(800, 800);
      resizeObserverCallbacks.forEach((run) => run());
    });
    expect(cameraOf(container, { width: 800, height: 800 }).x).toBeCloseTo(
      before.x + (400 - 600),
      5
    );
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

  it('tells each frame it is part of a canvas, and again after it reloads', () => {
    const { container } = renderCanvas();
    const frame = container.querySelector<HTMLIFrameElement>('iframe[data-frame-id="desktop"]')!;
    const post = vi.fn();
    Object.defineProperty(frame, 'contentWindow', {
      configurable: true,
      value: { postMessage: post },
    });

    // A reloaded document starts from the script's defaults — gesture
    // forwarding and viewport-unit rewriting off — so the load handler says it
    // again, including the viewport height the frame stands in for.
    fireEvent.load(frame);
    expect(post).toHaveBeenCalledWith({ type: 'ss:canvas', on: true, vh: 900 }, '*');
  });

  it('takes it back when a frame goes away', () => {
    const { container, unmount } = renderCanvas();
    const posts = [...container.querySelectorAll<HTMLIFrameElement>('iframe')].map((frame) => {
      const post = vi.fn();
      Object.defineProperty(frame, 'contentWindow', {
        configurable: true,
        value: { postMessage: post },
      });
      return post;
    });
    unmount();
    for (const post of posts) {
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ss:canvas', on: false }),
        '*'
      );
    }
  });

  it('tells the frames nobody is working in to hold still', () => {
    const { container, rerender, props } = renderCanvas({ activeFrameId: 'desktop' });
    const posts = new Map<string, ReturnType<typeof vi.fn>>();
    for (const frame of container.querySelectorAll<HTMLIFrameElement>('iframe')) {
      const post = vi.fn();
      Object.defineProperty(frame, 'contentWindow', {
        configurable: true,
        value: { postMessage: post },
      });
      posts.set(frame.dataset.frameId!, post);
    }

    // Four whole pages animating at once is most of what a canvas costs; only
    // the frame being worked in stays live.
    rerender(<PreviewCanvas {...props} activeFrameId="mobile" />);
    expect(posts.get('mobile')).toHaveBeenCalledWith({ type: 'ss:passive', on: false }, '*');
    expect(posts.get('desktop')).toHaveBeenCalledWith({ type: 'ss:passive', on: true }, '*');
  });

  it('grows a frame to the whole page inside it', () => {
    const { container } = renderCanvas();
    const frame = container.querySelector<HTMLIFrameElement>('iframe[data-frame-id="desktop"]')!;
    const stage = frame.closest<HTMLElement>('.preview-canvas-stage')!;
    // The device height is the starting guess and the floor.
    expect(stage.style.height).toBe('900px');

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'ss:pageHeight', height: 5200 },
          source: frame.contentWindow,
        })
      );
    });
    expect(stage.style.height).toBe('5200px');
  });

  it('ignores a page height from a frame that is not on this canvas', () => {
    const { container } = renderCanvas();
    const stage = container.querySelector<HTMLElement>('.preview-canvas-stage')!;
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'ss:pageHeight', height: 5200 },
          source: window,
        })
      );
    });
    expect(stage.style.height).toBe('900px');
  });

  it('pans the canvas with a gesture a frame could not use', async () => {
    const { container } = renderCanvas();
    const frame = container.querySelector<HTMLIFrameElement>('iframe[data-frame-id="desktop"]')!;
    const before = cameraOf(container);

    // A frame showing its whole page has nothing left to scroll, so it hands
    // the wheel up and the canvas moves instead — coalesced into one transform
    // write per frame, so the assertion waits for that frame.
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'ss:panBy', dx: 40, dy: 120 },
          source: frame.contentWindow,
        })
      );
    });
    await nextFrame();
    expect(cameraOf(container).x).toBe(before.x + 40);
    expect(cameraOf(container).y).toBe(before.y + 120);
  });

  it('reads out the current zoom, and returns to true size when it is clicked', async () => {
    const onZoomChange = vi.fn();
    renderCanvas({ zoom: 0.5, onZoomChange });
    await userEvent.click(screen.getByRole('button', { name: '50%' }));
    expect(onZoomChange).toHaveBeenCalledWith(1);
  });

  it('re-centres on Fit even when it is already fitting', async () => {
    const { container } = renderCanvas({ zoom: 'fit' });
    const rested = cameraOf(container);

    // Push the canvas away, the way a stray flick of the trackpad does.
    await panCanvas(container, 400, 300);
    expect(cameraOf(container).x).not.toBe(rested.x);

    await userEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expect(cameraOf(container).x).toBeCloseTo(rested.x, 5);
    expect(cameraOf(container).y).toBeCloseTo(rested.y, 5);
  });

  it('steps the zoom in and out', async () => {
    const onZoomChange = vi.fn();
    // Zoom is owned by the caller, so a step is measured against what the
    // caller last rendered — which is how a controlled component behaves and
    // how a gesture arriving faster than a render stays honest.
    const { props, rerender } = renderCanvas({ zoom: 0.5, onZoomChange });
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    // Published once the gesture settles, not once per event of it.
    await waitFor(() => expect(onZoomChange).toHaveBeenLastCalledWith(0.625));
    act(() => {
      rerender(<PreviewCanvas {...props} zoom={0.625} />);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    await waitFor(() => expect(onZoomChange).toHaveBeenLastCalledWith(0.5));
  });

  it('compounds gestures that arrive faster than it can render', async () => {
    const onZoomChange = vi.fn();
    const { container } = renderCanvas({ zoom: 0.5, onZoomChange });
    const viewport = container.querySelector<HTMLElement>('.preview-canvas')!;

    // A trackpad delivers a pinch far faster than React re-renders, so the
    // gesture is not allowed to go through one: each event builds on the live
    // camera, and the owner is told once at the end. Measuring each event
    // against the zoom last RENDERED would collapse the whole gesture into its
    // final event — which is what a canvas that "barely zooms" is doing.
    for (let i = 0; i < 3; i += 1) {
      fireEvent.wheel(viewport, { deltaY: -8, ctrlKey: true, clientX: 600, clientY: 400 });
    }
    expect(onZoomChange).not.toHaveBeenCalled();
    await waitFor(() => expect(onZoomChange).toHaveBeenCalledTimes(1));
    expect(onZoomChange.mock.calls[0][0]).toBeCloseTo(0.5 * Math.exp(0.006 * 8 * 3), 5);
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

  it('zooms on ⌘+wheel, keeping the point under the pointer in place', async () => {
    const onZoomChange = vi.fn();
    const { container } = renderCanvas({ zoom: 0.5, onZoomChange });
    const viewport = container.querySelector<HTMLElement>('.preview-canvas')!;
    const event = new WheelEvent('wheel', {
      deltaY: -120,
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      viewport.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(onZoomChange).toHaveBeenCalledWith(0.625));
  });

  it('anchors the zoom past the label row, not at the top of the surface', async () => {
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
    const viewport = container.querySelector<HTMLElement>('.preview-canvas')!;
    // Somewhere that is not the resting position, so a vertical drift would
    // show up rather than being absorbed by the centring rules.
    await panCanvas(container, 120, 90);
    const before = cameraOf(container);

    act(() => {
      viewport.dispatchEvent(
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
    await nextFrame();

    const expected = anchorScroll({
      scrollLeft: before.x,
      scrollTop: before.y,
      pointerX: 400,
      pointerY: 300,
      fromScale: 0.5,
      toScale: stepZoom(0.5, 'in'),
      originX: 1200 * PAN_SLACK_RATIO,
      originY: 800 * PAN_SLACK_RATIO + CANVAS_LABEL_PX,
    });
    expect(cameraOf(container).x).toBeCloseTo(expected.scrollLeft, 5);
    expect(cameraOf(container).y).toBeCloseTo(expected.scrollTop, 5);
  });

  it('pans on a plain wheel rather than zooming, wherever it came from', async () => {
    // The canvas owns the wheel now. It used to let the scroll container have
    // it, which is why panning changed character depending on whether the
    // pointer was over a live frame (whose wheel the canvas has to forward by
    // hand) or over the background (which the browser scrolled natively).
    const onZoomChange = vi.fn();
    const { container } = renderCanvas({ zoom: 0.5, onZoomChange });
    const viewport = container.querySelector<HTMLElement>('.preview-canvas')!;
    const before = cameraOf(container);
    const event = new WheelEvent('wheel', {
      deltaX: 30,
      deltaY: -120,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      viewport.dispatchEvent(event);
    });
    await nextFrame();
    expect(event.defaultPrevented).toBe(true);
    expect(cameraOf(container).x).toBe(before.x + 30);
    expect(cameraOf(container).y).toBe(before.y - 120);
    expect(onZoomChange).not.toHaveBeenCalled();
  });

  it('zooms with ⌘+ / ⌘- and fits with ⌘0', async () => {
    const onZoomChange = vi.fn();
    renderCanvas({ zoom: 0.5, onZoomChange });
    fireEvent.keyDown(window, { key: '=', metaKey: true });
    fireEvent.keyDown(window, { key: '=', metaKey: true });
    // Two steps, not one: the second measures itself against what the first
    // asked for rather than against the zoom still on screen.
    await waitFor(() =>
      expect(onZoomChange).toHaveBeenLastCalledWith(stepZoom(stepZoom(0.5, 'in'), 'in'))
    );
    // Fit is a decision, not a gesture, so it is published immediately.
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

  it('arms panning while space is held, and drags the canvas', async () => {
    const { container } = renderCanvas({ zoom: 1 });
    const root = container.querySelector<HTMLElement>('.preview-canvas-root')!;
    const viewport = container.querySelector<HTMLElement>('.preview-canvas')!;
    const before = cameraOf(container);

    fireEvent.keyDown(window, { code: 'Space' });
    expect(root.className).toContain('is-pannable');

    fireEvent.mouseDown(viewport, { button: 0, clientX: 300, clientY: 100 });
    expect(root.className).toContain('is-panning');
    fireEvent.mouseMove(document, { clientX: 250, clientY: 100 });
    await nextFrame();
    expect(cameraOf(container).x).toBe(before.x + 50);
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

  it('zooms at a gesture a frame forwards up, mapped back to where it happened', async () => {
    const onZoomChange = vi.fn();
    const { container } = renderCanvas({ zoom: 0.5, onZoomChange });
    const frame = container.querySelector<HTMLIFrameElement>('iframe[data-frame-id="desktop"]')!;
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          data: { type: 'ss:wheelZoom', deltaY: -10, x: 100, y: 50 },
        })
      );
    });
    await waitFor(() => expect(onZoomChange).toHaveBeenCalledWith(wheelZoom(0.5, -10)));
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
    const before = cameraOf(container);
    act(() => {
      rerender(<PreviewCanvas {...props} activeFrameId="mobile" zoom={1} />);
    });
    // Mobile is the last frame on the surface, so bringing it to the middle of
    // the pane at 1:1 moves the camera a long way right of where Fit rested it.
    const after = cameraOf(container);
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.x).toBeGreaterThan(0);
  });
});
