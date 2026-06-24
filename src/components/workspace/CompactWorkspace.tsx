/**
 * Compact workspace — the narrow-window layout (≤ 750px).
 *
 * Purpose-built, not a responsive squeeze of the full workspace. Renders just
 * a project/agent switcher strip and the terminal. Everything else (branches,
 * PRs, preview, publish, screenshot tools, dev-server logs) drops out — the
 * ⌘K palette remains as the escape hatch.
 *
 * ## Lifecycle caveat
 * When the user drags the window across the 750px threshold, WorkspaceView
 * swaps between FullWorkspace and this component. That remounts the terminal
 * DOM subtree — the backend PTY keeps running (agents don't die), but xterm's
 * local scrollback is cleared. Crossing the threshold mid-session is rare, so
 * we accept that cost rather than piping every Terminal instance through a
 * portal to survive the swap.
 *
 * @module components/CompactWorkspace
 */

import { Terminal } from '../terminal/Terminal';
import { StaleEnvBanner } from '../terminal/StaleEnvBanner';
import type { TerminalHandle, AgentStatus } from '../terminal/Terminal';
import { PlusIcon } from '../icons';
import { CompactTopbar } from './CompactTopbar';
import { getAgentById } from '../../lib/agent';
import { sessionRegistry } from '../../lib/sessionRegistry';
import type { Project } from '../../lib/project';
import type { TerminalTab } from '../../hooks/useTerminalManagement';
import type { PinnedProjectRow } from '../../hooks/usePinnedProjects';

interface TerminalSessionView {
  projectPath: string;
  tabs: TerminalTab[];
  activeTabId: number;
  sessionEpoch: number;
}

interface CompactWorkspaceProps {
  currentProject: Project;
  /** Live registry snapshot of all open-project sessions — drives the terminal
   *  stack so every project's tabs stay mounted across switches. */
  allSessions: TerminalSessionView[];
  /** Current project's tab list, in display order. */
  terminalTabs: TerminalTab[];
  activeTerminalTab: number;
  terminalRefsMap: React.MutableRefObject<Map<string, TerminalHandle | null>>;
  tabTitles: Map<number, string>;
  attentionTabs: Set<number>;
  maxTerminalTabs: number;
  onSelectTab: (id: number) => void;
  onAddTab: () => void;
  onCloseTab: (id: number) => void;
  /** Dev-server status for the current project (shown as a dot in the top bar). */
  hasDevServer: boolean;
  /** Pinned + active project rows — used by the project dropdown. */
  projectRows: PinnedProjectRow[];
  onSelectProject: (projectPath: string) => void;
  onGoHome: () => void;
  /** Autonomy-mode flag forwarded to the Terminal children. */
  autoAcceptMode: boolean;
  handleTerminalExit: (code: number | null) => void;
  /** Relaunch a tab's agent after it exits (parent mints a fresh session). */
  restartTerminalTab: (tabId: number, projectPath?: string) => void;
  createTabStatusHandler: (
    projectPath: string,
    tabId: number
  ) => (status: AgentStatus, title: string) => void;
  handleTabTitleChange: (projectPath: string, tabId: number) => (title: string) => void;
}

/**
 * Label for an agent/terminal tab: use the registry title if present, else
 * `{Agent Name} {ordinal}` — matches the sidebar's own labelling in full mode
 * so the user sees the same names across window sizes.
 */
function buildTabLabel(
  tab: TerminalTab,
  tabs: ReadonlyArray<TerminalTab>,
  tabTitles: Map<number, string>
): string {
  const registryTitle = tabTitles.get(tab.id)?.trim();
  if (registryTitle && registryTitle.length > 0) return registryTitle;
  const agent = getAgentById(tab.agentId);
  // Count this tab's ordinal within the same agent id (e.g. "Claude Code 2").
  let ordinal = 0;
  for (const t of tabs) {
    if (t.agentId === tab.agentId) {
      ordinal += 1;
      if (t.id === tab.id) break;
    }
  }
  return `${agent.displayName} ${ordinal}`;
}

