import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useCommands } from './useCommands';
import type { PaletteCtx } from './types';
import { useOpenModal } from '../contexts/ModalContext';
import { getDashboardProjects, type DashboardProject, type Project } from '../lib/project';
import { sessionRegistry } from '../lib/sessionRegistry';
import { checkForUpdate } from '../lib/updater';
import { checkIdeAvailability, openInIde, openInFinder } from '../lib/ide';
import { logger } from '../lib/logger';
import { kbd } from '../lib/shortcuts';
import { basename } from '../lib/paths';
import { fileManagerName } from '../lib/setup';
import {
  CodeIcon,
  CursorIcon,
  FolderOpenIcon,
  GlobeIcon,
  HomeIcon,
  PanelLeftIcon,
  PlusIcon,
  ResetIcon,
  SharedLibraryIcon,
  SettingsIcon,
} from '@/components/icons';

/**
 * End-to-end smoke-test commands — wired to the real AppContents handlers.
 *
 * This hook is called once from `AppContents` and fans out into multiple
 * `useCommands` contributions. In the long-term shape each feature hook
 * (`useDevServer`, `useBranchManagement`, …) should contribute its own
 * `useXxxCommands.tsx` companion; this file is the bootstrap and doubles
 * as the canonical example to copy.
 */
export interface UseAppCommandsParams {
  currentProject: Project | null;
  /** Pinned project paths in sidebar order (for the "Projects" tab). */
  pinnedPaths: string[];
  /** Opens a project (wired to the same handler the sidebar uses). */
  handleSelectProject: (project: Project) => void | Promise<void>;
  handleBackToProjects: () => void;
  handleCreateProject: () => void;
  handleImportProject: () => void;
  handleImportLocalFolder: () => void | Promise<void>;
  handleGitHubConnect: () => void | Promise<void>;
  handleRestartDevServer: () => Promise<void> | void;
  /** Start the dev server on demand (used when it isn't running). */
  handleStartDevServer: () => Promise<void> | void;
  /** Predicate: is a dev server currently tracked for the given project? */
  isDevServerRunning: (projectPath: string) => boolean;
  /** Current education-mode state, so the command can read "Enter" vs "Exit". */
  isEducationMode: boolean;
  setIsEducationMode: (mode: boolean) => void;
  compactWorkspaceToolbarEnabled: boolean;
  setCompactWorkspaceToolbarEnabled: (enabled: boolean) => void;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

export function useAppCommands({
  currentProject,
  pinnedPaths,
  handleSelectProject,
  handleBackToProjects,
  handleCreateProject,
  handleImportProject,
  handleImportLocalFolder,
  handleGitHubConnect,
  handleRestartDevServer,
  handleStartDevServer,
  isDevServerRunning,
  isEducationMode,
  setIsEducationMode,
  compactWorkspaceToolbarEnabled,
  setCompactWorkspaceToolbarEnabled,
  showToast,
}: UseAppCommandsParams) {
  const openModal = useOpenModal();

  // IDE availability — fetched once so we can hide commands for tools the
  // user doesn't have installed. A silent failure leaves both enabled
  // (palette will surface the "not installed" error as a toast on run).
  const [ide, setIde] = useState<{ vscode: boolean; cursor: boolean }>({
    vscode: true,
    cursor: true,
  });
  useEffect(() => {
    let cancelled = false;
    checkIdeAvailability()
      .then((r) => {
        if (!cancelled) setIde(r);
      })
      .catch((err) =>
        logger.warn('[useAppCommands] checkIdeAvailability failed', { error: String(err) })
      );
    return () => {
      cancelled = true;
    };
  }, []);

  const runIde = useCallback(
    (which: 'vscode' | 'cursor') => async () => {
      if (!currentProject) return;
      try {
        await openInIde(currentProject.path, which);
      } catch (err) {
        showToast(`Could not open in ${which === 'vscode' ? 'VS Code' : 'Cursor'}`, 'error');
        logger.warn('[useAppCommands] openInIde failed', { ide: which, error: String(err) });
      }
    },
    [currentProject, showToast]
  );

  const runFinder = useCallback(async () => {
    if (!currentProject) return;
    try {
      await openInFinder(currentProject.path);
    } catch (err) {
      showToast(`Could not reveal in ${fileManagerName()}`, 'error');
      logger.warn('[useAppCommands] openInFinder failed', { error: String(err) });
    }
  }, [currentProject, showToast]);

  const runCheckUpdates = useCallback(async () => {
    try {
      const result = await checkForUpdate();
      if (!result) showToast("You're up to date", 'success');
      // If there IS an update, the project sidebar indicator surfaces it.
    } catch (err) {
      logger.warn('[useAppCommands] checkForUpdate failed', { error: String(err) });
      showToast('Could not check for updates', 'error');
    }
  }, [showToast]);

  // Wrappers to keep `run` type Promise<void> | void clean for the registry.
  // When nothing is running, "restart" degrades to a plain start — same
  // behavior as selecting the Preview tab while stopped.
  const restart = useCallback(() => {
    if (!currentProject) return;
    if (!isDevServerRunning(currentProject.path)) {
      void handleStartDevServer();
      return;
    }
    void handleRestartDevServer();
  }, [currentProject, isDevServerRunning, handleStartDevServer, handleRestartDevServer]);

  // Subscribe to the session registry so the project list updates when live
  // sessions come and go. The returned key is a newline-joined, sorted list
  // of active paths — it changes iff the set of active paths changes, which
  // is exactly when we need to re-register project commands.
  const activePathsKey = useSyncExternalStore(sessionRegistry.subscribeSimple, () =>
    sessionRegistry
      .snapshotAll()
      .map((s) => s.projectPath)
      .sort()
      .join('\n')
  );

  // Full ~/ShipStudio project listing, sorted by last_opened (desc) by the
  // backend. Refetched when pinnedPaths changes (proxy for pin/create/import).
  const [allProjects, setAllProjects] = useState<DashboardProject[]>([]);
  useEffect(() => {
    let cancelled = false;
    getDashboardProjects()
      .then((list) => {
        if (!cancelled) setAllProjects(list);
      })
      .catch((err) =>
        logger.warn('[useAppCommands] getDashboardProjects failed', { error: String(err) })
      );
    return () => {
      cancelled = true;
    };
  }, [pinnedPaths.length]);

  // ── Project switch commands — visible in both Home and Project contexts.
  // Order:
  //   1. Pinned (sidebar order) → ⌘1..⌘N shortcuts
  //   2. The rest of ~/ShipStudio, sorted by last_opened (desc) — no shortcut
  //   3. Any live external session not seen above — no shortcut
  useCommands(() => {
    const pinSet = new Set(pinnedPaths);
    const seen = new Set(pinnedPaths);

    // Defensive sort by last_opened desc (nulls last) in case the
    // backend's ordering drifts. Untouched projects fall through to path
    // order so the list is stable across renders.
    const recent = allProjects
      .filter((p) => !pinSet.has(p.path))
      .sort((a, b) => {
        const at = a.last_opened ?? 0;
        const bt = b.last_opened ?? 0;
        if (bt !== at) return bt - at;
        return a.path.localeCompare(b.path);
      });
    for (const p of recent) seen.add(p.path);

    const activePaths = activePathsKey ? activePathsKey.split('\n').filter(Boolean) : [];
    const externalActive = activePaths.filter((p) => !seen.has(p)).sort();

    const currentPath = currentProject?.path ?? null;

    const pinnedEntries = pinnedPaths.map((path, i) => ({
      path,
      name: basename(path),
      shortcut: i < 9 ? kbd('mod', String(i + 1)) : undefined,
    }));
    const recentEntries = recent.map((p) => ({
      path: p.path,
      name: p.name,
      shortcut: undefined,
    }));
    const externalEntries = externalActive.map((path) => ({
      path,
      name: basename(path),
      shortcut: undefined,
    }));

    return [...pinnedEntries, ...recentEntries, ...externalEntries]
      .filter(({ path }) => path !== currentPath)
      .map(({ path, name, shortcut }) => ({
        id: `project.goto.${path}`,
        title: name,
        subtitle: path,
        icon: <FolderOpenIcon size={14} />,
        category: 'project' as const,
        keywords: [path],
        shortcut,
        run: () => void handleSelectProject({ name, path, thumbnail: null }),
      }));
  }, [pinnedPaths, activePathsKey, allProjects, currentProject?.path, handleSelectProject]);

  // Home-context commands
  useCommands(
    () => [
      {
        id: 'project.create',
        title: 'Create new project',
        icon: <PlusIcon size={14} />,
        category: 'action',
        when: 'home',
        keywords: ['new'],
        run: handleCreateProject,
      },
      {
        id: 'project.import.github',
        title: 'Import from GitHub',
        icon: <CodeIcon size={14} />,
        category: 'action',
        when: 'home',
        keywords: ['clone', 'repo'],
        run: handleImportProject,
      },
      {
        id: 'project.import.local',
        title: 'Import local folder',
        icon: <FolderOpenIcon size={14} />,
        category: 'action',
        when: 'home',
        keywords: ['import', 'folder', 'local', 'existing'],
        run: () => void handleImportLocalFolder(),
      },
      {
        id: 'github.connect',
        title: 'Connect GitHub account',
        icon: <CodeIcon size={14} />,
        category: 'action',
        when: 'home',
        keywords: ['auth', 'login', 'sign in'],
        run: () => void handleGitHubConnect(),
      },
      {
        id: 'settings.compactWorkspaceToolbar',
        title: compactWorkspaceToolbarEnabled
          ? 'Use classic workspace toolbar'
          : 'Use compact workspace toolbar',
        icon: <PanelLeftIcon size={14} />,
        category: 'settings',
        keywords: ['compact', 'toolbar', 'topbar', 'layout', 'single row'],
        run: () => setCompactWorkspaceToolbarEnabled(!compactWorkspaceToolbarEnabled),
      },
      {
        id: 'settings.changelog',
        title: "What's new",
        icon: <SettingsIcon size={14} />,
        category: 'settings',
        keywords: ['changelog', 'release'],
        run: () => openModal('changelog'),
      },
      {
        id: 'settings.checkUpdates',
        title: 'Check for updates',
        icon: <SettingsIcon size={14} />,
        category: 'settings',
        keywords: ['version', 'upgrade'],
        run: () => void runCheckUpdates(),
      },
      {
        id: 'modal.attachedLibraries',
        title: 'Shared libraries',
        icon: <SharedLibraryIcon size={14} />,
        category: 'settings',
        keywords: [
          'library',
          'attached',
          'workspace',
          'skills',
          'add-dir',
          'vault',
          'reference',
          'cross-project',
        ],
        run: () => openModal('attachedLibraries'),
      },
    ],
    [
      handleCreateProject,
      handleImportProject,
      handleImportLocalFolder,
      handleGitHubConnect,
      compactWorkspaceToolbarEnabled,
      setCompactWorkspaceToolbarEnabled,
      openModal,
      runCheckUpdates,
    ]
  );

  // Project-context commands
  useCommands(() => {
    if (!currentProject) return [];
    const cmds = [
      {
        id: 'nav.home',
        title: 'Go to Home',
        icon: <HomeIcon size={14} />,
        category: 'navigation' as const,
        when: 'project' as const,
        run: handleBackToProjects,
      },
      // Start vs Restart are two commands rather than one with a computed
      // title: `title` is a static string baked in at registration time, and
      // `isDevServerRunning` is ref-backed, so a single entry would keep
      // whichever label was true when the bucket was last registered. `when`
      // predicates *are* re-evaluated every time the palette opens, so gating
      // on them is what keeps the label honest.
      {
        id: 'devserver.start',
        title: 'Start dev server',
        icon: <ResetIcon size={14} />,
        category: 'action' as const,
        when: ({ kind }: PaletteCtx) =>
          kind === 'project' && !!currentProject && !isDevServerRunning(currentProject.path),
        keywords: ['dev', 'server', 'vite', 'next', 'start', 'restart', 'run'],
        run: restart,
      },
      {
        id: 'devserver.restart',
        title: 'Restart dev server',
        icon: <ResetIcon size={14} />,
        category: 'action' as const,
        when: ({ kind }: PaletteCtx) =>
          kind === 'project' && !!currentProject && isDevServerRunning(currentProject.path),
        keywords: ['dev', 'server', 'vite', 'next', 'start', 'restart', 'reload'],
        run: restart,
      },
      {
        id: 'ide.finder',
        title: `Reveal in ${fileManagerName()}`,
        icon: <FolderOpenIcon size={14} />,
        category: 'action' as const,
        when: 'project' as const,
        // Keep 'finder'/'explorer'/'files' all searchable regardless of platform.
        keywords: ['finder', 'explorer', 'files', 'show', 'open folder', 'reveal'],
        run: () => void runFinder(),
      },
      {
        id: 'mode.education.toggle',
        title: isEducationMode ? 'Exit learn mode' : 'Enter learn mode',
        icon: <SettingsIcon size={14} />,
        category: 'action' as const,
        when: 'project' as const,
        keywords: ['tutorial', 'walkthrough', 'learn', 'education'],
        run: () => setIsEducationMode(!isEducationMode),
      },
    ];
    if (ide.vscode) {
      cmds.push({
        id: 'ide.vscode',
        title: 'Open in VS Code',
        icon: <CodeIcon size={14} />,
        category: 'action' as const,
        when: 'project' as const,
        keywords: ['editor', 'code'],
        run: () => void runIde('vscode')(),
      });
    }
    if (ide.cursor) {
      cmds.push({
        id: 'ide.cursor',
        title: 'Open in Cursor',
        icon: <CursorIcon size={14} />,
        category: 'action' as const,
        when: 'project' as const,
        keywords: ['editor'],
        run: () => void runIde('cursor')(),
      });
    }
    return cmds;
  }, [
    currentProject,
    handleBackToProjects,
    restart,
    isDevServerRunning,
    runFinder,
    runIde,
    ide,
    isEducationMode,
    setIsEducationMode,
  ]);

  // Modal-opener commands (project context)
  useCommands(
    () => [
      {
        id: 'modal.envEditor',
        title: 'Environment variables',
        icon: <SettingsIcon size={14} />,
        category: 'settings',
        when: 'project',
        keywords: ['.env', 'dotenv'],
        run: () => openModal('envEditor'),
      },
      {
        id: 'modal.i18n',
        title: 'Languages (multilingual site)',
        icon: <GlobeIcon size={14} />,
        category: 'settings',
        when: 'project',
        keywords: ['i18n', 'translate', 'locale', 'language', 'international', 'multilingual'],
        run: () => openModal('i18n'),
      },
      {
        id: 'modal.backups',
        title: 'Backups',
        icon: <SettingsIcon size={14} />,
        category: 'settings',
        when: 'project',
        keywords: ['restore'],
        run: () => openModal('backups'),
      },
      {
        id: 'modal.pluginManager',
        title: 'Plugin manager',
        icon: <SettingsIcon size={14} />,
        category: 'plugin',
        when: 'project',
        keywords: ['extensions'],
        run: () => openModal('pluginManager'),
      },
      {
        id: 'modal.skills',
        title: 'Skills',
        icon: <SettingsIcon size={14} />,
        category: 'plugin',
        when: 'project',
        keywords: ['claude'],
        run: () => openModal('skills'),
      },
      {
        id: 'modal.mcp',
        title: 'MCP servers',
        icon: <SettingsIcon size={14} />,
        category: 'plugin',
        when: 'project',
        run: () => openModal('mcp'),
      },
      {
        id: 'modal.projectSettings',
        title: 'Project settings',
        icon: <SettingsIcon size={14} />,
        category: 'settings',
        when: 'project',
        keywords: ['port', 'localhost', '3000', 'configure'],
        run: () => openModal('projectSettings'),
      },
      {
        id: 'modal.devCommand',
        title: 'Configure dev command',
        icon: <SettingsIcon size={14} />,
        category: 'settings',
        when: 'project',
        keywords: ['server', 'script', 'command'],
        run: () => openModal('devCommand'),
      },
      {
        id: 'modal.help',
        title: 'Help & keyboard shortcuts',
        icon: <SettingsIcon size={14} />,
        category: 'settings',
        shortcut: kbd('mod', '/'),
        run: () => openModal('help'),
      },
    ],
    [openModal]
  );
}
