import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceHeaderProps } from './WorkspaceHeader';
import { WorkspaceHeader } from './WorkspaceHeader';

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    startDragging: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
  }),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));
vi.mock('../branches/GitHubButton', () => ({ GitHubButton: () => <div /> }));
vi.mock('../branches/PublishBranchDropdown', () => ({
  PublishBranchDropdown: () => <div />,
}));
vi.mock('../plugins/PluginSlot', () => ({ PluginSlot: () => <div /> }));
vi.mock('../support/SupportPanel', () => ({ SupportPanel: () => null }));
vi.mock('./PomodoroTimer', () => ({
  PomodoroTimer: () => <button aria-label="Open Pomodoro timer" />,
}));

const noop = vi.fn();
const props: WorkspaceHeaderProps = {
  projectPath: '/tmp/project',
  projectName: 'Project',
  onOpenAssetsPanel: noop,
  headerExtras: <span data-testid="header-extras">Extras</span>,
  integrations: {
    github: { cliStatus: { installed: false, authenticated: false }, username: null },
    projectGithub: null,
    claude: { cliStatus: { installed: false, version: null } },
  },
  onGitHubStatusChange: noop,
  onGitHubConnect: noop,
  focusActiveTerminal: noop,
  currentBranch: 'main',
  hasUncommittedChanges: false,
  isPublishing: false,
  setIsPublishing: noop,
  onPublishError: noop,
  onPublishStatusChange: noop,
  onCreatePR: noop,
  forcePublishOpen: false,
  onForcePublishOpenHandled: noop,
  getSlotPlugins: () => [],
  pluginProject: null,
  pluginActions: {
    showToast: noop,
    refreshGitStatus: noop,
    refreshBranches: noop,
    focusTerminal: noop,
    openUrl: noop,
    openTerminal: vi.fn().mockResolvedValue(null),
  },
  pluginTheme: {
    bgPrimary: '',
    bgSecondary: '',
    bgTertiary: '',
    textPrimary: '',
    textSecondary: '',
    textMuted: '',
    border: '',
    accent: '',
    accentHover: '',
    action: '',
    actionHover: '',
    actionText: '',
    error: '',
    success: '',
  },
};

function HeaderHarness() {
  return WorkspaceHeader(props).toolbar;
}

describe('WorkspaceHeader', () => {
  it('places Pomodoro after Support and before header extras', () => {
    render(<HeaderHarness />);
    const left = screen.getByText('Support').closest<HTMLElement>('.workspace-header-left');
    expect(left).not.toBeNull();

    const support = within(left!).getByText('Support').closest('button');
    const timer = within(left!).getByRole('button', { name: 'Open Pomodoro timer' });
    const extras = within(left!).getByTestId('header-extras');

    expect(support?.nextElementSibling).toBe(timer);
    expect(timer.nextElementSibling).toBe(extras);
  });
});
