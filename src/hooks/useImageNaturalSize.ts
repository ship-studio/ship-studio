import { useEffect, useState } from 'react';

export interface ImageNaturalSize {
  width: number;
  height: number;
}

export type ImageNaturalSizeStatus = 'loading' | 'error' | 'unavailable' | null;

interface ImageSource {
  currentSrc?: string | null;
  naturalWidth?: number | null;
  naturalHeight?: number | null;
}

interface ResourceSizeState {
  identity: string;
  status: 'loading' | 'loaded' | 'error';
  size?: ImageNaturalSize;
}

/** Return an absolute, credential-free image URL that can be probed safely. */
export function safeImageResourceSrc(source: string | null | undefined): string | null {
  if (!source) return null;
  try {
    const url = new URL(source);
    if (
      (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'blob:') &&
      !url.username &&
      !url.password
    ) {
      return url.href;
    }
  } catch {
    // Do not resolve relative image sources against the app shell's origin.
  }
  return null;
}

/**
 * Use signature dimensions immediately, then refresh them from the original
 * currentSrc. The raster thumbnail is deliberately never consulted.
 */
export function useImageNaturalSize(
  source: ImageSource,
  selectionIdentity: string
): { size: ImageNaturalSize | null; status: ImageNaturalSizeStatus } {
  const imageUrl = safeImageResourceSrc(source.currentSrc);
  const identity = `${selectionIdentity}:${imageUrl ?? ''}`;
  const [resourceState, setResourceState] = useState<ResourceSizeState | null>(null);
  const signatureSize =
    typeof source.naturalWidth === 'number' &&
    Number.isSafeInteger(source.naturalWidth) &&
    source.naturalWidth > 0 &&
    typeof source.naturalHeight === 'number' &&
    Number.isSafeInteger(source.naturalHeight) &&
    source.naturalHeight > 0
      ? { width: source.naturalWidth, height: source.naturalHeight }
      : null;
  const currentResourceState = resourceState?.identity === identity ? resourceState : null;
  const resourceSize = currentResourceState?.status === 'loaded' ? currentResourceState.size : null;
  const size = resourceSize ?? signatureSize;
  const status: ImageNaturalSizeStatus = size
    ? null
    : !imageUrl
      ? 'unavailable'
      : currentResourceState?.status === 'error'
        ? 'error'
        : 'loading';

  useEffect(() => {
    if (!imageUrl) return;
    let active = true;
    const requestIdentity = identity;
    const image = new Image();
    const onLoad = () => {
      if (!active) return;
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0) {
        setResourceState({ identity: requestIdentity, status: 'loaded', size: { width, height } });
      } else {
        setResourceState({ identity: requestIdentity, status: 'error' });
      }
    };

    image.onload = onLoad;
    image.onerror = () => {
      if (active) setResourceState({ identity: requestIdentity, status: 'error' });
    };
    image.src = imageUrl;
    if (image.complete) onLoad();

    return () => {
      active = false;
      image.onload = null;
      image.onerror = null;
    };
  }, [identity, imageUrl]);

  return { size, status };
}
