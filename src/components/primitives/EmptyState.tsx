import type { ReactNode } from 'react';

interface EmptyStateProps {
  /** Leading icon node, rendered muted above the title. */
  icon?: ReactNode;
  /** The headline (required). */
  title: ReactNode;
  /** Supporting copy under the title; wraps at a readable max-width. */
  description?: ReactNode;
  /** Call-to-action rendered below — typically a `<Button>`. */
  action?: ReactNode;
  /** Extra class on the container for feature-specific spacing tweaks. */
  className?: string;
}

/**
 * Canonical empty state: a centered icon / title / description / action stack
 * for empty lists and zero-data panels.
 */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={`empty-state${className ? ` ${className}` : ''}`}>
      {icon && <div className="empty-state-icon">{icon}</div>}
      <div className="empty-state-title">{title}</div>
      {description && <div className="empty-state-description">{description}</div>}
      {action}
    </div>
  );
}
