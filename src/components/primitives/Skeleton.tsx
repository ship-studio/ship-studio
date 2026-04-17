import type { CSSProperties } from 'react';

interface SkeletonProps {
  variant?: 'text' | 'card' | 'grid';
  count?: number;
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: CSSProperties;
}

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
