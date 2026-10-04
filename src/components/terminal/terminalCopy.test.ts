import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindTerminalCopyOnSelect, copyTerminalSelection } from './terminalCopy';

function installClipboard() {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

function fakeTerm(initial = '') {
  let selection = initial;
  const listeners = new Set<() => void>();
  return {
    getSelection: () => selection,
    select(text: string) {
      selection = text;
      for (const listener of listeners) listener();
    },
    /** Change the selection without telling xterm's selection listener. */
    setSelection(text: string) {
      selection = text;
    },
    clear() {
      selection = '';
      for (const listener of listeners) listener();
    },
    onSelectionChange(listener: () => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}

function mountContainer() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return container;
}

describe('copyTerminalSelection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears the selection after the write succeeds', async () => {
    installClipboard();
    const clearSelection = vi.fn();
    await copyTerminalSelection('npm test', clearSelection);
    expect(clearSelection).toHaveBeenCalledOnce();
  });

  it('leaves the selection when the clipboard write fails', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(() => Promise.reject(new Error('clipboard unavailable'))),
      },
    });
    const clearSelection = vi.fn();
    await expect(copyTerminalSelection('npm test', clearSelection)).rejects.toThrow(
      'clipboard unavailable'
    );
    expect(clearSelection).not.toHaveBeenCalled();
  });
});

describe('bindTerminalCopyOnSelect', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('copies the selection when the primary button is released', async () => {
    const writeText = installClipboard();
    const term = fakeTerm();
    const container = mountContainer();
    const dispose = bindTerminalCopyOnSelect(term, container);

    container.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    term.select('npm test');
    container.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('npm test'));
    dispose();
  });

  it('copies when the button is released outside the terminal', async () => {
    const writeText = installClipboard();
    const term = fakeTerm();
    const container = mountContainer();
    bindTerminalCopyOnSelect(term, container);

    container.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    term.select('outside');
    document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('outside'));
  });

  it('samples the selection during the drag before a redraw clears it', async () => {
    const writeText = installClipboard();
    const term = fakeTerm();
    const container = mountContainer();
    bindTerminalCopyOnSelect(term, container);

    container.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    term.setSelection('pnpm test:run');
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    term.clear();
    document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('pnpm test:run'));
  });

  it('does not recopy a previous selection on a later click', async () => {
    const writeText = installClipboard();
    const term = fakeTerm();
    const container = mountContainer();
    bindTerminalCopyOnSelect(term, container);

    container.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    term.select('keep me');
    container.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));

    container.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    term.clear();
    container.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  });

  it('keeps the text when output clears the selection before mouseup', async () => {
    const writeText = installClipboard();
    const term = fakeTerm();
    const container = mountContainer();
    bindTerminalCopyOnSelect(term, container);

    container.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    term.select('pnpm test:run');
    term.clear();
    container.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('pnpm test:run'));
  });

  it('reports a clipboard failure from mouseup', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(() => Promise.reject(new Error('denied'))),
      },
    });
    const term = fakeTerm();
    const container = mountContainer();
    const onError = vi.fn();
    bindTerminalCopyOnSelect(term, container, onError);

    container.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    term.select('keep');
    container.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('ignores the right button', async () => {
    const writeText = installClipboard();
    const term = fakeTerm('already');
    const container = mountContainer();
    bindTerminalCopyOnSelect(term, container);

    container.dispatchEvent(new MouseEvent('mouseup', { button: 2, bubbles: true }));
    await Promise.resolve();

    expect(writeText).not.toHaveBeenCalled();
  });

  it('stops listening after dispose', async () => {
    const writeText = installClipboard();
    const term = fakeTerm();
    const container = mountContainer();
    const dispose = bindTerminalCopyOnSelect(term, container);
    dispose();

    container.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    term.select('gone');
    document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    await Promise.resolve();

    expect(writeText).not.toHaveBeenCalled();
  });
});
