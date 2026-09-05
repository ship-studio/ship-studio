import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PreviewCanvas } from './PreviewCanvas';
import { CANVAS_PADDING_PX, type CanvasFrame } from '../../lib/previewCanvas';

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
    expect(stages[0].style.left).toBe(`${CANVAS_PADDING_PX}px`);
  });

  it('scales the surface down to fit rather than reflowing the pages', () => {
    const { container } = renderCanvas();
    const scaled = container.querySelector<HTMLElement>('.preview-canvas-scaled');
    // 1440+1024+768+375 + 3 gaps + 2 paddings = 3815 canvas px into 1200 screen px.
    expect(scaled?.style.transform).toBe('scale(0.3145478374836173)');
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

  it('activates the clicked frame', async () => {
    const onActivateFrame = vi.fn();
    renderCanvas({ onActivateFrame });
    await userEvent.click(screen.getByRole('button', { name: 'Work at Mobile, 375 pixels' }));
    expect(onActivateFrame).toHaveBeenCalledWith('mobile');
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

  it('offers zoom levels and reports the choice', async () => {
    const onZoomChange = vi.fn();
    renderCanvas({ onZoomChange });
    await userEvent.click(screen.getByRole('button', { name: '100%' }));
    expect(onZoomChange).toHaveBeenCalledWith(1);
    await userEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expect(onZoomChange).toHaveBeenCalledWith('fit');
  });

  it('marks the current zoom level as pressed', () => {
    renderCanvas({ zoom: 0.5 });
    expect(screen.getByRole('button', { name: '50%' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Fit' })).toHaveAttribute('aria-pressed', 'false');
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
