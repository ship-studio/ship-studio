import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceHeader, WorkspaceTitlebar, type WorkspaceHeaderProps } from './WorkspaceHeader';
import { openInFinder } from '../../lib/ide';

const { startDragging } = vi.hoisted(() => ({ startDragging: vi.fn() }));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ startDragging }),
}));

vi.mock('../../lib/ide', () => ({
  openInFinder: vi.fn(),
}));

const projectPath = '/Users/martin/ShipStudio/projects/a-very-long-project-name';

function headerProps(): WorkspaceHeaderProps {
  return {
    projectPath,
    projectName: 'A very long project name',
    onGoHome: vi.fn(),
    isSidebarHidden: false,
    commentsVisible: false,
    commentsAvailable: true,
    commentsPendingCount: 0,
    onToggleComments: vi.fn(),
    onToggleSidebar: vi.fn(),
    compactWorkspaceToolbarEnabled: true,
    onOpenAssetsPanel: vi.fn(),
    assetsPanelVisible: false,
    elementTreeVisible: false,
    elementTreeAvailable: true,
    onToggleElementTree: vi.fn(),
    agentPanelVisible: false,
    onToggleAgentPanel: vi.fn(),
    variablesPanelVisible: false,
    variablesPanelAvailable: true,
    onToggleVariablesPanel: vi.fn(),
    integrations: {
      github: { cliStatus: { installed: false, authenticated: false }, username: null },
      projectGithub: null,
      claude: { cliStatus: { installed: false, version: null } },
    },
    onGitHubStatusChange: vi.fn(),
    onGitHubConnect: vi.fn(),
    focusActiveTerminal: vi.fn(),
    currentBranch: null,
    branches: [],
    openPRs: [],
    hasUncommittedChanges: false,
    changedFiles: [],
    isPulling: false,
    isBranchSwitching: false,
    isRepositoryViewActive: false,
    onPullLatest: vi.fn(),
    onBranchSwitch: vi.fn(),
    onViewBranches: vi.fn(),
    onCreateBranch: vi.fn(),
    onViewPRs: vi.fn(),
    onDiscardChanges: vi.fn(),
    isPublishing: false,
    setIsPublishing: vi.fn(),
    onPublishError: vi.fn(),
    onPublishStatusChange: vi.fn(),
    onCreatePR: vi.fn(),
    forcePublishOpen: false,
    onForcePublishOpenHandled: vi.fn(),
    forceBranchesOpen: false,
    onForceBranchesOpenHandled: vi.fn(),
    getSlotPlugins: () => [],
    pluginProject: null,
    pluginActions: {
      showToast: vi.fn(),
      refreshGitStatus: vi.fn(),
      refreshBranches: vi.fn(),
      focusTerminal: vi.fn(),
      openUrl: vi.fn(),
      openTerminal: vi.fn(),
    },
    pluginTheme: {} as WorkspaceHeaderProps['pluginTheme'],
  };
}

function TitlebarHarness({ props = headerProps() }: { props?: WorkspaceHeaderProps } = {}) {
  const { titlebar } = WorkspaceHeader(props);
  return titlebar;
}

function HeaderHarness({ props = headerProps() }: { props?: WorkspaceHeaderProps } = {}) {
  const { titlebar, toolbar } = WorkspaceHeader(props);
  return (
    <>
      {titlebar}
      {toolbar}
    </>
  );
}

