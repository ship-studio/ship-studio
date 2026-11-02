/** Behavior tests for the variable preview lifecycle in the injected selection script. */

import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import scriptHtml from '../../../src-tauri/src/proxy/select_script.html?raw';

const scriptJs = scriptHtml.replace(/^<script>/, '').replace(/<\/script>\s*$/, '');

function send(data: object) {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

beforeAll(() => {
  window.eval(scriptJs);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('bounds mutation scans and keeps the inline fallback usable after timeout', async () => {
  vi.useFakeTimers();
  const originalStyleSheets = Object.getOwnPropertyDescriptor(document, 'styleSheets');
  let stylesheetScans = 0;
  Object.defineProperty(document, 'styleSheets', {
    configurable: true,
    get: () => {
      stylesheetScans += 1;
      return [];
    },
  });
  const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
  const disconnectsBefore = disconnect.mock.calls.length;
  const identity = {
    key: 'new-root-variable-timeout-regression',
    file: 'src/theme.css',
    selector: ':root',
    name: '--new-color',
    line: null,
  };

  try {
    send({ type: 'ss:setVar', identity, value: 'red' });
    expect(document.documentElement.style.getPropertyValue('--new-color')).toBe('red');
    send({ type: 'ss:clearVar', identity, commit: true });
    stylesheetScans = 0;

    await vi.advanceTimersByTimeAsync(10_000);

    expect(disconnect).toHaveBeenCalledTimes(disconnectsBefore + 1);
    expect(stylesheetScans).toBe(200);
    expect(document.documentElement.style.getPropertyValue('--new-color')).toBe('red');

    document.documentElement.appendChild(document.createElement('span'));
    await Promise.resolve();
    expect(stylesheetScans).toBe(200);

    send({ type: 'ss:setVar', identity, value: 'blue' });
    expect(document.documentElement.style.getPropertyValue('--new-color')).toBe('blue');
    send({ type: 'ss:clearVar', identity, commit: false });
    expect(document.documentElement.style.getPropertyValue('--new-color')).toBe('');
  } finally {
    disconnect.mockRestore();
    if (originalStyleSheets) {
      Object.defineProperty(document, 'styleSheets', originalStyleSheets);
    } else {
      delete (document as { styleSheets?: StyleSheetList }).styleSheets;
    }
  }
});

it('keeps watching through more than 200 mutations until the authored root rule appears', () => {
  vi.useFakeTimers();
  const originalStyleSheets = Object.getOwnPropertyDescriptor(document, 'styleSheets');
  const originalObserver = globalThis.MutationObserver;
  let observerDisconnected = false;
  let observerDisconnects = 0;
  let deliverMutation: (() => void) | undefined;
  let stylesheetAvailable = false;
  let stylesheetScans = 0;
  const authoredStyle = document.createElement('style');
  authoredStyle.setAttribute('data-vite-dev-id', '/project/src/theme.css');
  authoredStyle.textContent = ':root { --mutation-color: red; }';
  globalThis.MutationObserver = class {
    private readonly callback: MutationCallback;

    constructor(callback: MutationCallback) {
      this.callback = callback;
      deliverMutation = () => {
        if (!observerDisconnected) this.callback([], this as unknown as MutationObserver);
      };
    }

    observe() {}

    disconnect() {
      observerDisconnected = true;
      observerDisconnects += 1;
    }

    takeRecords() {
      return [];
    }
  } as unknown as typeof MutationObserver;
  Object.defineProperty(document, 'styleSheets', {
    configurable: true,
    get: () => {
      stylesheetScans += 1;
      return stylesheetAvailable && authoredStyle.sheet ? [authoredStyle.sheet] : [];
    },
  });

  const identity = {
    key: 'new-root-variable-mutation-regression',
    file: 'src/theme.css',
    selector: ':root',
    name: '--mutation-color',
    line: null,
  };

  try {
    send({ type: 'ss:setVar', identity, value: 'red' });
    send({ type: 'ss:clearVar', identity, commit: true });
    stylesheetScans = 0;

    // Fake timers stay at their initial time, so these notifications cannot
    // consume the bounded retry budget owned by the timer.
    for (let i = 0; i < 220; i += 1) deliverMutation?.();

    expect(stylesheetScans).toBe(220);
    expect(observerDisconnected).toBe(false);

    document.head.appendChild(authoredStyle);
    stylesheetAvailable = true;
    deliverMutation?.();

    expect(document.documentElement.style.getPropertyValue('--mutation-color')).toBe('');
    expect(authoredStyle.sheet?.cssRules[0]?.cssText).toContain('--mutation-color: red');
    expect(observerDisconnected).toBe(true);
    expect(observerDisconnects).toBe(1);
  } finally {
    authoredStyle.remove();
    globalThis.MutationObserver = originalObserver;
    if (originalStyleSheets) {
      Object.defineProperty(document, 'styleSheets', originalStyleSheets);
    } else {
      delete (document as { styleSheets?: StyleSheetList }).styleSheets;
    }
  }
});
