import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ProjectViewMode } from './ProjectGridView';

const mocks = vi.hoisted(() => ({
  openPalette: vi.fn(),
  trackEvent: vi.fn(),
}));

vi.mock('../../contexts/ModalContext', () => ({
  useModal: () => ({ open: mocks.openPalette }),
}));

vi.mock('../../lib/analytics', () => ({
  trackEvent: mocks.trackEvent,
}));

vi.mock('../icons', () => ({
  CheckIcon: () => null,
  ChevronIcon: () => null,
  FolderPlusIcon: () => null,
  GridIcon: () => null,
  HomeIcon: () => null,
  ListIcon: () => null,
  PlusIcon: () => null,
  PullIcon: () => null,
  SearchIcon: () => null,
  EyeOffIcon: () => null,
}));

import { DashboardHeader } from './DashboardHeader';
import { DashboardSearch } from './DashboardSearch';
import { SearchAndSort } from './SearchAndSort';

function renderSearchAndSort(overrides: Partial<React.ComponentProps<typeof SearchAndSort>> = {}) {
  const props: React.ComponentProps<typeof SearchAndSort> = {
    title: 'All Projects',
    totalCount: 8,
    sortBy: 'last_opened',
    viewMode: 'grid' as ProjectViewMode,
    onSortChange: vi.fn(),
    onViewModeChange: vi.fn(),
    onNewFolder: vi.fn(),
    onCreateProject: vi.fn(),
    onImportProject: vi.fn(),
    isGitHubAuthenticated: true,
    onGitHubConnectForImport: vi.fn(),
    ...overrides,
  };

  return { ...render(<SearchAndSort {...props} />), props };
}

describe('dashboard home layout pieces', () => {
  beforeEach(() => {
    mocks.openPalette.mockReset();
    mocks.trackEvent.mockReset();
  });

  it('renders the Ship Studio hero icon and copy', () => {
    render(<DashboardHeader />);

    expect(screen.getByRole('img', { name: 'Ship Studio' })).toHaveAttribute(
      'src',
      '/ShipStudio_IconBrand.png'
    );
    const logoButton = screen.getByRole('button', { name: 'Pulse Ship Studio logo' });
    fireEvent.click(logoButton);
    expect(logoButton).toHaveClass('dashboard-hero-icon-button--hover-suppressed');
    expect(screen.getByRole('img', { name: 'Ship Studio' })).toHaveClass(
      'dashboard-hero-icon--click-pulsing'
    );
    fireEvent.animationEnd(screen.getByRole('img', { name: 'Ship Studio' }));
    expect(screen.getByRole('img', { name: 'Ship Studio' })).not.toHaveClass(
      'dashboard-hero-icon--click-pulsing'
    );
    fireEvent.mouseLeave(logoButton);
    expect(logoButton).not.toHaveClass('dashboard-hero-icon-button--hover-suppressed');
    expect(screen.getByRole('heading', { name: 'What will you Ship today?' })).toBeInTheDocument();
  });

  it('routes the home screen header hide action', () => {
    const onHide = vi.fn();
    render(<DashboardHeader onHide={onHide} />);

    fireEvent.click(screen.getByRole('button', { name: 'Hide home screen header' }));

    expect(onHide).toHaveBeenCalledOnce();
  });

  it('opens the command palette from the standalone search', () => {
    render(<DashboardSearch />);

    expect(screen.getByText('Search projects, actions, settings...')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open command palette' }));

    expect(mocks.openPalette).toHaveBeenCalledOnce();
  });

  it('renders the count without parentheses and routes project actions', () => {
    const { props } = renderSearchAndSort();

    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.queryByText('(8)')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New Project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.click(screen.getByRole('button', { name: 'New Folder' }));

    expect(props.onCreateProject).toHaveBeenCalledOnce();
    expect(props.onImportProject).toHaveBeenCalledOnce();
    expect(props.onNewFolder).toHaveBeenCalledOnce();
  });

  it('routes unauthenticated import to GitHub connect', () => {
    const onImportProject = vi.fn();
    const onGitHubConnectForImport = vi.fn();
    renderSearchAndSort({
      onImportProject,
      onGitHubConnectForImport,
      isGitHubAuthenticated: false,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect(onImportProject).not.toHaveBeenCalled();
    expect(onGitHubConnectForImport).toHaveBeenCalledOnce();
  });

  it('uses the shared tabs primitive for the project view switcher', () => {
    renderSearchAndSort({ viewMode: 'grid' });

    expect(screen.getByRole('tab', { name: 'Grid view' })).toHaveClass('button--default');
    expect(screen.getByRole('tab', { name: 'List view' })).toHaveClass('button--ghost');
  });
});
