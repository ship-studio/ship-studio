import { describe, it, expect } from 'vitest';
import {
  CANVAS_GAP_PX,
  CANVAS_PADDING_PX,
  MAX_ZOOM,
  MIN_ZOOM,
  anchorScroll,
  clampZoom,
  fitScale,
  layoutFrames,
  scrollToCenterFrame,
  stepZoom,
  tallestFrame,
  visibleFrameIds,
  wheelZoom,
  type CanvasFrame,
} from './previewCanvas';

const FRAMES: CanvasFrame[] = [
  { id: 'desktop', label: 'Desktop', width: 1440, height: 900 },
  { id: 'laptop', label: 'Laptop', width: 1024, height: 700 },
  { id: 'tablet', label: 'Tablet', width: 768, height: 1024 },
  { id: 'mobile', label: 'Mobile', width: 375, height: 812 },
];

describe('layoutFrames', () => {
  it('places frames left to right with a gap between them', () => {
    const { placements } = layoutFrames(FRAMES);
    expect(placements.map((p) => p.x)).toEqual([
      0,
      1440 + CANVAS_GAP_PX,
      1440 + 1024 + CANVAS_GAP_PX * 2,
      1440 + 1024 + 768 + CANVAS_GAP_PX * 3,
    ]);
  });

  it('measures only the frames and the gaps between them', () => {
    // The room AROUND the frames is screen-space slack the canvas adds; it is
    // deliberately not part of what has to fit.
    const { contentWidth } = layoutFrames(FRAMES);
    expect(contentWidth).toBe(1440 + 1024 + 768 + 375 + CANVAS_GAP_PX * 3);
  });

  it('reports an empty surface for no frames', () => {
    expect(layoutFrames([])).toEqual({ placements: [], contentWidth: 0 });
  });
});

describe('fitScale', () => {
  it('shrinks the surface to the visible width, less a margin either side', () => {
    expect(fitScale(4000, 1000 + CANVAS_PADDING_PX * 2)).toBe(0.25);
  });

  it('never scales past true size', () => {
    expect(fitScale(800, 1600)).toBe(1);
  });

  it('falls back to true size when nothing has been measured yet', () => {
    expect(fitScale(0, 0)).toBe(1);
    expect(fitScale(4000, 0)).toBe(1);
  });
});

