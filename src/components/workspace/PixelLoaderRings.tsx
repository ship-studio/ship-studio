import { PixelLoader, type PixelLoaderProps } from '../primitives/PixelLoader';

export type PixelLoaderRingsProps = Omit<PixelLoaderProps, 'variant'>;

/** Centre-out pixel rings used for active agent work in the workspace sidebar. */
export function PixelLoaderRings(props: PixelLoaderRingsProps) {
  return <PixelLoader {...props} variant="rings" />;
}
