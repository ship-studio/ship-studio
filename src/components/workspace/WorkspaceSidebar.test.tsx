import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModalProvider } from '../../contexts/ModalContext';
import { PaletteContextProvider } from '../CommandPalette/paletteContext';
import { sessionRegistry, type SessionTerminalTab } from '../../lib/sessionRegistry';
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

function pinnedRow(projectPath: string, fallbackName: string): PinnedProjectRow {
  return {
    projectPath,
    fallbackName,
    status: 'inactive',
    agentStatus: 'idle',
    unreadCount: 0,
    memoryBytes: 0,
    isCurrent: false,
  };
}

function pointer(type: string, x: number, y: number, pointerId = 1) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: 'mouse' },
    clientX: { value: x },
    clientY: { value: y },
  });
  return event;
}

function mockPinnedRects() {
  const items = [...document.querySelectorAll<HTMLElement>('[data-drag-sort-item]')];
  items.forEach((item, index) => {
    Object.defineProperty(item, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: index * 30,
        right: 280,
        bottom: index * 30 + 20,
        width: 280,
        height: 20,
      }),
    });
  });
  return items;
}

function setItemRect(item: HTMLElement, top: number, height = 20) {
  Object.defineProperty(item, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 0,
      top,
      right: 280,
      bottom: top + height,
      width: 280,
      height,
    }),
  });
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
    mockInvokeResponse('get_spotify_widget_enabled', false);
    mockInvokeResponse('get_spotify_state', null);
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

  it('opens a full-width Settings summary in the sidebar footer and restores the gear trigger', async () => {
    const { container } = render(<WorkspaceSidebar {...sidebarProps()} />, { wrapper: Providers });

    const trigger = screen.getByRole('button', { name: 'Settings & Help' });
    expect(trigger).toHaveAttribute('data-settings-menu-trigger', 'workspace');
    expect(trigger).toHaveClass('button--icon-only');
    expect(trigger).not.toHaveTextContent('Settings');
    expect(trigger.querySelector('.workspace-switcher-chevron')).not.toBeInTheDocument();
    fireEvent.click(trigger);

    const menu = await screen.findByRole('menu');
    const drawer = menu.closest('.workspace-sidebar-settings-menu');
    expect(drawer).toHaveClass('is-open');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveClass('workspace-sidebar-settings-summary', 'button--fill');
    expect(trigger).not.toHaveClass('button--icon-only');
    expect(trigger).toHaveTextContent('Settings');
    const settingsChevron = trigger.querySelector('.workspace-switcher-chevron.is-open');
    expect(settingsChevron).toBeInTheDocument();
    expect(settingsChevron?.querySelector('[data-icon-name="ChevronIcon"]')).toBeInTheDocument();
    const settingsLabel = trigger.querySelector('.workspace-switcher-name')!;
    expect(
      settingsLabel.compareDocumentPosition(settingsChevron!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      menu.closest('.workspace-sidebar-footer-actions.has-settings-drawer')
    ).toBeInTheDocument();
    expect(menu.closest('.workspace-sidebar')).toBeInTheDocument();
    expect(container.contains(menu)).toBe(true);
    expect(menu.querySelector('[data-settings-item="bug-reports"]')).toBeInTheDocument();
    expect(menu.querySelector('[data-settings-item="feature-request"]')).toBeInTheDocument();
    expect(menu.querySelector('.ss-dropdown__divider')).not.toBeInTheDocument();

    fireEvent.click(trigger);

    await waitFor(() => {
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(trigger).toHaveClass('button--icon-only');
      expect(trigger).not.toHaveTextContent('Settings');
      expect(trigger.querySelector('.workspace-switcher-chevron')).not.toBeInTheDocument();
    });
  });

  it('dismisses the Settings drawer with Escape and an outside click', async () => {
    render(<WorkspaceSidebar {...sidebarProps()} />, { wrapper: Providers });
    const trigger = screen.getByRole('button', { name: 'Settings & Help' });

    fireEvent.click(trigger);
    await screen.findByRole('menu');
    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => {
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(trigger).toHaveFocus();
    });

    fireEvent.click(trigger);
    await screen.findByRole('menu');
    fireEvent.mouseDown(document.body);

    await waitFor(() => {
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });

  it('expands the collapsed rail before keeping Settings open and restores its gear on close', async () => {
    const onToggleSidebar = vi.fn();
    const props = sidebarProps();
    const { rerender } = render(
      <WorkspaceSidebar {...props} isSidebarHidden onToggleSidebar={onToggleSidebar} />,
      { wrapper: Providers }
    );

    const trigger = screen.getByRole('button', { name: 'Settings & Help' });
    expect(trigger).toHaveClass('button--icon-only');
    expect(trigger.querySelector('.workspace-switcher-chevron')).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(onToggleSidebar).toHaveBeenCalledOnce();

    rerender(
      <WorkspaceSidebar {...props} isSidebarHidden={false} onToggleSidebar={onToggleSidebar} />
    );

    await waitFor(() => {
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      expect(trigger).toHaveTextContent('Settings');
      expect(trigger).toHaveClass('workspace-sidebar-settings-summary', 'button--fill');
    });
    expect(
      trigger.querySelector('.workspace-switcher-chevron.is-open [data-icon-name="ChevronIcon"]')
    ).toBeInTheDocument();

    fireEvent.click(trigger);

    await waitFor(() => {
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(trigger).toHaveClass('button--icon-only');
      expect(trigger.querySelector('.workspace-switcher-chevron')).not.toBeInTheDocument();
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

  it('renders with no projects when projects can move between groups', async () => {
    sessionRegistry._resetForTests();

    render(
      <WorkspaceSidebar
        {...sidebarProps()}
        isHomeActive
        projects={[]}
        currentProjectPath={null}
        currentProjectName={null}
        terminalTabs={[]}
        onReorderProjects={vi.fn()}
        onTogglePinProject={vi.fn()}
      />,
      { wrapper: Providers }
    );

    expect(await screen.findByRole('button', { name: /Active/ })).toBeInTheDocument();
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

  it('shows one server light for a ready server on an idle project row', () => {
    localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify({ [PROJECT_PATH]: true }));
    act(() => {
      sessionRegistry.setTerminalTabs(
        PROJECT_PATH,
        [
          {
            id: 1,
            agentId: 'claude-code',
            sessionId: 'session-1',
            status: 'running',
          },
        ],
        0
      );
    });

    const { container } = render(
      <WorkspaceSidebar
        {...sidebarProps()}
        hasDevServer
        devServerRunning
        getProjectDevServerSnapshot={() => ({
          status: 'ready',
          address: 'localhost:3000',
          instanceId: 1,
        })}
      />,
      { wrapper: Providers }
    );

    const status = container.querySelector('.sidebar-project-status');
    expect(status?.querySelectorAll('.sidebar-row-dot')).toHaveLength(1);
    expect(status?.querySelector('.dot-server-ready')).toBeInTheDocument();
    expect(status?.querySelector('.dot-idle')).not.toBeInTheDocument();
    expect(container.querySelector('.sidebar-project-row')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('dev server running; localhost:3000')
    );
    expect(screen.getByText('localhost:3000')).toBeInTheDocument();
    expect(screen.queryByText('running')).not.toBeInTheDocument();
  });

  const activityCases = [
    {
      name: 'error',
      rowStatus: 'active',
      label: 'error',
      status: 'crashed',
    },
    {
      name: 'waiting',
      rowStatus: 'active',
      label: 'agent waiting for input',
      status: 'running',
      attention: true,
    },
    {
      name: 'working',
      rowStatus: 'active',
      label: 'agent working',
      status: 'thinking',
    },
    {
      name: 'idle',
      rowStatus: 'active',
      label: 'open and idle',
      status: 'running',
    },
    {
      name: 'closed',
      rowStatus: 'inactive',
      label: 'closed',
      status: null,
    },
  ] as const;

  const serverStatuses = ['ready', 'starting', 'stopped', 'not-running'] as const;
  const serverLabels = {
    ready: 'dev server running',
    starting: 'dev server starting',
    stopped: 'dev server stopped',
    'not-running': null,
  } as const;
  const serverDots = {
    ready: 'dot-server-ready',
    starting: 'dot-server-starting',
    stopped: 'dot-server-stopped',
    'not-running': null,
  } as const;

  it.each(
    activityCases.flatMap((activity) =>
      serverStatuses.map((serverStatus) => ({ activity, serverStatus }))
    )
  )(
    'renders one prioritized title indicator for $activity.name with a $serverStatus server',
    ({ activity, serverStatus }) => {
      const currentPath = '/tmp/matrix-current';
      const backgroundPath = '/tmp/matrix-background';
      const currentName = 'matrix-current';
      const backgroundName = 'matrix-background';
      localStorage.setItem(
        EXPANDED_PROJECTS_KEY,
        JSON.stringify({ [currentPath]: false, [backgroundPath]: false })
      );
      sessionRegistry._resetForTests();

      const makeTabs = (projectPath: string): SessionTerminalTab[] =>
        activity.status === null
          ? []
          : [
              {
                id: 1,
                agentId: 'claude-code',
                sessionId: `${projectPath}-agent`,
                status: activity.status,
                attention: 'attention' in activity ? activity.attention : undefined,
              },
            ];
      const currentTabs = makeTabs(currentPath);
      const backgroundTabs = makeTabs(backgroundPath);
      if (currentTabs.length > 0) sessionRegistry.setTerminalTabs(currentPath, currentTabs, 0);
      if (backgroundTabs.length > 0) {
        sessionRegistry.setTerminalTabs(backgroundPath, backgroundTabs, 0);
      }

      const currentRow = {
        ...pinnedRow(currentPath, currentName),
        status: activity.rowStatus,
      };
      const backgroundRow = {
        ...pinnedRow(backgroundPath, backgroundName),
        status: activity.rowStatus,
      };
      const serverLabel = serverLabels[serverStatus];
      const address = serverStatus === 'ready' ? 'localhost:3000' : null;
      const { container } = render(
        <WorkspaceSidebar
          {...sidebarProps()}
          projects={[currentRow, backgroundRow]}
          currentProjectPath={currentPath}
          currentProjectName={currentName}
          terminalTabs={currentTabs}
          activeTerminalTab={currentTabs[0]?.id ?? 0}
          attentionTabs={new Set('attention' in activity ? [1] : [])}
          getProjectDevServerSnapshot={() => ({
            status: serverStatus,
            address,
            instanceId: serverStatus === 'ready' ? 1 : null,
          })}
        />,
        { wrapper: Providers }
      );

      const projectRow = (name: string) =>
        [...container.querySelectorAll<HTMLElement>('.sidebar-project-row')].find((candidate) =>
          candidate.getAttribute('aria-label')?.startsWith(`${name};`)
        );
      const expectedIndicator = (isCurrent: boolean, isExpanded: boolean) => {
        if (activity.name === 'error') return 'dot-error';
        if (activity.name === 'waiting') return 'dot-waiting';
        if (activity.name === 'working') return isExpanded ? 'dot-active' : 'pixel-loader';
        const serverDot = serverDots[serverStatus];
        if (serverDot) {
          return serverStatus === 'ready' && isExpanded && !isCurrent ? 'dot-active' : serverDot;
        }
        return activity.name === 'idle' ? 'dot-idle' : 'dot-muted';
      };
      const expectProjectStatus = (name: string, isCurrent: boolean, isExpanded: boolean) => {
        const row = projectRow(name);
        const expectedLabel = [
          name,
          activity.label,
          serverLabel,
          address,
          isCurrent ? 'current project' : null,
        ]
          .filter(Boolean)
          .join('; ');
        expect(row).toHaveAttribute('aria-label', expectedLabel);

        const status = row?.querySelector('.sidebar-project-status');
        const indicators = status?.querySelectorAll('.sidebar-row-dot, .ss-pixel-loader');
        expect(status?.children).toHaveLength(1);
        expect(indicators).toHaveLength(1);
        const expected = expectedIndicator(isCurrent, isExpanded);
        if (expected === 'pixel-loader') {
          expect(indicators?.[0]).toHaveClass('ss-pixel-loader');
          expect(indicators?.[0]).toHaveAttribute(`aria-label`, `Working on ${name}`);
        } else {
          expect(indicators?.[0]).toHaveClass('sidebar-row-dot', expected);
        }
      };

      expectProjectStatus(currentName, true, false);
      expectProjectStatus(backgroundName, false, false);
      const currentRowElement = projectRow(currentName)!;
      const backgroundRowElement = projectRow(backgroundName)!;
      fireEvent.click(currentRowElement.querySelector('.sidebar-project-chevron')!);
      fireEvent.click(backgroundRowElement.querySelector('.sidebar-project-chevron')!);
      expect(currentRowElement.querySelector('.sidebar-project-chevron')).toHaveAttribute(
        'aria-expanded',
        'true'
      );
      expect(backgroundRowElement.querySelector('.sidebar-project-chevron')).toHaveAttribute(
        'aria-expanded',
        'true'
      );
      expectProjectStatus(currentName, true, true);
      expectProjectStatus(backgroundName, false, true);
    }
  );

  it('updates the prioritized title indicator across simultaneous tabs and a project error', async () => {
    const projectPath = '/tmp/priority-project';
    const projectName = 'priority-project';
    localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify({ [projectPath]: true }));
    sessionRegistry._resetForTests();

    const thinkingTab: SessionTerminalTab = {
      id: 1,
      agentId: 'claude-code',
      sessionId: 'thinking-agent',
      status: 'thinking',
    };
    const attentionTab: SessionTerminalTab = {
      id: 2,
      agentId: 'claude-code',
      sessionId: 'waiting-agent',
      status: 'running',
      attention: true,
    };
    const errorTab: SessionTerminalTab = {
      id: 3,
      agentId: 'claude-code',
      sessionId: 'crashed-agent',
      status: 'crashed',
    };
    sessionRegistry.setTerminalTabs(projectPath, [thinkingTab, attentionTab, errorTab], 0);

    const project = { ...pinnedRow(projectPath, projectName), status: 'active' as const };
    const baseProps = {
      ...sidebarProps(),
      projects: [project],
      currentProjectPath: projectPath,
      currentProjectName: projectName,
      terminalTabs: [thinkingTab, attentionTab, errorTab],
      activeTerminalTab: 1,
      attentionTabs: new Set([2]),
      hasDevServer: true,
      devServerRunning: true,
      getProjectDevServerSnapshot: () => ({
        status: 'ready' as const,
        address: 'localhost:3000',
        instanceId: 1,
      }),
    };
    const { container, rerender } = render(<WorkspaceSidebar {...baseProps} />, {
      wrapper: Providers,
    });
    const projectRow = container.querySelector<HTMLElement>('.sidebar-project-row')!;
    const titleStatus = projectRow.querySelector('.sidebar-project-status')!;
    const expectTitleDot = async (dot: string, activity: string) => {
      await waitFor(() => {
        expect(titleStatus.children).toHaveLength(1);
        expect(titleStatus.querySelectorAll('.sidebar-row-dot, .ss-pixel-loader')).toHaveLength(1);
        expect(titleStatus.querySelector('.sidebar-row-dot')).toHaveClass(`dot-${dot}`);
        expect(projectRow).toHaveAttribute(
          'aria-label',
          `${projectName}; ${activity}; dev server running; localhost:3000; current project`
        );
      });
    };

    await expectTitleDot('error', 'error');
    const childRows = projectRow.parentElement?.querySelector('.sidebar-project-body');
    expect(childRows?.querySelector('.dot-attention')).toBeInTheDocument();
    expect(childRows?.querySelector('.dot-server-ready')).toBeInTheDocument();

    act(() => {
      sessionRegistry.setTerminalTabs(projectPath, [thinkingTab, attentionTab], 0);
    });
    await expectTitleDot('waiting', 'agent waiting for input');

    act(() => {
      sessionRegistry.setTerminalTabs(projectPath, [thinkingTab], 0);
    });
    await expectTitleDot('active', 'agent working');

    rerender(
      <WorkspaceSidebar
        {...baseProps}
        projects={[{ ...project, status: 'error' }]}
        terminalTabs={[thinkingTab]}
      />
    );
    await expectTitleDot('error', 'error');
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

  it('keeps a background server address visible in the collapsed row and its expanded section', async () => {
    const projectPath = '/tmp/background-project';
    const backgroundProject = pinnedRow(projectPath, 'background-project');
    const getProjectDevServerSnapshot = vi.fn(() => ({
      status: 'ready' as const,
      address: 'localhost:4321',
      instanceId: 7,
    }));
    const { container } = render(
      <WorkspaceSidebar
        {...sidebarProps()}
        projects={[backgroundProject]}
        currentProjectPath="/tmp/current-project"
        currentProjectName="current-project"
        terminalTabs={[]}
        getProjectDevServerSnapshot={getProjectDevServerSnapshot}
      />,
      { wrapper: Providers }
    );

    const projectRow = container.querySelector<HTMLElement>('.sidebar-project-row');
    expect(projectRow).toHaveAttribute(
      'aria-label',
      expect.stringContaining('dev server running; localhost:4321')
    );
    expect(projectRow?.querySelector('.dot-server-ready')).toBeInTheDocument();

    const expandButton = projectRow?.querySelector<HTMLButtonElement>('.sidebar-project-chevron');
    expect(expandButton).not.toBeNull();
    act(() => {
      fireEvent.click(expandButton!);
    });
    expect(await screen.findByText('localhost:4321')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(
      projectRow?.querySelector('.sidebar-project-status .dot-server-ready')
    ).not.toBeInTheDocument();
    expect(projectRow?.querySelector('.sidebar-project-status .dot-active')).toBeInTheDocument();
    expect(
      screen.getByText('localhost:4321').closest('.sidebar-row')?.querySelector('.dot-server-ready')
    ).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'Settings & Help' })).toHaveClass(
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

  it('sorts only pinned rows with a leading handle and a full presentational overlay', async () => {
    vi.useFakeTimers();
    try {
      const projects = [
        pinnedRow('/tmp/alpha', 'alpha'),
        pinnedRow('/tmp/beta', 'beta'),
        pinnedRow('/tmp/gamma', 'gamma'),
      ];
      const onReorderProjects = vi.fn().mockResolvedValue(undefined);
      const onSelectProject = vi.fn();
      render(
        <WorkspaceSidebar
          {...sidebarProps()}
          projects={projects}
          currentProjectPath={null}
          currentProjectName={null}
          terminalTabs={[]}
          onSelectProject={onSelectProject}
          onReorderProjects={onReorderProjects}
        />,
        { wrapper: Providers }
      );

      const items = mockPinnedRects();
      expect(items).toHaveLength(3);
      const firstRow = items[0]?.querySelector<HTMLElement>('.sidebar-project-row');
      const handle = within(firstRow!).getByRole('button', { name: 'Move alpha project' });
      expect(firstRow?.firstElementChild).toBe(handle);
      expect(handle).toHaveClass('drag-sort__handle', 'sidebar-project-drag-handle');
      expect(handle).toHaveAttribute('data-drag-sort-handle-visibility', 'hover');
      expect(firstRow).toHaveAttribute('aria-label', expect.stringContaining('alpha; closed'));
      expect(firstRow).not.toHaveAttribute('title');
      expect(handle).not.toHaveAttribute('title');
      expect(firstRow?.querySelectorAll('[title]')).toHaveLength(0);

      fireEvent(handle, pointer('pointerdown', 10, 10));
      fireEvent(window, pointer('pointermove', 10, 75));
      expect(items[0]).toHaveAttribute('data-drag-sort-placeholder', 'true');
      expect(items[0]).toHaveStyle({ '--drag-sort-transform': 'translate3d(0px, 60px, 0)' });
      expect(items[1]).toHaveStyle({ '--drag-sort-transform': 'translate3d(0px, -30px, 0)' });
      expect(items[2]).toHaveStyle({ '--drag-sort-transform': 'translate3d(0px, -30px, 0)' });
      expect(items[2]).toHaveAttribute('data-drag-sort-target', 'true');
      expect(items[2]).toHaveAttribute('data-drag-sort-placement', 'after');
      expect(items[2]).not.toHaveAttribute('data-drag-sort-target-indicator');
      const placeholder = document.querySelector('[data-drag-sort-placeholder-gap="true"]');
      expect(placeholder).toHaveClass('workspace-sidebar-project-drop-placeholder');

      const overlay = document.querySelector('[data-drag-sort-overlay="true"]') as HTMLElement;
      expect(overlay).toBeInTheDocument();
      expect(overlay).toHaveStyle({
        '--drag-sort-overlay-width': '280px',
        '--drag-sort-overlay-height': '20px',
        '--drag-sort-overlay-y': '65px',
      });
      expect(overlay.querySelector('[data-drag-sort-overlay-content="true"]')).toHaveTextContent(
        'alpha'
      );
      expect(overlay.querySelector('.sidebar-project-chevron')).toBeInTheDocument();

      fireEvent(window, pointer('pointerup', 10, 75));
      fireEvent.click(firstRow!);
      expect(onSelectProject).not.toHaveBeenCalled();
      expect(onReorderProjects).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(250);
        await Promise.resolve();
      });
      expect(onReorderProjects).toHaveBeenCalledOnce();
      expect(onReorderProjects).toHaveBeenCalledWith(['/tmp/beta', '/tmp/gamma', '/tmp/alpha']);
      expect(document.querySelector('[data-drag-sort-overlay="true"]')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports keyboard reorder through the leading pinned-project handle', async () => {
    vi.useFakeTimers();
    try {
      const projects = [
        pinnedRow('/tmp/alpha', 'alpha'),
        pinnedRow('/tmp/beta', 'beta'),
        pinnedRow('/tmp/gamma', 'gamma'),
      ];
      const onReorderProjects = vi.fn().mockResolvedValue(undefined);
      render(
        <WorkspaceSidebar
          {...sidebarProps()}
          projects={projects}
          currentProjectPath={null}
          currentProjectName={null}
          terminalTabs={[]}
          onReorderProjects={onReorderProjects}
        />,
        { wrapper: Providers }
      );

      const items = mockPinnedRects();
      const handle = within(items[1]).getByRole('button', { name: 'Move beta project' });
      fireEvent.keyDown(handle, { key: ' ' });
      fireEvent.keyDown(handle, { key: 'ArrowDown' });
      fireEvent.keyDown(handle, { key: ' ' });

      await act(async () => {
        vi.advanceTimersByTime(250);
        await Promise.resolve();
      });
      expect(onReorderProjects).toHaveBeenCalledOnce();
      expect(onReorderProjects).toHaveBeenCalledWith(['/tmp/alpha', '/tmp/gamma', '/tmp/beta']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an expanded project row-sized while dragging and shows its expanded chevron', async () => {
    localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify({ '/tmp/alpha': true }));
    const projects = [pinnedRow('/tmp/alpha', 'alpha'), pinnedRow('/tmp/beta', 'beta')];
    render(
      <WorkspaceSidebar
        {...sidebarProps()}
        projects={projects}
        currentProjectPath={null}
        currentProjectName={null}
        terminalTabs={[]}
        onReorderProjects={vi.fn()}
      />,
      { wrapper: Providers }
    );

    const items = mockPinnedRects();
    Object.defineProperty(items[0], 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        const height = items[0].getAttribute('data-drag-sort-dragging') === 'true' ? 21 : 90;
        return { left: 0, top: 0, right: 280, bottom: height, width: 280, height };
      },
    });
    const handle = within(items[0]).getByRole('button', { name: 'Move alpha project' });
    act(() => {
      fireEvent(handle, pointer('pointerdown', 10, 10));
      fireEvent(window, pointer('pointermove', 10, 20));
    });

    const overlay = document.querySelector('[data-drag-sort-overlay="true"]');
    expect(overlay).toBeInTheDocument();
    expect(items[0]).toHaveAttribute('data-drag-sort-collapse-when-dragging', 'true');
    expect(overlay).toHaveStyle({ '--drag-sort-overlay-height': '21px' });
    expect(overlay).toHaveAttribute('data-drag-sort-id', '/tmp/alpha');
    expect(
      overlay?.querySelector('.sidebar-project-chevron[aria-expanded="true"]')
    ).toBeInTheDocument();
    expect(items[0]).toHaveAttribute('data-drag-sort-placeholder', 'true');
    await act(async () => {
      fireEvent(window, pointer('pointercancel', 10, 20));
      await Promise.resolve();
    });
  });

  it('sorts Active rows independently with an alphabetical fallback and disables both groups when compact', async () => {
    sessionRegistry._resetForTests();
    const activePaths = ['/tmp/zulu-project', '/tmp/alpha-active', '/tmp/mid-active'];
    for (const activePath of activePaths) sessionRegistry.getOrCreate(activePath);
    const projects = [pinnedRow('/tmp/beta', 'beta'), pinnedRow('/tmp/alpha', 'alpha')];
    const { container, rerender } = render(
      <WorkspaceSidebar
        {...sidebarProps()}
        projects={projects}
        currentProjectPath={null}
        currentProjectName={null}
        terminalTabs={[]}
        onReorderProjects={vi.fn()}
      />,
      { wrapper: Providers }
    );

    expect(container.querySelectorAll('[data-drag-sort-item]')).toHaveLength(5);
    const projectNames = [...container.querySelectorAll('.sidebar-project-name')].map(
      (name) => name.textContent
    );
    expect(projectNames.slice(-3)).toEqual(['alpha-active', 'mid-active', 'zulu-project']);
    const activeItems = [...container.querySelectorAll('[data-drag-sort-item]')].filter((item) =>
      activePaths.includes(item.getAttribute('data-drag-sort-id') ?? '')
    );
    expect(activeItems).toHaveLength(3);
    for (const activePath of activePaths) {
      const projectName = activePath.slice(activePath.lastIndexOf('/') + 1);
      expect(
        within(screen.getByText(projectName).closest('.sidebar-project')!).getByRole('button', {
          name: /Move/,
        })
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: `Move ${projectName} project` })
      ).not.toHaveAttribute('title');
      expect(
        screen.getByText(projectName).closest('.sidebar-project-row')?.querySelectorAll('[title]')
      ).toHaveLength(0);
    }

    const items = mockPinnedRects();
    const alphaItem = items.find(
      (item) => item.getAttribute('data-drag-sort-id') === '/tmp/alpha-active'
    );
    expect(alphaItem).toBeDefined();
    const alphaHandle = within(alphaItem!).getByRole('button', {
      name: 'Move alpha-active project',
    });
    act(() => {
      fireEvent(alphaHandle, pointer('pointerdown', 10, 10));
      fireEvent(window, pointer('pointermove', 10, 120));
      fireEvent(window, pointer('pointerup', 10, 120));
    });
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem('workspace.active-project-order') ?? '[]')).toEqual([
        '/tmp/mid-active',
        '/tmp/alpha-active',
        '/tmp/zulu-project',
      ])
    );

    rerender(
      <WorkspaceSidebar
        {...sidebarProps()}
        projects={projects}
        currentProjectPath={null}
        currentProjectName={null}
        terminalTabs={[]}
        isSidebarHidden
        onReorderProjects={vi.fn()}
      />
    );
    expect(container.querySelectorAll('[data-drag-sort-item]')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Move beta project' })).not.toBeInTheDocument();
  });

  it('pins an Active project at the position where it is dropped in Pinned', async () => {
    vi.useFakeTimers();
    try {
      sessionRegistry.destroy(PROJECT_PATH);
      const activePath = '/tmp/workspace-drag-active';
      sessionRegistry.getOrCreate(activePath);
      const onTogglePinProject = vi.fn().mockResolvedValue(true);
      const onReorderProjects = vi.fn().mockResolvedValue(undefined);
      render(
        <WorkspaceSidebar
          {...sidebarProps()}
          projects={[
            pinnedRow('/tmp/pinned-alpha', 'pinned-alpha'),
            pinnedRow('/tmp/pinned-beta', 'pinned-beta'),
          ]}
          currentProjectPath={null}
          currentProjectName={null}
          terminalTabs={[]}
          onTogglePinProject={onTogglePinProject}
          onReorderProjects={onReorderProjects}
        />,
        { wrapper: Providers }
      );

      const items = mockPinnedRects();
      const activeItem = items.find(
        (item) => item.getAttribute('data-drag-sort-id') === activePath
      );
      const pinnedBeta = items.find(
        (item) => item.getAttribute('data-drag-sort-id') === '/tmp/pinned-beta'
      );
      const activeSection = items.find(
        (item) =>
          item.getAttribute('data-drag-sort-id') === 'sidebar-active-section-placeholder-follower'
      );
      expect(activeItem).toBeDefined();
      expect(pinnedBeta).toBeDefined();
      expect(activeSection).toBeDefined();
      const handle = within(activeItem!).getByRole('button', {
        name: 'Move workspace-drag-active project',
      });
      fireEvent(handle, pointer('pointerdown', 10, 160));
      fireEvent(window, pointer('pointermove', 10, 85));

      expect(pinnedBeta).toHaveAttribute('data-drag-sort-target', 'true');
      expect(pinnedBeta).toHaveAttribute('data-drag-sort-placement', 'after');
      expect(pinnedBeta).not.toHaveAttribute('data-drag-sort-target-indicator');
      const placeholder = document.querySelector('[data-drag-sort-placeholder-gap="true"]');
      expect(placeholder).toHaveClass('workspace-sidebar-project-drop-placeholder');
      expect(placeholder).toHaveStyle({
        '--drag-sort-placeholder-y': '80px',
        '--drag-sort-placeholder-height': '20px',
      });
      expect(activeSection).toHaveStyle({ '--drag-sort-transform': 'translate3d(0px, 30px, 0)' });
      expect(document.querySelectorAll('[data-drag-sort-placeholder-gap="true"]')).toHaveLength(1);
      fireEvent(window, pointer('pointerup', 10, 85));
      await act(async () => {
        vi.advanceTimersByTime(250);
        await Promise.resolve();
      });

      expect(onTogglePinProject).toHaveBeenCalledWith(activePath, true);
      expect(onReorderProjects).toHaveBeenCalledWith([
        '/tmp/pinned-alpha',
        '/tmp/pinned-beta',
        activePath,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unpins a Pinned project at the position where it is dropped in Active', async () => {
    vi.useFakeTimers();
    try {
      sessionRegistry.destroy(PROJECT_PATH);
      const activePaths = ['/tmp/active-alpha', '/tmp/active-beta'];
      activePaths.forEach((path) => sessionRegistry.getOrCreate(path));
      const onTogglePinProject = vi.fn().mockResolvedValue(true);
      const onReorderProjects = vi.fn().mockResolvedValue(undefined);
      const onSelectProject = vi.fn((path: string) => {
        sessionRegistry.getOrCreate(path);
      });
      const renderSidebar = (projects: PinnedProjectRow[]) => (
        <WorkspaceSidebar
          {...sidebarProps()}
          projects={projects}
          currentProjectPath={null}
          currentProjectName={null}
          terminalTabs={[]}
          onTogglePinProject={onTogglePinProject}
          onReorderProjects={onReorderProjects}
          onSelectProject={onSelectProject}
        />
      );
      const { rerender } = render(renderSidebar([pinnedRow('/tmp/moving-pin', 'moving-pin')]), {
        wrapper: Providers,
      });

      const items = mockPinnedRects();
      const pinnedItem = items.find(
        (item) => item.getAttribute('data-drag-sort-id') === '/tmp/moving-pin'
      );
      const activeHeader = items.find(
        (item) =>
          item.getAttribute('data-drag-sort-id') === 'sidebar-expanded-active-header-drop-target'
      );
      expect(pinnedItem).toBeDefined();
      expect(activeHeader).toBeDefined();
      const handle = within(pinnedItem!).getByRole('button', { name: 'Move moving-pin project' });
      fireEvent(handle, pointer('pointerdown', 10, 10));

      const activeAlpha = items.find(
        (item) => item.getAttribute('data-drag-sort-id') === activePaths[0]
      );
      const activeBeta = items.find(
        (item) => item.getAttribute('data-drag-sort-id') === activePaths[1]
      );
      const projectActions = items.find(
        (item) => item.getAttribute('data-drag-sort-id') === 'sidebar-active-project-actions-anchor'
      );
      setItemRect(pinnedItem!, 0);
      setItemRect(activeHeader!, 30);
      setItemRect(activeAlpha!, 60);
      setItemRect(activeBeta!, 90);
      setItemRect(projectActions!, 120);

      fireEvent(window, pointer('pointermove', 10, 40));
      expect(activeHeader).toHaveAttribute('data-drag-sort-target', 'true');
      expect(activeHeader).not.toHaveAttribute('data-drag-sort-target-indicator');
      expect(document.querySelector('[data-drag-sort-placeholder-gap="true"]')).toHaveStyle({
        '--drag-sort-placeholder-y': '60px',
        '--drag-sort-placeholder-height': '20px',
      });
      expect(activeAlpha).toHaveStyle({ '--drag-sort-transform': 'translate3d(0px, 30px, 0)' });

      fireEvent(window, pointer('pointermove', 10, 75));
      expect(activeAlpha).toHaveAttribute('data-drag-sort-target', 'true');
      expect(activeAlpha).not.toHaveAttribute('data-drag-sort-target-indicator');
      expect(activeAlpha).toHaveAttribute('data-drag-sort-placement', 'after');
      const placeholder = document.querySelector('[data-drag-sort-placeholder-gap="true"]');
      expect(placeholder).toHaveClass('workspace-sidebar-project-drop-placeholder');
      expect(placeholder).toHaveStyle({
        '--drag-sort-placeholder-y': '90px',
        '--drag-sort-placeholder-height': '20px',
      });
      expect(document.querySelectorAll('[data-drag-sort-placeholder-gap="true"]')).toHaveLength(1);
      expect(activeBeta).toHaveStyle({ '--drag-sort-transform': 'translate3d(0px, 30px, 0)' });
      fireEvent(window, pointer('pointermove', 10, 86));
      expect(activeBeta).toHaveAttribute('data-drag-sort-target', 'true');
      expect(activeBeta).toHaveAttribute('data-drag-sort-placement', 'before');
      expect(document.querySelector('[data-drag-sort-placeholder-gap="true"]')).toHaveStyle({
        '--drag-sort-placeholder-y': '90px',
      });
      expect(activeBeta).toHaveStyle({ '--drag-sort-transform': 'translate3d(0px, 30px, 0)' });
      fireEvent(window, pointer('pointermove', 10, 105));
      expect(activeBeta).toHaveAttribute('data-drag-sort-placement', 'after');
      expect(projectActions).toHaveStyle({ '--drag-sort-transform': 'translate3d(0px, 30px, 0)' });
      fireEvent(window, pointer('pointermove', 10, 86));
      fireEvent(window, pointer('pointerup', 10, 86));
      await act(async () => {
        vi.advanceTimersByTime(250);
        await Promise.resolve();
      });

      expect(onTogglePinProject).toHaveBeenCalledWith('/tmp/moving-pin', false);
      expect(JSON.parse(localStorage.getItem('workspace.active-project-order') ?? '[]')).toEqual([
        activePaths[0],
        '/tmp/moving-pin',
        activePaths[1],
      ]);
      expect(onSelectProject).toHaveBeenCalledWith('/tmp/moving-pin');
      // Apply the parent's successful unpin update. The newly opened session
      // should now replace the old pinned row in Active.
      rerender(renderSidebar([]));
      expect(document.querySelector('[data-drag-sort-id="/tmp/moving-pin"]')).toBeInTheDocument();
      expect(onReorderProjects).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts the synthesized current-project row when unpinning into Active', async () => {
    vi.useFakeTimers();
    try {
      sessionRegistry.destroy(PROJECT_PATH);
      const activePaths = ['/tmp/active-alpha', '/tmp/active-beta'];
      activePaths.forEach((path) => sessionRegistry.getOrCreate(path));
      const onTogglePinProject = vi.fn().mockResolvedValue(true);
      const onReorderProjects = vi.fn().mockResolvedValue(undefined);
      render(
        <WorkspaceSidebar
          {...sidebarProps()}
          projects={[pinnedRow('/tmp/moving-pin', 'moving-pin')]}
          currentProjectPath="/tmp/external-current"
          currentProjectName="external-current"
          terminalTabs={[]}
          onTogglePinProject={onTogglePinProject}
          onReorderProjects={onReorderProjects}
          onSelectProject={vi.fn()}
        />,
        { wrapper: Providers }
      );

      const items = mockPinnedRects();
      const byId = (id: string) =>
        items.find((item) => item.getAttribute('data-drag-sort-id') === id);
      const pinnedItem = byId('/tmp/moving-pin');
      const external = byId('/tmp/external-current');
      const activeAlpha = byId(activePaths[0]);
      const activeBeta = byId(activePaths[1]);
      expect(external).toBeDefined();
      const handle = within(pinnedItem!).getByRole('button', { name: 'Move moving-pin project' });
      fireEvent(handle, pointer('pointerdown', 10, 10));
      setItemRect(pinnedItem!, 0);
      setItemRect(external!, 60);
      setItemRect(activeAlpha!, 90);
      setItemRect(activeBeta!, 120);

      // Upper half of beta: insert between alpha and beta.
      fireEvent(window, pointer('pointermove', 10, 124));
      expect(activeBeta).toHaveAttribute('data-drag-sort-placement', 'before');
      fireEvent(window, pointer('pointerup', 10, 124));
      await act(async () => {
        vi.advanceTimersByTime(250);
        await Promise.resolve();
      });

      expect(onTogglePinProject).toHaveBeenCalledWith('/tmp/moving-pin', false);
      expect(JSON.parse(localStorage.getItem('workspace.active-project-order') ?? '[]')).toEqual([
        '/tmp/external-current',
        activePaths[0],
        '/tmp/moving-pin',
        activePaths[1],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pins a project when it is dropped in the empty Pinned section body', async () => {
    vi.useFakeTimers();
    try {
      sessionRegistry.destroy(PROJECT_PATH);
      const activePath = '/tmp/only-active-project';
      sessionRegistry.getOrCreate(activePath);
      const onTogglePinProject = vi.fn().mockResolvedValue(true);
      const onReorderProjects = vi.fn().mockResolvedValue(undefined);
      render(
        <WorkspaceSidebar
          {...sidebarProps()}
          projects={[]}
          currentProjectPath={null}
          currentProjectName={null}
          terminalTabs={[]}
          onTogglePinProject={onTogglePinProject}
          onReorderProjects={onReorderProjects}
        />,
        { wrapper: Providers }
      );

      const items = mockPinnedRects();
      const activeItem = items.find(
        (item) => item.getAttribute('data-drag-sort-id') === activePath
      );
      const emptyPinnedTarget = items.find(
        (item) => item.getAttribute('data-drag-sort-id') === 'sidebar-empty-pinned-drop-target'
      );
      expect(activeItem).toBeDefined();
      expect(emptyPinnedTarget).toBeDefined();
      expect(within(emptyPinnedTarget!).getByText('Nothing pinned yet')).toBeInTheDocument();
      expect(
        emptyPinnedTarget!.previousElementSibling?.querySelector('.sidebar-group-header')
      ).toBeInTheDocument();
      setItemRect(emptyPinnedTarget!, 30, 30);
      setItemRect(activeItem!, 70);
      const handle = within(activeItem!).getByRole('button', {
        name: 'Move only-active-project project',
      });
      fireEvent(handle, pointer('pointerdown', 10, 80));
      fireEvent(window, pointer('pointermove', 10, 35));

      expect(emptyPinnedTarget).toHaveAttribute('data-drag-sort-target', 'true');
      expect(emptyPinnedTarget).not.toHaveAttribute('data-drag-sort-target-indicator');
      expect(emptyPinnedTarget).toHaveAttribute('data-drag-sort-placement', 'before');
      expect(document.querySelector('[data-drag-sort-placeholder-gap="true"]')).toHaveStyle({
        '--drag-sort-placeholder-y': '30px',
        '--drag-sort-placeholder-height': '20px',
      });
      fireEvent(window, pointer('pointerup', 10, 35));
      await act(async () => {
        vi.advanceTimersByTime(250);
        await Promise.resolve();
      });

      expect(onTogglePinProject).toHaveBeenCalledWith(activePath, true);
      expect(onReorderProjects).toHaveBeenCalledWith([activePath]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unpins a project when it is dropped on the collapsed empty Active group header', async () => {
    vi.useFakeTimers();
    try {
      sessionRegistry.destroy(PROJECT_PATH);
      const pinnedPath = '/tmp/only-pinned-project';
      const onTogglePinProject = vi.fn().mockResolvedValue(true);
      const onReorderProjects = vi.fn().mockResolvedValue(undefined);
      render(
        <WorkspaceSidebar
          {...sidebarProps()}
          projects={[pinnedRow(pinnedPath, 'only-pinned-project')]}
          currentProjectPath={null}
          currentProjectName={null}
          terminalTabs={[]}
          onTogglePinProject={onTogglePinProject}
          onReorderProjects={onReorderProjects}
        />,
        { wrapper: Providers }
      );

      const items = mockPinnedRects();
      const pinnedItem = items.find(
        (item) => item.getAttribute('data-drag-sort-id') === pinnedPath
      );
      const emptyActiveTarget = items.find(
        (item) =>
          item.getAttribute('data-drag-sort-id') === 'sidebar-empty-active-header-drop-target'
      );
      expect(pinnedItem).toBeDefined();
      expect(emptyActiveTarget).toBeDefined();
      const actionAnchor = items.find(
        (item) => item.getAttribute('data-drag-sort-id') === 'sidebar-active-project-actions-anchor'
      );
      expect(actionAnchor).toBeDefined();
      setItemRect(pinnedItem!, 100);
      setItemRect(emptyActiveTarget!, 30);
      setItemRect(actionAnchor!, 50);

      const handle = within(pinnedItem!).getByRole('button', {
        name: 'Move only-pinned-project project',
      });
      fireEvent(handle, pointer('pointerdown', 10, 110));
      fireEvent(window, pointer('pointermove', 10, 40));

      expect(emptyActiveTarget).toHaveAttribute('data-drag-sort-target', 'true');
      expect(emptyActiveTarget).not.toHaveAttribute('data-drag-sort-target-indicator');
      expect(emptyActiveTarget).toHaveAttribute('data-drag-sort-placement', 'after');
      expect(document.querySelector('[data-drag-sort-placeholder-gap="true"]')).toHaveStyle({
        '--drag-sort-placeholder-y': '50px',
        '--drag-sort-placeholder-height': '20px',
      });
      expect(actionAnchor).toHaveStyle({ '--drag-sort-transform': 'translate3d(0px, 20px, 0)' });
      fireEvent(window, pointer('pointerup', 10, 40));
      await act(async () => {
        vi.advanceTimersByTime(250);
        await Promise.resolve();
      });

      expect(onTogglePinProject).toHaveBeenCalledWith(pinnedPath, false);
      expect(JSON.parse(localStorage.getItem('workspace.active-project-order') ?? '[]')).toEqual([
        pinnedPath,
      ]);
      expect(onReorderProjects).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not prune saved Active ranks while sessions are hydrating', async () => {
    localStorage.setItem(
      'workspace.active-project-order',
      JSON.stringify(['/tmp/zulu-project', '/tmp/alpha-project'])
    );
    sessionRegistry._resetForTests();
    const { container } = render(
      <WorkspaceSidebar
        {...sidebarProps()}
        projects={[]}
        currentProjectPath={null}
        currentProjectName={null}
        terminalTabs={[]}
      />,
      { wrapper: Providers }
    );

    expect(container.querySelectorAll('[data-drag-sort-item]')).toHaveLength(0);
    act(() => {
      sessionRegistry.getOrCreate('/tmp/alpha-project');
      sessionRegistry.getOrCreate('/tmp/zulu-project');
    });
    await waitFor(() => {
      const names = [...container.querySelectorAll('.sidebar-project-name')].map(
        (name) => name.textContent
      );
      expect(names.slice(-2)).toEqual(['zulu-project', 'alpha-project']);
    });
    expect(JSON.parse(localStorage.getItem('workspace.active-project-order') ?? '[]')).toEqual([
      '/tmp/zulu-project',
      '/tmp/alpha-project',
    ]);
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
    mockInvokeResponse('get_spotify_widget_enabled', false);
    mockInvokeResponse('get_spotify_state', null);
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

  it('never lets the X change meaning under the cursor on a pinned row', async () => {
    // The bug: closing a pinned project left the row exactly where it was,
    // and the X — same glyph, same pixel — silently became Unpin. The close
    // looked like a no-op, so the next click landed on a destructive action
    // nobody asked for.
    const user = userEvent.setup();
    const onCloseProject = vi.fn((path: string) => sessionRegistry.destroy(path));
    const onUnpinProject = vi.fn();

    const pinned: PinnedProjectRow = {
      projectPath: ACTIVE_PATH,
      fallbackName: 'active-project',
      status: 'active',
      agentStatus: 'idle',
      unreadCount: 0,
      memoryBytes: 0,
      isCurrent: false,
    };

    const { container, rerender } = render(
      <WorkspaceSidebar
        {...activeSidebarProps()}
        projects={[pinned]}
        onCloseProject={onCloseProject}
        onUnpinProject={onUnpinProject}
      />,
      { wrapper: Providers }
    );

    await user.click(await screen.findByRole('button', { name: 'Close active-project' }));
    expect(onCloseProject).toHaveBeenCalledWith(ACTIVE_PATH);

    // What `usePinnedProjects` hands back once the session is gone.
    rerender(
      <WorkspaceSidebar
        {...activeSidebarProps()}
        projects={[{ ...pinned, status: 'inactive' }]}
        onCloseProject={onCloseProject}
        onUnpinProject={onUnpinProject}
      />
    );

    // The pin survives, but nothing clickable is left in the X's place.
    expect(screen.queryByRole('button', { name: 'Close active-project' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Unpin active-project' })).toBeNull();
    expect(onUnpinProject).not.toHaveBeenCalled();

    // And the row says so, so the close doesn't read as nothing happening.
    expect(container.querySelector('.sidebar-project-row[data-parked="true"]')).toBeInTheDocument();
  });

  it('still unpins a closed pin from the context menu (issue #366)', async () => {
    // Removing the hover X must not strand a pin whose folder was moved or
    // deleted outside the app — that is the case the X was added for.
    const user = userEvent.setup();
    const onUnpinProject = vi.fn();
    const { container } = render(
      <WorkspaceSidebar
        {...activeSidebarProps()}
        projects={[
          {
            projectPath: ACTIVE_PATH,
            fallbackName: 'active-project',
            status: 'inactive',
            agentStatus: 'idle',
            unreadCount: 0,
            memoryBytes: 0,
            isCurrent: false,
          },
        ]}
        onUnpinProject={onUnpinProject}
      />,
      { wrapper: Providers }
    );

    fireEvent.contextMenu(container.querySelector<HTMLElement>('.sidebar-project-row')!);
    await user.click(screen.getByRole('menuitem', { name: 'Unpin from sidebar' }));

    expect(onUnpinProject).toHaveBeenCalledWith(ACTIVE_PATH);
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
