import { describe, expect, it } from 'vitest';
import { mockIPC } from '@tauri-apps/api/mocks';
import { isPasteChord, readClipboardText, stageClipboardImage } from './clipboard';

// The global afterEach (test/setup.ts) clearMocks() wipes the IPC handler
// after each test, so each test installs its own mockIPC.

describe('readClipboardText', () => {
  it('returns the clipboard text from the backend', async () => {
    mockIPC((cmd) => {
      if (cmd === 'read_clipboard_text') return 'hello from clipboard';
      throw new Error(`unexpected command: ${cmd}`);
    });
    await expect(readClipboardText()).resolves.toBe('hello from clipboard');
  });

  it('returns null when the clipboard has no text', async () => {
    mockIPC((cmd) => {
      if (cmd === 'read_clipboard_text') return null;
      throw new Error(`unexpected command: ${cmd}`);
    });
    await expect(readClipboardText()).resolves.toBeNull();
  });
});

describe('stageClipboardImage', () => {
  it('returns the staged PNG path from the backend', async () => {
    mockIPC((cmd) => {
      if (cmd === 'stage_clipboard_image') return 'C:\\Temp\\shipstudio-paste-abc.png';
      throw new Error(`unexpected command: ${cmd}`);
    });
    await expect(stageClipboardImage()).resolves.toBe('C:\\Temp\\shipstudio-paste-abc.png');
  });

  it('returns null when the clipboard has no image', async () => {
    mockIPC((cmd) => {
      if (cmd === 'stage_clipboard_image') return null;
      throw new Error(`unexpected command: ${cmd}`);
    });
    await expect(stageClipboardImage()).resolves.toBeNull();
  });

  it('rejects when the backend fails', async () => {
    mockIPC(() => {
      throw new Error('clipboard locked');
    });
    await expect(stageClipboardImage()).rejects.toThrow('clipboard locked');
  });
});

describe('isPasteChord', () => {
  const base = {
    type: 'keydown',
    key: 'v',
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
  };

  it('matches a plain Ctrl+V keydown', () => {
    expect(isPasteChord(base)).toBe(true);
  });

  it('matches uppercase V (caps lock) without shift', () => {
    expect(isPasteChord({ ...base, key: 'V' })).toBe(true);
  });

  it('rejects keyup and keypress phases', () => {
    expect(isPasteChord({ ...base, type: 'keyup' })).toBe(false);
    expect(isPasteChord({ ...base, type: 'keypress' })).toBe(false);
  });

  it('rejects the chord without Ctrl', () => {
    expect(isPasteChord({ ...base, ctrlKey: false })).toBe(false);
  });

  it('rejects extra modifiers (Shift/Alt/Meta)', () => {
    expect(isPasteChord({ ...base, shiftKey: true })).toBe(false);
    expect(isPasteChord({ ...base, altKey: true })).toBe(false);
    expect(isPasteChord({ ...base, metaKey: true })).toBe(false);
  });

  it('rejects other keys', () => {
    expect(isPasteChord({ ...base, key: 'c' })).toBe(false);
    expect(isPasteChord({ ...base, key: 'Enter' })).toBe(false);
  });
});
