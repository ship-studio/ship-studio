import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  ActivityIcon,
  AddIcon,
  BellIcon,
  ChevronIcon,
  CloseIcon,
  EditFieldIcon,
  HomeIcon,
  PanelLeftIcon,
  PinIcon,
  ResetIcon,
  SearchIcon,
  SettingsIcon,
  SlackIcon,
  NewWorkspaceIcon,
  SwitchWorkspaceIcon,
} from '@/components/icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { PanelResizeHandle } from '../primitives/PanelResizeHandle';
import { Spinner } from '../primitives/Spinner';
import { BrowserDropdown } from '../preview/BrowserDropdown';
import { PixelLoaderRings } from './PixelLoaderRings';
import { SpotifyWidget } from './SpotifyWidget';
import { UpdateBanner } from '../UpdateBanner';
import { NewAccountModal } from '../accounts/NewAccountModal';
import { RenameProjectModal } from '../dashboard/RenameProjectModal';
import { useOpenPalette } from '../CommandPalette/paletteContext';
import { useModal } from '../../contexts/ModalContext';
import { ALL_AGENTS, TERMINAL, getAgentById, type AgentConfig } from '../../lib/agent';
import { getDevServerPort, setDevServerPort } from '../../lib/project';
import { preferredPortForProject } from '../../lib/ports';
import { type WorktreeInfo } from '../../lib/worktrees';
import {
  familyRootOf,
  ensureFamilyRoot,
  subscribeFamilyRoots,
  familyRootsVersion,
} from '../../lib/worktreeFamilies';
import { formatRelativeTime } from '../../lib/branches';
import type { TerminalTab } from '../../hooks/useTerminalManagement';
import type { PinnedProjectRow } from '../../hooks/usePinnedProjects';
import { useActiveAccount } from '../../hooks/useActiveAccount';
import { useCommands } from '../../commands/useCommands';
import { kbd } from '../../lib/shortcuts';
import { basename } from '../../lib/paths';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useOptionalToast } from '../../contexts/ToastContext';
import { setActiveAccountId, type Account } from '../../lib/accounts';
import { ProjectSettingsModal } from './ProjectSettingsModal';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../primitives/ContextMenu';
import {
  sessionRegistry,
  type SessionSnapshot,
  type SessionTerminalTab,
  type TabStatus,
} from '../../lib/sessionRegistry';

type SectionId = 'agents' | 'terminals' | 'worktrees' | 'commands';
type GroupId = 'pinned' | 'projects';

const WORKSPACE_SWITCHER_MENU_GUTTER = 8;
const WORKSPACE_SWITCHER_MENU_OFFSET = 4;

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
  isSidebarHidden?: boolean;
  onToggleSidebar?: () => void;
  /** Hide the sidebar-owned navigation row when the workspace titlebar owns it. */
  showNavigationControls?: boolean;
  /**
   * Which top-level destination is showing, so the
   * nav row can mark it current. Defaults to Home when omitted.
   */
  activeNav?: 'home' | 'workflows' | 'inbox';
  /** Open the Workflows page. Hides the nav button when omitted. */
  onGoWorkflows?: () => void;
  /** Open the Inbox. Hides the nav button when omitted. */
  onGoInbox?: () => void;
  /** Unread findings, rendered as a badge on the Inbox button. */
  inboxUnreadCount?: number;

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
  /** Unpin a pinned row. Rendered as the row's hover action when there's no
   *  live session to close — without it, a pin whose folder was moved or
   *  deleted outside the app could never be removed (issue #366). */
  onUnpinProject?: (projectPath: string) => void;
  /** Rename a project folder and update the owning app state. */
  onRenameProject?: (projectPath: string, newName: string) => Promise<void>;
  /** Toggle whether a project is pinned in the sidebar. */
  onTogglePinProject?: (projectPath: string, shouldPin: boolean) => void | Promise<void>;
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
  /** Stop the dev server for any project represented by a sidebar row. */
  onStopDevServer?: (projectPath: string) => void | Promise<void>;

  // Worktrees
  /** All worktrees of the current project's repository (`git worktree list`,
   *  main first). Empty for non-git projects — the section hides itself. */
  worktrees?: WorktreeInfo[];
  /** Open the "New worktree" modal. When omitted, the section has no "+". */
  onAddWorktree?: () => void;

  /** Open the "Switch Workspace" picker. When omitted, the sidebar switcher
   *  showing the active Workspace is not rendered. */
  onSwitchAccount?: () => void;
}

const SECTION_STORAGE_KEY = 'ship-studio:workspace-sidebar:collapsed';
const PROJECT_EXPAND_STORAGE_KEY = 'ship-studio:workspace-sidebar:expanded-projects';
const SLACK_INVITE_URL =
  'https://join.slack.com/t/shipstudiocommunity/shared_invite/zt-41vbyaoo0-_pZWNPyMdvMoF6neuDYw7g';

