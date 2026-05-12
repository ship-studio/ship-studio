import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useClickOutside } from '../hooks/useClickOutside';
import { getAgentById } from '../lib/agent';
import { ChevronIcon, CloseIcon } from './icons/common';
import { PlusIcon } from './icons/utility';
import type { TerminalTab } from '../hooks/useTerminalManagement';

interface TerminalSplitHeadersProps {
  panes: number[];
  /** Width of each pane as a percentage of container; sums to 100. */
  sizes: number[];
  tabs: TerminalTab[];
  tabTitles: Map<number, string>;
  onSelectTab: (paneIndex: number, tabId: number) => void;
  onRemovePane: (paneIndex: number) => void;
  onAddPane: () => void;
  canAddPane: boolean;
}

export function TerminalSplitHeaders({
  panes,
  sizes,
  tabs,
  tabTitles,
  onSelectTab,
  onRemovePane,
  onAddPane,
  canAddPane,
}: TerminalSplitHeadersProps) {
  const labelFor = (tabId: number): string => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return 'Unknown';
    return tabTitles.get(tab.id) || getAgentById(tab.agentId).displayName;
  };

  // Pre-compute cumulative left+right percentages for each pane so the
  // last pane's right edge lands at exactly 100% (no rounding drift).
  // Carry whether each side abuts a drag handle so the consumer can leave
  // a 4px gutter exactly where the 8px handle sits centered.
  const n = panes.length;
  const positions = panes.map((_, i) => ({
    leftPct: sizes.slice(0, i).reduce((a, b) => a + b, 0),
    rightPct: sizes.slice(i + 1).reduce((a, b) => a + b, 0),
    leftAbutsHandle: i > 0,
    rightAbutsHandle: i < n - 1,
  }));

  return (
    <div className="terminal-split-headers">
      {panes.map((tabId, paneIdx) => (
        <PaneHeader
          key={paneIdx}
          paneIndex={paneIdx}
          leftPct={positions[paneIdx].leftPct}
          rightPct={positions[paneIdx].rightPct}
          leftAbutsHandle={positions[paneIdx].leftAbutsHandle}
          rightAbutsHandle={positions[paneIdx].rightAbutsHandle}
          tabId={tabId}
          label={labelFor(tabId)}
          tabs={tabs}
          tabTitles={tabTitles}
          assignedTabIds={panes}
          onSelectTab={onSelectTab}
          onRemovePane={onRemovePane}
          showAddButton={canAddPane && paneIdx === panes.length - 1}
          onAddPane={onAddPane}
        />
      ))}
    </div>
  );
}

interface PaneHeaderProps {
  paneIndex: number;
  leftPct: number;
  rightPct: number;
  leftAbutsHandle: boolean;
  rightAbutsHandle: boolean;
  tabId: number;
  label: string;
  tabs: TerminalTab[];
  tabTitles: Map<number, string>;
  assignedTabIds: number[];
  onSelectTab: (paneIndex: number, tabId: number) => void;
  onRemovePane: (paneIndex: number) => void;
  showAddButton: boolean;
  onAddPane: () => void;
}

function PaneHeader({
  paneIndex,
  leftPct,
  rightPct,
  leftAbutsHandle,
  rightAbutsHandle,
  tabId,
  label,
  tabs,
  tabTitles,
  assignedTabIds,
  onSelectTab,
  onRemovePane,
  showAddButton,
  onAddPane,
}: PaneHeaderProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const closeMenu = useCallback(() => setIsOpen(false), []);
  useClickOutside(rootRef, closeMenu, isOpen, '.toolbar-dropdown-menu');

  // Anchor the portaled menu under the trigger. Anchor by LEFT edge —
  // pane labels are left-aligned within each pane column, so left anchor
  // keeps the menu under the label rather than drifting right.
  useLayoutEffect(() => {
    if (!isOpen) return;
    const anchor = () => {
      const btn = buttonRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      setMenuPosition({ top: rect.bottom + 6, left: rect.left });
    };
    anchor();
    window.addEventListener('scroll', anchor, true);
    window.addEventListener('resize', anchor);
    return () => {
      window.removeEventListener('scroll', anchor, true);
      window.removeEventListener('resize', anchor);
    };
  }, [isOpen]);

  // Reserve a 4px gutter on any side that abuts a drag handle so the
  // 8px-wide handle (centered on the boundary) sits in clean space rather
  // than overlapping the header chrome.
  const style = {
    left: leftAbutsHandle ? `calc(${leftPct}% + 4px)` : `${leftPct}%`,
    right: rightAbutsHandle ? `calc(${rightPct}% + 4px)` : `${rightPct}%`,
  };

  return (
    <div
      className="terminal-split-pane-header"
      style={style}
      ref={rootRef}
      data-pane-idx={paneIndex}
    >
      <button
        ref={buttonRef}
        type="button"
        className={`toolbar-icon-btn terminal-split-pane-trigger ${isOpen ? 'is-open' : ''}`}
        onClick={() => setIsOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <span className="terminal-split-pane-name">{label}</span>
        <ChevronIcon size={10} className={isOpen ? 'chevron-flipped' : undefined} />
      </button>
      <div className="terminal-split-pane-actions">
        {showAddButton && (
          <button
            type="button"
            className="toolbar-icon-btn terminal-split-pane-iconbtn"
            onClick={onAddPane}
            title="Add another agent pane"
            aria-label="Add agent pane"
          >
            <PlusIcon size={12} />
          </button>
        )}
        <button
          type="button"
          className="toolbar-icon-btn terminal-split-pane-iconbtn"
          onClick={() => onRemovePane(paneIndex)}
          title="Remove this pane"
          aria-label="Remove pane"
        >
          <CloseIcon size={12} />
        </button>
      </div>
      {isOpen &&
        menuPosition &&
        createPortal(
          <div
            className="toolbar-dropdown-menu toolbar-dropdown-menu-floating"
            style={{ top: menuPosition.top, left: menuPosition.left }}
            role="menu"
          >
            {tabs.map((t) => {
              const isCurrent = t.id === tabId;
              const inOtherPane = !isCurrent && assignedTabIds.includes(t.id);
              const itemLabel = tabTitles.get(t.id) || getAgentById(t.agentId).displayName;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="menuitem"
                  className="toolbar-dropdown-item"
                  onClick={() => {
                    onSelectTab(paneIndex, t.id);
                    setIsOpen(false);
                  }}
                >
                  <span>{itemLabel}</span>
                  {inOtherPane && <span className="toggle-indicator off">SWAP</span>}
                  {isCurrent && <span className="toggle-indicator on">ON</span>}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </div>
  );
}
