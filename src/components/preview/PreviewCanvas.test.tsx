import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PreviewCanvas } from './PreviewCanvas';
import { CANVAS_PADDING_PX, MAX_ZOOM, type CanvasFrame } from '../../lib/previewCanvas';

const FRAMES: CanvasFrame[] = [
  { id: 'desktop', label: 'Desktop', width: 1440 },
  { id: 'laptop', label: 'Laptop', width: 1024 },
  { id: 'tablet', label: 'Tablet', width: 768 },
  { id: 'mobile', label: 'Mobile', width: 375 },
];

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
});

afterEach(() => {
  restoreSize?.();
  restoreSize = null;
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

  it('scales the surface down to fit rather than reflowing the pages', () => {
    const { container } = renderCanvas();
    const scaled = container.querySelector<HTMLElement>('.preview-canvas-scaled');
    // 1440+1024+768+375 + 3 gaps = 3751 canvas px into 1200 - 2×32 screen px.
    const expected = (1200 - CANVAS_PADDING_PX * 2) / 3751;
    expect(scaled?.style.transform).toBe(`scale(${expected})`);
  });

  it('opens with room to pan on every side, and rests on the frames', () => {
    const { container } = renderCanvas();
    const scaled = container.querySelector<HTMLElement>('.preview-canvas-scaled')!;
    const scroller = container.querySelector<HTMLElement>('.preview-canvas')!;
    // Half a screen of slack either side (PAN_SLACK_RATIO), and the canvas
    // scrolled onto the content rather than sitting in the empty margin.
    expect(scaled.style.left).toBe('600px');
    expect(scroller.scrollLeft).toBe(600 - CANVAS_PADDING_PX);
  });

  it('labels every frame with its device name and width', () => {
    renderCanvas();
    expect(screen.getByText('Desktop')).toBeInTheDocument();
    expect(screen.getByText('1440px')).toBeInTheDocument();
    expect(screen.getByText('375px')).toBeInTheDocument();
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

  it('reads out the current zoom, and returns to true size when it is clicked', async () => {
    const onZoomChange = vi.fn();
    renderCanvas({ zoom: 0.5, onZoomChange });
    await userEvent.click(screen.getByRole('button', { name: '50%' }));
    expect(onZoomChange).toHaveBeenCalledWith(1);
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

  it('lifts the frames out of the way while the zoom modifier is held', () => {
    const { container } = renderCanvas();
    const root = container.querySelector<HTMLElement>('.preview-canvas-root')!;
    expect(root.className).not.toContain('is-zooming');
    fireEvent.keyDown(window, { key: 'Meta', metaKey: true });
    expect(root.className).toContain('is-zooming');
    fireEvent.keyUp(window, { key: 'Meta', metaKey: false });
    expect(root.className).not.toContain('is-zooming');
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
