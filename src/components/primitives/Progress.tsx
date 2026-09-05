import type { CSSProperties, HTMLAttributes } from 'react';

export interface ProgressProps extends HTMLAttributes<HTMLDivElement> {
  /** Current progress value. Omit or pass null for an indeterminate bar. */
  value?: number | null;
  /** The value that represents 100% progress. */
  max?: number;
}

function clampProgressValue(value: number, max: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(0, value));
}

/**
 * Dependency-free progress bar primitive with native progressbar semantics.
 * The indicator is intentionally decorative; the root owns the accessible
 * value so determinate and indeterminate states are announced correctly.
 */
export function Progress({ value, max = 100, className, style, ...rest }: ProgressProps) {
  const resolvedMax = Number.isFinite(max) && max > 0 ? max : 100;
  const resolvedValue = value == null ? null : clampProgressValue(value, resolvedMax);
  const percentage =
    resolvedValue == null
      ? null
      : Math.round((resolvedValue / resolvedMax) * 100 * 10_000) / 10_000;
  const classes = [
    'ss-progress',
    resolvedValue == null ? 'ss-progress--indeterminate' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  const indicatorStyle =
    percentage == null ? undefined : ({ width: `${percentage}%` } as CSSProperties);

  return (
    <div
      className={classes}
      data-slot="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={resolvedMax}
      aria-valuenow={resolvedValue ?? undefined}
      style={style}
      {...rest}
    >
      <div
        className="ss-progress__indicator"
        data-slot="progress-indicator"
        aria-hidden="true"
        style={indicatorStyle}
      />
    </div>
  );
}
