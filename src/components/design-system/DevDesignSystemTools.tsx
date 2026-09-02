import { DevIconGallery } from '@/components/icons/DevIconGallery';
import { DevDesignSystemLab } from './DevDesignSystemLab';

/** Hosts development-only design-system inspection tools outside production bundles. */
export function DevDesignSystemTools() {
  return (
    <>
      <DevIconGallery />
      <DevDesignSystemLab />
    </>
  );
}
