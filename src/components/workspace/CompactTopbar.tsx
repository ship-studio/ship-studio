/**
 * Compact workspace top bar.
 *
 * Self-contained. Layout uses **inline styles** (not CSS classes) so no
 * stylesheet cascade / HMR caching / specificity quirk can prevent the right
 * cluster from sitting at the right edge of the window. The only thing CSS
 * classes are used for here is hover/active state on the buttons.
 *
 * @module components/CompactTopbar
 */

import { useCallback, useState, type CSSProperties } from 'react';
import { PinIcon, ChevronIcon } from '../icons';
import { useOpenPalette } from '../CommandPalette/paletteContext';
import { setAlwaysOnTop } from '../../lib/window';
import { logger } from '../../lib/logger';
import type { PinnedProjectRow } from '../../hooks/usePinnedProjects';

interface Props {
  projectLabel: string;
  hasDevServer: boolean;
  switchableProjects: PinnedProjectRow[];
  onSelectProject: (projectPath: string) => void;
  onGoHome: () => void;
}

// React's CSSProperties doesn't include the `WebkitAppRegion` Tauri/Electron
// drag annotation. Extend locally so we avoid the stringified-key cast.
type Style = CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' };

// Inline styles — authoritative for layout. Kept here so CSS can't fight us.
const topbarStyle: Style = {
  display: 'flex',
  alignItems: 'center',
  width: '100vw',
  height: 36,
  boxSizing: 'border-box',
  paddingLeft: 78, // reserves space under the macOS traffic lights
  paddingRight: 8,
  background: 'var(--bg-secondary)',
  borderBottom: '1px solid var(--border)',
  flexShrink: 0,
  userSelect: 'none',
  WebkitAppRegion: 'drag',
};

const spacerStyle: CSSProperties = {
  flex: '1 1 auto', // grows to fill, pushes right cluster to the edge
  alignSelf: 'stretch',
};

const rightStyle: Style = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  flex: '0 0 auto',
  WebkitAppRegion: 'no-drag',
};

const iconBtnStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  padding: 0,
  background: 'transparent',
  border: '1px solid transparent',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-muted)',
  cursor: 'pointer',
};

const paletteBtnStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: 24,
  padding: '0 8px',
  background: 'var(--bg-tertiary)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-secondary)',
  fontSize: 11,
  fontFamily: 'var(--font-mono, monospace)',
  letterSpacing: '0.4px',
  cursor: 'pointer',
};

const projectBtnStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 24,
  maxWidth: 220,
  padding: '0 8px',
  background: 'var(--bg-tertiary)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-primary)',
  fontSize: 11,
  fontWeight: 500,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const pickerWrapperStyle: CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
};

const dotStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 20,
  height: 20,
};

const dotInnerStyle: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: 'var(--success)',
};

export function CompactTopbar({
  projectLabel,
  hasDevServer,
  switchableProjects,
  onSelectProject,
  onGoHome,
}: Props) {
  const openPalette = useOpenPalette();
  const openProjectPalette = useCallback(() => openPalette({ tab: 'project' }), [openPalette]);
  const openAllPalette = useCallback(() => openPalette(), [openPalette]);

  const [isPinned, setIsPinned] = useState(false);
  const togglePin = useCallback(() => {
    const next = !isPinned;
    setIsPinned(next);
    setAlwaysOnTop(next).catch((error) => {
      logger.error('Failed to toggle always on top', { error });
      setIsPinned(!next);
    });
  }, [isPinned]);

  // Hover state for the project-switch menu. Inline styles win specificity
  // over :hover CSS selectors, so we manage it in React state instead.
  const [menuOpen, setMenuOpen] = useState(false);

  const pinStyle: CSSProperties = isPinned
    ? {
        ...iconBtnStyle,
        color: 'var(--accent)',
        background: 'rgba(45, 164, 157, 0.15)',
        borderColor: 'rgba(45, 164, 157, 0.3)',
      }
    : iconBtnStyle;

  return (
    <div style={topbarStyle}>
      <div style={spacerStyle} aria-hidden="true" />
      <div style={rightStyle}>
        {hasDevServer && (
          <span style={dotStyle} aria-label="Dev server running">
            <span style={dotInnerStyle} />
          </span>
        )}
        <button
          type="button"
          style={pinStyle}
          onClick={togglePin}
          aria-pressed={isPinned}
          title={isPinned ? 'Unpin window' : 'Pin window on top'}
          aria-label={isPinned ? 'Unpin window' : 'Pin window on top'}
        >
          <PinIcon size={12} />
        </button>
        <button
          type="button"
          style={paletteBtnStyle}
          onClick={openAllPalette}
          title="Open command palette"
          aria-label="Open command palette"
        >
          ⌘K
        </button>
        <div
          style={pickerWrapperStyle}
          onMouseEnter={() => setMenuOpen(true)}
          onMouseLeave={() => setMenuOpen(false)}
        >
          <button
            type="button"
            style={projectBtnStyle}
            onClick={openProjectPalette}
            title={`Switch project (currently ${projectLabel})`}
            aria-label={`Switch project (currently ${projectLabel})`}
          >
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 180,
              }}
            >
              {projectLabel}
            </span>
            <ChevronIcon size={10} />
          </button>
          {menuOpen && switchableProjects.length > 0 && (
            <div
              role="menu"
              className="compact-topbar-project-menu"
              style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                right: 0,
                minWidth: 180,
                maxHeight: 240,
                overflowY: 'auto',
                padding: 4,
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                boxShadow: 'var(--shadow-md)',
                zIndex: 100,
              }}
            >
              <button type="button" className="compact-topbar-project-menu-item" onClick={onGoHome}>
                Home
              </button>
              {switchableProjects.map((row) => (
                <button
                  key={row.projectPath}
                  type="button"
                  className="compact-topbar-project-menu-item"
                  onClick={() => onSelectProject(row.projectPath)}
                >
                  {row.fallbackName}
                </button>
              ))}
              <div
                style={{
                  height: 1,
                  background: 'var(--border)',
                  margin: '4px 2px',
                }}
              />
              <button
                type="button"
                className="compact-topbar-project-menu-item is-subtle"
                onClick={openProjectPalette}
              >
                All projects…
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
