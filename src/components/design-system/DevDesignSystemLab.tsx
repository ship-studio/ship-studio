import { lazy, Suspense } from 'react';

const DesignSystemLab = import.meta.env.DEV
  ? lazy(() =>
      import('./DesignSystemLab').then(({ DesignSystemLab: Lab }) => ({
        default: Lab,
      }))
    )
  : null;

/** Returns whether the current development URL explicitly requests the primitive lab. */
export function isDevDesignSystemLabRequested(search: string): boolean {
  return import.meta.env.DEV && new URLSearchParams(search).get('designSystemLab') === '1';
}

/** Lazily mounts the primitive lab when its development-only query gate is enabled. */
export function DevDesignSystemLab() {
  if (!DesignSystemLab || !isDevDesignSystemLabRequested(window.location.search)) return null;

  return (
    <Suspense fallback={null}>
      <DesignSystemLab />
    </Suspense>
  );
}
