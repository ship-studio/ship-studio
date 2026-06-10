import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useCommands } from './useCommands';
import { useOpenModal } from '../contexts/ModalContext';
import { getDashboardProjects, type DashboardProject, type Project } from '../lib/project';
import { sessionRegistry } from '../lib/sessionRegistry';
import { checkForUpdate } from '../lib/updater';
import { checkIdeAvailability, openInIde, openInFinder } from '../lib/ide';
import { logger } from '../lib/logger';
import {
  CodeIcon,
  CursorIcon,
  FolderIcon,
  GlobeIcon,
  PlusIcon,
  SettingsIcon,
} from '../components/icons';

/** Inline restart/refresh glyph — no equivalent in the icons/ lib yet. */
const RestartGlyph = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="1 4 1 10 7 10" />
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
  </svg>
);

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
  /** Current education-mode state, so the command can read "Enter" vs "Exit". */
  isEducationMode: boolean;
  setIsEducationMode: (mode: boolean) => void;
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
  isEducationMode,
  setIsEducationMode,
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
      showToast('Could not reveal in Finder', 'error');
      logger.warn('[useAppCommands] openInFinder failed', { error: String(err) });
    }
  }, [currentProject, showToast]);

  const runCheckUpdates = useCallback(async () => {
    try {
      const result = await checkForUpdate();
      if (!result) showToast("You're up to date", 'success');
      // If there IS an update, the UpdateBanner already surfaces it.
    } catch (err) {
      logger.warn('[useAppCommands] checkForUpdate failed', { error: String(err) });
      showToast('Could not check for updates', 'error');
    }
  }, [showToast]);

  // Wrappers to keep `run` type Promise<void> | void clean for the registry.
  const restart = useCallback(() => void handleRestartDevServer(), [handleRestartDevServer]);

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
      name: path.split('/').pop() ?? path,
      shortcut: i < 9 ? `⌘${i + 1}` : undefined,
    }));
    const recentEntries = recent.map((p) => ({
      path: p.path,
      name: p.name,
      shortcut: undefined,
    }));
    const externalEntries = externalActive.map((path) => ({
      path,
      name: path.split('/').pop() ?? path,
      shortcut: undefined,
    }));

    return [...pinnedEntries, ...recentEntries, ...externalEntries]
      .filter(({ path }) => path !== currentPath)
      .map(({ path, name, shortcut }) => ({
        id: `project.goto.${path}`,
        title: name,
        subtitle: path,
        icon: <FolderIcon size={14} />,
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
        icon: <FolderIcon size={14} />,
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
    ],
    [
      handleCreateProject,
      handleImportProject,
      handleImportLocalFolder,
      handleGitHubConnect,
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
        icon: <FolderIcon size={14} />,
        category: 'navigation' as const,
        when: 'project' as const,
        run: handleBackToProjects,
      },
      {
        id: 'devserver.restart',
        title: 'Restart dev server',
        icon: <RestartGlyph />,
        category: 'action' as const,
        when: 'project' as const,
        keywords: ['dev', 'server', 'vite', 'next'],
        run: restart,
      },
      {
        id: 'ide.finder',
        title: 'Reveal in Finder',
        icon: <FolderIcon size={14} />,
        category: 'action' as const,
        when: 'project' as const,
        keywords: ['finder', 'show', 'open folder'],
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
        keywords: ['configure'],
        run: () => openModal('projectSettings'),
      },
      {
        id: 'modal.devCommand',
        title: 'Configure dev command',
        icon: <SettingsIcon size={14} />,
        category: 'settings',
        when: 'project',
        keywords: ['port', 'server', 'script'],
        run: () => openModal('devCommand'),
      },
      {
        id: 'modal.help',
        title: 'Help & keyboard shortcuts',
        icon: <SettingsIcon size={14} />,
        category: 'settings',
        shortcut: '⌘/',
        run: () => openModal('help'),
      },
    ],
    [openModal]
  );
}
