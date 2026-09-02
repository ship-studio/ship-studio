import { lazy, Suspense } from 'react';

const IconGallery = import.meta.env.DEV
  ? lazy(() => import('./IconGallery').then(({ IconGallery }) => ({ default: IconGallery })))
  : null;

/** Returns whether the current development URL explicitly requests the icon gallery. */
export function isDevIconGalleryRequested(search: string): boolean {
  return import.meta.env.DEV && new URLSearchParams(search).get('iconGallery') === '1';
}

/** Lazily mounts the icon gallery when its development-only query gate is enabled. */
export function DevIconGallery() {
  if (!IconGallery || !isDevIconGalleryRequested(window.location.search)) return null;
  return (
    <Suspense fallback={null}>
      <IconGallery />
    </Suspense>
  );
}
