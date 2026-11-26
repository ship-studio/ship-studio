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
});
