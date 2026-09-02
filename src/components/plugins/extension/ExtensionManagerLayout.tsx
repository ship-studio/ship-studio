import type { ReactNode } from 'react';

/** Props for the shared extension-manager shell, search area, content, and footer. */
export interface ExtensionManagerLayoutProps {
  /** The manager's tab list, kept separate from its scrollable panels. */
  tabs: ReactNode;
  /** Optional controls that sit between the tabs and the panels. */
  controls?: ReactNode;
  /** Tab panels or other domain-owned manager content. */
  children: ReactNode;
  /** Optional footer content shared by extension managers. */
  footer?: ReactNode;
  className?: string;
}

/**
 * Structural shell for extension-management modals.
 *
 * It owns only the stable layout slots. MCP, Skills, and Plugins retain their
 * own tabs, data loading, filtering, and domain-specific panel content.
 */
export function ExtensionManagerLayout({
  tabs,
  controls,
  children,
  footer,
  className,
}: ExtensionManagerLayoutProps) {
  return (
    <div className={['extension-manager-layout', className].filter(Boolean).join(' ')}>
      <div className="extension-manager-layout__tabs">{tabs}</div>
      {controls ? <div className="extension-manager-layout__controls">{controls}</div> : null}
      <div className="extension-manager-layout__panels">{children}</div>
      {footer ? <div className="extension-manager-layout__footer">{footer}</div> : null}
    </div>
  );
}
