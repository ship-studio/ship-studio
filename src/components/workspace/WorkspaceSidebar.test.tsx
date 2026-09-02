import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModalProvider } from '../../contexts/ModalContext';
import { PaletteContextProvider } from '../CommandPalette/paletteContext';
import { sessionRegistry } from '../../lib/sessionRegistry';
import type { PinnedProjectRow } from '../../hooks/usePinnedProjects';
import { mockInvokeResponse } from '../../test/setup';
import { WorkspaceSidebar } from './WorkspaceSidebar';

const PROJECT_PATH = '/tmp/sidebar-project';
const EXPANDED_PROJECTS_KEY = 'ship-studio:workspace-sidebar:expanded-projects';

function row(): PinnedProjectRow {
  return {
    projectPath: PROJECT_PATH,
    fallbackName: 'sidebar-project',
    status: 'active',
    agentStatus: 'thinking',
    unreadCount: 0,
    memoryBytes: 0,
    isCurrent: true,
  };
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <ModalProvider>
      <PaletteContextProvider>{children}</PaletteContextProvider>
    </ModalProvider>
  );
}

function sidebarProps(): ComponentProps<typeof WorkspaceSidebar> {
  return {
    isHomeActive: false,
    onGoHome: vi.fn(),
    onOpenProjectPicker: vi.fn(),
    projects: [row()],
    currentProjectPath: PROJECT_PATH,
    currentProjectName: 'sidebar-project',
    onSelectProject: vi.fn(),
    terminalTabs: [
      {
        id: 1,
        agentId: 'claude-code',
        sessionId: 'session-1',
      },
    ],
    activeTerminalTab: 1,
    tabTitles: new Map(),
    attentionTabs: new Set(),
    maxTabs: 5,
    onSelectTab: vi.fn(),
    onAddTab: vi.fn(),
    onCloseTab: vi.fn(),
    hasDevServer: false,
    isRestartingDevServer: false,
    devServerRunning: false,
  };
}

describe('WorkspaceSidebar project activity indicator', () => {
  beforeEach(() => {
    localStorage.clear();
    mockInvokeResponse('list_accounts', []);
    mockInvokeResponse('get_project_account_id', null);
    mockInvokeResponse('get_active_account_id', 'default');
    sessionRegistry._resetForTests();
    sessionRegistry.setTerminalTabs(
      PROJECT_PATH,
      [
        {
          id: 1,
          agentId: 'claude-code',
          sessionId: 'session-1',
          status: 'thinking',
        },
      ],
      0
    );
  });

  afterEach(() => {
    localStorage.clear();
    sessionRegistry._resetForTests();
  });

  it('uses the same icon-only ghost treatment for Home as the project titlebar', async () => {
    render(<WorkspaceSidebar {...sidebarProps()} />, { wrapper: Providers });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Home' })).toHaveClass(
        'button--ghost',
        'button--icon-only'
      );
    });
  });

  it('disables Home while the Homepage is active', async () => {
    render(<WorkspaceSidebar {...sidebarProps()} isHomeActive />, { wrapper: Providers });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Home' })).toBeDisabled();
    });
  });

  it('shows the PixelLoader in a collapsed project row when a tab is thinking', async () => {
    localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify({ [PROJECT_PATH]: false }));

    const { container } = render(<WorkspaceSidebar {...sidebarProps()} />, {
      wrapper: Providers,
    });

    await waitFor(() => {
      expect(
        container.querySelector('.sidebar-project-status .ss-pixel-loader')
      ).toBeInTheDocument();
      expect(
        container.querySelector('.sidebar-project-status .sidebar-row-dot')
      ).not.toBeInTheDocument();
    });
  });

  it('keeps the project dot while expanded and shows the PixelLoader on the tab row', async () => {
    localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify({ [PROJECT_PATH]: true }));

    const { container } = render(<WorkspaceSidebar {...sidebarProps()} />, {
      wrapper: Providers,
    });

    await waitFor(() => {
      expect(
        container.querySelector('.sidebar-project-status .sidebar-row-dot')
      ).toBeInTheDocument();
      expect(container.querySelector('.sidebar-project-body .ss-pixel-loader')).toBeInTheDocument();
    });
  });
});

