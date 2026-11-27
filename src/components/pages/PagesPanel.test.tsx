import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ModalProvider } from '../../contexts/ModalContext';
import { projectPagesStorageKey, type ProjectPagesState } from '../../lib/projectPages';
import { getInvokeCalls, mockInvokeResponse } from '../../test/setup';
import { PagesPanel } from './PagesPanel';

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

describe('PagesPanel sorting', () => {
  it('moves down relative to the next visible sibling when a saved route is absent', async () => {
    const projectPath = '/tmp/pages-panel-visible-sibling';
    const storageKey = projectPagesStorageKey(projectPath, '');
    const savedState: ProjectPagesState = {
      version: 1,
      sortMode: 'manual',
      pages: {
        '/alpha': { displayName: null, parentFolderId: null, order: 0, lastUsedAt: null },
        '/hidden': { displayName: null, parentFolderId: null, order: 1, lastUsedAt: null },
        '/beta': { displayName: null, parentFolderId: null, order: 2, lastUsedAt: null },
      },
      folders: [],
    };
    window.localStorage.setItem(storageKey, JSON.stringify(savedState));
    mockInvokeResponse('list_pages', [
      { route: '/alpha', file_path: '/repo/src/pages/alpha.astro' },
      { route: '/beta', file_path: '/repo/src/pages/beta.astro' },
    ]);
    render(
      <ModalProvider>
        <PagesPanel
          projectPath={projectPath}
          workspaceKey=""
          projectType="astro"
          onOpenPage={vi.fn()}
          onOpenSourceFile={vi.fn()}
          onOpenDuplicatedPage={vi.fn().mockResolvedValue('opened')}
          pinned
          onTogglePin={vi.fn()}
          onClose={vi.fn()}
        />
      </ModalProvider>
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Settings for Alpha' }));
    fireEvent.click(await screen.findByText('Move down'));
    await waitFor(() => {
      const saved = JSON.parse(
        window.localStorage.getItem(storageKey) ?? 'null'
      ) as ProjectPagesState | null;
      expect(saved?.pages['/alpha']?.order).toBe(2);
      expect(saved?.pages['/beta']?.order).toBe(1);
      expect(saved?.pages['/hidden']?.order).toBe(0);
    });
  });

  it('reorders a newly discovered route and persists the visible order after a drop', async () => {
    const projectPath = '/tmp/pages-panel-order-regression';
    const storageKey = projectPagesStorageKey(projectPath, '');
    const savedState: ProjectPagesState = {
      version: 1,
      sortMode: 'manual',
      pages: {
        '/alpha': { displayName: null, parentFolderId: null, order: 0, lastUsedAt: null },
        '/beta': { displayName: null, parentFolderId: null, order: 1, lastUsedAt: null },
      },
      folders: [],
    };
    window.localStorage.setItem(storageKey, JSON.stringify(savedState));
    mockInvokeResponse('list_pages', [
      { route: '/alpha', file_path: '/repo/src/pages/alpha.astro' },
      { route: '/beta', file_path: '/repo/src/pages/beta.astro' },
      { route: '/new', file_path: '/repo/src/pages/new.astro' },
    ]);
    const onOpenPage = vi.fn();

    const { container } = render(
      <ModalProvider>
        <PagesPanel
          projectPath={projectPath}
          workspaceKey=""
          onOpenPage={onOpenPage}
          onOpenSourceFile={vi.fn()}
          onOpenDuplicatedPage={vi.fn().mockResolvedValue('opened')}
          pinned
          onTogglePin={vi.fn()}
          onClose={vi.fn()}
        />
      </ModalProvider>
    );

    await waitFor(() => expect(container.querySelectorAll('[data-page-route]')).toHaveLength(3));
    const rows = [...container.querySelectorAll<HTMLElement>('[data-drag-sort-item]')];
    const targets = [...container.querySelectorAll<HTMLElement>('[data-drag-sort-target-element]')];
    expect(rows.map((row) => row.dataset.dragSortId)).toEqual([
      'page:/alpha',
      'page:/beta',
      'page:/new',
    ]);
    expect(container.querySelector('[draggable="true"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-drag-sort-item][role="button"]')).not.toBeInTheDocument();
    expect(container.querySelector('.pages-row__drag-handle')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('/alpha'));
    expect(onOpenPage).toHaveBeenCalledWith('/alpha');

    rows.forEach((row, index) => {
      const rect = {
        left: 0,
        top: index * 30,
        right: 320,
        bottom: index * 30 + 24,
        width: 320,
        height: 24,
      } as DOMRect;
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(rect);
      vi.spyOn(targets[index], 'getBoundingClientRect').mockReturnValue(rect);
    });

    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    try {
      act(() => {
        fireEvent(screen.getByText('/new'), pointer('pointerdown', 10, 70));
        fireEvent(window, pointer('pointermove', 10, 33));
        fireEvent(window, pointer('pointerup', 10, 33));
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(screen.queryByText('Drop here to move to root')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(
        [...container.querySelectorAll<HTMLElement>('[data-page-route]')].map(
          (row) => row.dataset.pageRoute
        )
      ).toEqual(['/alpha', '/new', '/beta']);
    });

    const persisted = JSON.parse(
      window.localStorage.getItem(storageKey) ?? 'null'
    ) as ProjectPagesState | null;
    expect(persisted?.pages['/new']?.order).toBe(1);
    expect(persisted?.pages['/beta']?.order).toBe(2);
  });
});

describe('PagesPanel dynamic templates', () => {
  it('preserves a saved folder placement and highlights the selected template row', async () => {
    const projectPath = '/tmp/pages-panel-template-folder';
    const storageKey = projectPagesStorageKey(projectPath, '');
    const savedState: ProjectPagesState = {
      version: 1,
      sortMode: 'manual',
      pages: {
        '/about': { displayName: null, parentFolderId: null, order: 1, lastUsedAt: null },
        '/work/:slug': {
          displayName: null,
          parentFolderId: 'custom-work',
          order: 0,
          lastUsedAt: null,
        },
      },
      folders: [{ id: 'custom-work', name: 'Client work', parentFolderId: null, order: 0 }],
    };
    window.localStorage.setItem(storageKey, JSON.stringify(savedState));
    mockInvokeResponse('list_pages', [
      { route: '/about', file_path: '/repo/src/pages/about.astro' },
      { route: '/work/:slug', file_path: '/repo/src/pages/work/[slug].astro' },
    ]);

    const { container } = render(
      <ModalProvider>
        <PagesPanel
          projectPath={projectPath}
          workspaceKey=""
          projectType="astro"
          currentRoute="/about"
          selectedTemplateRoute="/work/:slug"
          onOpenPage={vi.fn()}
          onOpenSourceFile={vi.fn()}
          onOpenDuplicatedPage={vi.fn().mockResolvedValue('opened')}
          pinned
          onTogglePin={vi.fn()}
          onClose={vi.fn()}
        />
      </ModalProvider>
    );

    const template = await waitFor(() => {
      const page = container.querySelector<HTMLElement>('[data-page-route="/work/:slug"]');
      expect(page).not.toBeNull();
      return page as HTMLElement;
    });
    const folder = container.querySelector('[data-folder-id="custom-work"]');
    expect(folder?.contains(template)).toBe(true);
    expect(template.querySelector('.pages-tree__sortable-row')?.getAttribute('style')).toContain(
      '--pages-tree-depth: 1'
    );
    const activeRows = container.querySelectorAll('.pages-row--active');
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]?.closest('[data-page-route]')).toBe(template);
  });

  it('keeps the custom page name when a committed create cannot refresh inventory', async () => {
    const projectPath = '/tmp/pages-panel-committed-create';
    const storageKey = projectPagesStorageKey(projectPath, '');
    mockInvokeResponse('list_pages', []);
    mockInvokeResponse('mutate_project_page', {
      committed: true,
      pages: null,
      refreshError: 'scan failed',
    });

    render(
      <ModalProvider>
        <PagesPanel
          projectPath={projectPath}
          workspaceKey=""
          projectType="astro"
          onOpenPage={vi.fn()}
          onOpenSourceFile={vi.fn()}
          onOpenDuplicatedPage={vi.fn().mockResolvedValue('opened')}
          pinned
          onTogglePin={vi.fn()}
          onClose={vi.fn()}
        />
      </ModalProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add page' }));
    fireEvent.change(screen.getByPlaceholderText('about'), { target: { value: 'about' } });
    fireEvent.change(screen.getByPlaceholderText('About'), { target: { value: 'About us' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create page' }));

    await waitFor(() => {
      expect(getInvokeCalls('mutate_project_page')).toHaveLength(1);
      const saved = JSON.parse(
        window.localStorage.getItem(storageKey) ?? 'null'
      ) as ProjectPagesState | null;
      expect(saved?.pages['/about']?.displayName).toBe('About us');
    });
  });
});
