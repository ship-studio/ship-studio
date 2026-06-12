import type { CSSProperties } from 'react';

interface SkeletonProps {
  /** text = 12px line (default), card = 96px block, grid = auto-fill grid of cards. */
  variant?: 'text' | 'card' | 'grid';
  /** How many placeholders to render (siblings, or cells for `grid`). Default 1. */
  count?: number;
  /** Inline width override (px number or CSS string). Ignored by `grid`. */
  width?: number | string;
  /** Inline height override (px number or CSS string). Ignored by `grid`. */
  height?: number | string;
  /** Extra class on each placeholder (or the grid container). */
  className?: string;
  /** Extra inline styles merged before width/height. Ignored by `grid`. */
  style?: CSSProperties;
}

/**
 * Canonical loading placeholder. Pulses via the shared `skeleton-pulse`
 * keyframes in base.css — keyframe names are global in CSS, so never redefine
 * them in a feature file (a duplicate silently overrides every consumer).
 */
export function Skeleton({
  variant = 'text',
  count = 1,
  width,
  height,
  className,
  style,
}: SkeletonProps) {
  if (variant === 'grid') {
    return (
      <div className={`skeleton--grid${className ? ` ${className}` : ''}`}>
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="skeleton skeleton--card" />
        ))}
      </div>
    );
  }

  const inlineStyle: CSSProperties = { ...style };
  if (width !== undefined) inlineStyle.width = width;
  if (height !== undefined) inlineStyle.height = height;

  const classes = `skeleton skeleton--${variant}${className ? ` ${className}` : ''}`;
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={classes} style={inlineStyle} />
      ))}
    </>
  );
}
