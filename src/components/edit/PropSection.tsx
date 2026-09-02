/**
 * Collapsible section wrapper for a group of controls. Native `<details>`/`<summary>`
 * so it's keyboard-accessible for free and its content stays in the DOM when
 * collapsed (the chevron rotates via CSS on `[open]`). Common sections start open;
 * the long-tail ones collapse to keep the panel scannable.
 */

import type { ReactNode } from 'react';
import { ChevronIcon } from '@/components/icons';

export function PropSection({
  title,
  defaultOpen,
  sectionId,
  children,
}: {
  title: string;
  defaultOpen: boolean;
  sectionId?: string;
  children: ReactNode;
}) {
  // NOTE: the <summary> itself MUST keep its default display. WebKit (Tauri) stops
  // treating a summary as the disclosure element when its display is overridden
  // (e.g. to flex), which hides it entirely while collapsed. So the flex layout
  // lives on an inner wrapper, not the summary.
  return (
    <details
      className={`ss-edit-panel__section${sectionId ? ` ss-edit-panel__section--${sectionId}` : ''}`}
      open={defaultOpen}
    >
      <summary className="ss-edit-panel__section-head">
        <span className="ss-edit-panel__section-row">
          <span className="ss-edit-panel__section-title">{title}</span>
          <ChevronIcon className="ss-edit-panel__section-chevron" />
        </span>
      </summary>
      <div className="ss-edit-panel__section-body">{children}</div>
    </details>
  );
}
