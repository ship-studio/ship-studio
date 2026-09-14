import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import scriptHtml from '../../../src-tauri/src/proxy/select_script.html?raw';

const scriptJs = scriptHtml.replace(/^<script>/, '').replace(/<\/script>\s*$/, '');

/** Every event type the script put on `window` while it loaded. */
let listenersAtLoad: string[] = [];

beforeAll(() => {
  vi.useFakeTimers();
  const add = vi.spyOn(window, 'addEventListener');
  window.eval(scriptJs);
  listenersAtLoad = add.mock.calls.map(([type]) => type);
  add.mockRestore();
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

it('remeasures late content after settling and shrinks again without idle polling', async () => {
  document.body.innerHTML = '<main></main>';
  window.dispatchEvent(
    new MessageEvent('message', { data: { type: 'ss:canvas', on: true, vh: 700 } })
  );
  document.body.style.margin = '0';
  const main = document.querySelector('main')!;
  vi.spyOn(main, 'getBoundingClientRect').mockReturnValue({ bottom: 900 } as DOMRect);
  await vi.advanceTimersByTimeAsync(11000);
  const post = vi.spyOn(window.parent, 'postMessage');
  const extra = document.createElement('section');
  vi.spyOn(extra, 'getBoundingClientRect').mockReturnValue({ bottom: 2800 } as DOMRect);
  document.body.appendChild(extra);
  await vi.advanceTimersByTimeAsync(800);
  expect(post).toHaveBeenCalledWith({ type: 'ss:pageHeight', height: 2800 }, '*');
  extra.remove();
  await vi.advanceTimersByTimeAsync(800);
  expect(post).toHaveBeenCalledWith({ type: 'ss:pageHeight', height: 900 }, '*');
  const count = post.mock.calls.filter(
    ([d]) => (d as { type?: string }).type === 'ss:pageHeight'
  ).length;
  await vi.advanceTimersByTimeAsync(12000);
  expect(
    post.mock.calls.filter(([d]) => (d as { type?: string }).type === 'ss:pageHeight')
  ).toHaveLength(count);
  post.mockRestore();
});

/** Every box the select layer draws: the hover box plus one per selected
 *  element. They are the only `[data-ss-overlay]` divs on the page. */
const overlayBoxes = () =>
  Array.from(document.querySelectorAll<HTMLElement>('div[data-ss-overlay]'));

it('keeps the selection outline 1.5 screen pixels at every canvas zoom', () => {
  // The fixture itself has to be real: `?raw` has silently yielded an empty
  // string before, and every assertion below would then pass on nothing.
  expect(scriptJs).toContain('ss:canvasScale');

  document.body.innerHTML = '<section class="hero"><p class="copy">Hi</p></section>';
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'ss:activate' } }));
  document.querySelector('.copy')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  const boxes = overlayBoxes();
  // A guard, not decoration: with no box to measure, every width assertion
  // below would iterate an empty set and pass.
  expect(boxes.length).toBeGreaterThan(0);

  // What must hold is the RENDERED width — the page sits inside the canvas's
  // scale transform, so the border the user sees is `borderWidth x scale`.
  const renderedWidths = (scale: number) => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'ss:canvasScale', scale } }));
    return overlayBoxes().map((box) => Number.parseFloat(box.style.borderWidth) * scale);
  };

  expect(renderedWidths(0.25)).toEqual(boxes.map(() => 1.5));
  expect(renderedWidths(3)).toEqual(boxes.map(() => 1.5));

  // A box created AFTER the scale arrived is born at the right width too.
  document.querySelector('.hero')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(overlayBoxes().map((box) => Number.parseFloat(box.style.borderWidth) * 3)).toEqual(
    overlayBoxes().map(() => 1.5)
  );

  // Off the canvas there is no transform to cancel, so it is a plain 1.5px.
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'ss:canvas', on: false } }));
  expect(overlayBoxes().map((box) => box.style.borderWidth)).toEqual(
    overlayBoxes().map(() => '1.5px')
  );
});

it('drops the selection and its boxes when the host says the canvas was clicked', () => {
  document.body.innerHTML = '<section class="hero"><p class="copy">Hi</p></section>';
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'ss:activate' } }));
  const copy = document.querySelector('.copy')!;
  copy.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(overlayBoxes().filter((box) => box.style.display === 'block').length).toBeGreaterThan(0);
  // The selection is live: a mutation aimed at it lands. Without this the
  // "no longer lands" assertion below would pass on a selection that never
  // worked in the first place.
  window.dispatchEvent(
    new MessageEvent('message', { data: { type: 'ss:mutate', className: 'copy selected' } })
  );
  expect(copy.getAttribute('class')).toBe('copy selected');

  const post = vi.spyOn(window.parent, 'postMessage');
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'ss:deselect' } }));

  // The boxes are the thing on screen, and the selection behind them is what
  // an edit would land on: both have to go.
  expect(overlayBoxes().filter((box) => box.style.display === 'block')).toEqual([]);
  window.dispatchEvent(
    new MessageEvent('message', { data: { type: 'ss:mutate', className: 'copy after' } })
  );
  expect(copy.getAttribute('class')).toBe('copy selected');
  // And the host is told, so its panels, toolbar and tree let go at the same
  // moment rather than describing an element nothing points at.
  expect(post).toHaveBeenCalledWith({ type: 'ss:deselect' }, '*');
  post.mockRestore();
});

it('gives the single preview no wheel or pinch listener, and the canvas one only while it lasts', () => {
  // A guard: the spy has to have seen the script register listeners at all,
  // or the "none of them is a wheel" assertion below would pass on nothing.
  expect(listenersAtLoad).toContain('message');
  // Issue #959. A non-passive wheel listener costs the page its trackpad
  // scrolling in WebKit even when it returns straight away, so the ordinary
  // preview must not carry one.
  expect(listenersAtLoad.filter((type) => /^(wheel|gesture)/.test(type))).toEqual([]);

  const ctrlWheel = () => {
    const event = new WheelEvent('wheel', { deltaY: 10, ctrlKey: true, cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const post = vi.spyOn(window.parent, 'postMessage');

  // On a canvas, a pinch-zoom over the frame still belongs to the canvas.
  window.dispatchEvent(
    new MessageEvent('message', { data: { type: 'ss:canvas', on: true, vh: 700 } })
  );
  expect(ctrlWheel()).toBe(true);
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'ss:wheelZoom' }), '*');

  // Back to the single preview: the listeners go, not just their effect.
  const remove = vi.spyOn(window, 'removeEventListener');
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'ss:canvas', on: false } }));
  expect(remove.mock.calls.map(([type]) => type)).toEqual(
    expect.arrayContaining(['wheel', 'gesturestart', 'gesturechange', 'gestureend'])
  );
  post.mockClear();
  expect(ctrlWheel()).toBe(false);
  expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'ss:wheelZoom' }), '*');

  remove.mockRestore();
  post.mockRestore();
});
