/**
 * PluginsDropdown — left-cluster header dropdown that lists the plugin
 * manager plus every currently-loaded non-hosting plugin. Matches the
 * visual shape of `ToolbarDropdown` (toolbar-icon-btn trigger, menu body
 * styled like the Dropdown primitive) so both live-together consistently.
 *
 * NOT built on the Dropdown primitive (`primitives/Dropdown.tsx`) — the
 * primitive unmounts its menu children while closed, and this menu must
 * stay mounted (see below). If the primitive ever grows a `keepMounted`
 * mode, migrate this component to it.
 *
 * Mounting strategy: the menu is rendered *always* and hidden via
 * off-screen absolute positioning when closed (see `.is-hidden` in
 * terminal.css). Plugins like Webflow-to-Code render their Modal as an
 * inline sibling of the trigger button, so conditionally mounting the
 * menu would tear down the plugin subtree — and its open modal —
 * mid-interaction. `display:none` is avoided for the same reason: it
 * would cascade through the plugin's fixed-positioned modal. Staying
 * mounted preserves the plugin's internal state (e.g. `modalOpen`)
 * across dropdown open/close cycles.
 *
 * Row-click forwarding: each row has an onClick that finds and
 * programmatically clicks the plugin's own <button>, so users can hit
 * anywhere in the row (including the label text) instead of having to
 * aim at the ~22px icon.
 *
 * @module components/PluginsDropdown
 */

import { useState, useRef, useCallback, type MouseEvent } from 'react';
import { useClickOutside } from '../hooks/useClickOutside';
import { ChevronIcon, PuzzleIcon } from './icons';
import { PluginSlot } from './PluginSlot';
import type { LoadedPlugin } from '../hooks/usePlugins';
import type {
  PluginProjectData,
  PluginAppActions,
  PluginThemeData,
} from '../contexts/PluginContext';

interface PluginsDropdownProps {
  plugins: LoadedPlugin[];
  pluginProject: PluginProjectData | null;
  pluginActions: PluginAppActions;
  pluginTheme: PluginThemeData;
  onOpenPluginManager: () => void;
}

export function PluginsDropdown({
  plugins,
  pluginProject,
  pluginActions,
  pluginTheme,
  onOpenPluginManager,
}: PluginsDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setIsOpen(false), []);
  useClickOutside(menuRef, closeMenu, isOpen);

  return (
    <div className="toolbar-dropdown-container" ref={menuRef}>
      <button
        className={`toolbar-icon-btn ${isOpen ? 'is-open' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        title="Plugins"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        data-education-id="plugins-dropdown"
      >
        <PuzzleIcon size={12} />
        <span className="toolbar-btn-label">Plugins</span>
        <ChevronIcon size={10} className={isOpen ? 'chevron-flipped' : undefined} />
      </button>

      <div className={`plugins-dropdown-menu ${isOpen ? '' : 'is-hidden'}`} role="menu">
        <button
          className="toolbar-dropdown-item"
          onClick={() => {
            setIsOpen(false);
            onOpenPluginManager();
          }}
        >
          <PuzzleIcon size={14} />
          <span>Plugin Manager</span>
        </button>
        {plugins.length > 0 && <div className="ss-dropdown__divider" />}
        {plugins.map((plugin) => (
          <PluginDropdownRow
            key={plugin.info.manifest.id}
            plugin={plugin}
            pluginProject={pluginProject}
            pluginActions={pluginActions}
            pluginTheme={pluginTheme}
          />
        ))}
        {plugins.length === 0 && (
          <div className="toolbar-dropdown-empty-hint">No plugins installed yet.</div>
        )}
      </div>
    </div>
  );
}

/**
 * One row in the Plugins dropdown. The plugin's own toolbar slot
 * renders inside the trigger div — the row wrapper forwards clicks
 * anywhere in the row (e.g. on the label text) to the plugin's
 * <button> so users don't have to aim at the tiny icon.
 */
interface PluginDropdownRowProps {
  plugin: LoadedPlugin;
  pluginProject: PluginProjectData | null;
  pluginActions: PluginAppActions;
  pluginTheme: PluginThemeData;
}

function PluginDropdownRow({
  plugin,
  pluginProject,
  pluginActions,
  pluginTheme,
}: PluginDropdownRowProps) {
  const triggerRef = useRef<HTMLDivElement>(null);

  const handleRowClick = (e: MouseEvent<HTMLDivElement>) => {
    // Anything inside the plugin's own subtree (button, modal overlay,
    // modal body, etc.) handles itself. Forwarding from the row would
    // re-fire the button and, e.g., reopen a modal the plugin just
    // closed via its overlay click.
    if (triggerRef.current?.contains(e.target as Node)) return;
    // Click landed on the row wrapper (label text, empty space) —
    // forward it to the plugin's button so users can hit anywhere in
    // the row instead of aiming at the ~22px icon.
    triggerRef.current?.querySelector('button')?.click();
  };

  return (
    <div
      className="plugin-dropdown-row"
      title={plugin.info.manifest.description}
      onClick={handleRowClick}
      role="menuitem"
    >
      <div ref={triggerRef} className="plugin-dropdown-row-trigger">
        <PluginSlot
          name="toolbar"
          plugins={[plugin]}
          project={pluginProject}
          actions={pluginActions}
          theme={pluginTheme}
        />
      </div>
      <span className="plugin-dropdown-row-label">{plugin.info.manifest.name}</span>
    </div>
  );
}
