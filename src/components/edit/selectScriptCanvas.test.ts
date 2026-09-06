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

it('keeps root scrollbar gutters out of a canvas without changing nested scrollers', async () => {
  document.body.innerHTML = '<main><div id="scroller">Nested content</div></main>';
  const siteStyle = document.createElement('style');
  siteStyle.textContent = `
    html { scrollbar-width: auto; scrollbar-gutter: stable; }
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    #scroller { height: 100px; overflow: auto; scrollbar-width: thin; }
  `;
  document.head.appendChild(siteStyle);
  const originalSiteCss = siteStyle.sheet!.cssRules[0].cssText;
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
  expect(root.getPropertyValue('scrollbar-width')).toBe('none');
  expect(root.getPropertyPriority('scrollbar-width')).toBe('important');
  expect(root.getPropertyValue('scrollbar-gutter')).toBe('auto');
  expect(root.getPropertyPriority('scrollbar-gutter')).toBe('important');
  // Overflow must remain visible: clipping the root to its device height would
  // remove the page below the first screen, even with a full-height iframe.
  expect(root.getPropertyValue('overflow')).toBe('visible');
  const scrollbar = rules.find((rule) => rule.selectorText === 'html::-webkit-scrollbar')!;
  expect(scrollbar.style.getPropertyValue('display')).toBe('none');
  expect(scrollbar.style.getPropertyPriority('display')).toBe('important');
  expect(scrollbar.style.getPropertyValue('width')).toBe('0');
  expect(scrollbar.style.getPropertyPriority('width')).toBe('important');
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
