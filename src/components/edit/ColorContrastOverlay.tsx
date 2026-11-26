import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { converter } from 'culori';
import { parseColor } from '../../lib/parseColor';

const toRgb = converter('rgb');
const MAX_SAMPLE_SPACING = 1.25;
const MAX_GRID_SIZE = 321;
const DOT_SPACING = 8;

interface Props {
  visualRef: RefObject<HTMLDivElement | null>;
  hue: number;
  alpha: number;
  backgroundColor: string | null;
  threshold: number | null;
  enabled: boolean;
}

interface ContrastGrid {
  columns: number;
  rows: number;
  stepX: number;
  stepY: number;
  values: Float64Array;
}

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

interface CornerRadii {
  topLeftX: number;
  topRightX: number;
  bottomRightX: number;
  bottomLeftX: number;
  topLeftY: number;
  topRightY: number;
  bottomRightY: number;
  bottomLeftY: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function linearizeChannel(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminanceChannels(r: number, g: number, b: number): number {
  return 0.2126 * linearizeChannel(r) + 0.7152 * linearizeChannel(g) + 0.0722 * linearizeChannel(b);
}

function relativeLuminance({ r, g, b }: RgbColor): number {
  return relativeLuminanceChannels(r, g, b);
}

function parseOpaqueBackground(backgroundColor: string): RgbColor | null {
  const parsed = parseColor(backgroundColor);
  if (!parsed) return null;
  const rgb = toRgb(parsed);
  if (!rgb) return null;

  const channels = [rgb.r, rgb.g, rgb.b, rgb.alpha ?? 1];
  if (!channels.every((channel) => typeof channel === 'number' && Number.isFinite(channel))) {
    return null;
  }

  const alpha = clamp01(rgb.alpha ?? 1);
  if (alpha !== 1) return null;
  return {
    r: clamp01(rgb.r ?? 0),
    g: clamp01(rgb.g ?? 0),
    b: clamp01(rgb.b ?? 0),
  };
}

function sampleGrid(
  hue: number,
  alpha: number,
  background: RgbColor,
  threshold: number,
  width: number,
  height: number
): ContrastGrid {
  const columns = Math.min(MAX_GRID_SIZE, Math.max(2, Math.ceil(width / MAX_SAMPLE_SPACING) + 1));
  const rows = Math.min(MAX_GRID_SIZE, Math.max(2, Math.ceil(height / MAX_SAMPLE_SPACING) + 1));
  const stepX = width / (columns - 1);
  const stepY = height / (rows - 1);
  const values = new Float64Array(columns * rows);
  const backgroundLuminance = relativeLuminance(background);
  const normalizedHue = ((hue % 360) + 360) % 360;
  const hueSector = normalizedHue / 60;
  const hueSection = Math.floor(hueSector);
  const secondChannelFactor = 1 - Math.abs((hueSector % 2) - 1);
  const foregroundAlpha = clamp01(alpha);

  for (let y = 0; y < rows; y += 1) {
    const value = (rows - 1 - y) / (rows - 1);
    for (let x = 0; x < columns; x += 1) {
      const saturation = x / (columns - 1);
      const chroma = value * saturation;
      const second = chroma * secondChannelFactor;
      const offset = value - chroma;
      let red = 0;
      let green = 0;
      let blue = 0;

      switch (hueSection) {
        case 0:
          red = chroma;
          green = second;
          break;
        case 1:
          red = second;
          green = chroma;
          break;
        case 2:
          green = chroma;
          blue = second;
          break;
        case 3:
          green = second;
          blue = chroma;
          break;
        case 4:
          red = second;
          blue = chroma;
          break;
        default:
          red = chroma;
          blue = second;
      }

      red = clamp01((red + offset) * foregroundAlpha + background.r * (1 - foregroundAlpha));
      green = clamp01((green + offset) * foregroundAlpha + background.g * (1 - foregroundAlpha));
      blue = clamp01((blue + offset) * foregroundAlpha + background.b * (1 - foregroundAlpha));
      const foregroundLuminance = relativeLuminanceChannels(red, green, blue);
      const lighter = Math.max(foregroundLuminance, backgroundLuminance);
      const darker = Math.min(foregroundLuminance, backgroundLuminance);
      const ratio = (lighter + 0.05) / (darker + 0.05);
      values[y * columns + x] = ratio - threshold;
    }
  }

  return { columns, rows, stepX, stepY, values };
}

function gridValueAt(grid: ContrastGrid, x: number, y: number): number {
  const gridX = Math.min(grid.columns - 1, Math.max(0, x / grid.stepX));
  const gridY = Math.min(grid.rows - 1, Math.max(0, y / grid.stepY));
  const left = Math.floor(gridX);
  const top = Math.floor(gridY);
  const right = Math.min(grid.columns - 1, left + 1);
  const bottom = Math.min(grid.rows - 1, top + 1);
  const horizontal = gridX - left;
  const vertical = gridY - top;
  const topLeft = grid.values[top * grid.columns + left];
  const topRight = grid.values[top * grid.columns + right];
  const bottomLeft = grid.values[bottom * grid.columns + left];
  const bottomRight = grid.values[bottom * grid.columns + right];
  const topValue = topLeft + (topRight - topLeft) * horizontal;
  const bottomValue = bottomLeft + (bottomRight - bottomLeft) * horizontal;
  return topValue + (bottomValue - topValue) * vertical;
}

function drawGrid(
  canvas: HTMLCanvasElement,
  hue: number,
  alpha: number,
  backgroundColor: string,
  threshold: number,
  width: number,
  height: number,
  scaleX: number,
  scaleY: number,
  radii: CornerRadii
): boolean {
  const background = parseOpaqueBackground(backgroundColor);
  const white = getComputedStyle(canvas).getPropertyValue('--color-white').trim();
  if (!background || !white) return false;

  const devicePixelRatio = window.devicePixelRatio || 1;
  const pixelRatioX = Math.max(0.5, devicePixelRatio * scaleX);
  const pixelRatioY = Math.max(0.5, devicePixelRatio * scaleY);
  canvas.width = Math.max(1, Math.round(width * pixelRatioX));
  canvas.height = Math.max(1, Math.round(height * pixelRatioY));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.style.borderRadius = `${radii.topLeftX}px ${radii.topRightX}px ${radii.bottomRightX}px ${radii.bottomLeftX}px / ${radii.topLeftY}px ${radii.topRightY}px ${radii.bottomRightY}px ${radii.bottomLeftY}px`;

  const context = canvas.getContext('2d');
  if (!context) return false;
  context.setTransform(pixelRatioX, 0, 0, pixelRatioY, 0, 0);
  context.clearRect(0, 0, width, height);

  const grid = sampleGrid(hue, alpha, background, threshold, width, height);
  // Place the stipple on its own CSS-pixel lattice. Bilinear lookup keeps its
  // spacing independent of the dense samples used by the contour renderer.
  context.fillStyle = white;
  context.globalAlpha = 0.34;
  const dotColumns = Math.max(1, Math.ceil(width / DOT_SPACING));
  const dotRows = Math.max(1, Math.ceil(height / DOT_SPACING));
  const dotStepX = width / dotColumns;
  const dotStepY = height / dotRows;
  const dotRadius = 0.55;
  for (let row = 0; row < dotRows; row += 1) {
    const y = (row + 0.5) * dotStepY;
    for (let column = 0; column < dotColumns; column += 1) {
      const x = (column + 0.5) * dotStepX;
      if (gridValueAt(grid, x, y) < 0) {
        context.beginPath();
        context.arc(x, y, dotRadius, 0, Math.PI * 2);
        context.fill();
      }
    }
  }

  // Marching squares keeps every threshold crossing, including the two sides
  // of a failing band when alpha makes contrast non-monotonic along value.
  // The canvas path is antialiased by the browser at the backing-store scale.
  context.globalAlpha = 1;
  context.strokeStyle = white;
  context.lineWidth = 1.35;
  context.lineCap = 'round';
  context.beginPath();

  const addCrossing = (
    hits: { x: number; y: number }[],
    firstValue: number,
    secondValue: number,
    firstX: number,
    firstY: number,
    secondX: number,
    secondY: number
  ) => {
    const firstPasses = firstValue >= 0;
    const secondPasses = secondValue >= 0;
    if (firstPasses === secondPasses) return;
    const delta = secondValue - firstValue;
    const progress = delta === 0 ? 0.5 : Math.max(0, Math.min(1, -firstValue / delta));
    hits.push({
      x: firstX + (secondX - firstX) * progress,
      y: firstY + (secondY - firstY) * progress,
    });
  };

  for (let y = 0; y < grid.rows - 1; y += 1) {
    for (let x = 0; x < grid.columns - 1; x += 1) {
      const firstIndex = y * grid.columns + x;
      const firstValue = grid.values[firstIndex];
      const secondValue = grid.values[firstIndex + 1];
      const thirdValue = grid.values[firstIndex + grid.columns + 1];
      const fourthValue = grid.values[firstIndex + grid.columns];
      if (
        !Number.isFinite(firstValue) ||
        !Number.isFinite(secondValue) ||
        !Number.isFinite(thirdValue) ||
        !Number.isFinite(fourthValue)
      ) {
        continue;
      }

      const firstPasses = firstValue >= 0;
      const secondPasses = secondValue >= 0;
      const thirdPasses = thirdValue >= 0;
      const fourthPasses = fourthValue >= 0;
      if (
        firstPasses === secondPasses &&
        secondPasses === thirdPasses &&
        thirdPasses === fourthPasses
      ) {
        continue;
      }

      const hits: { x: number; y: number }[] = [];
      const x1 = (x + 1) * grid.stepX;
      const y1 = (y + 1) * grid.stepY;
      addCrossing(
        hits,
        firstValue,
        secondValue,
        x * grid.stepX,
        y * grid.stepY,
        x1,
        y * grid.stepY
      );
      addCrossing(hits, secondValue, thirdValue, x1, y * grid.stepY, x1, y1);
      addCrossing(hits, thirdValue, fourthValue, x1, y1, x * grid.stepX, y1);
      addCrossing(
        hits,
        fourthValue,
        firstValue,
        x * grid.stepX,
        y1,
        x * grid.stepX,
        y * grid.stepY
      );

      let pairs: [number, number][] = [];
      if (hits.length === 2) {
        pairs = [[0, 1]];
      } else if (hits.length === 4) {
        const centerPasses = (firstValue + secondValue + thirdValue + fourthValue) / 4 >= 0;
        const topLeftPasses = firstValue >= 0;
        pairs =
          centerPasses === topLeftPasses
            ? [
                [0, 1],
                [2, 3],
              ]
            : [
                [0, 3],
                [1, 2],
              ];
      }

      pairs.forEach(([first, second]) => {
        const firstPoint = hits[first];
        const secondPoint = hits[second];
        if (!firstPoint || !secondPoint) return;
        context.moveTo(firstPoint.x, firstPoint.y);
        context.lineTo(secondPoint.x, secondPoint.y);
      });
    }
  }
  context.stroke();
  return true;
}

function borderWidth(style: CSSStyleDeclaration, side: 'Left' | 'Right' | 'Top' | 'Bottom') {
  const value =
    side === 'Left'
      ? style.borderLeftWidth
      : side === 'Right'
        ? style.borderRightWidth
        : side === 'Top'
          ? style.borderTopWidth
          : style.borderBottomWidth;
  return Number.parseFloat(value) || 0;
}

function radiusPair(value: string): [number, number] {
  const parts = value
    .trim()
    .split(/\s+/)
    .map((part) => Number.parseFloat(part) || 0);
  return [parts[0] ?? 0, parts[1] ?? parts[0] ?? 0];
}

function innerCornerRadii(style: CSSStyleDeclaration): CornerRadii {
  const left = borderWidth(style, 'Left');
  const right = borderWidth(style, 'Right');
  const top = borderWidth(style, 'Top');
  const bottom = borderWidth(style, 'Bottom');
  const [topLeftX, topLeftY] = radiusPair(style.borderTopLeftRadius);
  const [topRightX, topRightY] = radiusPair(style.borderTopRightRadius);
  const [bottomRightX, bottomRightY] = radiusPair(style.borderBottomRightRadius);
  const [bottomLeftX, bottomLeftY] = radiusPair(style.borderBottomLeftRadius);

  return {
    topLeftX: Math.max(0, topLeftX - left),
    topRightX: Math.max(0, topRightX - right),
    bottomRightX: Math.max(0, bottomRightX - right),
    bottomLeftX: Math.max(0, bottomLeftX - left),
    topLeftY: Math.max(0, topLeftY - top),
    topRightY: Math.max(0, topRightY - top),
    bottomRightY: Math.max(0, bottomRightY - bottom),
    bottomLeftY: Math.max(0, bottomLeftY - bottom),
  };
}

/** Non-interactive contrast boundary and failing-region dots for the HSV field. */
export function ColorContrastOverlay({
  hue,
  visualRef,
  alpha,
  backgroundColor,
  threshold,
  enabled,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef<(() => void) | null>(null);
  const inputsRef = useRef({ hue, alpha, backgroundColor, threshold, enabled });

  useEffect(() => {
    if (!enabled || !canvasRef.current || !visualRef.current) return;

    const canvas = canvasRef.current;
    const visual = visualRef.current;
    const saturation = visual.querySelector<HTMLElement>('.react-colorful__saturation');
    if (!saturation) return;

    let frame: { id: number; animationFrame: boolean } | null = null;
    const cancelFrame = (scheduled: { id: number; animationFrame: boolean }) => {
      if (scheduled.animationFrame && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(scheduled.id);
      } else {
        window.clearTimeout(scheduled.id);
      }
    };
    const scheduleFrame = (callback: FrameRequestCallback) => {
      if (typeof window.requestAnimationFrame === 'function') {
        return { id: window.requestAnimationFrame(callback), animationFrame: true };
      }
      return {
        id: window.setTimeout(() => callback(performance.now()), 0),
        animationFrame: false,
      };
    };

    const render = () => {
      frame = null;
      const inputs = inputsRef.current;
      if (!inputs.enabled || !inputs.backgroundColor || inputs.threshold === null) {
        canvas.style.visibility = 'hidden';
        return;
      }

      const bounds = saturation.getBoundingClientRect();
      const visualBounds = visual.getBoundingClientRect();
      const visualStyle = getComputedStyle(visual);
      const saturationStyle = getComputedStyle(saturation);
      const layoutWidth = visual.offsetWidth;
      const layoutHeight = visual.offsetHeight;
      if (bounds.width <= 0 || bounds.height <= 0 || layoutWidth <= 0 || layoutHeight <= 0) return;

      const scaleX = visualBounds.width / layoutWidth;
      const scaleY = visualBounds.height / layoutHeight;
      if (scaleX <= 0 || scaleY <= 0) return;

      const visualBorderLeft = borderWidth(visualStyle, 'Left');
      const visualBorderTop = borderWidth(visualStyle, 'Top');
      const saturationBorderLeft = borderWidth(saturationStyle, 'Left');
      const saturationBorderRight = borderWidth(saturationStyle, 'Right');
      const saturationBorderTop = borderWidth(saturationStyle, 'Top');
      const saturationBorderBottom = borderWidth(saturationStyle, 'Bottom');
      const width = bounds.width / scaleX - saturationBorderLeft - saturationBorderRight;
      const height = bounds.height / scaleY - saturationBorderTop - saturationBorderBottom;
      if (width <= 0 || height <= 0) return;

      const left =
        (bounds.left - visualBounds.left) / scaleX - visualBorderLeft + saturationBorderLeft;
      const top = (bounds.top - visualBounds.top) / scaleY - visualBorderTop + saturationBorderTop;
      canvas.style.left = `${left}px`;
      canvas.style.top = `${top}px`;
      canvas.style.visibility = drawGrid(
        canvas,
        inputs.hue,
        inputs.alpha,
        inputs.backgroundColor,
        inputs.threshold,
        width,
        height,
        scaleX,
        scaleY,
        innerCornerRadii(saturationStyle)
      )
        ? 'visible'
        : 'hidden';
    };

    const draw = () => {
      if (frame) cancelFrame(frame);
      frame = scheduleFrame(render);
    };

    drawRef.current = draw;
    draw();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(draw);
    observer?.observe(saturation);
    observer?.observe(visual);
    window.addEventListener('resize', draw);
    return () => {
      if (drawRef.current === draw) drawRef.current = null;
      if (frame) cancelFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', draw);
    };
  }, [enabled, visualRef]);

  useLayoutEffect(() => {
    inputsRef.current = { hue, alpha, backgroundColor, threshold, enabled };
    drawRef.current?.();
  }, [alpha, backgroundColor, enabled, hue, threshold]);

  if (!enabled || !backgroundColor || threshold === null) return null;
  return <canvas ref={canvasRef} className="ss-color-picker__contrast-canvas" aria-hidden="true" />;
}