describe('WorkspaceHeader title bar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('places sidebar navigation controls in the titlebar', () => {
    const { container } = render(<TitlebarHarness />);

    expect(container.querySelector('.workspace-titlebar-navigation')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide sidebar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Home' })).toHaveClass('button--icon-only');
  });

  it('puts an icon-only project location action after Home and hides the project name', () => {
    const { container } = render(<TitlebarHarness />);
    const home = screen.getByRole('button', { name: 'Home' });
    const location = screen.getByRole('button', {
      name: `Open ${projectPath} in Finder`,
    });

    expect(location).toHaveClass('button--icon-only');
    expect(home.compareDocumentPosition(location)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(container.querySelector('.workspace-title-group')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'A very long project name' })
    ).not.toBeInTheDocument();

    fireEvent.click(location);
    expect(openInFinder).toHaveBeenCalledWith(projectPath);
  });

  it('keeps navigation in the titlebar while restoring the second toolbar in classic layout', () => {
    const props = headerProps();
    props.compactWorkspaceToolbarEnabled = false;
    const { container } = render(<HeaderHarness props={props} />);

    expect(container.querySelector('.workspace-titlebar-navigation')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide sidebar' })).toBeInTheDocument();
    expect(container.querySelector('.workspace-header')).toBeInTheDocument();
    expect(container.querySelector('.workspace-header-left')).toContainElement(
      screen.getByRole('button', { name: 'Elements' })
    );
  });

  it('starts dragging from non-interactive middle sections of the titlebar', () => {
    const { container } = render(
      <WorkspaceTitlebar>
        <div className="workspace-titlebar-center">
          <span>Project location</span>
          <button type="button">Action</button>
        </div>
      </WorkspaceTitlebar>
    );

    fireEvent.mouseDown(screen.getByText('Project location'), { button: 0 });
    expect(startDragging).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Action' }), { button: 0 });
    expect(startDragging).toHaveBeenCalledTimes(1);

    expect(container.querySelector('.workspace-titlebar-center')).toBeInTheDocument();
  });

  it('keeps the whole path action labelled with the full path', () => {
    const props = headerProps();
    props.compactWorkspaceToolbarEnabled = false;
    render(<TitlebarHarness props={props} />);

    const actionLabel = `Open ${projectPath} in Finder`;
    const title = screen.getByRole('heading', { name: 'A very long project name' });
    const pathButton = screen.getByRole('button', { name: actionLabel });

    expect(title.parentElement).toHaveClass('workspace-title-group');
    expect(pathButton.parentElement).toHaveClass('project-path-container');
    expect(pathButton).toHaveAttribute('title', 'Open in Finder');
    expect(pathButton.querySelector('svg')).toBeInTheDocument();
    fireEvent.click(pathButton);
    expect(openInFinder).toHaveBeenCalledWith(projectPath);
  });

  it('places the workspace controls in the titlebar', () => {
    const { container } = render(<TitlebarHarness />);

    expect(container.querySelector('.workspace-titlebar-divider')).toBeInTheDocument();
    expect(container.querySelector('.workspace-titlebar-tools')).toBeInTheDocument();
    expect(container.querySelector('.workspace-titlebar-actions')).toBeInTheDocument();
    expect(
      container.querySelector('.workspace-titlebar .source-control-actions')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Elements' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Agent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Variables' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assets' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Branches' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Push' })).toBeDisabled();
  });

  it('places the mode switcher between workspace tools and source controls', () => {
    const props = headerProps();
    props.modes = <div data-testid="workspace-modes" />;
    const { container } = render(<TitlebarHarness props={props} />);

    const tools = container.querySelector('.workspace-titlebar-tools');
    const modes = container.querySelector('[data-testid="workspace-modes"]');
    const actions = container.querySelector('.workspace-titlebar-actions');

    expect(tools).toBeInTheDocument();
    expect(modes).toBeInTheDocument();
    expect(actions).toBeInTheDocument();
    expect(tools!.compareDocumentPosition(modes!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(modes!.compareDocumentPosition(actions!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('expands to the measured full path while hovered', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.classList.contains('project-path-expansion-measure')) {
        return {
          width: 420,
          height: 20,
          top: 0,
          left: 0,
          right: 420,
          bottom: 20,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return {
        width: 240,
        height: 20,
        top: 0,
        left: 0,
        right: 240,
        bottom: 20,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });

    const props = headerProps();
    props.compactWorkspaceToolbarEnabled = false;
    render(<TitlebarHarness props={props} />);
    const pathButton = screen.getByRole('button', {
      name: `Open ${projectPath} in Finder`,
    });
    const container = pathButton.parentElement;

    expect(container).toHaveClass('project-path-container');
    fireEvent.mouseEnter(container!);
    expect(container).toHaveStyle({ width: '420px' });

    fireEvent.mouseLeave(container!);
    expect(container).not.toHaveStyle({ width: '420px' });
  });

  it('places Agent first, followed by Variables and Assets, and toggles Variables', () => {
    const props = headerProps();
    render(<TitlebarHarness props={props} />);

    const tools = document.querySelector('.workspace-titlebar-tools');
    const agent = screen.getByRole('button', { name: 'Agent' });
    const variables = screen.getByRole('button', { name: 'Variables' });
    const assets = screen.getByRole('button', { name: 'Assets' });
    const buttons = Array.from(tools!.querySelectorAll<HTMLElement>('button'));

    expect(buttons[0]).toBe(agent);
    expect(buttons.indexOf(agent)).toBeLessThan(buttons.indexOf(variables));
    expect(buttons.indexOf(variables)).toBeLessThan(buttons.indexOf(assets));

    fireEvent.click(variables);
    expect(props.onToggleVariablesPanel).toHaveBeenCalledTimes(1);
  });
});
