/** Shared dockable panel header used by the workspace panels. */

import type { ReactNode } from 'react';
import { CloseIcon, PinIcon } from '@/components/icons';
import { IconButton } from '../primitives/IconButton';
import { ToggleButton } from '../primitives/ToggleButton';

interface DockablePanelHeaderProps {
  title: string;
  pinned?: boolean;
  onTogglePin?: () => void;
  onClose?: () => void;
  pinTitle?: { pinned: string; unpinned: string };
  closeTitle?: string;
  children?: ReactNode;
}

/** Workspace panel title, optional center content, pin, and close controls. */
export function DockablePanelHeader({
  title,
  pinned = false,
  onTogglePin,
  onClose,
  pinTitle = { pinned: 'Unpin — float over the workspace', unpinned: 'Pin to the window' },
  closeTitle = `Close ${title} panel`,
  children,
}: DockablePanelHeaderProps) {
  return (
    <div className="ss-tree-panel__header" data-dockable-drag-handle>
      <span className="ss-tree-panel__title workspace-panel-title">{title}</span>
      {children}
      {onTogglePin && (
        <ToggleButton
          variant="ghost"
          size="compact"
          className="button--icon-only panel-pin-toggle"
          onClick={onTogglePin}
          title={pinned ? pinTitle.pinned : pinTitle.unpinned}
          aria-label={pinned ? `Unpin ${title} panel` : `Pin ${title} panel to the window`}
          pressed={pinned}
          leftIcon={<PinIcon size={13} />}
        />
      )}
      {onClose && (
        <IconButton
          variant="ghost"
          size="compact"
          onClick={onClose}
          title={closeTitle}
          aria-label={closeTitle}
          icon={<CloseIcon size={14} />}
        />
      )}
    </div>
  );
}