/**
 * The close ("X") button on an ACTIVE-group row. These rows are rendered
 * straight off the session registry, so destroying the session is what makes
 * them go away — except for the row of the CURRENT project, which the sidebar
 * synthesizes from `currentProjectPath` when the registry has no entry (the
 * initial-open gap). That synthesis is why closing the current project must
 * also leave the workspace in the same tick; see `handleCloseProject`.
 */
describe('WorkspaceSidebar project close button', () => {
  const ACTIVE_PATH = '/tmp/active-project';
  const OTHER_PATH = '/tmp/other-project';

  function activeSidebarProps(): ComponentProps<typeof WorkspaceSidebar> {
    return {
      ...sidebarProps(),
      // Nothing pinned: the row can only come from the session registry.
      projects: [],
      currentProjectPath: null,
      currentProjectName: null,
      terminalTabs: [],
    };
  }

  beforeEach(() => {
    localStorage.clear();
    mockInvokeResponse('list_accounts', []);
    mockInvokeResponse('get_project_account_id', null);
    mockInvokeResponse('get_active_account_id', 'default');
    sessionRegistry._resetForTests();
    sessionRegistry.getOrCreate(ACTIVE_PATH);
    sessionRegistry.getOrCreate(OTHER_PATH);
  });

  afterEach(() => {
    localStorage.clear();
    sessionRegistry._resetForTests();
  });

  it('removes a background project row and never re-registers it on the next mirror sync', async () => {
    const user = userEvent.setup();
    const onCloseProject = vi.fn((path: string) => {
      // What App.tsx's handleCloseProject does synchronously.
      sessionRegistry.destroy(path);
    });

    render(<WorkspaceSidebar {...activeSidebarProps()} onCloseProject={onCloseProject} />, {
      wrapper: Providers,
    });

    await user.click(await screen.findByRole('button', { name: 'Close active-project' }));
    expect(onCloseProject).toHaveBeenCalledWith(ACTIVE_PATH);

    // Source of truth first…
    expect(sessionRegistry.snapshot(ACTIVE_PATH)).toBeUndefined();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Close active-project' })).toBeNull();
    });

    // …then the mirror sync App.tsx runs whenever terminal state changes. It
    // iterates the surviving sessions only; a closed project must not be
    // resurrected by it (`setTerminalTabs` auto-creates missing entries).
    act(() => {
      for (const path of [OTHER_PATH]) {
        sessionRegistry.setTerminalTabs(
          path,
          [{ id: 1, agentId: 'claude-code', sessionId: 's' }],
          0
        );
      }
    });
    expect(sessionRegistry.snapshot(ACTIVE_PATH)).toBeUndefined();
    expect(screen.queryByRole('button', { name: 'Close active-project' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close other-project' })).toBeInTheDocument();
  });

  it('keeps synthesizing the current project row until the workspace is left', async () => {
    const user = userEvent.setup();
    const onCloseProject = vi.fn((path: string) => sessionRegistry.destroy(path));

    const { rerender } = render(
      <WorkspaceSidebar
        {...activeSidebarProps()}
        currentProjectPath={ACTIVE_PATH}
        currentProjectName="active-project"
        onCloseProject={onCloseProject}
      />,
      { wrapper: Providers }
    );

    await user.click(await screen.findByRole('button', { name: 'Close active-project' }));
    expect(onCloseProject).toHaveBeenCalledWith(ACTIVE_PATH);
    expect(sessionRegistry.snapshot(ACTIVE_PATH)).toBeUndefined();

    // Destroying the session is NOT enough on its own — the row is re-derived
    // from `currentProjectPath`. This is the flicker users reported.
    expect(screen.getByRole('button', { name: 'Close active-project' })).toBeInTheDocument();

    // handleCloseProject clears the current project in the same tick, which
    // is what actually retires the row.
    rerender(
      <WorkspaceSidebar
        {...activeSidebarProps()}
        currentProjectPath={null}
        currentProjectName={null}
        onCloseProject={onCloseProject}
      />
    );
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Close active-project' })).toBeNull();
    });
  });
});
