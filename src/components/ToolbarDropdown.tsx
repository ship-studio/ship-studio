/**
 * ToolbarDropdown - dropdown menu for terminal toolbar actions.
 *
 * Consolidates notification settings, skills, auto-accept, help,
 * and plugin actions into a single dropdown menu.
 *
 * @module components/ToolbarDropdown
 */

import { useState, useRef, useCallback } from 'react';
import { useClickOutside } from '../hooks/useClickOutside';
import {
  MoreHorizontalIcon,
  BellIcon,
  ZapIcon,
  PlugIcon,
  ShieldCheckIcon,
  HelpIcon,
} from './icons';
import { PluginSlot } from './PluginSlot';
import type { LoadedPlugin } from '../hooks/usePlugins';
import type {
  PluginProjectData,
  PluginAppActions,
  PluginThemeData,
} from '../contexts/PluginContext';
import type { AgentConfig } from '../lib/agent';

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
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setIsOpen(false), []);
  useClickOutside(menuRef, closeMenu, isOpen);

  return (
    <div className="toolbar-dropdown-container" ref={menuRef}>
      <button
        className={`workspace-tab icon-only ${isOpen ? 'active' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        title="More options"
        data-education-id="toolbar-more"
      >
        <MoreHorizontalIcon size={12} />
      </button>

      {isOpen && (
        <div className="toolbar-dropdown-menu">
          <button
            className="toolbar-dropdown-item"
            data-education-id="notification-settings"
            onClick={() => {
              setIsOpen(false);
              onNotificationSettings();
            }}
          >
            <BellIcon size={14} />
            <span>Notification sounds</span>
          </button>
          {agent.supportsSkills && (
            <button
              className="toolbar-dropdown-item"
              data-education-id="skills-manager"
              onClick={() => {
                setIsOpen(false);
                onSkills();
              }}
            >
              <ZapIcon size={14} />
              <span>Skills</span>
            </button>
          )}
          {agent.supportsMcp && (
            <button
              className="toolbar-dropdown-item"
              onClick={() => {
                setIsOpen(false);
                onMcp();
              }}
              data-education-id="mcp-manager"
            >
              <PlugIcon size={14} />
              <span>MCP Servers</span>
            </button>
          )}
          {agent.autoAcceptFlag && (
            <button
              className={`toolbar-dropdown-item ${autoAcceptMode ? 'auto-accept-on' : ''}`}
              onClick={() => {
                setIsOpen(false);
                onAutoAcceptToggle();
              }}
            >
              <ShieldCheckIcon size={14} />
              <span>Auto-accept</span>
              <span className={`toggle-indicator ${autoAcceptMode ? 'on' : 'off'}`}>
                {autoAcceptMode ? 'ON' : 'OFF'}
              </span>
            </button>
          )}
          {terminalPlugins.length > 0 && (
            <>
              <div className="toolbar-dropdown-divider" />
              <PluginSlot
                name="terminal"
                plugins={terminalPlugins}
                project={pluginProject}
                actions={pluginActions}
                theme={pluginTheme}
              />
            </>
          )}
          <div className="toolbar-dropdown-divider" />
          <button
            className="toolbar-dropdown-item"
            data-education-id="help-commands"
            onClick={() => {
              setIsOpen(false);
              onHelp();
            }}
          >
            <HelpIcon size={14} />
            <span>Help & Commands</span>
          </button>
        </div>
      )}
    </div>
  );
}
