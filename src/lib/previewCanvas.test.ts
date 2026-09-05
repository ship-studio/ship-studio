import { describe, it, expect } from 'vitest';
import {
  CANVAS_GAP_PX,
  CANVAS_PADDING_PX,
  fitScale,
  frameHeight,
  layoutFrames,
  scrollToCenterFrame,
  visibleFrameIds,
  type CanvasFrame,
} from './previewCanvas';

const FRAMES: CanvasFrame[] = [
  { id: 'desktop', label: 'Desktop', width: 1440 },
  { id: 'laptop', label: 'Laptop', width: 1024 },
  { id: 'tablet', label: 'Tablet', width: 768 },
  { id: 'mobile', label: 'Mobile', width: 375 },
];

describe('layoutFrames', () => {
  it('places frames left to right with a gap between them', () => {
    const { placements } = layoutFrames(FRAMES);
    expect(placements.map((p) => p.x)).toEqual([
      CANVAS_PADDING_PX,
      CANVAS_PADDING_PX + 1440 + CANVAS_GAP_PX,
      CANVAS_PADDING_PX + 1440 + 1024 + CANVAS_GAP_PX * 2,
      CANVAS_PADDING_PX + 1440 + 1024 + 768 + CANVAS_GAP_PX * 3,
    ]);
  });

  it('measures the surface as the frames plus inner gaps and outer padding', () => {
    const { contentWidth } = layoutFrames(FRAMES);
    expect(contentWidth).toBe(1440 + 1024 + 768 + 375 + CANVAS_GAP_PX * 3 + CANVAS_PADDING_PX * 2);
  });

  it('reports an empty surface for no frames', () => {
    expect(layoutFrames([])).toEqual({ placements: [], contentWidth: 0 });
  });
});

describe('fitScale', () => {
  it('shrinks the surface to the visible width', () => {
    expect(fitScale(4000, 1000)).toBe(0.25);
  });

  it('never scales past true size', () => {
    expect(fitScale(800, 1600)).toBe(1);
  });

  it('falls back to true size when nothing has been measured yet', () => {
    expect(fitScale(0, 0)).toBe(1);
    expect(fitScale(4000, 0)).toBe(1);
  });
});

describe('frameHeight', () => {
  it('grows the frame as the canvas shrinks so it still fills the pane', () => {
    expect(frameHeight(800, 0.5)).toBe(1600);
  });

  it('clamps a heavily zoomed-out canvas instead of asking for an absurd viewport', () => {
    expect(frameHeight(800, 0.1)).toBe(2000);
  });

  it('keeps a floor so a short pane still renders a usable page', () => {
    expect(frameHeight(200, 1)).toBe(480);
  });

  it('is safe before the pane is measured', () => {
    expect(frameHeight(0, 0)).toBe(480);
  });
});

describe('visibleFrameIds', () => {
  const layout = layoutFrames(FRAMES);

  it('keeps every frame mounted when the whole canvas fits', () => {
    const scale = fitScale(layout.contentWidth, 1200);
    expect(visibleFrameIds(layout, scale, 0, 1200)).toEqual([
      'desktop',
      'laptop',
      'tablet',
      'mobile',
    ]);
  });

  it('drops frames that are scrolled more than a screen away', () => {
    // At true size a 1200px window on the left edge sees Desktop, and the
    // one-screen margin reaches into Laptop — but not as far as Mobile.
    const visible = visibleFrameIds(layout, 1, 0, 1200);
    expect(visible).toContain('desktop');
    expect(visible).not.toContain('mobile');
  });

  it('follows the scroll position', () => {
    const scrollLeft = layout.placements[3].x - 200;
    const visible = visibleFrameIds(layout, 1, scrollLeft, 600);
    expect(visible).toContain('mobile');
    expect(visible).not.toContain('desktop');
  });

  it('mounts everything before the pane has been measured', () => {
    expect(visibleFrameIds(layout, 1, 0, 0)).toHaveLength(FRAMES.length);
  });
});

describe('scrollToCenterFrame', () => {
  const layout = layoutFrames(FRAMES);

  it('centres the requested frame', () => {
    const scrollLeft = scrollToCenterFrame(layout, 'tablet', 1, 1000);
    const tablet = layout.placements[2];
    expect(scrollLeft).toBe(tablet.x + tablet.width / 2 - 500);
  });

  it('clamps to the start of the surface', () => {
    expect(scrollToCenterFrame(layout, 'desktop', 1, 4000)).toBe(0);
  });

  it('clamps to the end of the surface', () => {
    const max = layout.contentWidth - 1000;
    expect(scrollToCenterFrame(layout, 'mobile', 1, 1000)).toBeLessThanOrEqual(max);
  });

  it('ignores an unknown frame', () => {
    expect(scrollToCenterFrame(layout, 'nope', 1, 1000)).toBe(0);
  });
});
