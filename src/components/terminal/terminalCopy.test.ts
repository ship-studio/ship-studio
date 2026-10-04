import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindTerminalCopyOnSelect } from './terminalCopy';

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

describe('bindTerminalCopyOnSelect', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('copies the selection when the primary button is released', async () => {
    const writeText = installClipboard();
    const term = fakeTerm();
    const container = document.createElement('div');
    const dispose = bindTerminalCopyOnSelect(term, container);

    container.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    term.select('npm test');
    container.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('npm test');
    dispose();
  });

  it('does not recopy a previous selection on a later click', async () => {
    const writeText = installClipboard();
    const term = fakeTerm();
    const container = document.createElement('div');
    bindTerminalCopyOnSelect(term, container);

    container.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    term.select('keep me');
    container.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));

    container.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    term.clear();
    container.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('keeps the text when output clears the selection before mouseup', async () => {
    const writeText = installClipboard();
    const term = fakeTerm();
    const container = document.createElement('div');
    bindTerminalCopyOnSelect(term, container);

    container.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    term.select('pnpm test:run');
    term.clear();
    container.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('pnpm test:run');
  });

  it('ignores the right button', async () => {
    const writeText = installClipboard();
    const term = fakeTerm('already');
    const container = document.createElement('div');
    bindTerminalCopyOnSelect(term, container);

    container.dispatchEvent(new MouseEvent('mouseup', { button: 2 }));
    await Promise.resolve();

    expect(writeText).not.toHaveBeenCalled();
  });
});
