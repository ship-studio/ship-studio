import type { HTMLAttributes, ReactNode } from 'react';

/** Props for a standardized extension-manager result row and its trailing action. */
export interface ExtensionListRowProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /** Optional trailing action area; row content remains domain-owned. */
  action?: ReactNode;
}

/** Shared bordered row surface used by MCP, Skills, and Plugin lists. */
export function ExtensionListRow({ children, action, className, ...props }: ExtensionListRowProps) {
  return (
    <div {...props} className={['extension-list-row', className].filter(Boolean).join(' ')}>
      <div className="extension-list-row__main">{children}</div>
      {action ? <div className="extension-list-row__action">{action}</div> : null}
    </div>
  );
}
