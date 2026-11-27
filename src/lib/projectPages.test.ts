import { describe, expect, it } from 'vitest';
import {
  canMovePageEntry,
  emptyProjectPagesState,
  isDynamicPageRoute,
  movePageEntry,
  pageDisplayName,
  reconcilePageInventory,
  recordPageOpened,
  siblingEntries,
  validateStaticPageRoute,
  normalizeProjectPagesState,
  createPageFolder,
} from './projectPages';

describe('project page organization', () => {
  it('seeds nested routes, preserves manual root moves, and validates static paths', () => {
    const initial = reconcilePageInventory(emptyProjectPagesState(), [
      { route: '/', file_path: '/repo/src/pages/index.astro' },
      { route: '/about', file_path: '/repo/src/pages/about.astro' },
      { route: '/blog/post', file_path: '/repo/src/pages/blog/post.astro' },
    ]);
    const blog = initial.folders.find((folder) => folder.name === 'blog');
    expect(blog).toBeDefined();
    expect(initial.pages['/blog/post']?.parentFolderId).toBe(blog?.id);

    const movedToRoot = movePageEntry(initial, { kind: 'page', id: '/blog/post' }, null, 1);
    const rescanned = reconcilePageInventory(movedToRoot, [
      { route: '/', file_path: '/repo/src/pages/index.astro' },
      { route: '/about', file_path: '/repo/src/pages/about.astro' },
      { route: '/blog/post', file_path: '/repo/src/pages/blog/post.astro' },
    ]);
    expect(rescanned.pages['/blog/post']?.parentFolderId).toBeNull();
    expect(siblingEntries(recordPageOpened(rescanned, '/about', 42), null, 'recent')[0]?.id).toBe(
      '/about'
    );
    expect(pageDisplayName('/about')).toBe('About');
    expect(canMovePageEntry(rescanned, { kind: 'folder', id: blog!.id }, blog!.id)).toBe(false);
    expect(validateStaticPageRoute('/v1.2')).toEqual({ route: '/v1.2', error: null });
    expect(validateStaticPageRoute('/blog/[slug]').route).toBeNull();
    expect(isDynamicPageRoute('/blog/[slug]')).toBe(true);
  });

  it('allocates a new folder after both page and folder siblings and repairs duplicate folder ids', () => {
    const state = normalizeProjectPagesState({
      version: 1,
      sortMode: 'manual',
      pages: { '/one': { displayName: null, parentFolderId: null, order: 4 } },
      folders: [
        { id: 'shared', name: 'First', parentFolderId: null, order: 8 },
        { id: 'shared', name: 'Duplicate', parentFolderId: 'shared', order: 0 },
      ],
    });
    const updated = createPageFolder(state, 'Last', null, 'last');
    expect(updated.folders).toHaveLength(2);
    expect(updated.folders[1]).toMatchObject({ id: 'last', parentFolderId: null, order: 9 });
    expect(updated.folders[0]?.parentFolderId).toBeNull();
  });

  it('keeps route-derived folders and discovered routes on one shared order sequence', () => {
    const state = reconcilePageInventory(emptyProjectPagesState(), [
      { route: '/z', file_path: '/repo/src/pages/z.astro' },
      { route: '/blog/post', file_path: '/repo/src/pages/blog/post.astro' },
      { route: '/a', file_path: '/repo/src/pages/a.astro' },
    ]);
    expect(
      siblingEntries(state, null, 'manual').map((entry) => [entry.kind, entry.order, entry.id])
    ).toEqual([
      ['page', 0, '/z'],
      ['folder', 1, 'route:/blog'],
      ['page', 2, '/a'],
    ]);
  });
});
