/**
 * Code-tab file-tree + inline-editing state.
 *
 * Focus: the behaviors that carried real bugs — the discard-confirmation guard
 * (a switch/toggle-off must NOT drop the dirty buffer until confirmed; this
 * replaced a `window.confirm` that Tauri's webview made non-blocking), the
 * persisted global edit-mode opt-in, the ⌘S-on-clean no-op, and auto-entering
 * edit mode for editable files only. Only the lib/code Tauri wrappers are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { FileContent } from '../lib/code';

vi.mock('../lib/code', async (importActual) => {
  const actual = await importActual<typeof import('../lib/code')>();
  return {
    ...actual,
    listProjectFiles: vi.fn().mockResolvedValue([]),
    readProjectFile: vi.fn(),
    saveProjectFile: vi.fn().mockResolvedValue(undefined),
    buildFileTree: vi.fn(() => []),
  };
});

vi.mock('../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// saveFile fires a 'code_file_saved' event; keep it off the real Tauri IPC.
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn().mockResolvedValue(undefined) }));

import { useFileTree } from './useFileTree';
import { readProjectFile, saveProjectFile } from '../lib/code';

type Fn = ReturnType<typeof vi.fn>;
const EDIT_KEY = 'shipstudio:code-edit-mode';

const file = (over: Partial<FileContent> = {}): FileContent => ({
  content: 'hello',
  isBinary: false,
  isTruncated: false,
  size: 5,
  language: 'typescript',
  ...over,
});

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

/** Render the hook (settling the async tree-load on mount); if `editMode`, seed
 *  the persisted opt-in before mount. */
async function setup(editMode = false) {
  if (editMode) localStorage.setItem(EDIT_KEY, '1');
  const hook = renderHook(() => useFileTree('/proj'));
  await act(async () => {
    await flush();
  });
  return hook;
}

