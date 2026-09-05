import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('collapses an empty Active group by default', async () => {
    sessionRegistry._resetForTests();

    render(
      <WorkspaceSidebar
        {...sidebarProps()}
        projects={[]}
        currentProjectPath={null}
        currentProjectName={null}
        terminalTabs={[]}
      />,
      { wrapper: Providers }
    );

    const activeGroup = await screen.findByRole('button', { name: /Active/ });
    expect(activeGroup).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('No active projects yet.')).not.toBeInTheDocument();
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

  it('opens project actions from a sidebar row context menu', async () => {
    const onUnpinProject = vi.fn();
    const { container } = render(
      <WorkspaceSidebar {...sidebarProps()} onUnpinProject={onUnpinProject} />,
      { wrapper: Providers }
    );

    const projectRow = container.querySelector<HTMLElement>('.sidebar-project-row');
    expect(projectRow).not.toBeNull();
    fireEvent.contextMenu(projectRow!);

    expect(screen.getByRole('menuitem', { name: 'Project Settings' })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Unpin from sidebar' }));

    expect(onUnpinProject).toHaveBeenCalledWith(PROJECT_PATH);
  });

  it('keeps the full project action set visible and disables unavailable actions', () => {
    const { container } = render(<WorkspaceSidebar {...sidebarProps()} />, {
      wrapper: Providers,
    });

    fireEvent.contextMenu(container.querySelector<HTMLElement>('.sidebar-project-row')!);

    expect(screen.getByRole('menuitem', { name: 'Project Settings' })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: 'Rename project' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Stop dev server' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Unpin from sidebar' })).toBeDisabled();
  });

  it('toggles a pinned project to unpinned from the context menu', async () => {
    const user = userEvent.setup();
    const onTogglePinProject = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <WorkspaceSidebar {...sidebarProps()} onTogglePinProject={onTogglePinProject} />,
      { wrapper: Providers }
    );

    fireEvent.contextMenu(container.querySelector<HTMLElement>('.sidebar-project-row')!);

    await user.click(screen.getByRole('menuitem', { name: 'Unpin from sidebar' }));

    expect(onTogglePinProject).toHaveBeenCalledWith(PROJECT_PATH, false);
  });

  it('opens the rename modal and commits a sidebar project rename', async () => {
    const user = userEvent.setup();
    const onRenameProject = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <WorkspaceSidebar {...sidebarProps()} onRenameProject={onRenameProject} />,
      { wrapper: Providers }
    );

    fireEvent.contextMenu(container.querySelector<HTMLElement>('.sidebar-project-row')!);
    await user.click(screen.getByRole('menuitem', { name: 'Rename project' }));

    const input = await screen.findByLabelText('Project name');
    fireEvent.change(input, { target: { value: 'renamed-project' } });
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() => {
      expect(onRenameProject).toHaveBeenCalledWith(PROJECT_PATH, 'renamed-project');
    });
  });

  it('shows and stops a running project dev server from the context menu', async () => {
    const user = userEvent.setup();
    const onStopDevServer = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <WorkspaceSidebar
        {...sidebarProps()}
        isProjectDevServerRunning={() => true}
        onStopDevServer={onStopDevServer}
      />,
      { wrapper: Providers }
    );

    fireEvent.contextMenu(container.querySelector<HTMLElement>('.sidebar-project-row')!);
    await user.click(screen.getByRole('menuitem', { name: 'Stop dev server' }));

    expect(onStopDevServer).toHaveBeenCalledWith(PROJECT_PATH);
  });

  it('opens project settings for the sidebar project', async () => {
    mockInvokeResponse('get_dev_server_port', 4321);
    const { container } = render(<WorkspaceSidebar {...sidebarProps()} />, {
      wrapper: Providers,
    });

    const projectRow = container.querySelector<HTMLElement>('.sidebar-project-row');
    expect(projectRow).not.toBeNull();
    fireEvent.contextMenu(projectRow!);
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Project Settings' }));

    expect(await screen.findByRole('dialog', { name: 'Project Settings' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton')).toHaveValue(4321);
  });

  it('opens the workspace switcher and switches accounts from its upward menu', async () => {
    const defaultWorkspace = {
      id: 'default',
      name: 'Default',
      color: '#6b7280',
      isDefault: true,
      createdAt: 1,
    };
    const clientWorkspace = {
      id: 'client',
      name: 'Client',
      color: '#3b82f6',
      isDefault: false,
      createdAt: 2,
    };
    const onGoHome = vi.fn();
    const setActive = vi.fn();
    mockInvokeResponse('list_accounts', [defaultWorkspace, clientWorkspace]);
    mockInvokeResponse('set_active_account_id', (args: unknown) => {
      setActive(args);
    });

    const user = userEvent.setup();
    render(<WorkspaceSidebar {...sidebarProps()} onGoHome={onGoHome} onSwitchAccount={vi.fn()} />, {
      wrapper: Providers,
    });

    const trigger = await screen.findByRole('button', {
      name: 'Switch workspace, currently Default',
    });
    expect(trigger).toHaveClass('button--default');
    expect(trigger).not.toHaveAttribute('title');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger.querySelector('.workspace-switcher-dot')).toHaveTextContent('D');
    expect(trigger.closest('.workspace-sidebar-footer-actions')).toHaveClass(
      'has-workspace-switcher'
    );

    const openProjectButton = screen.getByRole('button', { name: 'Open project' });
    expect(openProjectButton).toHaveClass('button--ghost');
    expect(openProjectButton.closest('.workspace-sidebar-active-actions')).toBeInTheDocument();
    expect(openProjectButton.closest('.workspace-sidebar-scroll')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Support' })).toHaveClass(
      'button--default',
      'button--icon-only'
    );
    expect(screen.getByRole('button', { name: 'App settings' })).toHaveClass(
      'button--default',
      'button--icon-only'
    );

    await user.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveClass('button--ghost');
    const currentWorkspaceButton = screen.getByRole('button', {
      name: 'Default, current workspace',
    });
    expect(currentWorkspaceButton).toBeVisible();
    expect(currentWorkspaceButton).toHaveAttribute('aria-current', 'true');
    expect(currentWorkspaceButton).toHaveAttribute('data-selected', 'true');
    const options = screen.getByRole('group', { name: 'Available workspaces' });
    expect(options).toHaveClass('workspace-switcher-options');
    expect(options).not.toHaveClass('is-portal');
    expect(options.parentElement).toBe(trigger.closest('.workspace-switcher'));
    expect(options.querySelector('.workspace-switcher-options-stack')?.lastElementChild).toBe(
      currentWorkspaceButton
    );
    const manageButton = screen.getByRole('button', { name: 'Manage workspaces' });
    const clientButton = screen.getByRole('button', { name: 'Switch to Client' });
    expect(manageButton).toBeVisible();
    expect(clientButton).toBeVisible();
    const newWorkspaceButton = screen.getByRole('button', { name: 'New workspace' });
    expect(newWorkspaceButton).toBeVisible();
    expect(
      newWorkspaceButton.querySelector('[data-icon-name="NewWorkspaceIcon"]')
    ).toBeInTheDocument();
    expect(manageButton.querySelector('[data-icon-name="SettingsIcon"]')).toBeInTheDocument();
    expect(clientButton.querySelector('.workspace-switcher-dot')).toHaveTextContent('C');
    expect(clientButton.querySelector('.workspace-switcher-option-dot')).toBeInTheDocument();

    await user.click(newWorkspaceButton);
    expect(screen.getByRole('dialog', { name: 'New Workspace' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. Client B')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close dialog' }));

    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Switch to Client' }));

    await waitFor(() => {
      expect(setActive).toHaveBeenCalledWith({ id: 'client' });
      expect(onGoHome).toHaveBeenCalledOnce();
    });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the workspace switcher available as icon-only controls when collapsed', async () => {
    const defaultWorkspace = {
      id: 'default',
      name: 'Default',
      color: '#6b7280',
      isDefault: true,
      createdAt: 1,
    };
    const clientWorkspace = {
      id: 'client',
      name: 'Client',
      color: '#3b82f6',
      isDefault: false,
      createdAt: 2,
    };
    mockInvokeResponse('list_accounts', [defaultWorkspace, clientWorkspace]);

    const user = userEvent.setup();
    render(<WorkspaceSidebar {...sidebarProps()} isSidebarHidden onSwitchAccount={vi.fn()} />, {
      wrapper: Providers,
    });

    const trigger = await screen.findByRole('button', {
      name: 'Switch workspace, currently Default',
    });
    expect(trigger).toHaveClass('button--icon-only');
    expect(trigger).toHaveAttribute('title', 'Switch workspace, currently Default');
    const switcher = trigger.closest('.workspace-switcher');
    expect(switcher).toBeInTheDocument();
    expect(switcher?.querySelector('#workspace-switcher-options')).not.toBeInTheDocument();

    await user.click(trigger);

    const options = screen.getByRole('group', { name: 'Available workspaces' });
    expect(options).toHaveClass('workspace-switcher-options', 'is-portal');
    expect(options.parentElement).toBe(document.body);

    const manageButton = screen.getByRole('button', { name: 'Manage workspaces' });
    const newWorkspaceButton = screen.getByRole('button', { name: 'New workspace' });
    const currentWorkspaceButton = screen.getByRole('button', {
      name: 'Default, current workspace',
    });
    const clientButton = screen.getByRole('button', { name: 'Switch to Client' });
    expect(manageButton).not.toHaveClass('button--icon-only');
    expect(newWorkspaceButton).not.toHaveClass('button--icon-only');
    expect(currentWorkspaceButton).not.toHaveClass('button--icon-only');
    expect(clientButton).not.toHaveClass('button--icon-only');
    expect(manageButton).toHaveTextContent('Manage workspaces');
    expect(newWorkspaceButton).toHaveTextContent('New workspace');
    expect(currentWorkspaceButton).toHaveTextContent('Default');
    expect(clientButton).toHaveTextContent('Client');
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

  it('offers Pin to sidebar for an unpinned active project', async () => {
    const user = userEvent.setup();
    const onTogglePinProject = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <WorkspaceSidebar {...activeSidebarProps()} onTogglePinProject={onTogglePinProject} />,
      { wrapper: Providers }
    );

    fireEvent.contextMenu(container.querySelector<HTMLElement>('.sidebar-project-row')!);

    await user.click(screen.getByRole('menuitem', { name: 'Pin to sidebar' }));

    expect(onTogglePinProject).toHaveBeenCalledWith(ACTIVE_PATH, true);
  });
});
