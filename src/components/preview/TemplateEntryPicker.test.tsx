import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listTemplatePageEntries } from '../../lib/project';
import { TemplateEntryPicker } from './TemplateEntryPicker';

vi.mock('../../lib/project', () => ({
  listTemplatePageEntries: vi.fn(),
}));

describe('TemplateEntryPicker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('navigates to the selected concrete route from returned entries', async () => {
    vi.mocked(listTemplatePageEntries).mockResolvedValue({
      entries: [
        { route: '/work/glow', label: 'Glow' },
        { route: '/work/kinetic', label: 'Kinetic' },
      ],
      error: null,
    });
    const onNavigate = vi.fn();

    const { container } = render(
      <TemplateEntryPicker
        projectPath="/project"
        templateRoute="/work/:slug"
        currentPage="/work/glow"
        onNavigate={onNavigate}
      />
    );

    await waitFor(() =>
      expect(listTemplatePageEntries).toHaveBeenCalledWith('/project', '/work/:slug')
    );
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.click(
      container.querySelector('.template-entry-picker__trigger') as HTMLButtonElement
    );
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: /Kinetic/ })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole('menuitem', { name: /Kinetic/ }));

    expect(onNavigate).toHaveBeenCalledWith('/work/kinetic');
    expect(listTemplatePageEntries).toHaveBeenCalledWith('/project', '/work/:slug');
  });

  it('navigates to the first returned route when the current path is outside the template', async () => {
    vi.mocked(listTemplatePageEntries).mockResolvedValue({
      entries: [
        { route: '/work/glow', label: 'Glow' },
        { route: '/work/kinetic', label: 'Kinetic' },
      ],
      error: null,
    });
    const onNavigate = vi.fn();

    const { container } = render(
      <TemplateEntryPicker
        projectPath="/project"
        templateRoute="/work/:slug"
        currentPage="/about"
        onNavigate={onNavigate}
      />
    );

    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('/work/glow'));
    expect(container.querySelector('.template-entry-picker__trigger')).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });
});
