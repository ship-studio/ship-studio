/**
 * PluginsDropdown — left-cluster header dropdown that lists the plugin
 * manager plus every currently-loaded non-hosting plugin. Matches the
 * visual shape of `ToolbarDropdown` (canonical MenuButton trigger, menu body
 * styled like the Dropdown primitive) so both live together consistently.
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
 * aim at the ~22px icon. When no button exists (the plugin crashed and
 * rendered the error chip instead) the click toasts an explanation.
 *
 * Accounting: plugins that failed to load render as greyed rows, and a
 * footer notes how many hosting plugins live in the header toolbar — so
 * the dropdown's visible count always matches what's installed.
 *
 * @module components/PluginsDropdown
 */

import { useState, useRef, useCallback, type MouseEvent } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside';
import { ChevronIcon, PuzzleIcon } from '@/components/icons';
import { PluginSlot, PluginErrorChip } from './PluginSlot';
import { MenuButton } from '../primitives/MenuButton';
import type { LoadedPlugin, PluginFailure } from '../../hooks/usePlugins';
import type {
  PluginProjectData,
  PluginAppActions,
  PluginThemeData,
} from '../../contexts/PluginContext';

interface PluginsDropdownProps {
  plugins: LoadedPlugin[];
  /** Plugins that failed to load — rendered as greyed, non-actionable rows */
  failures?: PluginFailure[];
  /** Installed hosting plugins (vercel/…) render in the header toolbar, not here */
  hostingPluginCount?: number;
  pluginProject: PluginProjectData | null;
  pluginActions: PluginAppActions;
  pluginTheme: PluginThemeData;
  onOpenPluginManager: () => void;
}

export function PluginsDropdown({
  plugins,
  failures = [],
  hostingPluginCount = 0,
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
      <MenuButton
        expanded={isOpen}
        onClick={() => setIsOpen(!isOpen)}
        title="Plugins"
        data-education-id="plugins-dropdown"
        leftIcon={<PuzzleIcon size={16} />}
        aria-label="Plugins"
      >
        <ChevronIcon size={10} className={isOpen ? 'chevron-flipped' : undefined} />
      </MenuButton>

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
        {(plugins.length > 0 || failures.length > 0) && <div className="ss-dropdown__divider" />}
        {plugins.map((plugin) => (
          <PluginDropdownRow
            key={plugin.info.manifest.id}
            plugin={plugin}
            pluginProject={pluginProject}
            pluginActions={pluginActions}
            pluginTheme={pluginTheme}
          />
        ))}
        {failures.map((failure) => (
          <div
            key={failure.id ?? failure.name}
            className="plugin-dropdown-row plugin-dropdown-row--failed"
            role="menuitem"
            aria-disabled="true"
            onClick={() =>
              pluginActions.showToast(
                `${failure.name} is unavailable — it may have crashed. Check the plugin manager.`,
                'error'
              )
            }
          >
            <div className="plugin-dropdown-row-trigger">
              <PluginErrorChip pluginName={failure.name} compact detail={failure.reason} />
            </div>
            <span className="plugin-dropdown-row-label">{failure.name}</span>
          </div>
        ))}
        {plugins.length === 0 && failures.length === 0 && hostingPluginCount === 0 && (
          <div className="toolbar-dropdown-empty-hint">No plugins installed yet.</div>
        )}
        {hostingPluginCount > 0 && (
          <div className="plugins-dropdown-footer">
            {hostingPluginCount === 1
              ? '1 hosting plugin lives in the toolbar'
              : `${hostingPluginCount} hosting plugins live in the toolbar`}
          </div>
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
    const button = triggerRef.current?.querySelector('button');
    if (button) {
      button.click();
      return;
    }
    // No button rendered. A plugin with no toolbar slot at all (e.g. Sanity
    // CMS, whose button lives in the preview toolbar) is working as designed —
    // reporting it as crashed was a false alarm (issue #390).
    if (!plugin.module.slots?.toolbar) {
      pluginActions.showToast(
        `${plugin.info.manifest.name} doesn't add an action to this menu — look for its controls in the preview toolbar.`
      );
      return;
    }
    // The plugin declares a toolbar slot but rendered no button — it crashed
    // (error chip) or rendered nothing. Say so instead of ignoring the click.
    pluginActions.showToast(
      `${plugin.info.manifest.name} is unavailable — it may have crashed. Check the plugin manager.`,
      'error'
    );
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
