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

  it('selects the first entry when the template is opened from another page', async () => {
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

    await waitFor(() => expect(listTemplatePageEntries).toHaveBeenCalled());
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('/work/glow'));
    expect(container.querySelector('.template-entry-picker__trigger')).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('does not auto-select an entry after the user navigates while entries load', async () => {
    let resolveEntries!: (value: {
      entries: { route: string; label: string }[];
      error: null;
    }) => void;
    vi.mocked(listTemplatePageEntries).mockReturnValue(
      new Promise((resolve) => {
        resolveEntries = resolve;
      })
    );
    const onNavigate = vi.fn();
    const view = render(
      <TemplateEntryPicker
        projectPath="/project"
        templateRoute="/work/:slug"
        currentPage="/about"
        onNavigate={onNavigate}
      />
    );
    view.rerender(
      <TemplateEntryPicker
        projectPath="/project"
        templateRoute="/work/:slug"
        currentPage="/contact"
        onNavigate={onNavigate}
      />
    );
    resolveEntries({ entries: [{ route: '/work/glow', label: 'Glow' }], error: null });
    await waitFor(() => expect(listTemplatePageEntries).toHaveBeenCalled());
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('matches a localized concrete entry against the canonical current route', async () => {
    vi.mocked(listTemplatePageEntries).mockResolvedValue({
      entries: [
        { route: '/fr/work/kinetic', label: 'Kinetic' },
        { route: '/fr/work/glow', label: 'Glow' },
      ],
      error: null,
    });
    const onNavigate = vi.fn();
    const { container } = render(
      <TemplateEntryPicker
        projectPath="/project"
        templateRoute="/work/:slug"
        currentPage="/work/glow"
        canonicalizeRoute={(route) => route.replace(/^\/fr(?=\/)/, '')}
        onNavigate={onNavigate}
      />
    );

    await waitFor(() => expect(screen.getByText('Glow')).toBeInTheDocument());
    expect(container.querySelector('.template-entry-picker__current')).toHaveTextContent('Glow');
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
