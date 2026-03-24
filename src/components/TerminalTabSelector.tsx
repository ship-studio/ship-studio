/**
 * TerminalTabSelector - dropdown for switching between terminal tabs.
 *
 * Replaces the horizontal tab bar with a compact dropdown that shows
 * the active tab title and lets users switch tabs, change agents,
 * add new tabs, and close tabs.
 *
 * @module components/TerminalTabSelector
 */

import { useState, useRef, useCallback } from 'react';
import { useClickOutside } from '../hooks/useClickOutside';
import { ChevronIcon, PlusIcon, CloseIcon, CheckIcon } from './icons';
import { ALL_AGENTS, TERMINAL, getAgentById } from '../lib/agent';
import type { TerminalTab } from '../hooks/useTerminalManagement';

interface TerminalTabSelectorProps {
  tabs: TerminalTab[];
  activeTabId: number;
  tabTitles: Map<number, string>;
  attentionTabs: Set<number>;
  maxTabs: number;
  onSelectTab: (tabId: number) => void;
  onAddTab: () => void;
  onCloseTab: (tabId: number) => void;
  onSwitchAgent: (tabId: number, agentId: string) => void;
}

export function TerminalTabSelector({
  tabs,
  activeTabId,
  tabTitles,
  attentionTabs,
  maxTabs,
  onSelectTab,
  onAddTab,
  onCloseTab,
  onSwitchAgent,
}: TerminalTabSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setIsOpen(false), []);
  useClickOutside(menuRef, closeMenu, isOpen);

  const activeIndex = tabs.findIndex((t) => t.id === activeTabId);
  const activeTab = tabs[activeIndex];
  const activeTitle = activeTab
    ? tabTitles.get(activeTab.id) || getAgentById(activeTab.agentId).displayName
    : 'Terminal';

  return (
    <div className="tab-selector" ref={menuRef}>
      <button
        className={`tab-selector-trigger ${isOpen ? 'open' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <span className="tab-selector-title">{activeTitle}</span>
        <span className="tab-selector-shortcut">
          <span className="tab-selector-cmd">&#8984;</span>
          {activeIndex + 1}
        </span>
        <ChevronIcon size={10} />
      </button>

      {isOpen && (
        <div className="tab-selector-menu">
          <div className="tab-selector-section-label">Tabs</div>
          {tabs.map((tab, index) => {
            const title = tabTitles.get(tab.id) || getAgentById(tab.agentId).displayName;
            const isActive = tab.id === activeTabId;
            const hasAttention = attentionTabs.has(tab.id);
            return (
              <div key={tab.id} className="tab-selector-item-row">
                <button
                  className={`tab-selector-item ${isActive ? 'active' : ''}`}
                  onClick={() => {
                    onSelectTab(tab.id);
                    setIsOpen(false);
                  }}
                >
                  <span className="tab-selector-item-left">
                    {hasAttention && <span className="tab-selector-attention-dot" />}
                    <span className="tab-selector-item-title">{title}</span>
                  </span>
                  {tabs.length > 1 && (
                    <span
                      className="tab-selector-close-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCloseTab(tab.id);
                        if (tabs.length <= 1) setIsOpen(false);
                      }}
                      title="Close tab"
                    >
                      <CloseIcon size={10} />
                    </span>
                  )}
                  <span className="tab-selector-item-shortcut">&#8984;{index + 1}</span>
                </button>
              </div>
            );
          })}

          {tabs.length < maxTabs && (
            <button
              className="tab-selector-item add"
              onClick={() => {
                onAddTab();
                setIsOpen(false);
              }}
            >
              <PlusIcon size={12} />
              <span>New tab</span>
              <span className="tab-selector-item-shortcut">&#8984;T</span>
            </button>
          )}

          <div className="tab-selector-divider" />
          <div className="tab-selector-section-label">Agent</div>
          {ALL_AGENTS.map((agent) => {
            const currentAgent = activeTab ? getAgentById(activeTab.agentId) : null;
            return (
              <button
                key={agent.id}
                className={`tab-selector-item ${agent.id === currentAgent?.id ? 'active' : ''}`}
                onClick={() => {
                  if (activeTab && agent.id !== activeTab.agentId) {
                    onSwitchAgent(activeTab.id, agent.id);
                  }
                  setIsOpen(false);
                }}
              >
                {agent.id === currentAgent?.id ? (
                  <CheckIcon size={12} />
                ) : (
                  <span style={{ width: 12 }} />
                )}
                <span>{agent.displayName}</span>
              </button>
            );
          })}
          <div className="tab-selector-divider" />
          <button
            className={`tab-selector-item ${TERMINAL.id === activeTab?.agentId ? 'active' : ''}`}
            onClick={() => {
              if (activeTab && TERMINAL.id !== activeTab.agentId) {
                onSwitchAgent(activeTab.id, TERMINAL.id);
              }
              setIsOpen(false);
            }}
          >
            {TERMINAL.id === activeTab?.agentId ? (
              <CheckIcon size={12} />
            ) : (
              <span style={{ width: 12 }} />
            )}
            <span>{TERMINAL.displayName}</span>
          </button>
        </div>
      )}
    </div>
  );
}
