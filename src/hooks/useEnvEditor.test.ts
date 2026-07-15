import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useEnvEditor } from './useEnvEditor';

// Mock external dependencies
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('../lib/analytics', () => ({
  trackEvent: vi.fn(),
  trackError: vi.fn(),
}));

vi.mock('../lib/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('useEnvEditor', () => {
  let core: typeof import('@tauri-apps/api/core');

  beforeEach(async () => {
    vi.clearAllMocks();
    core = await import('@tauri-apps/api/core');
    vi.mocked(core.invoke).mockImplementation((cmd: string) => {
      if (cmd === 'list_env_files') return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
  });

  function renderEnvEditor() {
    return renderHook(() =>
      useEnvEditor({
        projectPath: '/test/project',
        isOpen: true,
        onClose: vi.fn(),
        onToast: vi.fn(),
      })
    );
  }

  describe('handleCreateFile error path', () => {
    it('renders a CommandError rejection as a readable message, not "[object Object]"', async () => {
      // invoke() rejections from migrated commands are plain CommandError
      // objects — NOT instanceof Error.
      vi.mocked(core.invoke).mockImplementation((cmd: string) => {
        if (cmd === 'list_env_files') return Promise.resolve([]);
        if (cmd === 'create_env_file') {
          // Intentional non-Error rejection: this is exactly how Tauri
          // surfaces CommandError values.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject({ type: 'Io', message: 'permission denied' });
        }
        return Promise.resolve(undefined);
      });

      const { result } = renderEnvEditor();
      await waitFor(() =>
        expect(core.invoke).toHaveBeenCalledWith('list_env_files', expect.anything())
      );

      await act(async () => {
        await result.current.handleCreateFile();
      });

      expect(result.current.error).toBe('I/O error: permission denied');
      expect(result.current.error).not.toContain('[object Object]');
    });

    it('renders a legacy string rejection as-is', async () => {
      vi.mocked(core.invoke).mockImplementation((cmd: string) => {
        if (cmd === 'list_env_files') return Promise.resolve([]);
        if (cmd === 'create_env_file') {
          // Intentional string rejection: legacy commands reject with strings.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject('file already exists');
        }
        return Promise.resolve(undefined);
      });

      const { result } = renderEnvEditor();

      await act(async () => {
        await result.current.handleCreateFile();
      });

      expect(result.current.error).toBe('file already exists');
    });
  });
});
