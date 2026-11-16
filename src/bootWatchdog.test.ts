import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../index.html?raw';

/**
 * The boot watchdogs in `index.html` are the only thing standing between a
 * failed start and a uniformly dark window with no explanation — the shape of
 * issue #173, and of the report that prompted this test, where a user saw a
 * blank screen through a delete-and-reinstall and none of the app's fallbacks
 * ever appeared.
 *
 * Two failure modes, and the second is the one that used to be silent:
 *  - the bundle never evaluated, so React never cleared `#root`;
 *  - the bundle ran but the stylesheet did not load, so React mounted and drew
 *    an app with no rules — black text on a #1e1e1e body, i.e. nothing.
 *
 * The false-positive case matters as much as the true ones: this markup shows
 * an error *over a working app* if it gets the condition wrong, so a healthy
 * boot is asserted here too.
 */

const SCRIPT = (() => {
  const scripts = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const watchdog = scripts.find((s) => s.includes('boot-fallback'));
  if (!watchdog) throw new Error('boot watchdog script not found in index.html');
  return watchdog;
})();

/** The page's markup, minus the scripts, so we control when the watchdog runs. */
function renderPage() {
  const body = indexHtml.slice(indexHtml.indexOf('<body>') + 6, indexHtml.indexOf('</body>'));
  document.body.innerHTML = body.replace(/<script>[\s\S]*?<\/script>/g, '');
  document.head.innerHTML = '';
}

/** Whatever React would have done to `#root` before the watchdog fires. */
function mountApp() {
  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing');
  root.innerHTML = '<div class="app">mounted</div>';
}

function addStylesheet({ loaded }: { loaded: boolean }) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/assets/index-abc123.css';
  document.head.appendChild(link);
  // jsdom never populates `sheet` for a <link>, which is exactly the "failed"
  // shape; a loaded sheet is simulated by defining the property.
  if (loaded) Object.defineProperty(link, 'sheet', { value: {}, configurable: true });
}

const shown = (id: string) => document.getElementById(id)?.style.display === 'flex';

describe('index.html boot watchdogs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    renderPage();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.style.cssText = '';
  });

  const runInlineScript = () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
    new Function(SCRIPT)();
  };

  const runWatchdog = () => {
    runInlineScript();
    vi.advanceTimersByTime(10_000);
  };

  it('explains a bundle that never evaluated', () => {
    // React never ran, so #boot-fallback is still inside #root.
    runWatchdog();
    expect(shown('boot-fallback')).toBe(true);
    expect(shown('styles-fallback')).toBe(false);
  });

  it('reports a failed app entry module', () => {
    runInlineScript();
    const entry = document.getElementById('app-entry');
    if (!entry) throw new Error('#app-entry missing');

    entry.dispatchEvent(new Event('error'));

    expect(document.getElementById('boot-fallback-error')?.textContent).toContain(
      'The app entry module failed to load'
    );
  });

  it('distinguishes a loaded entry module that did not mount React', () => {
    runInlineScript();
    const entry = document.getElementById('app-entry');
    if (!entry) throw new Error('#app-entry missing');
    entry.dispatchEvent(new Event('load'));

    vi.advanceTimersByTime(10_000);

    expect(document.getElementById('boot-fallback-error')?.textContent).toContain(
      'The app entry module loaded, but React did not mount'
    );
  });

  it('explains an app that mounted without its stylesheet', () => {
    mountApp();
    addStylesheet({ loaded: false });
    runWatchdog();
    expect(shown('styles-fallback')).toBe(true);
  });

  it('says nothing when the app mounted and its stylesheet loaded', () => {
    mountApp();
    addStylesheet({ loaded: true });
    runWatchdog();
    expect(shown('boot-fallback')).toBe(false);
    expect(shown('styles-fallback')).toBe(false);
  });

  it('says nothing in a dev build, which injects its CSS and has no <link>', () => {
    mountApp();
    runWatchdog();
    expect(shown('styles-fallback')).toBe(false);
  });

  it('will not cry stylesheet when the tokens actually resolve', () => {
    // Both signals must agree. If the sheet is unreadable for some other
    // reason but the rules are plainly applying, this must stay quiet rather
    // than put an error banner over a working app.
    mountApp();
    addStylesheet({ loaded: false });
    document.documentElement.style.setProperty('--surface-app', '#0b0b0d');
    runWatchdog();
    expect(shown('styles-fallback')).toBe(false);
  });
});
