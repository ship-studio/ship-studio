import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import scriptHtml from '../../../src-tauri/src/proxy/select_script.html?raw';

const scriptJs = scriptHtml.replace(/^<script>/, '').replace(/<\/script>\s*$/, '');

beforeAll(() => {
  vi.useFakeTimers();
  window.eval(scriptJs);
});

afterAll(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('pins the root height for a canvas without touching the site around it', async () => {
  document.body.innerHTML = '<main><div id="scroller">Nested content</div></main>';
  const siteStyle = document.createElement('style');
  siteStyle.textContent = `
    html { scrollbar-width: auto; scrollbar-gutter: stable; }
    #scroller { height: 100px; overflow: auto; scrollbar-width: thin; }
  `;
  document.head.appendChild(siteStyle);
  const originalSiteCss = siteStyle.sheet!.cssRules[0].cssText;
  // Everything the canvas adds is off until it is told it is on a canvas, so
  // the ordinary single-frame preview costs exactly what it did before.
  expect(document.getElementById('ss-root-height')).toBeNull();

  const announce = () => {
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'ss:canvas', on: true, vh: 700 } })
    );
  };
  announce();

  const pin = document.querySelector<HTMLStyleElement>('#ss-root-height')!;
  const rules = Array.from(pin.sheet!.cssRules) as CSSStyleRule[];
  const root = rules.find((rule) => rule.selectorText === 'html')!.style;
  // The device height, not the frame's: that is what makes a page laid out in
  // a 13,000px frame still believe `100vh` is one screen.
  expect(root.getPropertyValue('height')).toBe('700px');
  expect(root.getPropertyPriority('height')).toBe('important');
  // Overflow must remain visible: clipping the root to its device height would
  // remove the page below the first screen, even with a full-height iframe.
  expect(root.getPropertyValue('overflow')).toBe('visible');
  // The site's own stylesheet is read, never rewritten, and nested scrollers
  // keep their own scrolling and their own scrollbars.
  expect(siteStyle.sheet!.cssRules[0].cssText).toBe(originalSiteCss);
  expect(getComputedStyle(document.getElementById('scroller')!).overflow).toBe('auto');
  expect(getComputedStyle(document.getElementById('scroller')!).scrollbarWidth).toBe('thin');

  // Re-announcing and settling must not turn the head observer into a loop.
  const mutations: MutationRecord[] = [];
  const observer = new MutationObserver((records) => mutations.push(...records));
  observer.observe(pin, { childList: true, subtree: true, characterData: true });
  announce();
  await vi.advanceTimersByTimeAsync(1200);
  observer.disconnect();
  expect(mutations).toEqual([]);
});