/** Select a file and let the (async) read + auto-enter effect settle. */
async function open(
  result: { current: ReturnType<typeof useFileTree> },
  path: string,
  content: FileContent
) {
  (readProjectFile as Fn).mockResolvedValue(content);
  await act(async () => {
    result.current.selectFile(path);
    await flush();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (saveProjectFile as Fn).mockResolvedValue(undefined);
  localStorage.clear();
});

describe('useFileTree — edit mode persistence', () => {
  it('restores editModeEnabled from localStorage', async () => {
    const { result } = await setup(true);
    expect(result.current.editModeEnabled).toBe(true);
  });

  it('defaults to off when nothing is persisted', async () => {
    const { result } = await setup(false);
    expect(result.current.editModeEnabled).toBe(false);
  });

  it('setEditMode persists the choice app-wide', async () => {
    const { result } = await setup(false);
    act(() => result.current.setEditMode(true));
    expect(result.current.editModeEnabled).toBe(true);
    expect(localStorage.getItem(EDIT_KEY)).toBe('1');
    act(() => result.current.setEditMode(false));
    expect(result.current.editModeEnabled).toBe(false);
    expect(localStorage.getItem(EDIT_KEY)).toBe('0');
  });
});

describe('useFileTree — auto-enter edit mode', () => {
  it('opens an editable file straight into the editor when edit mode is on', async () => {
    const { result } = await setup(true);
    await open(result, 'a.ts', file({ content: 'abc' }));
    expect(result.current.isEditing).toBe(true);
    expect(result.current.draft).toBe('abc');
  });

  it('leaves binary and truncated files read-only', async () => {
    const { result } = await setup(true);
    await open(result, 'img.png', file({ isBinary: true }));
    expect(result.current.isEditing).toBe(false);

    await open(result, 'huge.log', file({ isTruncated: true }));
    expect(result.current.isEditing).toBe(false);
  });

  it('stays read-only when edit mode is off', async () => {
    const { result } = await setup(false);
    await open(result, 'a.ts', file());
    expect(result.current.isEditing).toBe(false);
  });
});

describe('useFileTree — saveFile', () => {
  it('writes the draft to disk when dirty', async () => {
    const { result } = await setup(true);
    await open(result, 'a.ts', file({ content: 'abc' }));
    await act(async () => {
      result.current.updateDraft('abcX');
      await flush();
    });
    let ret: string | undefined;
    await act(async () => {
      ret = await result.current.saveFile();
    });
    expect(saveProjectFile).toHaveBeenCalledWith('/proj', 'a.ts', 'abcX');
    expect(ret).toBe('saved');
  });

  it('no-ops on a clean buffer (the ⌘S-on-unchanged guard)', async () => {
    const { result } = await setup(true);
    await open(result, 'a.ts', file({ content: 'abc' }));
    // draft === content → unchanged
    let ret: string | undefined;
    await act(async () => {
      ret = await result.current.saveFile();
    });
    expect(saveProjectFile).not.toHaveBeenCalled();
    expect(ret).toBe('noop');
  });

  it('surfaces a save failure and returns false', async () => {
    (saveProjectFile as Fn).mockRejectedValueOnce(new Error('disk full'));
    const { result } = await setup(true);
    await open(result, 'a.ts', file({ content: 'abc' }));
    await act(async () => {
      result.current.updateDraft('abcX');
      await flush();
    });
    let ret: string | undefined;
    await act(async () => {
      ret = await result.current.saveFile();
    });
    expect(ret).toBe('error');
    expect(result.current.saveError).toBe('disk full');
  });
});

describe('useFileTree — discard-confirmation guard', () => {
  async function dirtyEditing(result: { current: ReturnType<typeof useFileTree> }) {
    await open(result, 'a.ts', file({ content: 'abc' }));
    await act(async () => {
      result.current.updateDraft('abcX');
      await flush();
    });
    expect(result.current.isDirty).toBe(true);
  }

  it('does NOT switch files while dirty — it stages a pending confirmation', async () => {
    const { result } = await setup(true);
    await dirtyEditing(result);

    (readProjectFile as Fn).mockClear();
    await act(async () => {
      result.current.selectFile('b.ts');
      await flush();
    });

    expect(result.current.pendingAction).toEqual({ kind: 'switch', path: 'b.ts' });
    expect(result.current.selectedFilePath).toBe('a.ts'); // unchanged
    expect(readProjectFile).not.toHaveBeenCalled(); // b.ts never loaded
  });

  it('confirming the pending switch discards the buffer and loads the new file', async () => {
    const { result } = await setup(true);
    await dirtyEditing(result);
    await act(async () => {
      result.current.selectFile('b.ts');
      await flush();
    });

    (readProjectFile as Fn).mockResolvedValue(file({ content: 'bbb' }));
    await act(async () => {
      result.current.confirmPendingAction();
      await flush();
    });

    expect(result.current.selectedFilePath).toBe('b.ts');
    expect(result.current.draft).toBe('bbb');
    expect(result.current.pendingAction).toBeNull();
  });

  it('cancelling the pending switch keeps the file and the unsaved edits', async () => {
    const { result } = await setup(true);
    await dirtyEditing(result);
    await act(async () => {
      result.current.selectFile('b.ts');
      await flush();
    });

    act(() => result.current.cancelPendingAction());

    expect(result.current.pendingAction).toBeNull();
    expect(result.current.selectedFilePath).toBe('a.ts');
    expect(result.current.draft).toBe('abcX'); // edits intact
  });

  it('turning edit mode OFF while dirty stages a confirmation instead of dropping edits', async () => {
    const { result } = await setup(true);
    await dirtyEditing(result);

    await act(async () => {
      result.current.setEditMode(false);
      await flush();
    });

    // Not yet applied — still editing, still dirty, still persisted on.
    expect(result.current.pendingAction).toEqual({ kind: 'disable-edit' });
    expect(result.current.editModeEnabled).toBe(true);
    expect(result.current.isDirty).toBe(true);

    await act(async () => {
      result.current.confirmPendingAction();
      await flush();
    });
    expect(result.current.editModeEnabled).toBe(false);
    expect(localStorage.getItem(EDIT_KEY)).toBe('0');
    expect(result.current.isEditing).toBe(false);
  });

  it('switching to a non-dirty file goes straight through (no confirmation)', async () => {
    const { result } = await setup(true);
    await open(result, 'a.ts', file({ content: 'abc' }));
    // not dirty — switch should just load
    await open(result, 'b.ts', file({ content: 'bbb' }));
    expect(result.current.pendingAction).toBeNull();
    expect(result.current.selectedFilePath).toBe('b.ts');
    expect(result.current.draft).toBe('bbb');
  });
});
