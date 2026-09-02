import type { ReactNode } from 'react';
import { Spinner } from '../../primitives/Spinner';

export type ExtensionStateKind = 'loading' | 'empty' | 'error';

/** Props for loading, empty, and error states in extension-manager surfaces. */
export interface ExtensionStateProps {
  kind: ExtensionStateKind;
  children: ReactNode;
  className?: string;
  loadingLabel?: string;
}

/** Shared semantic loading, empty, and error surface for extension managers. */
export function ExtensionState({
  kind,
  children,
  className,
  loadingLabel = 'Loading',
}: ExtensionStateProps) {
  return (
    <div
      className={['extension-state', `extension-state--${kind}`, className]
        .filter(Boolean)
        .join(' ')}
      role={kind === 'error' ? 'alert' : undefined}
    >
      {kind === 'loading' ? (
        <Spinner className="extension-state__spinner" label={loadingLabel} />
      ) : null}
      <span>{children}</span>
    </div>
  );
}
