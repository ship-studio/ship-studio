import type { HTMLAttributes, ReactNode } from 'react';

export type CascadeChipTone = 'selector' | 'tag' | 'media';

interface CascadeChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone: CascadeChipTone;
  editing?: boolean;
  interactive?: boolean;
  children: ReactNode;
}

/**
 * Stable visual shell for selector and condition chips.
 *
 * Display and editing states intentionally share one root contract so a visual
 * change does not need parallel selector-, media-, and edit-wrapper rules.
 */
export function CascadeChip({
  tone,
  editing = false,
  interactive = false,
  className,
  children,
  ...props
}: CascadeChipProps) {
  const classes = [
    'ss-cascade-chip',
    editing ? 'is-editing' : null,
    interactive ? 'is-interactive' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classes} data-tone={tone} {...props}>
      {children}
    </span>
  );
}
