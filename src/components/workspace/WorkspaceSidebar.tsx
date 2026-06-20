import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { SearchIcon, ChevronIcon, ResetIcon, LayersIcon } from '../icons';
import { Button } from '../primitives/Button';
import { BrowserDropdown } from '../preview/BrowserDropdown';
import { useOpenPalette } from '../CommandPalette/paletteContext';
import { ALL_AGENTS, TERMINAL, getAgentById, type AgentConfig } from '../../lib/agent';
import type { TerminalTab } from '../../hooks/useTerminalManagement';
import type { PinnedProjectRow } from '../../hooks/usePinnedProjects';
import { useActiveAccount } from '../../hooks/useActiveAccount';
import { useCommands } from '../../commands/useCommands';
import '../../styles/features/account-select.css';
import {
  sessionRegistry,
  type SessionSnapshot,
  type SessionTerminalTab,
  type TabStatus,
} from '../../lib/sessionRegistry';

type SectionId = 'agents' | 'terminals' | 'commands';
type GroupId = 'pinned' | 'projects';

interface SidebarItem {
  key: string;
  label: string;
  dotState: 'idle' | 'active' | 'thinking' | 'attention' | 'muted';
  onSelect?: () => void;
  onClose?: () => void;
  isActive?: boolean;
  meta?: string;
  /** Optional inline action button (e.g. restart) rendered before the close
   *  button. Not shown when `actionBusy` is true — pair it with a meta value
   *  like "restarting" so the row still communicates activity. */
  onAction?: () => void;
  actionIcon?: ReactNode;
  actionLabel?: string;
  actionBusy?: boolean;
  /** Optional trailing element rendered after the action button (before the
   *  close button). Used by the Dev server row to host the BrowserDropdown
   *  icon — click opens default browser, hover reveals a picker. */
  trailing?: ReactNode;
  /** Commit a manual rename. When provided, double-clicking the row label
   *  switches to an inline `<input>`; pressing Enter or blurring calls this
   *  with the new (trimmed) value. Empty string clears the custom title. */
  onRename?: (newName: string) => void;
}

interface Props {
  // Home / navigation
  isHomeActive: boolean;
  onGoHome: () => void;
  onOpenProjectPicker: () => void;

  // Projects
  /** Pinned projects (in pin order). Have live registry data. */
  projects: PinnedProjectRow[];
  currentProjectPath: string | null;
  currentProjectName: string | null;
  onSelectProject: (projectPath: string) => void;
  /** Close an active session: stop its dev server, tear down the registry
   *  entry, and (if it was the current project) route back to home. Called
   *  by the per-row close button. */
  onCloseProject?: (projectPath: string) => void;
  /**
   * Switch to a non-current project and focus a specific tab (by session id)
   * once the restore completes. The caller is responsible for persisting
   * the target `activeTabIndex` to backend before invoking the project open.
   */
  onSelectProjectTab?: (projectPath: string, tabSessionId: string) => void;

  // Terminal tabs (scoped to current project)
  terminalTabs: TerminalTab[];
  activeTerminalTab: number;
  tabTitles: Map<number, string>;
  attentionTabs: Set<number>;
  maxTabs: number;
  onSelectTab: (id: number) => void;
  onAddTab: (agentId?: string) => void;
  onCloseTab: (id: number) => void;
  /** Commit a manual rename of a terminal tab. Empty string clears the
   *  custom title so the row falls back to the PTY-emitted name. */
  onRenameTab?: (id: number, name: string) => void;

  // Dev server
  hasDevServer: boolean;
  isRestartingDevServer: boolean;
  devServerRunning: boolean;
  onOpenDevServerLogs?: () => void;
  /** Restart the dev server for the current project. When provided, the
   *  Commands → Dev server row renders a refresh icon-button that fires
   *  this handler (disabled while `isRestartingDevServer` is true). */
  onRestartDevServer?: () => void;
  /** URL of the current project's dev server (e.g. `http://localhost:3000`).
   *  When set, the Commands → Dev server row shows an inline "open in
   *  browser" icon next to the restart button. Click opens the default
   *  browser; hover reveals a picker of installed browsers. */
  devServerUrl?: string;
  /** Predicate: is a dev server currently tracked for the given project path?
   *  Used for background (non-current) project rows so their Commands section
   *  can reflect the live state. Evaluated on each render. */
  isProjectDevServerRunning?: (projectPath: string) => boolean;

  /** Open the "Switch Workspace" picker. When omitted, the footer button
   *  showing the active Workspace is not rendered. */
  onSwitchAccount?: () => void;
}

const SECTION_STORAGE_KEY = 'ship-studio:workspace-sidebar:collapsed';
const PROJECT_EXPAND_STORAGE_KEY = 'ship-studio:workspace-sidebar:expanded-projects';

