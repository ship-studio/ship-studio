import { useMemo, useState } from 'react';
import * as iconLibrary from './index';
import type { IconComponent } from './icon-base';
import '../../styles/components/icon-gallery.css';

function isIconComponent(value: unknown): value is IconComponent {
  return typeof value === 'object' && value !== null && 'iconMeta' in value;
}

/** Returns shared icon components in stable display-name order for the development gallery. */
export function getGalleryIcons(): IconComponent[] {
  return Object.values(iconLibrary)
    .filter(isIconComponent)
    .sort((a, b) => a.iconMeta.name.localeCompare(b.iconMeta.name));
}

/** Development-only visual index of the shared semantic icon library. */
export function IconGallery() {
  const [open, setOpen] = useState(true);
  const icons = useMemo(() => getGalleryIcons(), []);
  const enabled =
    import.meta.env.DEV && new URLSearchParams(window.location.search).get('iconGallery') === '1';

  if (!enabled || !open) return null;

  return (
    <aside className="icon-gallery" aria-label="Icon gallery">
      <header className="icon-gallery__header">
        <div>
          <strong>Icon gallery</strong>
          <span>{icons.length} shared icons</span>
        </div>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close icon gallery">
          Close
        </button>
      </header>
      <div className="icon-gallery__grid">
        {icons.map((Icon) => (
          <div className="icon-gallery__item" key={Icon.iconMeta.name}>
            <div className="icon-gallery__glyph">
              <Icon size={24} />
            </div>
            <span className="icon-gallery__name">{Icon.iconMeta.name}</span>
            <span className="icon-gallery__kind">{Icon.iconMeta.kind}</span>
            <span className="icon-gallery__source">{Icon.iconMeta.source}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}
