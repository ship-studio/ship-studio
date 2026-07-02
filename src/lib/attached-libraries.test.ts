/**
 * Tests for the attached-libraries Tauri wrappers (src/lib/attached-libraries.ts).
 *
 * These are thin invoke() wrappers, so the tests assert the command name and
 * argument shape reaching the backend, plus error propagation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AttachedLibrary } from './attached-libraries';
import {
  listAttachedLibraries,
  attachedLibraryDirs,
  addAttachedLibrary,
  removeAttachedLibrary,
} from './attached-libraries';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('lib/attached-libraries', () => {
  let core: typeof import('@tauri-apps/api/core');

  beforeEach(async () => {
    vi.clearAllMocks();
    core = await import('@tauri-apps/api/core');
  });

  describe('listAttachedLibraries', () => {
    it('invokes "list_attached_libraries" and returns the entries', async () => {
      const libs: AttachedLibrary[] = [{ path: '/Users/me/vault', added_at: 1 }];
      vi.mocked(core.invoke).mockResolvedValue(libs);

      const result = await listAttachedLibraries();

      expect(core.invoke).toHaveBeenCalledWith('list_attached_libraries');
      expect(result).toEqual(libs);
    });
  });

  describe('attachedLibraryDirs', () => {
    it('invokes "attached_library_dirs" and returns the existing dir paths', async () => {
      vi.mocked(core.invoke).mockResolvedValue(['/Users/me/vault']);

      const result = await attachedLibraryDirs();

      expect(core.invoke).toHaveBeenCalledWith('attached_library_dirs');
      expect(result).toEqual(['/Users/me/vault']);
    });
  });

  describe('addAttachedLibrary', () => {
    it('invokes "add_attached_library" and returns the registered path', async () => {
      vi.mocked(core.invoke).mockResolvedValue('/Users/me/vault');

      const result = await addAttachedLibrary();

      expect(core.invoke).toHaveBeenCalledWith('add_attached_library');
      expect(result).toBe('/Users/me/vault');
    });

    it('returns null when the picker is cancelled', async () => {
      vi.mocked(core.invoke).mockResolvedValue(null);
      expect(await addAttachedLibrary()).toBeNull();
    });
  });

  describe('removeAttachedLibrary', () => {
    it('invokes "remove_attached_library" with the path', async () => {
      vi.mocked(core.invoke).mockResolvedValue(undefined);

      await removeAttachedLibrary('/Users/me/vault');

      expect(core.invoke).toHaveBeenCalledWith('remove_attached_library', {
        path: '/Users/me/vault',
      });
    });

    it('propagates errors from invoke', async () => {
      vi.mocked(core.invoke).mockRejectedValue(new Error('not found'));
      await expect(removeAttachedLibrary('/nope')).rejects.toThrow('not found');
    });
  });
});