function readCollapsed(): Record<SectionId, boolean> {
  try {
    const raw = localStorage.getItem(SECTION_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Record<SectionId, boolean>;
  } catch {
    // ignore
  }
  return { agents: false, terminals: false, worktrees: false, commands: false };
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

function workspaceInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?';
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
 *   - status === 'thinking'                → `thinking` (green; PixelLoader)
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
  activeNav,
  onGoWorkflows,
  onGoInbox,
  inboxUnreadCount = 0,
  onGoHome,
  onOpenProjectPicker,
  isSidebarHidden,
  onToggleSidebar,
  showNavigationControls = true,
  projects,
  currentProjectPath,
  currentProjectName,
  onSelectProject,
  onCloseProject,
  onUnpinProject,
  onRenameProject,
  onTogglePinProject,
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
  onStopDevServer,
  worktrees,
  onAddWorktree,
  onSwitchAccount,
}: Props) {
  const appSettingsModal = useModal('settings');
  // 219, not 214: the top row gained Workflows and Inbox beside Home, and at the
  // old default the last one sat hard against the resize edge.
  const [sidebarWidth, setSidebarWidth] = useState(219);
  const sidebarProjectSettingsModal = useModal('sidebarProjectSettings');
  const sidebarProjectRenameModal = useModal('sidebarProjectRename');
  const { showToast } = useOptionalToast();
  const [projectSettingsTarget, setProjectSettingsTarget] = useState<Pick<
    PinnedProjectRow,
    'projectPath' | 'fallbackName'
  > | null>(null);
  const [projectSettingsPort, setProjectSettingsPort] = useState<number | null>(null);
  const [renameTarget, setRenameTarget] = useState<Pick<
    PinnedProjectRow,
    'projectPath' | 'fallbackName'
  > | null>(null);
  const { activeAccount, accounts } = useActiveAccount(currentProjectPath);
  const [workspaceSwitcherOpen, setWorkspaceSwitcherOpen] = useState(false);
  const [switchingWorkspaceId, setSwitchingWorkspaceId] = useState<string | null>(null);
  const workspaceSwitcherRef = useRef<HTMLDivElement>(null);
  const workspaceSwitcherOptionsRef = useRef<HTMLDivElement>(null);
  const [workspaceSwitcherPosition, setWorkspaceSwitcherPosition] = useState<{
    bottom: number;
    left: number;
  } | null>(null);
  // The Workspaces feature is invisible until you actually have more than one.
  // For the ~80% single-workspace users the footer switcher stays hidden; the
  // picker is still reachable any time via the ⌘K command below.
  const hasMultipleWorkspaces = accounts.length > 1;
  const showWorkspaceSwitcher = Boolean(onSwitchAccount && activeAccount && hasMultipleWorkspaces);
  const otherWorkspaces = accounts.filter((account) => account.id !== activeAccount?.id);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);

  const handleOpenProjectSettings = useCallback(
    async (row: Pick<PinnedProjectRow, 'projectPath' | 'fallbackName'>) => {
      try {
        const savedPort = await getDevServerPort(row.projectPath);
        setProjectSettingsTarget(row);
        setProjectSettingsPort(savedPort ?? preferredPortForProject(row.projectPath));
        sidebarProjectSettingsModal.open();
      } catch (error) {
        showToast(
          `Couldn't load settings for ${row.fallbackName}: ${formatCommandError(asCommandError(error))}`,
          'error'
        );
      }
    },
    [sidebarProjectSettingsModal, showToast]
  );

  const handleSaveProjectSettings = useCallback(
    async (port: number) => {
      if (!projectSettingsTarget) return;
      try {
        await setDevServerPort(projectSettingsTarget.projectPath, port);
        showToast('Project settings saved', 'success');
      } catch (error) {
        showToast(
          `Couldn't save settings for ${projectSettingsTarget.fallbackName}: ${formatCommandError(asCommandError(error))}`,
          'error'
        );
      }
    },
    [projectSettingsTarget, showToast]
  );

  const handleOpenRenameProject = useCallback(
    (row: Pick<PinnedProjectRow, 'projectPath' | 'fallbackName'>) => {
      if (!onRenameProject) return;
      setRenameTarget(row);
      sidebarProjectRenameModal.open();
    },
    [onRenameProject, sidebarProjectRenameModal]
  );

  const handleCloseRenameProject = useCallback(() => {
    sidebarProjectRenameModal.close();
    setRenameTarget(null);
  }, [sidebarProjectRenameModal]);

  const handleRenameProject = useCallback(
    async (newName: string) => {
      if (!renameTarget || !onRenameProject) return;
      await onRenameProject(renameTarget.projectPath, newName);
    },
    [onRenameProject, renameTarget]
  );

  useEffect(() => {
    if (!sidebarProjectSettingsModal.isOpen) {
      setProjectSettingsTarget(null);
      setProjectSettingsPort(null);
    }
  }, [sidebarProjectSettingsModal.isOpen]);

  useEffect(() => {
    if (!sidebarProjectRenameModal.isOpen) setRenameTarget(null);
  }, [sidebarProjectRenameModal.isOpen]);

  const closeWorkspaceSwitcher = useCallback(() => {
    setWorkspaceSwitcherOpen(false);
    setWorkspaceSwitcherPosition(null);
  }, []);

  const toggleWorkspaceSwitcher = useCallback(() => {
    if (switchingWorkspaceId) return;
    setWorkspaceSwitcherOpen((open) => {
      if (open) setWorkspaceSwitcherPosition(null);
      return !open;
    });
  }, [switchingWorkspaceId]);

  const openNewWorkspace = useCallback(() => {
    closeWorkspaceSwitcher();
    setNewWorkspaceOpen(true);
  }, [closeWorkspaceSwitcher]);

  const handleWorkspaceSelect = useCallback(
    async (account: Account) => {
      if (switchingWorkspaceId) return;

      if (account.id === activeAccount?.id) {
        closeWorkspaceSwitcher();
        return;
      }

      setSwitchingWorkspaceId(account.id);
      try {
        await setActiveAccountId(account.id);
        closeWorkspaceSwitcher();
        // Projects are scoped to the active workspace. Leave the current
        // project before the sidebar resolves the new workspace indicator so
        // the dashboard can load the correct project set.
        onGoHome();
      } catch (error) {
        showToast(
          `Failed to switch workspace: ${formatCommandError(asCommandError(error))}`,
          'error'
        );
      } finally {
        setSwitchingWorkspaceId(null);
      }
    },
    [activeAccount?.id, closeWorkspaceSwitcher, onGoHome, showToast, switchingWorkspaceId]
  );

  const updateWorkspaceSwitcherPosition = useCallback(() => {
    const switcher = workspaceSwitcherRef.current;
    if (!switcher) return;

    const rect = switcher.getBoundingClientRect();
    setWorkspaceSwitcherPosition({
      bottom: Math.max(
        WORKSPACE_SWITCHER_MENU_GUTTER,
        window.innerHeight - rect.top + WORKSPACE_SWITCHER_MENU_OFFSET
      ),
      left: rect.left,
    });
  }, []);

  useLayoutEffect(() => {
    if (!isSidebarHidden || !workspaceSwitcherOpen) return;

    updateWorkspaceSwitcherPosition();
    const handleViewportChange = () => updateWorkspaceSwitcherPosition();
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [isSidebarHidden, updateWorkspaceSwitcherPosition, workspaceSwitcherOpen]);

  useLayoutEffect(() => {
    if (!isSidebarHidden || !workspaceSwitcherOpen || !workspaceSwitcherPosition) return;
    const menu = workspaceSwitcherOptionsRef.current;
    if (!menu) return;

    const rect = menu.getBoundingClientRect();
    const maxLeft = Math.max(
      WORKSPACE_SWITCHER_MENU_GUTTER,
      window.innerWidth - rect.width - WORKSPACE_SWITCHER_MENU_GUTTER
    );
    const maxBottom = Math.max(
      WORKSPACE_SWITCHER_MENU_GUTTER,
      window.innerHeight - rect.height - WORKSPACE_SWITCHER_MENU_GUTTER
    );
    const left = Math.min(
      Math.max(WORKSPACE_SWITCHER_MENU_GUTTER, workspaceSwitcherPosition.left),
      maxLeft
    );
    const bottom = Math.min(
      Math.max(WORKSPACE_SWITCHER_MENU_GUTTER, workspaceSwitcherPosition.bottom),
      maxBottom
    );

    if (left === workspaceSwitcherPosition.left && bottom === workspaceSwitcherPosition.bottom) {
      return;
    }

    setWorkspaceSwitcherPosition((current) => (current ? { ...current, bottom, left } : current));
  }, [isSidebarHidden, workspaceSwitcherOpen, workspaceSwitcherPosition]);

  useEffect(() => {
    if (!workspaceSwitcherOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (workspaceSwitcherRef.current?.contains(target) ||
          workspaceSwitcherOptionsRef.current?.contains(target))
      ) {
        return;
      }
      closeWorkspaceSwitcher();
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeWorkspaceSwitcher();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeWorkspaceSwitcher, workspaceSwitcherOpen]);

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
              icon: hasMultipleWorkspaces ? (
                <SwitchWorkspaceIcon size={14} />
              ) : (
                <NewWorkspaceIcon size={14} />
              ),
              category: 'action' as const,
              keywords: ['workspace', 'account', 'switch', 'new workspace', 'profile', 'org'],
              run: () => (hasMultipleWorkspaces ? onSwitchAccount() : openNewWorkspace()),
            },
            ...(hasMultipleWorkspaces
              ? [
                  {
                    id: 'workspace.new',
                    title: 'New workspace…',
                    icon: <NewWorkspaceIcon size={14} />,
                    category: 'action' as const,
                    keywords: ['workspace', 'account', 'new', 'create', 'profile', 'org'],
                    run: () => openNewWorkspace(),
                  },
                ]
              : []),
          ]
        : [],
    [onSwitchAccount, hasMultipleWorkspaces, openNewWorkspace]
  );

  useCommands(
    () =>
      onRenameProject && currentProjectPath
        ? [
            {
              id: 'project.rename',
              title: 'Rename project…',
              icon: <EditFieldIcon size={14} />,
              category: 'action' as const,
              when: 'project' as const,
              keywords: ['project', 'rename', 'name', 'folder'],
              run: () =>
                handleOpenRenameProject({
                  projectPath: currentProjectPath,
                  fallbackName: currentProjectName ?? basename(currentProjectPath),
                }),
            },
          ]
        : [],
    [onRenameProject, currentProjectPath, currentProjectName, handleOpenRenameProject]
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

  // Git-truth family roots for worktree sessions. The `.worktrees/<name>/…`
  // path guess can't locate the real parent for external projects (the repo
  // lives outside ~/ShipStudio), so each worktree path is resolved via
  // `list_worktrees` — this subscription re-renders when a resolution lands
  // and the grouping below snaps to the correct family.
  const familiesVersion = useSyncExternalStore(
    subscribeFamilyRoots,
    familyRootsVersion,
    familyRootsVersion
  );
  useEffect(() => {
    void registryVersion;
    for (const s of sessionRegistry.snapshotAll()) ensureFamilyRoot(s.projectPath);
    if (currentProjectPath) ensureFamilyRoot(currentProjectPath);
  }, [registryVersion, currentProjectPath]);

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
            <BrowserDropdown
              url={devServerUrl}
              buttonClassName="sidebar-row-action"
              buttonVariant="ghost"
              iconOnly
            />
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

  // Worktree rows for the current project. Clicking a non-current worktree
  // performs the same in-place project switch as any other sidebar row — the
  // previous worktree's session (PTYs + dev server) stays hot in "Active".
  const worktreeItems = useMemo<SidebarItem[]>(() => {
    void registryVersion;
    const list = worktrees ?? [];
    return list.map((wt) => {
      const snap = sessionRegistry.snapshot(wt.path);
      const hasLiveSession = snap?.status === 'active';
      return {
        key: `worktree-${wt.path}`,
        label: wt.branch ?? wt.head,
        isActive: wt.isCurrent,
        dotState: wt.isCurrent || hasLiveSession ? 'active' : 'muted',
        // Meta: state problems first (stale/locked), else how fresh the
        // checked-out commit is — same language as the branch cards.
        meta:
          wt.prunable !== null
            ? 'stale'
            : wt.locked !== null
              ? 'locked'
              : wt.lastCommitDate !== null
                ? formatRelativeTime(wt.lastCommitDate)
                : undefined,
        onSelect: wt.isCurrent ? undefined : () => onSelectProject(wt.path),
        // Live background worktree sessions can be shut down from here — the
        // family close on the project row does all of them at once.
        onClose:
          !wt.isCurrent && hasLiveSession && onCloseProject
            ? () => onCloseProject(wt.path)
            : undefined,
      };
    });
  }, [worktrees, registryVersion, onSelectProject, onCloseProject]);

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
  // A "family" is one repository: the main checkout plus its worktrees. The
  // sidebar shows ONE row per family — worktree sessions never appear as
  // separate top-level rows; they live inside the family row's body.
  const familyKeyOf = (path: string) => familyRootOf(path);
  const currentFamily = currentProjectPath !== null ? familyKeyOf(currentProjectPath) : null;

  const activeRows: PinnedProjectRow[] = useMemo(() => {
    // `registryVersion` is the reactivity trigger — snapshots are read below.
    // `familiesVersion` re-groups rows when an async family-root resolution
    // lands (a worktree session merging into its parent's row).
    void registryVersion;
    void familiesVersion;
    const snaps = sessionRegistry.snapshotAll();
    const families = new Map<string, typeof snaps>();
    for (const snap of snaps) {
      const family = familyKeyOf(snap.projectPath);
      // Families whose root is pinned render under Pinned, not Active —
      // their worktree sessions show inside the pinned row's body.
      if (pinnedPaths.has(snap.projectPath) || pinnedPaths.has(family)) continue;
      const list = families.get(family);
      if (list) list.push(snap);
      else families.set(family, [snap]);
    }
    const rows: PinnedProjectRow[] = [...families.entries()].map(([family, members]) => {
      const root = members.find((m) => m.projectPath === family);
      const primary = root ?? members[0];
      return {
        projectPath: family,
        fallbackName: basename(family) || 'Project',
        status: members.some((m) => m.status === 'active') ? 'active' : primary.status,
        agentStatus: primary.lastAgentStatus,
        unreadCount: members.reduce((n, m) => n + m.unreadCount, 0),
        memoryBytes: members.reduce((n, m) => n + m.memoryBytes, 0),
        isCurrent: currentFamily === family,
      };
    });
    // Stable name order (matches useProjectNumberShortcuts) so swapping
    // between two active projects doesn't reorder rows.
    rows.sort(
      (a, b) =>
        a.fallbackName.localeCompare(b.fallbackName) || a.projectPath.localeCompare(b.projectPath)
    );
    return rows;
  }, [pinnedPaths, currentFamily, registryVersion, familiesVersion]);

  // A collapsed project hides its tab rows, so surface the same working state
  // in the project row when any tab in the family is actively thinking.
  const workingProjectFamilies = useMemo(() => {
    const families = new Set<string>();
    for (const snapshot of sessionRegistry.snapshotAll()) {
      if (snapshot.terminalTabs.some((tab) => tab.status === 'thinking')) {
        families.add(familyRootOf(snapshot.projectPath));
      }
    }
    return families;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- registryVersion/familiesVersion are change counters that force re-derivation from the mutable sessionRegistry; they aren't read in the body by design
  }, [registryVersion, familiesVersion]);

  // Edge case: current project isn't in pinned or active (e.g. the session
  // registry hasn't picked it up yet during the initial open). Synthesize
  // a row so the workspace still has a sidebar entry.
  const currentIsKnown =
    currentFamily !== null &&
    (pinnedRows.some((r) => familyKeyOf(r.projectPath) === currentFamily) ||
      activeRows.some((p) => p.projectPath === currentFamily));
  const currentExternalRow: PinnedProjectRow | null =
    currentProjectPath && currentFamily && !currentIsKnown
      ? {
          projectPath: currentFamily,
          fallbackName:
            basename(currentFamily) ||
            currentProjectName ||
            basename(currentProjectPath) ||
            'Project',
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
  const currentInPinned =
    currentFamily !== null && pinnedRows.some((r) => familyKeyOf(r.projectPath) === currentFamily);
  const currentInActive =
    currentFamily !== null &&
    !currentInPinned &&
    (currentExternalRow !== null || activeRows.some((r) => r.projectPath === currentFamily));
  const pinnedOpen = currentInPinned || !groupCollapsed.pinned;
  const hasActiveProjects = visibleActive.length > 0;
  const activeOpen = currentInActive || (hasActiveProjects && !groupCollapsed.projects);

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
    // A row is "current" when the current project is any member of its
    // family — being inside a worktree still highlights the project row.
    const isCurrent = currentFamily !== null && familyKeyOf(row.projectPath) === currentFamily;
    const expanded = isProjectExpanded(row.projectPath);
    // Only rows with a live session can be closed. Pinned rows that have
    // never been opened this launch show status 'inactive' and instead get
    // an unpin affordance — critically including pins whose folder no longer
    // exists and which therefore can never become active (issue #366).
    const canClose = !!onCloseProject && row.status !== 'inactive';
    const unpinProject =
      onUnpinProject && pinnedPaths.has(row.projectPath)
        ? () => onUnpinProject(row.projectPath)
        : undefined;
    const isPinned = pinnedPaths.has(row.projectPath);
    const togglePin = onTogglePinProject
      ? (shouldPin: boolean) => {
          void onTogglePinProject(row.projectPath, shouldPin);
        }
      : unpinProject
        ? (_shouldPin: boolean) => unpinProject()
        : undefined;
    const canUnpin = !canClose && unpinProject !== undefined;
    const hasRunningDevServer = isProjectDevServerRunning
      ? isProjectDevServerRunning(row.projectPath)
      : isCurrent && devServerRunning;
    const stopDevServer =
      onStopDevServer && hasRunningDevServer
        ? () => {
            void onStopDevServer(row.projectPath);
          }
        : undefined;
    // Closing a family row shuts down every member session (main checkout
    // and worktrees alike) — leaving invisible hot sessions behind would
    // silently keep dev servers and PTYs running.
    const closeFamily = () => {
      if (!onCloseProject) return;
      const members = sessionRegistry
        .snapshotAll()
        .filter((s) => familyKeyOf(s.projectPath) === familyKeyOf(row.projectPath))
        .map((s) => s.projectPath);
      for (const path of members.length > 0 ? members : [row.projectPath]) {
        onCloseProject(path);
      }
    };
    // Hot sessions in this family other than the row's own path — rendered
    // as a Worktrees section inside non-current rows' bodies.
    const familyWorktreeItems: SidebarItem[] = sessionRegistry
      .snapshotAll()
      .filter(
        (s) =>
          s.projectPath !== row.projectPath &&
          familyKeyOf(s.projectPath) === familyKeyOf(row.projectPath)
      )
      .map((s) => ({
        key: `bg-wt-${s.projectPath}`,
        label: basename(s.projectPath) || s.projectPath,
        dotState: s.status === 'active' ? ('active' as const) : ('muted' as const),
        onSelect: () => onSelectProject(s.projectPath),
        onClose: onCloseProject ? () => onCloseProject(s.projectPath) : undefined,
      }));
    return (
      <ProjectGroup
        key={row.projectPath}
        row={row}
        isCurrent={isCurrent}
        compact={!!isSidebarHidden}
        isExpanded={expanded}
        isWorking={workingProjectFamilies.has(familyRootOf(row.projectPath))}
        shortcutNumber={shortcutNumberFor(row)}
        onToggleExpand={() => toggleProjectExpanded(row.projectPath)}
        onSelectProject={onSelectProject}
        onClose={canClose ? closeFamily : undefined}
        isPinned={isPinned}
        onOpenRenameProject={onRenameProject ? () => handleOpenRenameProject(row) : undefined}
        onOpenProjectSettings={() => void handleOpenProjectSettings(row)}
        onUnpin={canUnpin ? unpinProject : undefined}
        onTogglePin={togglePin}
        onStopDevServer={stopDevServer}
      >
        {expanded &&
          (isCurrent ? (
            <div key="current-body" className="sidebar-project-body-inner">
              {worktreeItems.length > 0 && (
                <SidebarSection
                  id="worktrees"
                  label="Worktrees"
                  total={worktreeItems.length}
                  collapsed={collapsed.worktrees}
                  onToggle={() => toggleSection('worktrees')}
                  onAdd={onAddWorktree ? () => onAddWorktree() : undefined}
                  addLabel="New worktree"
                  items={worktreeItems.filter((i) => matchesFilter(i.label))}
                  emptyHint={filter ? 'No matches' : 'No worktrees'}
                />
              )}
              <SidebarSection
                id="agents"
                label="Agents"
                total={agentItems.length}
                collapsed={collapsed.agents}
                onToggle={() => toggleSection('agents')}
                addOptions={atMaxTabs ? undefined : AGENT_ADD_OPTIONS}
                onAdd={atMaxTabs ? undefined : (agentId) => onAddTab(agentId)}
                addLabel="Add agent tab"
                addShortcut={kbd('mod', 'T')}
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
                worktreeItems={familyWorktreeItems}
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

  const resizeSidebar = useCallback((clientX: number) => {
    setSidebarWidth(Math.max(150, Math.min(clientX, 500)));
  }, []);

  const resizeSidebarBy = useCallback((delta: number) => {
    setSidebarWidth((width) => Math.max(150, Math.min(width + delta, 500)));
  }, []);

  const workspaceSwitcherOptionContent = (
    <div className="workspace-switcher-options-stack">
      {isSidebarHidden && !workspaceSwitcherOpen ? (
        <IconButton
          variant="ghost"
          className="workspace-switcher-manage"
          icon={<SettingsIcon size={14} />}
          onClick={() => {
            closeWorkspaceSwitcher();
            onSwitchAccount?.();
          }}
          tabIndex={workspaceSwitcherOpen ? 0 : -1}
          aria-label="Manage workspaces"
          title="Manage workspaces"
        />
      ) : (
        <Button
          variant="ghost"
          width={isSidebarHidden ? 'hug' : 'fill'}
          className="workspace-switcher-manage"
          onClick={() => {
            closeWorkspaceSwitcher();
            onSwitchAccount?.();
          }}
          tabIndex={workspaceSwitcherOpen ? 0 : -1}
          leftIcon={<SettingsIcon size={14} />}
        >
          Manage workspaces
        </Button>
      )}
      {isSidebarHidden && !workspaceSwitcherOpen ? (
        <IconButton
          variant="ghost"
          className="workspace-switcher-new"
          icon={<NewWorkspaceIcon size={14} />}
          onClick={openNewWorkspace}
          tabIndex={workspaceSwitcherOpen ? 0 : -1}
          aria-label="New workspace"
          title="New workspace"
        />
      ) : (
        <Button
          variant="ghost"
          width={isSidebarHidden ? 'hug' : 'fill'}
          className="workspace-switcher-new"
          onClick={openNewWorkspace}
          tabIndex={workspaceSwitcherOpen ? 0 : -1}
          leftIcon={<NewWorkspaceIcon size={14} />}
        >
          New workspace
        </Button>
      )}
      <div className="workspace-switcher-option-list">
        {otherWorkspaces.map((account) => {
          const isSwitching = account.id === switchingWorkspaceId;

          return isSidebarHidden && !workspaceSwitcherOpen ? (
            <IconButton
              key={account.id}
              variant="ghost"
              className="workspace-switcher-option"
              icon={
                isSwitching ? (
                  <Spinner size="sm" />
                ) : (
                  <span
                    className="workspace-switcher-dot"
                    style={{ background: account.color }}
                    aria-hidden="true"
                  >
                    {workspaceInitial(account.name)}
                  </span>
                )
              }
              onClick={() => void handleWorkspaceSelect(account)}
              disabled={switchingWorkspaceId !== null}
              tabIndex={workspaceSwitcherOpen ? 0 : -1}
              aria-label={`Switch to ${account.name}`}
              title={`Switch to ${account.name}`}
            />
          ) : (
            <Button
              key={account.id}
              variant="ghost"
              width={isSidebarHidden ? 'hug' : 'fill'}
              className="workspace-switcher-option"
              onClick={() => void handleWorkspaceSelect(account)}
              disabled={switchingWorkspaceId !== null}
              tabIndex={workspaceSwitcherOpen ? 0 : -1}
              aria-label={`Switch to ${account.name}`}
            >
              <span className="workspace-switcher-option-dot" aria-hidden="true">
                <span className="workspace-switcher-dot" style={{ background: account.color }}>
                  {workspaceInitial(account.name)}
                </span>
              </span>
              <span className="workspace-switcher-option-name">{account.name}</span>
              {isSwitching && <Spinner size="sm" />}
            </Button>
          );
        })}
      </div>
      {activeAccount && (
        <Button
          variant="ghost"
          width={isSidebarHidden ? 'hug' : 'fill'}
          className="workspace-switcher-option is-current"
          onClick={closeWorkspaceSwitcher}
          tabIndex={workspaceSwitcherOpen ? 0 : -1}
          aria-label={`${activeAccount.name}, current workspace`}
          aria-current="true"
          data-selected="true"
        >
          <span className="workspace-switcher-option-dot" aria-hidden="true">
            <span className="workspace-switcher-dot" style={{ background: activeAccount.color }}>
              {workspaceInitial(activeAccount.name)}
            </span>
          </span>
          <span className="workspace-switcher-option-name">{activeAccount.name}</span>
        </Button>
      )}
    </div>
  );

  const sidebarStyle = {
    width: sidebarWidth,
    '--workspace-sidebar-width': isSidebarHidden
      ? 'calc(var(--control-height-standard) + (var(--space-08) * 2) - var(--border-width-default))'
      : `${sidebarWidth}px`,
  } as CSSProperties;

  return (
    <>
      <aside
        className={`workspace-sidebar${isSidebarHidden ? ' is-hidden' : ''}`}
        aria-label="Processes"
        style={sidebarStyle}
      >
        {showNavigationControls && (
          <div className="workspace-sidebar-top-row">
            {onToggleSidebar && (
              <IconButton
                variant="ghost"
                className="workspace-sidebar-toggle"
                icon={<PanelLeftIcon size={12} />}
                onClick={onToggleSidebar}
                title={isSidebarHidden ? 'Show sidebar' : 'Hide sidebar'}
                aria-label={isSidebarHidden ? 'Show sidebar' : 'Hide sidebar'}
                data-education-id="toggle-sidebar"
              />
            )}
            <IconButton
              variant="ghost"
              className={`workspace-sidebar-home ${isHomeActive ? 'is-active' : ''}`}
              icon={<HomeIcon size={12} />}
              onClick={onGoHome}
              disabled={isHomeActive}
              aria-current={isHomeActive ? 'page' : undefined}
              title="Home"
              aria-label="Home"
            />
            {onGoWorkflows && (
              <IconButton
                variant="ghost"
                className={`workspace-sidebar-home ${activeNav === 'workflows' ? 'is-active' : ''}`}
                icon={<ActivityIcon size={12} />}
                onClick={onGoWorkflows}
                disabled={activeNav === 'workflows'}
                aria-current={activeNav === 'workflows' ? 'page' : undefined}
                title="Workflows"
                aria-label="Workflows"
              />
            )}
            {onGoInbox && (
              <span className="workspace-sidebar-inbox">
                <IconButton
                  variant="ghost"
                  className={`workspace-sidebar-home ${activeNav === 'inbox' ? 'is-active' : ''}`}
                  icon={<BellIcon size={12} />}
                  onClick={onGoInbox}
                  disabled={activeNav === 'inbox'}
                  aria-current={activeNav === 'inbox' ? 'page' : undefined}
                  title="Inbox"
                  aria-label={inboxUnreadCount > 0 ? `Inbox — ${inboxUnreadCount} unread` : 'Inbox'}
                />
                {inboxUnreadCount > 0 && (
                  <span className="workspace-sidebar-inbox-badge" aria-hidden>
                    {inboxUnreadCount > 9 ? '9+' : inboxUnreadCount}
                  </span>
                )}
              </span>
            )}
          </div>
        )}

        <div className="workspace-sidebar-search-panel">
          <button
            type="button"
            className="workspace-sidebar-filter"
            onClick={() => openPalette()}
            title="Open command palette"
            aria-label="Open command palette"
          >
            <SearchIcon size={12} />
            <span className="workspace-sidebar-filter-placeholder">Search</span>
            <span className="workspace-sidebar-filter-shortcut">{kbd('mod', 'K')}</span>
          </button>
        </div>

        <SpotifyWidget isSidebarHidden={isSidebarHidden} />

        <div className="workspace-sidebar-scroll">
          {isSidebarHidden ? (
            <CompactSidebarGroupMarker label="Pinned" />
          ) : (
            <SidebarGroupHeader
              label="Pinned"
              count={pinnedRows.length}
              collapsed={!pinnedOpen}
              onToggle={() => toggleGroup('pinned')}
              emptyHint="Pin a project from the Projects list below"
            />
          )}
          {(isSidebarHidden || pinnedOpen) &&
            (visiblePinned.length === 0 && !filterLower
              ? !isSidebarHidden && <div className="sidebar-group-empty">Nothing pinned yet</div>
              : visiblePinned.map((row) => renderProjectRow(row)))}

          {isSidebarHidden ? (
            <CompactSidebarGroupMarker label="Active" />
          ) : (
            <SidebarGroupHeader
              label="Active"
              count={activeRows.length + (currentExternalRow ? 1 : 0)}
              collapsed={!activeOpen}
              onToggle={() => toggleGroup('projects')}
            />
          )}
          {(isSidebarHidden || activeOpen) &&
            (visibleActive.length === 0 && !filterLower
              ? !isSidebarHidden && (
                  <div className="sidebar-group-empty">No active projects yet.</div>
                )
              : visibleActive.map((row) => renderProjectRow(row)))}

          <div className="workspace-sidebar-active-actions">
            <Button
              variant="ghost"
              width="fill"
              className="workspace-sidebar-add-project"
              onClick={onOpenProjectPicker}
              title="Open a project"
            >
              <AddIcon size={16} />
              <span>Open project</span>
            </Button>
          </div>
        </div>

        <div className="workspace-sidebar-footer">
          <UpdateBanner />
          <div
            className={`workspace-sidebar-footer-actions${
              showWorkspaceSwitcher ? ' has-workspace-switcher' : ''
            }`}
          >
            {onSwitchAccount && activeAccount && hasMultipleWorkspaces && (
              <div
                ref={workspaceSwitcherRef}
                className={`workspace-switcher${workspaceSwitcherOpen ? ' is-open' : ''}`}
              >
                {isSidebarHidden ? (
                  <IconButton
                    variant={workspaceSwitcherOpen ? 'ghost' : 'default'}
                    className="workspace-sidebar-ws-switch"
                    icon={
                      <span
                        className="workspace-switcher-dot"
                        style={{ background: activeAccount.color }}
                        aria-hidden="true"
                      >
                        {workspaceInitial(activeAccount.name)}
                      </span>
                    }
                    onClick={toggleWorkspaceSwitcher}
                    aria-label={`Switch workspace, currently ${activeAccount.name}`}
                    aria-expanded={workspaceSwitcherOpen}
                    aria-controls="workspace-switcher-options"
                    title={`Switch workspace, currently ${activeAccount.name}`}
                  />
                ) : (
                  <Button
                    variant={workspaceSwitcherOpen ? 'ghost' : 'default'}
                    width="fill"
                    className="workspace-sidebar-ws-switch"
                    onClick={toggleWorkspaceSwitcher}
                    aria-label={`Switch workspace, currently ${activeAccount.name}`}
                    aria-expanded={workspaceSwitcherOpen}
                    aria-controls="workspace-switcher-options"
                  >
                    <span className="workspace-switcher-summary">
                      <span
                        className="workspace-switcher-dot"
                        style={{ background: activeAccount.color }}
                        aria-hidden="true"
                      >
                        {workspaceInitial(activeAccount.name)}
                      </span>
                      <span className="workspace-switcher-name">{activeAccount.name}</span>
                    </span>
                    <span
                      className={`workspace-switcher-chevron${workspaceSwitcherOpen ? ' is-open' : ''}`}
                      aria-hidden="true"
                    >
                      <ChevronIcon size={12} />
                    </span>
                  </Button>
                )}
                {!isSidebarHidden && (
                  <div
                    id="workspace-switcher-options"
                    className="workspace-switcher-options"
                    role="group"
                    aria-label="Available workspaces"
                    aria-hidden={!workspaceSwitcherOpen}
                  >
                    {workspaceSwitcherOptionContent}
                  </div>
                )}
              </div>
            )}
            {isSidebarHidden && workspaceSwitcherOpen && workspaceSwitcherPosition
              ? createPortal(
                  <div
                    ref={workspaceSwitcherOptionsRef}
                    id="workspace-switcher-options"
                    className="workspace-switcher-options is-portal"
                    role="group"
                    aria-label="Available workspaces"
                    aria-hidden="false"
                    style={{
                      bottom: workspaceSwitcherPosition.bottom,
                      left: workspaceSwitcherPosition.left,
                    }}
                  >
                    {workspaceSwitcherOptionContent}
                  </div>,
                  document.body
                )
              : null}
            <IconButton
              variant="default"
              className="workspace-sidebar-support"
              icon={<SlackIcon size={12} />}
              onClick={() => void openUrl(SLACK_INVITE_URL)}
              title="Join the Ship Studio community on Slack"
              aria-label="Support"
              data-education-id="support-button"
            />
            <IconButton
              variant="default"
              className="workspace-sidebar-settings"
              icon={<SettingsIcon size={12} />}
              onClick={appSettingsModal.open}
              title="App settings"
              aria-label="App settings"
            />
          </div>
        </div>
      </aside>
      <NewAccountModal
        isOpen={newWorkspaceOpen}
        onClose={() => setNewWorkspaceOpen(false)}
        onCreated={() => setNewWorkspaceOpen(false)}
      />
      <PanelResizeHandle
        value={sidebarWidth}
        min={150}
        max={500}
        label="Resize Project Sidebar"
        onResize={resizeSidebar}
        onResizeBy={resizeSidebarBy}
      />
      {projectSettingsTarget && projectSettingsPort !== null && (
        <ProjectSettingsModal
          key={projectSettingsTarget.projectPath}
          modalId="sidebarProjectSettings"
          currentPort={projectSettingsPort}
          onSave={(port) => void handleSaveProjectSettings(port)}
        />
      )}
      {renameTarget && onRenameProject && (
        <RenameProjectModal
          key={renameTarget.projectPath}
          isOpen={sidebarProjectRenameModal.isOpen}
          onClose={handleCloseRenameProject}
          currentName={renameTarget.fallbackName}
          onRename={handleRenameProject}
        />
      )}
    </>
  );
});

const AGENT_ADD_OPTIONS: AgentConfig[] = ALL_AGENTS;

function CompactSidebarGroupMarker({ label }: { label: 'Pinned' | 'Active' }) {
  return (
    <div
      className="sidebar-group-marker"
      role="heading"
      aria-level={2}
      aria-label={`${label} projects`}
      title={`${label} projects`}
    >
      {label === 'Pinned' ? <PinIcon size={14} /> : <ActivityIcon size={14} />}
    </div>
  );
}

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
      <span className="sidebar-group-symbol" aria-hidden="true">
        {label === 'Pinned' ? <PinIcon size={14} /> : <ActivityIcon size={14} />}
      </span>
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
  worktreeItems,
  filterLower,
  hasLiveDevServer,
  onSelectTab,
}: {
  snapshot: SessionSnapshot | undefined;
  /** Hot worktree sessions in this project's family (empty when none). */
  worktreeItems?: SidebarItem[];
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
      {worktreeItems && worktreeItems.length > 0 && (
        <SidebarSection
          id="worktrees"
          label="Worktrees"
          total={worktreeItems.length}
          collapsed={false}
          onToggle={() => {}}
          items={worktreeItems.filter((i) => matches(i.label))}
          emptyHint={filterLower ? 'No matches' : 'No worktrees'}
        />
      )}
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

/**
 * Project-row label. Worktree names ("project / branch") ellipsize the
 * PROJECT part and always keep the branch visible — end-truncation would
 * render every worktree of one project as the same "myproject…" string,
 * which reads as duplicate rows.
 */
function ProjectRowName({ name }: { name: string }) {
  const slash = name.indexOf(' / ');
  if (slash === -1) {
    return (
      <span className="sidebar-project-name" title={name}>
        {name}
      </span>
    );
  }
  return (
    <span className="sidebar-project-name sidebar-project-name-split" title={name}>
      <span className="sidebar-project-name-repo">{name.slice(0, slash)}</span>
      <span className="sidebar-project-name-branch">{name.slice(slash)}</span>
    </span>
  );
}

function ProjectGroup({
  row,
  isCurrent,
  compact,
  isExpanded,
  isWorking,
  shortcutNumber,
  onToggleExpand,
  onSelectProject,
  onClose,
  isPinned,
  onOpenRenameProject,
  onOpenProjectSettings,
  onUnpin,
  onTogglePin,
  onStopDevServer,
  children,
}: {
  row: PinnedProjectRow;
  isCurrent: boolean;
  compact: boolean;
  isExpanded: boolean;
  isWorking: boolean;
  /** Cmd+N shortcut badge (1..9). Null for rows beyond the shortcut range. */
  shortcutNumber: number | null;
  onToggleExpand: () => void;
  onSelectProject: (path: string) => void;
  /** Whether this row is currently pinned to the sidebar. */
  isPinned: boolean;
  /** Open the rename modal for this project. */
  onOpenRenameProject?: () => void;
  /** Open settings for this project from the context menu. */
  onOpenProjectSettings: () => void;
  /** Shown as a hover-only X when defined. */
  onClose?: () => void;
  /** Hover-only unpin action for rows with no live session (issue #366).
   *  Ignored when `onClose` is present — one hover action per row. */
  onUnpin?: () => void;
  /** Toggle the pin state shown in the context menu. */
  onTogglePin?: (shouldPin: boolean) => void;
  /** Stop this row's dev server when one is explicitly tracked. */
  onStopDevServer?: () => void;
  children?: React.ReactNode;
}) {
  const initials = projectInitials(row.fallbackName);
  // Parent WorkspaceSidebar subscribes to the registry; this snapshot is
  // therefore re-read on every relevant change.
  const snap = sessionRegistry.snapshot(row.projectPath);
  const baseDot = projectDotState(row, snap?.terminalTabs);
  // Family rows can be live purely through a worktree session (the root path
  // itself has no tabs) — the aggregated row status is authoritative then.
  const dot = baseDot === 'muted' && row.status === 'active' ? 'active' : baseDot;
  const memoryLabel =
    row.memoryBytes > 0 ? `${Math.round(row.memoryBytes / (1024 * 1024))}MB` : null;
  const showWorkingIndicator = !isExpanded && isWorking;

  return (
    <div className={`sidebar-project ${isCurrent ? 'is-current' : ''}`}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
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
            {!compact && (
              <IconButton
                className="sidebar-project-control sidebar-project-chevron"
                variant="ghost"
                size="compact"
                icon={
                  <ChevronIcon
                    size={10}
                    className={isExpanded ? 'chevron-expanded' : 'chevron-collapsed'}
                  />
                }
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleExpand();
                }}
                aria-expanded={isExpanded}
                title={isExpanded ? 'Collapse project' : 'Expand project'}
                aria-label={isExpanded ? 'Collapse project' : 'Expand project'}
              />
            )}
            <span
              className={`sidebar-project-initials ${shortcutNumber !== null ? 'is-shortcut' : ''}`}
              aria-hidden={!compact}
              title={
                compact
                  ? row.fallbackName
                  : shortcutNumber !== null
                    ? kbd('mod', String(shortcutNumber))
                    : undefined
              }
            >
              {shortcutNumber !== null ? kbd('mod', String(shortcutNumber)) : initials}
            </span>
            {!compact && <ProjectRowName name={row.fallbackName} />}
            {!compact && memoryLabel && <span className="sidebar-project-meta">{memoryLabel}</span>}
            {!compact && onClose && (
              <IconButton
                className="sidebar-project-control sidebar-project-close"
                variant="ghost"
                size="compact"
                icon={<CloseIcon size={10} />}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose();
                }}
                aria-label={`Close ${row.fallbackName}`}
                title="Close project (stops dev server)"
              />
            )}
            {!compact && !onClose && onUnpin && (
              <IconButton
                className="sidebar-project-control sidebar-project-close"
                variant="ghost"
                size="compact"
                icon={<CloseIcon size={10} />}
                onClick={(e) => {
                  e.stopPropagation();
                  onUnpin();
                }}
                aria-label={`Unpin ${row.fallbackName}`}
                title="Unpin from sidebar"
              />
            )}
            {!compact && (
              <span className="sidebar-project-status">
                {showWorkingIndicator ? (
                  <PixelLoaderRings
                    className="sidebar-project-pixel-loader"
                    size="sm"
                    label={`Working on ${row.fallbackName}`}
                  />
                ) : (
                  <span className={`sidebar-row-dot dot-${dot}`} aria-hidden="true" />
                )}
              </span>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent aria-label={`Actions for ${row.fallbackName}`}>
          <ContextMenuItem onSelect={onOpenProjectSettings}>
            <SettingsIcon size={14} aria-hidden="true" />
            <span>Project Settings</span>
          </ContextMenuItem>
          <ContextMenuItem disabled={!onOpenRenameProject} onSelect={onOpenRenameProject}>
            <EditFieldIcon size={14} aria-hidden="true" />
            <span>Rename project</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!onStopDevServer} onSelect={onStopDevServer}>
            <CloseIcon size={14} aria-hidden="true" />
            <span>Stop dev server</span>
          </ContextMenuItem>
          <ContextMenuItem disabled={!onTogglePin} onSelect={() => onTogglePin?.(!isPinned)}>
            <PinIcon size={14} aria-hidden="true" />
            <span>{isPinned ? 'Unpin from sidebar' : 'Pin to sidebar'}</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {!compact && isExpanded && children && <div className="sidebar-project-body">{children}</div>}
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
          <span className="sidebar-section-control-slot sidebar-section-count">{total}</span>
          {onAdd && (
            <IconButton
              className="sidebar-section-add"
              variant="ghost"
              icon={<span aria-hidden="true">+</span>}
              onClick={handleAddClick}
              title={addLabel}
              aria-label={addLabel ?? `Add ${label.toLowerCase()}`}
            />
          )}
          {!onAdd && <span className="sidebar-section-control-slot" aria-hidden="true" />}
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
                <Button
                  variant="default"
                  width="fill"
                  className="sidebar-section-add-footer"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFooterPickerOpen(false);
                    onAdd();
                  }}
                  aria-label={addFooterLabel}
                >
                  <span>{addFooterLabel}</span>
                  {addShortcut && <span className="capture-shortcut">{addShortcut}</span>}
                </Button>
                {hasMultipleOptions && (
                  <Button
                    variant="default"
                    className={`sidebar-section-add-footer-caret ${footerPickerOpen ? 'is-open' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFooterPicker();
                    }}
                    aria-haspopup="menu"
                    aria-expanded={footerPickerOpen}
                    aria-label="Choose agent type"
                  >
                    <ChevronIcon size={12} />
                  </Button>
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
      <span className="sidebar-row-status">
        {item.dotState === 'thinking' ? (
          <PixelLoaderRings
            className="sidebar-row-pixel-loader"
            size="sm"
            label={`Working on ${item.label}`}
          />
        ) : (
          <span className={`sidebar-row-dot dot-${item.dotState}`} aria-hidden="true" />
        )}
      </span>
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
      <span className="sidebar-row-meta">{item.meta}</span>
      <span className="sidebar-row-control-slot">
        {item.onAction && item.actionIcon && (
          <IconButton
            className="sidebar-row-action"
            variant="ghost"
            icon={item.actionIcon}
            onClick={handleAction}
            disabled={item.actionBusy}
            title={item.actionLabel}
            aria-label={item.actionLabel ?? 'Item action'}
          />
        )}
      </span>
      <span className="sidebar-row-control-slot">
        {item.trailing && (
          <span
            className="sidebar-row-trailing"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {item.trailing}
          </span>
        )}
        {!item.trailing && item.onClose && (
          <IconButton
            className="sidebar-row-close"
            variant="ghost"
            icon={<span aria-hidden="true">×</span>}
            onClick={handleClose}
            title="Close"
            aria-label={`Close ${item.label}`}
          />
        )}
      </span>
    </li>
  );
}
