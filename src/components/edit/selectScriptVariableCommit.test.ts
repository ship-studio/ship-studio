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
