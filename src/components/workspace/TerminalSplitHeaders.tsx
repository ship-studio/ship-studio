import { getAgentById } from '../../lib/agent';
import { ChevronIcon, CloseIcon } from '../icons/common';
import { PlusIcon } from '../icons/utility';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import type { TerminalTab } from '../../hooks/useTerminalManagement';

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
  // Reserve a 4px gutter on any side that abuts a drag handle so the
  // 8px-wide handle (centered on the boundary) sits in clean space rather
  // than overlapping the header chrome.
  const style = {
    left: leftAbutsHandle ? `calc(${leftPct}% + 4px)` : `${leftPct}%`,
    right: rightAbutsHandle ? `calc(${rightPct}% + 4px)` : `${rightPct}%`,
  };

  return (
    <div className="terminal-split-pane-header" style={style} data-pane-idx={paneIndex}>
      {/* Portal mode: the header lives inside the overflow-clipped terminal
          area, so the menu renders fixed in a body portal. Default left
          alignment keeps the menu under the left-aligned pane label rather
          than drifting right. */}
      <Dropdown
        portal
        menuClassName="toolbar-dropdown-menu"
        trigger={(p) => (
          <button
            type="button"
            className={`toolbar-icon-btn terminal-split-pane-trigger ${p['aria-expanded'] ? 'is-open' : ''}`}
            {...p}
          >
            <span className="terminal-split-pane-name">{label}</span>
            <ChevronIcon size={10} className={p['aria-expanded'] ? 'chevron-flipped' : undefined} />
          </button>
        )}
      >
        {tabs.map((t) => {
          const isCurrent = t.id === tabId;
          const inOtherPane = !isCurrent && assignedTabIds.includes(t.id);
          const itemLabel = tabTitles.get(t.id) || getAgentById(t.agentId).displayName;
          return (
            <DropdownItem
              key={t.id}
              active={isCurrent}
              onSelect={() => onSelectTab(paneIndex, t.id)}
            >
              <span>{itemLabel}</span>
              {inOtherPane && <span className="toggle-indicator off">SWAP</span>}
              {isCurrent && <span className="toggle-indicator on">ON</span>}
            </DropdownItem>
          );
        })}
      </Dropdown>
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
    </div>
  );
}
