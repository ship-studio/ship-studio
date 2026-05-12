/**
 * ToolbarDropdown - dropdown menu for terminal toolbar actions.
 *
 * Consolidates notification settings, skills, auto-accept, help,
 * and plugin actions into a single dropdown menu.
 *
 * @module components/ToolbarDropdown
 */

import { useState, useRef, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useClickOutside } from '../hooks/useClickOutside';
import {
  BellIcon,
  ZapIcon,
  PlugIcon,
  ShieldCheckIcon,
  HelpIcon,
  ChevronIcon,
  SettingsIcon,
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
  const [menuPosition, setMenuPosition] = useState<{ top: number; right: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setIsOpen(false), []);
  // useClickOutside checks `rootRef.current.contains(target)` — the menu is
  // portaled to <body>, so it's not a DOM descendant of rootRef. Wire the
  // menu node in via the `exclude` selector so clicks inside it don't
  // dismiss.
  useClickOutside(rootRef, closeMenu, isOpen, '.toolbar-dropdown-menu');

  /* Position the portaled menu under the button. Fixed positioning
     escapes ancestor `overflow: hidden` (this dropdown lives inside
     .terminal-pane which clips absolute children). Re-anchor on scroll
     + resize so the menu tracks the button through layout changes. */
  useLayoutEffect(() => {
    if (!isOpen) return;
    const anchor = () => {
      const btn = buttonRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      // Anchor by the button's RIGHT edge so the menu expands leftward.
      // The Agent Settings button sits at the right end of the terminal
      // toolbar — in focus mode (and on narrow windows) anchoring by the
      // left edge pushed the menu off-screen.
      setMenuPosition({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    };
    anchor();
    window.addEventListener('scroll', anchor, true);
    window.addEventListener('resize', anchor);
    return () => {
      window.removeEventListener('scroll', anchor, true);
      window.removeEventListener('resize', anchor);
    };
  }, [isOpen]);

  return (
    <div className="toolbar-dropdown-container" ref={rootRef}>
      <button
        ref={buttonRef}
        className={`toolbar-icon-btn ${isOpen ? 'is-open' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        title="Agent settings"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        data-education-id="toolbar-more"
      >
        <SettingsIcon size={12} />
        <span className="toolbar-btn-label">Agent Settings</span>
        <ChevronIcon size={10} className={isOpen ? 'chevron-flipped' : undefined} />
      </button>

      {isOpen &&
        menuPosition &&
        createPortal(
          <div
            ref={menuRef}
            className="toolbar-dropdown-menu toolbar-dropdown-menu-floating"
            style={{ top: menuPosition.top, right: menuPosition.right }}
          >
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
          </div>,
          document.body
        )}
    </div>
  );
}
