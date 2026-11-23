import { ElementLinkIcon, PinIcon } from '@/components/icons';
import { usePanelDock } from '../../contexts/PanelDockContext';
import type { ReactNode } from 'react';

function LinkedLayoutColumn({
  side,
  label,
  icon,
}: {
  side: string;
  label: string;
  icon: ReactNode;
}) {
  return (
    <section className="workspace-layout-menu__side">
      <div className="workspace-layout-menu__section">{side}</div>
      <div className="workspace-layout-menu__column">
        <div className="workspace-layout-menu__column-label-row">
          <span className="workspace-layout-menu__column-label">Column 1</span>
        </div>
        <div className="workspace-layout-menu__tile">
          <div className="workspace-layout-menu__panel-row">
            <span className="workspace-layout-menu__overlay-icon">{icon}</span>
            <span className="workspace-layout-menu__tile-name">{label}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Keep the saved arrangement and linked preview in one interruptible viewport. */
export function WorkspaceLayoutMenuSlides({ children }: { children: ReactNode }) {
  const { focusMode, singlePanelModeEnabled } = usePanelDock();

  return (
    <div className="workspace-layout-menu__slides" data-layout-slides="true">
      <div
        className={`workspace-layout-menu__slide-track${singlePanelModeEnabled ? ' is-linked' : ''}`}
        data-layout-active-slide={singlePanelModeEnabled ? 'linked' : 'saved'}
      >
        <div
          className="workspace-layout-menu__slide"
          data-layout-slide="saved"
          aria-hidden={singlePanelModeEnabled}
          inert={singlePanelModeEnabled}
        >
          {children}
        </div>
        <div
          className="workspace-layout-menu__slide"
          data-layout-slide="linked"
          aria-hidden={!singlePanelModeEnabled}
          inert={!singlePanelModeEnabled}
        >
          <div
            className="workspace-layout-menu__canvas"
            role="group"
            aria-label="Active linked layout"
          >
            <span className="workspace-layout-menu__scope-label">
              {focusMode ? 'Linked layout resumes after Focus' : 'Active linked layout'}
            </span>
            <LinkedLayoutColumn
              side="Left"
              label="Linked panels"
              icon={<ElementLinkIcon size={14} />}
            />
            <div className="workspace-layout-menu__column workspace-layout-menu__column--preview">
              <span className="workspace-layout-menu__preview-label">Preview</span>
            </div>
            <LinkedLayoutColumn side="Right" label="Editor" icon={<PinIcon size={14} />} />
            <span className="workspace-layout-menu__scope-label">
              Saved layout is available when unlinked
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
