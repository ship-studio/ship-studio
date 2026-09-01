import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { describeInvalidEnvKey, splitEnvEntry, useEnvEditor } from './useEnvEditor';

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

  describe('variable name field (issue #824)', () => {
    /** Render with one loaded .env.local holding a single variable. */
    async function renderWithVar() {
      vi.mocked(core.invoke).mockImplementation((cmd: string) => {
        if (cmd === 'list_env_files')
          return Promise.resolve([{ name: '.env.local', path: '/test/project/.env.local' }]);
        if (cmd === 'read_env_file') return Promise.resolve([{ key: 'FOO', value: 'bar' }]);
        return Promise.resolve(undefined);
      });
      const rendered = renderEnvEditor();
      await waitFor(() => expect(rendered.result.current.vars).toHaveLength(1));
      return rendered;
    }

    it('splits a pasted KEY=value into both fields and explains what happened', async () => {
      const { result } = await renderWithVar();

      act(() => {
        result.current.handleUpdateVar(0, 'key', 'API_KEY=sk-123');
      });

      expect(result.current.vars[0]).toEqual({ key: 'API_KEY', value: 'sk-123' });
      expect(result.current.keyNotice).toContain('name and value fields');
    });

    it('strips quotes from the split value, like the bulk paste flow', async () => {
      const { result } = await renderWithVar();

      act(() => {
        result.current.handleUpdateVar(0, 'key', 'GREETING="hello world"');
      });

      expect(result.current.vars[0]).toEqual({ key: 'GREETING', value: 'hello world' });
    });

    it('a trailing "=" (a .env.example line) never wipes the row\'s existing value', async () => {
      // `API_KEY=` carries a name and NO value. Treating the empty half as a
      // real value overwrote the stored secret with '', and Save destroyed it.
      const { result } = await renderWithVar();

      act(() => {
        result.current.handleUpdateVar(0, 'key', 'API_KEY=');
      });

      expect(result.current.vars[0]).toEqual({ key: 'API_KEY', value: 'bar' });
      expect(result.current.keyNotice).toContain('left as it was');

      await act(async () => {
        await result.current.handleSave();
      });
      expect(core.invoke).toHaveBeenCalledWith('write_env_file', {
        filePath: '/test/project/.env.local',
        vars: [{ key: 'API_KEY', value: 'bar' }],
      });
    });

    it('refuses to save an invalid name inline instead of letting the backend reject it', async () => {
      const { result } = await renderWithVar();
      act(() => {
        result.current.handleUpdateVar(0, 'key', 'my key');
      });

      await act(async () => {
        await result.current.handleSave();
      });

      expect(result.current.error).toContain('valid variable name');
      expect(core.invoke).not.toHaveBeenCalledWith('write_env_file', expect.anything());
    });

    it('still saves a valid name', async () => {
      const { result } = await renderWithVar();
      act(() => {
        result.current.handleUpdateVar(0, 'key', 'FOO_2');
      });

      await act(async () => {
        await result.current.handleSave();
      });

      expect(result.current.error).toBeNull();
      expect(core.invoke).toHaveBeenCalledWith('write_env_file', expect.anything());
    });
  });
});

describe('splitEnvEntry', () => {
  it('splits at the first "=" and trims both halves', () => {
    expect(splitEnvEntry(' API_KEY = sk-1=2 ')).toEqual({ key: 'API_KEY', value: 'sk-1=2' });
  });

  it('leaves the value untouched (null) when there is no "="', () => {
    expect(splitEnvEntry('  API_KEY ')).toEqual({ key: 'API_KEY', value: null });
  });

  it('keeps a lone quote character as-is', () => {
    expect(splitEnvEntry('K="')).toEqual({ key: 'K', value: '"' });
  });

  it('reports a trailing "=" as no value at all, so callers keep the existing one', () => {
    expect(splitEnvEntry('API_KEY=')).toEqual({ key: 'API_KEY', value: null });
    expect(splitEnvEntry('API_KEY=   ')).toEqual({ key: 'API_KEY', value: null });
    expect(splitEnvEntry('API_KEY=""')).toEqual({ key: 'API_KEY', value: null });
  });
});

describe('describeInvalidEnvKey', () => {
  it('accepts names write_env_file accepts', () => {
    for (const key of ['FOO', '_private', 'A1_b2']) {
      expect(describeInvalidEnvKey(key)).toBeNull();
    }
  });

  it('explains empty, leading-digit and illegal-character names', () => {
    expect(describeInvalidEnvKey('   ')).toContain('needs a name');
    expect(describeInvalidEnvKey('1FOO')).toContain("can't start with a number");
    expect(describeInvalidEnvKey('MY KEY')).toContain('valid variable name');
    expect(describeInvalidEnvKey('KEY=value')).toContain('valid variable name');
  });

  it('rejects a name longer than the backend limit', () => {
    expect(describeInvalidEnvKey('A'.repeat(257))).toContain('too long');
  });
});