function readCollapsed(): Record<SectionId, boolean> {
  try {
    const raw = localStorage.getItem(SECTION_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Record<SectionId, boolean>;
  } catch {
    // ignore
  }
  return { agents: false, terminals: false, commands: false };
}

function writeCollapsed(state: Record<SectionId, boolean>) {
  try {
    localStorage.setItem(SECTION_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

function readProjectExpanded(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(PROJECT_EXPAND_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Record<string, boolean>;
  } catch {
    // ignore
  }
  return {};
}

function writeProjectExpanded(state: Record<string, boolean>) {
  try {
    localStorage.setItem(PROJECT_EXPAND_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

function formatDevServerLabel(url: string | undefined): string {
  if (!url) return 'Dev server';
  try {
    return new URL(url).host;
  } catch {
    return 'Dev server';
  }
}

function projectInitials(name: string): string {
  const cleaned = name.trim();
  if (!cleaned) return '··';
  const parts = cleaned.split(/[\s\-_]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
}

/**
 * Single source of truth for agent/terminal row dots. Used identically by
 * current-project rows and background-project rows so the sidebar speaks
 * one language regardless of which project has focus.
 *
 * Rules (highest priority first):
 *   - tab has attention flag               → `attention` (amber pulse)
 *   - status === 'crashed'                 → `attention` (amber; TODO: red)
 *   - status === 'exited'                  → `muted` (grey, dimmed)
 *   - status === 'thinking'                → `thinking` (green; dot spins)
 *   - status === 'waiting'                 → `active` (green; agent busy)
 *   - status === 'running' | 'starting'    → `active` (green; PTY alive)
 *   - no status yet (freshly-created tab)  → `active`
 *
 * `isActive` (selected tab) no longer influences the dot — a non-selected
 * but running tab is still green. Selection styling is handled by the row
 * background.
 */
function tabDotState(tab: { attention?: boolean; status?: TabStatus }): SidebarItem['dotState'] {
  if (tab.attention) return 'attention';
  if (tab.status === 'crashed') return 'attention';
  if (tab.status === 'exited') return 'muted';
  if (tab.status === 'thinking') return 'thinking';
  return 'active';
}

/**
 * Project-row dot — now driven by the tabs themselves (authoritative)
 * instead of the registry's `lastAgentStatus` (which was "last status
 * anybody posted" and got stuck on `waiting`). Priority:
 *   - any tab attention or crash → attention
 *   - session error               → attention
 *   - session inactive/suspended  → muted
 *   - any tab running             → active
 *   - otherwise                   → muted
 */
function projectDotState(
  row: PinnedProjectRow,
  tabs: ReadonlyArray<SessionTerminalTab> | undefined
): SidebarItem['dotState'] {
  const list = tabs ?? [];
  if (list.some((t) => t.attention)) return 'attention';
  if (list.some((t) => t.status === 'crashed')) return 'attention';
  if (row.status === 'error') return 'attention';
  if (row.status === 'inactive' || row.status === 'suspended') return 'muted';
  if (list.some((t) => t.status !== 'exited')) return 'active';
  return 'muted';
}

export const WorkspaceSidebar = memo(function WorkspaceSidebar({
  isHomeActive,
  onGoHome,
  onOpenProjectPicker,
  projects,
  currentProjectPath,
  currentProjectName,
  onSelectProject,
  onCloseProject,
  onSelectProjectTab,
  terminalTabs,
  activeTerminalTab,
  tabTitles,
  attentionTabs,
  maxTabs,
  onSelectTab,
  onAddTab,
  onCloseTab,
  onRenameTab,
  hasDevServer,
  isRestartingDevServer,
  devServerRunning,
  onOpenDevServerLogs,
  onRestartDevServer,
  devServerUrl,
  isProjectDevServerRunning,
  onSwitchAccount,
}: Props) {
  const { activeAccount, accounts } = useActiveAccount(currentProjectPath);
  // The Workspaces feature is invisible until you actually have more than one.
  // For the ~80% single-workspace users the footer switcher stays hidden; the
  // picker is still reachable any time via the ⌘K command below.
  const hasMultipleWorkspaces = accounts.length > 1;

  // Keep the workspace picker discoverable from the palette even when the
  // footer switcher is hidden (single-workspace case) — otherwise a user with
  // one workspace would have no way to ever create a second.
  useCommands(
    () =>
      onSwitchAccount
        ? [
            {
              id: 'workspace.switch',
              title: hasMultipleWorkspaces ? 'Switch workspace…' : 'New workspace…',
              icon: <LayersIcon size={14} />,
              category: 'action' as const,
              keywords: ['workspace', 'account', 'switch', 'new workspace', 'profile', 'org'],
              run: () => onSwitchAccount(),
            },
          ]
        : [],
    [onSwitchAccount, hasMultipleWorkspaces]
  );
  // Filter state retained as a constant — the sidebar used to own a
  // text-filter input, but the ⌘K palette now takes over search. The
  // filter helpers below all short-circuit when the string is empty,
  // so they become free no-ops.
  const filter = '';
  const openPalette = useOpenPalette();
  const [collapsed, setCollapsed] = useState<Record<SectionId, boolean>>(readCollapsed);
  const [projectExpanded, setProjectExpanded] =
    useState<Record<string, boolean>>(readProjectExpanded);
  // Groups default to open at mount — we deliberately don't persist
  // collapsed state to localStorage because users were losing sight of
  // their pinned projects after a stale setting survived reloads.
  const [groupCollapsed, setGroupCollapsed] = useState<Record<GroupId, boolean>>({
    pinned: false,
    projects: false,
  });

  const toggleGroup = (id: GroupId) => {
    setGroupCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  // Subscribe to the session registry — re-renders when any project's
  // terminal tabs or status change. We read the actual per-project tab list
  // on demand from `sessionRegistry.snapshot(path)` below. The version is
  // also fed into the `otherRows` memo so non-pinned rows pick up live
  // status/memory updates when the registry moves.
  const registryVersion = useSyncExternalStore(
    sessionRegistry.subscribeSimple,
    () => sessionRegistry.getVersion(),
    () => 0
  );

  const toggleSection = (id: SectionId) => {
    setCollapsed((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      writeCollapsed(next);
      return next;
    });
  };

  const toggleProjectExpanded = (projectPath: string) => {
    setProjectExpanded((prev) => {
      const next = { ...prev, [projectPath]: !(prev[projectPath] ?? false) };
      writeProjectExpanded(next);
      return next;
    });
  };

  // Expanded if the user has an explicit preference; otherwise default to
  // "expanded when current, collapsed when not". Storing the toggle means
  // collapsing the current project sticks even across project switches —
  // previously we force-returned `true` for the current project, so the
  // chevron was a no-op on the current row.
  const isProjectExpanded = (projectPath: string): boolean => {
    const explicit = projectExpanded[projectPath];
    if (typeof explicit === 'boolean') return explicit;
    return projectPath === currentProjectPath;
  };

  // Registry-owned state for the current project's tabs. We join it to
  // the hook-owned `terminalTabs` list by id to pick up live status/pid
  // without duplicating the source of truth. `registryVersion` is already
  // a dep via the enclosing memo so subscription re-renders fire here.
  const currentRegistryTabs = useMemo<Map<number, SessionTerminalTab>>(() => {
    void registryVersion;
    const map = new Map<number, SessionTerminalTab>();
    if (!currentProjectPath) return map;
    const snap = sessionRegistry.snapshot(currentProjectPath);
    if (!snap) return map;
    for (const t of snap.terminalTabs) map.set(t.id, t);
    return map;
  }, [currentProjectPath, registryVersion]);

  // Build sidebar items for the current project's sections.
  const { agentItems, terminalItems, commandItems } = useMemo(() => {
    const agents: SidebarItem[] = [];
    const terms: SidebarItem[] = [];
    const agentCounts = new Map<string, number>();

    for (const tab of terminalTabs) {
      const agent = getAgentById(tab.agentId);
      const isShell = agent.id === 'terminal';
      const isActive = tab.id === activeTerminalTab;
      const hasAttention = attentionTabs.has(tab.id);
      const regTab = currentRegistryTabs.get(tab.id);

      const count = (agentCounts.get(agent.id) ?? 0) + 1;
      agentCounts.set(agent.id, count);
      const ordinal = `${agent.displayName} ${count}`;
      const title = tabTitles.get(tab.id)?.trim();
      const label = title && title.length > 0 ? title : ordinal;

      const item: SidebarItem = {
        key: `tab-${tab.id}`,
        label,
        isActive,
        dotState: tabDotState({ attention: hasAttention, status: regTab?.status }),
        onSelect: () => onSelectTab(tab.id),
        onClose: terminalTabs.length > 1 ? () => onCloseTab(tab.id) : undefined,
        onRename: onRenameTab ? (newName) => onRenameTab(tab.id, newName) : undefined,
      };

      if (isShell) terms.push(item);
      else agents.push(item);
    }

    const commands: SidebarItem[] = [];
    if (hasDevServer || isRestartingDevServer) {
      commands.push({
        key: 'dev-server',
        label: formatDevServerLabel(devServerUrl),
        dotState: isRestartingDevServer ? 'attention' : devServerRunning ? 'active' : 'idle',
        onSelect: onOpenDevServerLogs,
        meta: isRestartingDevServer ? 'restarting' : undefined,
        onAction: onRestartDevServer,
        actionIcon: <ResetIcon size={11} />,
        actionLabel: 'Restart dev server',
        actionBusy: isRestartingDevServer,
        trailing: devServerUrl ? (
          <span data-education-id="browser-button">
            <BrowserDropdown url={devServerUrl} buttonClassName="sidebar-row-action" iconOnly />
          </span>
        ) : undefined,
      });
    }

    return { agentItems: agents, terminalItems: terms, commandItems: commands };
  }, [
    terminalTabs,
    activeTerminalTab,
    tabTitles,
    attentionTabs,
    currentRegistryTabs,
    hasDevServer,
    isRestartingDevServer,
    devServerRunning,
    onSelectTab,
    onCloseTab,
    onRenameTab,
    onOpenDevServerLogs,
    onRestartDevServer,
    devServerUrl,
  ]);

  const filterLower = filter.trim().toLowerCase();
  const matchesFilter = (label: string) =>
    !filterLower || label.toLowerCase().includes(filterLower);

  const filteredAgents = agentItems.filter((i) => matchesFilter(i.label));
  const filteredTerminals = terminalItems.filter((i) => matchesFilter(i.label));
  const filteredCommands = commandItems.filter((i) => matchesFilter(i.label));

  const atMaxTabs = terminalTabs.length >= maxTabs;

  // Pinned projects keep their pin-list order exactly — no pop-to-top on
  // activation, so cells don't shift when the user switches between them.
  const pinnedRows: PinnedProjectRow[] = projects;
  const pinnedPaths = useMemo(() => new Set(pinnedRows.map((p) => p.projectPath)), [pinnedRows]);

  // Active sessions that aren't pinned — "Active" group. Source of truth is
  // the session registry, which tracks every project that's been opened
  // this launch. Dev servers stay alive for these rows until the user hits
  // the close button.
  const activeRows: PinnedProjectRow[] = useMemo(() => {
    // `registryVersion` is the reactivity trigger — snapshots are read below.
    void registryVersion;
    const snaps = sessionRegistry.snapshotAll();
    const rows: PinnedProjectRow[] = [];
    for (const snap of snaps) {
      if (pinnedPaths.has(snap.projectPath)) continue;
      rows.push({
        projectPath: snap.projectPath,
        fallbackName: snap.projectPath.split('/').pop() ?? 'Project',
        status: snap.status,
        agentStatus: snap.lastAgentStatus,
        unreadCount: snap.unreadCount,
        memoryBytes: snap.memoryBytes,
        isCurrent: snap.projectPath === currentProjectPath,
      });
    }
    // Registry order is activation order; stabilize by path so swapping
    // between two active projects doesn't reorder rows.
    rows.sort((a, b) => a.projectPath.localeCompare(b.projectPath));
    return rows;
  }, [pinnedPaths, currentProjectPath, registryVersion]);

  // Edge case: current project isn't in pinned or active (e.g. the session
  // registry hasn't picked it up yet during the initial open). Synthesize
  // a row so the workspace still has a sidebar entry.
  const currentIsKnown =
    currentProjectPath !== null &&
    (pinnedPaths.has(currentProjectPath) ||
      activeRows.some((p) => p.projectPath === currentProjectPath));
  const currentExternalRow: PinnedProjectRow | null =
    currentProjectPath && !currentIsKnown
      ? {
          projectPath: currentProjectPath,
          fallbackName: currentProjectName ?? currentProjectPath.split('/').pop() ?? 'Project',
          status: 'active',
          agentStatus: 'idle',
          unreadCount: 0,
          memoryBytes: 0,
          isCurrent: true,
        }
      : null;

  const visiblePinned = pinnedRows.filter((p) => matchesFilter(p.fallbackName));
  const visibleActive = [...(currentExternalRow ? [currentExternalRow] : []), ...activeRows].filter(
    (p) => matchesFilter(p.fallbackName)
  );

  // Force-open the group containing the current project. We honor the
  // user's manual collapsed state for the OTHER group.
  const currentInPinned = currentProjectPath !== null && pinnedPaths.has(currentProjectPath);
  const currentInActive =
    currentProjectPath !== null &&
    !currentInPinned &&
    (currentExternalRow !== null || activeRows.some((r) => r.projectPath === currentProjectPath));
  const pinnedOpen = currentInPinned || !groupCollapsed.pinned;
  const activeOpen = currentInActive || !groupCollapsed.projects;

  /**
   * Cmd+1..9 shortcut number for this row — matches the ordering used by
   * `useProjectNumberShortcuts`: pinned first, then active (alphabetical).
   * Only rows 1..9 get a badge; 10+ return null.
   */
  const shortcutNumberFor = (row: PinnedProjectRow): number | null => {
    const pinIdx = pinnedRows.findIndex((r) => r.projectPath === row.projectPath);
    if (pinIdx !== -1) return pinIdx < 9 ? pinIdx + 1 : null;
    const actIdx = activeRows.findIndex((r) => r.projectPath === row.projectPath);
    if (actIdx !== -1) {
      const n = pinnedRows.length + actIdx + 1;
      return n <= 9 ? n : null;
    }
    return null;
  };

  // Single row renderer shared by both groups — the current project gets its
  // live agent/terminal/command sections; anyone else gets the read-only
  // InactiveProjectSections view fed from the session registry.
  const renderProjectRow = (row: PinnedProjectRow) => {
    const isCurrent = row.projectPath === currentProjectPath;
    const expanded = isProjectExpanded(row.projectPath);
    // Only rows with a live session can be closed. Pinned rows that have
    // never been opened this launch show status 'inactive' and get no X.
    const canClose = !!onCloseProject && row.status !== 'inactive';
    return (
      <ProjectGroup
        key={row.projectPath}
        row={row}
        isCurrent={isCurrent}
        isExpanded={expanded}
        shortcutNumber={shortcutNumberFor(row)}
        onToggleExpand={() => toggleProjectExpanded(row.projectPath)}
        onSelectProject={onSelectProject}
        onClose={canClose ? () => onCloseProject(row.projectPath) : undefined}
      >
        {expanded &&
          (isCurrent ? (
            <div key="current-body" className="sidebar-project-body-inner">
              <SidebarSection
                id="agents"
                label="Agents"
                total={agentItems.length}
                collapsed={collapsed.agents}
                onToggle={() => toggleSection('agents')}
                addOptions={atMaxTabs ? undefined : AGENT_ADD_OPTIONS}
                onAdd={atMaxTabs ? undefined : (agentId) => onAddTab(agentId)}
                addLabel="Add agent tab"
                addShortcut="⌘T"
                addFooterLabel={atMaxTabs ? undefined : 'Add new agent'}
                items={filteredAgents}
                emptyHint={filter ? 'No matches' : 'No agents running'}
              />
              <SidebarSection
                id="terminals"
                label="Terminals"
                total={terminalItems.length}
                collapsed={collapsed.terminals}
                onToggle={() => toggleSection('terminals')}
                onAdd={atMaxTabs ? undefined : () => onAddTab(TERMINAL.id)}
                addLabel="Add terminal"
                items={filteredTerminals}
                emptyHint={filter ? 'No matches' : 'No terminals'}
              />
              <SidebarSection
                id="commands"
                label="Dev server"
                total={commandItems.length}
                collapsed={collapsed.commands}
                onToggle={() => toggleSection('commands')}
                items={filteredCommands}
                emptyHint={filter ? 'No matches' : 'Not running'}
              />
            </div>
          ) : (
            <div key="inactive-body" className="sidebar-project-body-inner">
              <InactiveProjectSections
                snapshot={sessionRegistry.snapshot(row.projectPath)}
                filterLower={filterLower}
                hasLiveDevServer={isProjectDevServerRunning?.(row.projectPath) ?? false}
                onSelectTab={(sessionId) => {
                  if (onSelectProjectTab) {
                    onSelectProjectTab(row.projectPath, sessionId);
                  } else {
                    onSelectProject(row.projectPath);
                  }
                }}
              />
            </div>
          ))}
      </ProjectGroup>
    );
  };

  return (
    <aside className="workspace-sidebar" aria-label="Processes">
      <div className="workspace-sidebar-top-row">
        <button
          type="button"
          className={`workspace-sidebar-home ${isHomeActive ? 'is-active' : ''}`}
          onClick={onGoHome}
          aria-current={isHomeActive ? 'page' : undefined}
        >
          <span className="workspace-sidebar-home-icon" aria-hidden="true">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
          </span>
          <span>Home</span>
        </button>
      </div>

      <button
        type="button"
        className="workspace-sidebar-filter"
        onClick={() => openPalette()}
        title="Open command palette"
        aria-label="Open command palette"
      >
        <SearchIcon size={12} />
        <span className="workspace-sidebar-filter-placeholder">Search</span>
        <span className="workspace-sidebar-filter-shortcut">⌘K</span>
      </button>

      <div className="workspace-sidebar-scroll">
        <SidebarGroupHeader
          label="Pinned"
          count={pinnedRows.length}
          collapsed={!pinnedOpen}
          onToggle={() => toggleGroup('pinned')}
          emptyHint="Pin a project from the Projects list below"
        />
        {pinnedOpen &&
          (visiblePinned.length === 0 && !filterLower ? (
            <div className="sidebar-group-empty">Nothing pinned yet</div>
          ) : (
            visiblePinned.map((row) => renderProjectRow(row))
          ))}

        <SidebarGroupHeader
          label="Active"
          count={activeRows.length + (currentExternalRow ? 1 : 0)}
          collapsed={!activeOpen}
          onToggle={() => toggleGroup('projects')}
        />
        {activeOpen &&
          (visibleActive.length === 0 && !filterLower ? (
            <div className="sidebar-group-empty">No active projects. Open one from Home.</div>
          ) : (
            visibleActive.map((row) => renderProjectRow(row))
          ))}
      </div>

      <div className="workspace-sidebar-footer">
        <Button
          variant="ghost"
          block
          className="workspace-sidebar-add-project"
          onClick={onOpenProjectPicker}
          title="Open a project"
        >
          <span className="workspace-sidebar-add-icon">+</span>
          <span>Open project</span>
        </Button>
        {onSwitchAccount && activeAccount && hasMultipleWorkspaces && (
          <>
            <div className="workspace-sidebar-footer-divider" />
            <Button
              variant="ghost"
              block
              className="workspace-sidebar-ws-switch"
              onClick={onSwitchAccount}
              title={`Switch workspace (${activeAccount.name})`}
            >
              <span
                className="workspace-switch-account-dot"
                style={{ background: activeAccount.color }}
              />
              <span className="workspace-switch-account-name">{activeAccount.name}</span>
            </Button>
          </>
        )}
      </div>
    </aside>
  );
});

const AGENT_ADD_OPTIONS: AgentConfig[] = ALL_AGENTS;

/**
 * Top-level collapsible group header ("Pinned" / "Projects"). Style-wise
 * distinct from the per-project SidebarSection so users read the hierarchy
 * as three levels: group → project → section.
 */
function SidebarGroupHeader({
  label,
  count,
  collapsed,
  onToggle,
  emptyHint: _emptyHint,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  emptyHint?: string;
}) {
  return (
    <button
      type="button"
      className={`sidebar-group-header ${collapsed ? 'is-collapsed' : ''}`}
      onClick={onToggle}
      aria-expanded={!collapsed}
    >
      <ChevronIcon size={10} className={collapsed ? 'chevron-collapsed' : 'chevron-expanded'} />
      <span className="sidebar-group-label">{label}</span>
      <span className="sidebar-group-count">{count}</span>
    </button>
  );
}

/**
 * Read-only view of another project's agent/terminal lists, pulled from
 * the session registry snapshot. Under Slice 4 these tabs' PTYs are STILL
 * RUNNING in the background (we keep every active session hot), so dots
 * render active. Clicking a tab switches to that project and focuses the
 * tab — the live Terminal just unhides, no reconnect required.
 */
function InactiveProjectSections({
  snapshot,
  filterLower,
  hasLiveDevServer,
  onSelectTab,
}: {
  snapshot: SessionSnapshot | undefined;
  filterLower: string;
  /** True if a dev server is currently tracked for this project path. */
  hasLiveDevServer: boolean;
  onSelectTab: (sessionId: string) => void;
}) {
  const tabs: ReadonlyArray<SessionTerminalTab> = snapshot?.terminalTabs ?? [];
  const matches = (label: string) => !filterLower || label.toLowerCase().includes(filterLower);
  const agentCounts = new Map<string, number>();

  const agents: SidebarItem[] = [];
  const terminals: SidebarItem[] = [];
  for (const tab of tabs) {
    const agent = getAgentById(tab.agentId);
    const count = (agentCounts.get(agent.id) ?? 0) + 1;
    agentCounts.set(agent.id, count);
    const title = tab.title?.trim();
    const label = title && title.length > 0 ? title : `${agent.displayName} ${count}`;
    if (!matches(label)) continue;
    const item: SidebarItem = {
      key: `bg-${tab.sessionId}`,
      label,
      dotState: tabDotState({ attention: tab.attention, status: tab.status }),
      onSelect: () => onSelectTab(tab.sessionId),
    };
    if (agent.id === 'terminal') terminals.push(item);
    else agents.push(item);
  }

  const commands: SidebarItem[] = hasLiveDevServer
    ? [
        {
          key: 'dev-server',
          label: 'Dev server',
          dotState: 'active',
        },
      ]
    : [];

  return (
    <>
      <SidebarSection
        id="agents"
        label="Agents"
        total={agents.length}
        collapsed={false}
        onToggle={() => {}}
        items={agents}
        emptyHint={filterLower ? 'No matches' : 'No agents running'}
      />
      <SidebarSection
        id="terminals"
        label="Terminals"
        total={terminals.length}
        collapsed={false}
        onToggle={() => {}}
        items={terminals}
        emptyHint={filterLower ? 'No matches' : 'No terminals'}
      />
      <SidebarSection
        id="commands"
        label="Dev server"
        total={commands.length}
        collapsed={false}
        onToggle={() => {}}
        items={commands}
        emptyHint={filterLower ? 'No matches' : 'Not running'}
      />
    </>
  );
}

function ProjectGroup({
  row,
  isCurrent,
  isExpanded,
  shortcutNumber,
  onToggleExpand,
  onSelectProject,
  onClose,
  children,
}: {
  row: PinnedProjectRow;
  isCurrent: boolean;
  isExpanded: boolean;
  /** Cmd+N shortcut badge (1..9). Null for rows beyond the shortcut range. */
  shortcutNumber: number | null;
  onToggleExpand: () => void;
  onSelectProject: (path: string) => void;
  /** Shown as a hover-only X when defined. */
  onClose?: () => void;
  children?: React.ReactNode;
}) {
  const initials = projectInitials(row.fallbackName);
  // Parent WorkspaceSidebar subscribes to the registry; this snapshot is
  // therefore re-read on every relevant change.
  const snap = sessionRegistry.snapshot(row.projectPath);
  const dot = projectDotState(row, snap?.terminalTabs);
  const memoryLabel =
    row.memoryBytes > 0 ? `${Math.round(row.memoryBytes / (1024 * 1024))}MB` : null;

  return (
    <div className={`sidebar-project ${isCurrent ? 'is-current' : ''}`}>
      <div
        className="sidebar-project-row"
        role="button"
        tabIndex={0}
        aria-current={isCurrent ? 'true' : undefined}
        onClick={() => {
          if (!isCurrent) onSelectProject(row.projectPath);
        }}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !isCurrent) {
            e.preventDefault();
            onSelectProject(row.projectPath);
          }
        }}
      >
        <button
          type="button"
          className="sidebar-project-chevron"
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand();
          }}
          aria-expanded={isExpanded}
          title={isExpanded ? 'Collapse project' : 'Expand project'}
          aria-label={isExpanded ? 'Collapse project' : 'Expand project'}
        >
          <ChevronIcon
            size={10}
            className={isExpanded ? 'chevron-expanded' : 'chevron-collapsed'}
          />
        </button>
        <span
          className={`sidebar-project-initials ${shortcutNumber !== null ? 'is-shortcut' : ''}`}
          aria-hidden="true"
          title={shortcutNumber !== null ? `⌘${shortcutNumber}` : undefined}
        >
          {shortcutNumber !== null ? `⌘${shortcutNumber}` : initials}
        </span>
        <span className="sidebar-project-name" title={row.fallbackName}>
          {row.fallbackName}
        </span>
        {memoryLabel && <span className="sidebar-project-meta">{memoryLabel}</span>}
        {onClose && (
          <button
            type="button"
            className="sidebar-project-close"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            aria-label={`Close ${row.fallbackName}`}
            title="Close project (stops dev server)"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path
                d="M1 1 L9 9 M9 1 L1 9"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
        <span className={`sidebar-row-dot dot-${dot}`} aria-hidden="true" />
      </div>
      {isExpanded && children && <div className="sidebar-project-body">{children}</div>}
    </div>
  );
}

interface SectionProps {
  id: SectionId;
  label: string;
  total: number;
  collapsed: boolean;
  items: SidebarItem[];
  emptyHint: string;
  onToggle: () => void;
  /** Simple "+" click handler. If `addOptions` is provided, this is invoked with the chosen agent id. */
  onAdd?: (agentId?: string) => void;
  addLabel?: string;
  /** Display-only keyboard hint next to the "+" button (e.g. "⌘T"). */
  addShortcut?: string;
  /** If provided, the "+" opens a popover picker with these options instead of an instant add. */
  addOptions?: AgentConfig[];
  /** If set, renders a full-width "+ <label>" row below the items
      (styled like a toolbar button) that invokes the default add. */
  addFooterLabel?: string;
}

function SidebarSection({
  id,
  label,
  total,
  collapsed,
  items,
  emptyHint,
  onToggle,
  onAdd,
  addLabel,
  addShortcut,
  addOptions,
  addFooterLabel,
}: SectionProps) {
  const headerId = `sidebar-section-${id}`;
  const [footerPickerOpen, setFooterPickerOpen] = useState(false);
  const [footerPickerPos, setFooterPickerPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const footerWrapRef = useRef<HTMLDivElement>(null);
  const footerPickerRef = useRef<HTMLDivElement>(null);

  /* Show the agent picker only when the user has multiple options.
     With a single agent configured, `+` is an unambiguous "add the
     default agent" button — a one-item dropdown would just be noise. */
  const hasMultipleOptions = (addOptions?.length ?? 0) > 1;

  const toggleFooterPicker = () => {
    if (!hasMultipleOptions) return;
    setFooterPickerOpen((prev) => {
      if (prev) return false;
      if (footerWrapRef.current) {
        /* Portal-anchor the picker relative to the viewport so the
           sidebar's `overflow: hidden` and scroll-container clipping
           can't chop it off. We mirror the wrapper's x/width so the
           dropdown visually aligns with the split-button pill. */
        const rect = footerWrapRef.current.getBoundingClientRect();
        setFooterPickerPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
      }
      return true;
    });
  };

  useEffect(() => {
    if (!footerPickerOpen) return;
    const handleKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setFooterPickerOpen(false);
    };
    /* Click-outside dismissal. The picker is portaled to the body, so a
       wrapper-only check would treat clicks inside the picker as outside
       and close it before the item's onClick fires. */
    const handlePointerDown = (e: globalThis.MouseEvent) => {
      const target = e.target as Node;
      if (footerWrapRef.current?.contains(target)) return;
      if (footerPickerRef.current?.contains(target)) return;
      setFooterPickerOpen(false);
    };
    window.addEventListener('keydown', handleKey);
    window.addEventListener('mousedown', handlePointerDown);
    return () => {
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('mousedown', handlePointerDown);
    };
  }, [footerPickerOpen]);

  /* Click always opens the default agent immediately — the picker is
     strictly for the power user who wants a non-default. `onAdd()` with
     no agentId falls through to `getDefaultAgentId()` downstream. */
  const handleAddClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!onAdd) return;
    setFooterPickerOpen(false);
    onAdd();
  };

  return (
    <section className={`sidebar-section ${collapsed ? 'is-collapsed' : ''}`}>
      <header className="sidebar-section-header">
        <button
          type="button"
          className="sidebar-section-toggle"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls={headerId}
        >
          <ChevronIcon size={10} className={collapsed ? 'chevron-collapsed' : 'chevron-expanded'} />
          <span className="sidebar-section-label">{label}</span>
        </button>
        <div className="sidebar-section-meta">
          <span className="sidebar-section-count">{total}</span>
          {onAdd && (
            <button
              type="button"
              className="sidebar-section-add"
              onClick={handleAddClick}
              title={addLabel}
              aria-label={addLabel}
            >
              +
            </button>
          )}
        </div>
      </header>
      {!collapsed && (
        <ul className="sidebar-section-list" id={headerId}>
          {items.length === 0 ? (
            <li className="sidebar-section-empty">{emptyHint}</li>
          ) : (
            items.map((item) => <SidebarRow key={item.key} item={item} />)
          )}
          {addFooterLabel && onAdd && items.length > 0 && (
            <li className="sidebar-section-add-footer-row">
              <div
                className={`sidebar-section-add-footer-group ${hasMultipleOptions ? 'has-caret' : ''}`}
                ref={footerWrapRef}
              >
                <button
                  type="button"
                  className="toolbar-icon-btn sidebar-section-add-footer"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFooterPickerOpen(false);
                    onAdd();
                  }}
                  aria-label={addFooterLabel}
                >
                  <span>{addFooterLabel}</span>
                  {addShortcut && <span className="capture-shortcut">{addShortcut}</span>}
                </button>
                {hasMultipleOptions && (
                  <button
                    type="button"
                    className={`toolbar-icon-btn sidebar-section-add-footer-caret ${footerPickerOpen ? 'is-open' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFooterPicker();
                    }}
                    aria-haspopup="menu"
                    aria-expanded={footerPickerOpen}
                    aria-label="Choose agent type"
                  >
                    <ChevronIcon size={12} />
                  </button>
                )}
              </div>
              {footerPickerOpen &&
                addOptions &&
                hasMultipleOptions &&
                footerPickerPos &&
                createPortal(
                  <div
                    ref={footerPickerRef}
                    className="sidebar-section-picker is-footer"
                    role="menu"
                    style={{
                      top: footerPickerPos.top,
                      left: footerPickerPos.left,
                      width: footerPickerPos.width,
                    }}
                  >
                    {addOptions.map((agent) => (
                      <button
                        key={agent.id}
                        type="button"
                        className="sidebar-section-picker-item"
                        onClick={() => {
                          setFooterPickerOpen(false);
                          onAdd(agent.id);
                        }}
                      >
                        {agent.displayName}
                      </button>
                    ))}
                  </div>,
                  document.body
                )}
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function SidebarRow({ item }: { item: SidebarItem }) {
  // The draft is only read while `isEditing`. We seed it from `item.label`
  // when the user enters edit mode (see `enterEditMode`) and let it go
  // stale otherwise — no need to sync from props in an effect.
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus + select-all when entering edit mode so the user can replace the
  // existing name without an extra keystroke.
  useEffect(() => {
    if (!isEditing || !inputRef.current) return;
    inputRef.current.focus();
    inputRef.current.select();
  }, [isEditing]);

  const handleKeyDown = (e: KeyboardEvent<HTMLLIElement>) => {
    if (isEditing) return;
    if ((e.key === 'Enter' || e.key === ' ') && item.onSelect) {
      e.preventDefault();
      item.onSelect();
    }
  };

  const handleClose = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    item.onClose?.();
  };

  const handleAction = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (item.actionBusy) return;
    item.onAction?.();
  };

  const enterEditMode = () => {
    if (!item.onRename) return;
    setDraft(item.label);
    setIsEditing(true);
  };

  const commitEdit = () => {
    if (!item.onRename) return;
    const trimmed = draft.trim();
    // Only fire onRename if the value actually changed — saves a no-op
    // round-trip to disk and a registry notify when the user just blurs.
    if (trimmed !== item.label) item.onRename(trimmed);
    setIsEditing(false);
  };

  const cancelEdit = () => {
    setDraft(item.label);
    setIsEditing(false);
  };

  const isAttention = item.dotState === 'attention';
  return (
    <li
      className={[
        'sidebar-row',
        item.isActive ? 'is-active' : '',
        isAttention && !item.isActive ? 'is-attention' : '',
        isEditing ? 'is-editing' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      role={item.onSelect && !isEditing ? 'button' : undefined}
      tabIndex={item.onSelect && !isEditing ? 0 : -1}
      onClick={isEditing ? undefined : item.onSelect}
      onDoubleClick={item.onRename ? enterEditMode : undefined}
      onKeyDown={handleKeyDown}
    >
      <span className={`sidebar-row-dot dot-${item.dotState}`} aria-hidden="true" />
      {isEditing ? (
        <input
          ref={inputRef}
          className="sidebar-row-rename"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              commitEdit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancelEdit();
            }
          }}
          aria-label="Rename tab"
        />
      ) : (
        <span className="sidebar-row-label" title={item.label}>
          {item.label}
        </span>
      )}
      {item.meta && <span className="sidebar-row-meta">{item.meta}</span>}
      {item.onAction && item.actionIcon && (
        <button
          type="button"
          className="sidebar-row-action"
          onClick={handleAction}
          disabled={item.actionBusy}
          title={item.actionLabel}
          aria-label={item.actionLabel}
        >
          {item.actionIcon}
        </button>
      )}
      {item.trailing && (
        <span
          className="sidebar-row-trailing"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {item.trailing}
        </span>
      )}
      {item.onClose && (
        <button
          type="button"
          className="sidebar-row-close"
          onClick={handleClose}
          title="Close"
          aria-label={`Close ${item.label}`}
        >
          ×
        </button>
      )}
    </li>
  );
}
