import type { HTMLAttributes } from 'react';

/** Props for the user- or project-scope badge shown on extensions. */
export interface ScopeBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  scope: string;
}

/** Shared scope badge; unknown future scopes keep their label and neutral styling. */
export function ScopeBadge({ scope, className, ...props }: ScopeBadgeProps) {
  const modifier = scope === 'project' ? 'extension-scope-badge--project' : null;

  return (
    <span
      {...props}
      className={['extension-scope-badge', modifier, className].filter(Boolean).join(' ')}
    >
      {scope}
    </span>
  );
}