export function CompactWorkspace({
  currentProject,
  allSessions,
  terminalTabs,
  activeTerminalTab,
  terminalRefsMap,
  tabTitles,
  attentionTabs,
  maxTerminalTabs,
  onSelectTab,
  onAddTab,
  onCloseTab,
  hasDevServer,
  projectRows,
  onSelectProject,
  onGoHome,
  autoAcceptMode,
  handleTerminalExit,
  restartTerminalTab,
  createTabStatusHandler,
  handleTabTitleChange,
}: CompactWorkspaceProps) {
  // Other projects the user can switch to — pinned + active, minus the current
  // one. The topbar renders them inline for fast switching; anything beyond
  // this short list is still one ⌘K away.
  const switchableProjects = projectRows.filter((row) => row.projectPath !== currentProject.path);

  const atMaxTabs = terminalTabs.length >= maxTerminalTabs;

  // Fall back to the directory basename so there's always a visible label,
  // even if a project somehow lands here without a populated `name`.
  const projectLabel =
    (currentProject.name?.trim() ?? '') ||
    currentProject.path.split('/').filter(Boolean).pop() ||
    'Project';

  return (
    <div className="compact-workspace">
      <CompactTopbar
        projectLabel={projectLabel}
        hasDevServer={hasDevServer}
        switchableProjects={switchableProjects}
        onSelectProject={onSelectProject}
        onGoHome={onGoHome}
      />

      <div className="compact-tabs" role="tablist" aria-label="Agent and terminal tabs">
        {terminalTabs.map((tab) => {
          const isActive = tab.id === activeTerminalTab;
          const hasAttention = attentionTabs.has(tab.id) && !isActive;
          const label = buildTabLabel(tab, terminalTabs, tabTitles);
          const canClose = terminalTabs.length > 1;
          return (
            <div
              key={tab.id}
              className={`compact-tab ${isActive ? 'is-active' : ''} ${
                hasAttention ? 'has-attention' : ''
              }`}
              role="tab"
              aria-selected={isActive}
            >
              <button
                type="button"
                className="compact-tab-select"
                onClick={() => onSelectTab(tab.id)}
                title={label}
              >
                <span className="compact-tab-dot" aria-hidden="true" />
                <span className="compact-tab-label">{label}</span>
              </button>
              {canClose && (
                <button
                  type="button"
                  className="compact-tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  aria-label={`Close ${label}`}
                  title="Close tab"
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
        {!atMaxTabs && (
          <button
            type="button"
            className="compact-tab-add"
            onClick={onAddTab}
            aria-label="New terminal tab"
            title="New terminal tab (⌘T)"
          >
            <PlusIcon size={12} />
          </button>
        )}
      </div>

      <StaleEnvBanner projectPath={currentProject.path} />

      <div className="compact-terminal-stack">
        {allSessions.flatMap((session) =>
          session.tabs.map((tab) => {
            const isCurrentProject = session.projectPath === currentProject.path;
            const isVisible = isCurrentProject && activeTerminalTab === tab.id;
            const refKey = `${session.projectPath}::${tab.id}`;
            return (
              <div
                key={`session-${session.sessionEpoch}-${refKey}`}
                className={`terminal-tab-content ${isVisible ? 'active' : ''}`}
                data-agent-id={tab.agentId}
              >
                <Terminal
                  ref={(ref) => {
                    if (ref) {
                      terminalRefsMap.current.set(refKey, ref);
                    } else {
                      terminalRefsMap.current.delete(refKey);
                    }
                  }}
                  agent={getAgentById(tab.agentId)}
                  projectPath={session.projectPath}
                  onSpawn={(pid) => {
                    sessionRegistry.patchTerminalTab(session.projectPath, tab.id, {
                      status: 'running',
                      pid,
                      exitCode: null,
                    });
                  }}
                  onExit={(code) => {
                    handleTerminalExit(code);
                    sessionRegistry.patchTerminalTab(session.projectPath, tab.id, {
                      status: code === 0 || code === null ? 'exited' : 'crashed',
                      pid: null,
                      exitCode: code,
                    });
                  }}
                  autoAcceptMode={autoAcceptMode}
                  onStatusChange={createTabStatusHandler(session.projectPath, tab.id)}
                  onTitleChange={handleTabTitleChange(session.projectPath, tab.id)}
                  sessionName={tab.sessionId}
                  isActive={isVisible}
                  shouldResume={tab.shouldResume}
                  onRequestRestart={() => restartTerminalTab(tab.id, session.projectPath)}
                />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
