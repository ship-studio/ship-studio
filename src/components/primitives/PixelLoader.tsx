import type { CSSProperties, HTMLAttributes } from 'react';

export type PixelLoaderSize = 'sm' | 'md' | 'lg';
export type PixelLoaderVariant =
  | 'rings'
  | 'ripple'
  | 'ripple-isolated'
  | 'ripple-decay'
  | 'ripple-quad'
  | 'ripple-quad-tight'
  | 'scan'
  | 'spark';

export interface PixelLoaderProps extends HTMLAttributes<HTMLDivElement> {
  /** sm = 14px, md = 20px (default), lg = 30px. */
  size?: PixelLoaderSize;
  /** Selects a fixed-grid light pattern. */
  variant?: PixelLoaderVariant;
  /** Number of rows and columns. Defaults to 5, or 6 for the quad variants. */
  gridSize?: number;
  /** Width and height of the centred core block. Defaults to 1, or 2 for quad variants. */
  coreSize?: number;
  /** Accessible status announced to screen readers. */
  label?: string;
}

type PixelStyle = CSSProperties &
  Partial<Record<'--pixel-loader-column' | '--pixel-loader-phase' | '--pixel-loader-ring', number>>;

function clampInteger(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function createPixels(gridSize: number, coreSize: number) {
  const centreStart = Math.floor((gridSize - coreSize) / 2);
  const centreEnd = centreStart + coreSize - 1;

  return Array.from({ length: gridSize * gridSize }, (_, index) => {
    const row = Math.floor(index / gridSize);
    const column = index % gridSize;
    const rowDistance = row < centreStart ? centreStart - row : Math.max(0, row - centreEnd);
    const columnDistance =
      column < centreStart ? centreStart - column : Math.max(0, column - centreEnd);

    return {
      column,
      index,
      phase: (row + column) % 2,
      ring: Math.max(rowDistance, columnDistance),
    };
  });
}

/**
 * A compact square-pixel loading indicator. Pixel positions never move;
 * each variant animates light and glow across an even, optionally custom grid.
 */
export function PixelLoader({
  size = 'md',
  variant = 'ripple',
  gridSize,
  coreSize,
  label = 'Loading',
  className,
  style,
  ...rest
}: PixelLoaderProps) {
  const usesQuadCore = variant === 'ripple-quad' || variant === 'ripple-quad-tight';
  const resolvedGridSize = clampInteger(gridSize ?? (usesQuadCore ? 6 : 5), 1, 16);
  const resolvedCoreSize = clampInteger(coreSize ?? (usesQuadCore ? 2 : 1), 1, resolvedGridSize);
  const pixels = createPixels(resolvedGridSize, resolvedCoreSize);
  const gridStyle = {
    ...style,
    '--pixel-loader-grid-size': resolvedGridSize,
  } as CSSProperties;
  const classes = [
    'ss-pixel-loader',
    `ss-pixel-loader--${variant}`,
    resolvedGridSize === 6 ? 'ss-pixel-loader--grid-6' : null,
    size !== 'md' ? `ss-pixel-loader--${size}` : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} role="status" aria-label={label} style={gridStyle} {...rest}>
      {pixels.map((pixel) => (
        <span
          className="ss-pixel-loader__pixel"
          data-column={pixel.column}
          data-phase={pixel.phase}
          data-ring={pixel.ring}
          style={
            {
              '--pixel-loader-column': pixel.column,
              '--pixel-loader-phase': pixel.phase,
              '--pixel-loader-ring': pixel.ring,
            } as PixelStyle
          }
          key={pixel.index}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}