describe('tallestFrame', () => {
  it('reports the tallest device on the canvas — what the surface has to hold', () => {
    expect(tallestFrame(layoutFrames(FRAMES))).toBe(1024);
  });

  it('is zero for an empty canvas', () => {
    expect(tallestFrame(layoutFrames([]))).toBe(0);
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

  it('accounts for the slack the frames are offset by', () => {
    // Scrolled to the frames' own start: the leftmost frame is in view.
    const slack = 600;
    expect(visibleFrameIds(layout, 1, slack, 1200, slack)).toContain('desktop');
    // Scrolled a long way left of them: nothing is.
    expect(visibleFrameIds(layout, 1, 0, 200, 100000)).toHaveLength(0);
  });
});

describe('scrollToCenterFrame', () => {
  const layout = layoutFrames(FRAMES);

  it('centres the requested frame', () => {
    const scrollLeft = scrollToCenterFrame(layout, 'tablet', 1, 1000);
    const tablet = layout.placements[2];
    expect(scrollLeft).toBe(tablet.x + tablet.width / 2 - 500);
  });

  it('centres it through the slack offset too', () => {
    const slack = 500;
    const tablet = layout.placements[2];
    expect(scrollToCenterFrame(layout, 'tablet', 1, 1000, slack)).toBe(
      slack + tablet.x + tablet.width / 2 - 500
    );
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

describe('clampZoom', () => {
  it('holds the zoom inside the usable range', () => {
    expect(clampZoom(0.001)).toBe(MIN_ZOOM);
    expect(clampZoom(50)).toBe(MAX_ZOOM);
    expect(clampZoom(0.8)).toBe(0.8);
  });
});

describe('stepZoom', () => {
  it('steps by a ratio, so a press feels the same size at any zoom', () => {
    expect(stepZoom(0.4, 'in')).toBeCloseTo(0.5);
    expect(stepZoom(1.6, 'in')).toBeCloseTo(2);
    expect(stepZoom(0.5, 'out')).toBeCloseTo(0.4);
  });

  it('stops at the ends of the range', () => {
    expect(stepZoom(MAX_ZOOM, 'in')).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, 'out')).toBe(MIN_ZOOM);
  });
});

describe('wheelZoom', () => {
  it('zooms in on a scroll up and out on a scroll down', () => {
    expect(wheelZoom(1, -120)).toBeCloseTo(1.25);
    expect(wheelZoom(1, 120)).toBeCloseTo(0.8);
  });

  it('scales a trackpad gesture with its size', () => {
    expect(wheelZoom(1, -5)).toBeLessThan(wheelZoom(1, -20));
    expect(wheelZoom(1, -0.5)).toBeCloseTo(1, 1);
  });

  it('treats a mouse-wheel notch as exactly one step, however many pixels it claims', () => {
    // A notch arrives as ~100+ pixels at once; through the continuous response
    // that would be an enormous jump.
    expect(wheelZoom(1, -120)).toBe(stepZoom(1, 'in'));
    expect(wheelZoom(1, -400)).toBe(stepZoom(1, 'in'));
    expect(wheelZoom(1, 120)).toBe(stepZoom(1, 'out'));
  });

  it('stays inside the range however hard the gesture is', () => {
    expect(wheelZoom(MAX_ZOOM, -49)).toBe(MAX_ZOOM);
    expect(wheelZoom(MIN_ZOOM, 49)).toBe(MIN_ZOOM);
  });

  it('does nothing for an empty gesture', () => {
    expect(wheelZoom(0.7, 0)).toBe(0.7);
  });
});

describe('anchorScroll', () => {
  const base = { scrollLeft: 0, scrollTop: 0, pointerX: 0, pointerY: 0 };

  it('keeps the canvas point under the pointer under the pointer', () => {
    const next = anchorScroll({
      ...base,
      scrollLeft: 400,
      pointerX: 200,
      fromScale: 0.5,
      toScale: 1,
    });
    // Canvas x under the pointer was (400+200)/0.5 = 1200; at scale 1 that must
    // still sit 200px into the visible canvas.
    expect(next.scrollLeft).toBe(1200 - 200);
  });

  it('works on both axes', () => {
    const next = anchorScroll({
      scrollLeft: 100,
      scrollTop: 50,
      pointerX: 10,
      pointerY: 20,
      fromScale: 1,
      toScale: 2,
    });
    expect(next).toEqual({ scrollLeft: 210, scrollTop: 120 });
  });

  it('never scrolls to a negative offset', () => {
    const next = anchorScroll({ ...base, pointerX: 500, fromScale: 1, toScale: 0.5 });
    expect(next.scrollLeft).toBe(0);
  });

  it('is a no-op for a nonsense scale', () => {
    const next = anchorScroll({ ...base, scrollLeft: 42, fromScale: 0, toScale: 1 });
    expect(next.scrollLeft).toBe(42);
  });
});

describe('anchorScroll with a pan-slack origin', () => {
  it('keeps the point under the pointer put, offset and all', () => {
    const originX = 600;
    const next = anchorScroll({
      scrollLeft: 800,
      scrollTop: 0,
      pointerX: 200,
      pointerY: 0,
      fromScale: 0.5,
      toScale: 1,
      originX,
      originY: 0,
    });
    // Canvas x under the pointer: (800 + 200 - 600) / 0.5 = 800. At scale 1 it
    // must sit 200px into the visible canvas again, past the same origin.
    expect(next.scrollLeft).toBe(originX + 800 - 200);
  });

  it('ignoring the origin would anchor somewhere else entirely', () => {
    const params = {
      scrollLeft: 800,
      scrollTop: 0,
      pointerX: 200,
      pointerY: 0,
      fromScale: 0.5,
      toScale: 1,
    };
    expect(anchorScroll({ ...params, originX: 600 }).scrollLeft).not.toBe(
      anchorScroll(params).scrollLeft
    );
  });
});
