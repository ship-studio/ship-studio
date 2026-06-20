/**
 * Tests for the custom-classes wrapper (src/lib/customClasses.ts).
 *
 * Verifies each wrapper calls invoke() with the right command name and arg
 * shape, and returns the resolved value unchanged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TailwindSetup, CustomClass } from './customClasses';
import {
  detectTailwindSetup,
  listCustomClasses,
  createCustomClass,
  updateCustomClass,
  deleteCustomClass,
  classifyApplyTokens,
} from './customClasses';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('lib/customClasses', () => {
  let core: typeof import('@tauri-apps/api/core');

  beforeEach(async () => {
    vi.clearAllMocks();
    core = await import('@tauri-apps/api/core');
  });

  describe('detectTailwindSetup', () => {
    it('invokes "detect_tailwind_setup" with projectPath and returns the setup', async () => {
      const setup: TailwindSetup = {
        version: 'v4',
        entryCss: 'src/index.css',
        componentsLayer: true,
      };
      vi.mocked(core.invoke).mockResolvedValue(setup);

      const result = await detectTailwindSetup('/abs/project');

      expect(core.invoke).toHaveBeenCalledTimes(1);
      expect(core.invoke).toHaveBeenCalledWith('detect_tailwind_setup', {
        projectPath: '/abs/project',
      });
      expect(result).toEqual(setup);
    });

    it('passes through a "none" setup with a null entry stylesheet', async () => {
      const setup: TailwindSetup = { version: 'none', entryCss: null, componentsLayer: false };
      vi.mocked(core.invoke).mockResolvedValue(setup);

      await expect(detectTailwindSetup('/p')).resolves.toEqual(setup);
    });
  });

  describe('listCustomClasses', () => {
    it('invokes "list_custom_classes" with projectPath and returns the classes', async () => {
      const classes: CustomClass[] = [
        { name: 'btn-primary', tokens: ['px-4', 'py-2', 'rounded'], editable: true },
        { name: 'legacy', tokens: ['p-2'], editable: false },
      ];
      vi.mocked(core.invoke).mockResolvedValue(classes);

      const result = await listCustomClasses('/abs/project');

      expect(core.invoke).toHaveBeenCalledTimes(1);
      expect(core.invoke).toHaveBeenCalledWith('list_custom_classes', {
        projectPath: '/abs/project',
      });
      expect(result).toEqual(classes);
    });

    it('returns an empty array when the project has no custom classes', async () => {
      vi.mocked(core.invoke).mockResolvedValue([]);
      await expect(listCustomClasses('/p')).resolves.toEqual([]);
    });

    it('propagates backend errors to the caller', async () => {
      vi.mocked(core.invoke).mockRejectedValue(new Error('boom'));
      await expect(listCustomClasses('/p')).rejects.toThrow('boom');
    });
  });

  describe('createCustomClass', () => {
    it('invokes "create_custom_class" with name + tokens and returns the fresh list', async () => {
      const list: CustomClass[] = [{ name: 'btn', tokens: ['px-4', 'py-2'], editable: true }];
      vi.mocked(core.invoke).mockResolvedValue(list);

      const result = await createCustomClass('/abs/project', 'btn', ['px-4', 'py-2']);

      expect(core.invoke).toHaveBeenCalledWith('create_custom_class', {
        projectPath: '/abs/project',
        name: 'btn',
        tokens: ['px-4', 'py-2'],
      });
      expect(result).toEqual(list);
    });

    it('propagates a duplicate-name rejection', async () => {
      vi.mocked(core.invoke).mockRejectedValue(new Error('already exists'));
      await expect(createCustomClass('/p', 'btn', ['p-2'])).rejects.toThrow('already exists');
    });
  });

  describe('updateCustomClass', () => {
    it('invokes "update_custom_class" with the new token list', async () => {
      vi.mocked(core.invoke).mockResolvedValue([]);

      await updateCustomClass('/abs/project', 'btn', ['px-8']);

      expect(core.invoke).toHaveBeenCalledWith('update_custom_class', {
        projectPath: '/abs/project',
        name: 'btn',
        tokens: ['px-8'],
      });
    });
  });

  describe('deleteCustomClass', () => {
    it('invokes "delete_custom_class" with the class name', async () => {
      vi.mocked(core.invoke).mockResolvedValue([]);

      await deleteCustomClass('/abs/project', 'btn');

      expect(core.invoke).toHaveBeenCalledWith('delete_custom_class', {
        projectPath: '/abs/project',
        name: 'btn',
      });
    });
  });

  describe('classifyApplyTokens', () => {
    it('invokes "classify_apply_tokens" and returns the unsafe tokens', async () => {
      vi.mocked(core.invoke).mockResolvedValue(['animate-fade']);

      const result = await classifyApplyTokens('/abs/project', ['px-4', 'animate-fade']);

      expect(core.invoke).toHaveBeenCalledWith('classify_apply_tokens', {
        projectPath: '/abs/project',
        tokens: ['px-4', 'animate-fade'],
      });
      expect(result).toEqual(['animate-fade']);
    });
  });
});
