/**
 * ToolbarDropdown - dropdown menu for terminal toolbar actions.
 *
 * Consolidates notification settings, skills, auto-accept, help,
 * and plugin actions into a single dropdown menu.
 *
 * Built on the Dropdown primitive in `portal` mode: the trigger lives in
 * .terminal-pane (overflow: hidden), so the menu renders fixed in a body
 * portal and re-anchors on scroll/resize. `align="right"` anchors by the
 * trigger's right edge — the Agent Settings button sits at the right end
 * of the terminal toolbar, so a left anchor would push the menu off-screen
 * in focus mode / narrow windows.
 *
 * @module components/ToolbarDropdown
 */

import {
  BellIcon,
  ZapIcon,
  PlugIcon,
  ShieldCheckIcon,
  HelpIcon,
  ChevronIcon,
  SettingsIcon,
} from '../icons';
import { Dropdown, DropdownItem, DropdownDivider } from '../primitives/Dropdown';
import { PluginSlot } from '../plugins/PluginSlot';
import type { LoadedPlugin } from '../../hooks/usePlugins';
import type {
  PluginProjectData,
  PluginAppActions,
  PluginThemeData,
} from '../../contexts/PluginContext';
import type { AgentConfig } from '../../lib/agent';

interface ToolbarDropdownProps {
  agent: AgentConfig;
  autoAcceptMode: boolean;
  onNotificationSettings: () => void;
  onSkills: () => void;
  onMcp: () => void;
  onAutoAcceptToggle: () => void;
  onHelp: () => void;
  terminalPlugins: LoadedPlugin[];
  pluginProject: PluginProjectData | null;
  pluginActions: PluginAppActions;
  pluginTheme: PluginThemeData;
}

export function ToolbarDropdown({
  agent,
  autoAcceptMode,
  onNotificationSettings,
  onSkills,
  onMcp,
  onAutoAcceptToggle,
  onHelp,
  terminalPlugins,
  pluginProject,
  pluginActions,
  pluginTheme,
}: ToolbarDropdownProps) {
  return (
    <Dropdown
      portal
      align="right"
      menuClassName="toolbar-dropdown-menu"
      trigger={(p) => (
        <button
          className={`toolbar-icon-btn ${p['aria-expanded'] ? 'is-open' : ''}`}
          title="Agent settings"
          data-education-id="toolbar-more"
          {...p}
        >
          <SettingsIcon size={12} />
          <span className="toolbar-btn-label">Agent Settings</span>
          <ChevronIcon size={10} className={p['aria-expanded'] ? 'chevron-flipped' : undefined} />
        </button>
      )}
    >
      <DropdownItem icon={<BellIcon size={14} />} onSelect={onNotificationSettings}>
        <span data-education-id="notification-settings">Notification sounds</span>
      </DropdownItem>
      {agent.supportsSkills && (
        <DropdownItem icon={<ZapIcon size={14} />} onSelect={onSkills}>
          <span data-education-id="skills-manager">Skills</span>
        </DropdownItem>
      )}
      {agent.supportsMcp && (
        <DropdownItem icon={<PlugIcon size={14} />} onSelect={onMcp}>
          <span data-education-id="mcp-manager">MCP Servers</span>
        </DropdownItem>
      )}
      {agent.autoAcceptFlag && (
        // Selecting closes the menu — matches the pre-primitive handler,
        // which called setIsOpen(false) before toggling.
        <DropdownItem
          icon={<ShieldCheckIcon size={14} />}
          active={autoAcceptMode}
          onSelect={onAutoAcceptToggle}
        >
          <span>Auto-accept</span>
          <span className={`toggle-indicator ${autoAcceptMode ? 'on' : 'off'}`}>
            {autoAcceptMode ? 'ON' : 'OFF'}
          </span>
        </DropdownItem>
      )}
      {terminalPlugins.length > 0 && (
        <>
          <DropdownDivider />
          <PluginSlot
            name="terminal"
            plugins={terminalPlugins}
            project={pluginProject}
            actions={pluginActions}
            theme={pluginTheme}
          />
        </>
      )}
      <DropdownDivider />
      <DropdownItem icon={<HelpIcon size={14} />} onSelect={onHelp}>
        <span data-education-id="help-commands">Help &amp; Commands</span>
      </DropdownItem>
    </Dropdown>
  );
}
