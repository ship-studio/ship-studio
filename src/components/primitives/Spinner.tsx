import type { HTMLAttributes } from 'react';

export type SpinnerSize = 'sm' | 'md' | 'lg';

interface SpinnerProps extends HTMLAttributes<HTMLDivElement> {
  /** sm = 14px (inline, inside buttons), md = 20px (default), lg = 32px (section loading). */
  size?: SpinnerSize;
  /** Accessible label announced to screen readers. */
  label?: string;
}

/**
 * Canonical loading spinner. The spinning arc uses `currentColor`, so tint it
 * by setting `color` on the spinner itself or letting it inherit from the
 * parent (e.g. inside a green action button the arc is automatically dark).
 */
export function Spinner({ size = 'md', label = 'Loading', className, ...rest }: SpinnerProps) {
  const classes = ['ss-spinner', size !== 'md' ? `ss-spinner--${size}` : null, className]
    .filter(Boolean)
    .join(' ');

  return <div className={classes} role="status" aria-label={label} {...rest} />;
}
