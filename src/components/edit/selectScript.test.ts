/**
 * Behavior test for the in-iframe selection script (`SELECT_SCRIPT`).
 *
 * The script's canonical source lives in `src-tauri/src/proxy/select_script.html`
 * (Rust injects it via `include_str!`). Here we evaluate that exact source in the
 * jsdom window and exercise the message protocol the rest of the editor depends on:
 * inert-until-activated, click → `ss:select` signature, and `ss:mutate` → live class.
 */

import { beforeAll, expect, it } from 'vitest';
// Import the exact script Rust injects (via `include_str!`) as a raw string so
// both consumers share one source of truth.
import scriptHtml from '../../../src-tauri/src/proxy/select_script.html?raw';

const scriptJs = scriptHtml.replace(/^<script>/, '').replace(/<\/script>\s*$/, '');

/** Deliver a parent→iframe control message synchronously. */
function send(data: unknown) {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

/** Resolve with the next `ss:select` the script posts to the parent. */
function nextSelect(): Promise<{ signature: Record<string, unknown>; count: number }> {
  return new Promise((res) => {
    const handler = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type === 'ss:select') {
        window.removeEventListener('message', handler);
        res(e.data as { signature: Record<string, unknown>; count: number });
      }
    };
    window.addEventListener('message', handler);
  });
}

beforeAll(() => {
  window.eval(scriptJs);
});

it('stays inert until activated', () => {
  document.body.innerHTML = '<button class="btn">x</button>';
  let posted = false;
  const handler = (e: MessageEvent) => {
    if ((e.data as { type?: string })?.type === 'ss:select') posted = true;
  };
  window.addEventListener('message', handler);
  document.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  window.removeEventListener('message', handler);
  expect(posted).toBe(false);
});

it('reports a signature on click after activate', async () => {
  document.body.innerHTML =
    '<section class="hero"><div class="card"><button class="btn p-4">Buy now</button></div></section>';
  send({ type: 'ss:activate' });
  const selected = nextSelect();
  document.querySelector('.btn')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const msg = await selected;
  expect(msg.signature.className).toBe('btn p-4');
  expect(msg.signature.tagName).toBe('button');
  expect(msg.signature.text).toBe('Buy now');
  // Nearest-first ancestor class chain anchors disambiguation.
  expect(msg.signature.ancestorClasses).toEqual(['card', 'hero']);
  expect(msg.count).toBe(1);
});

it('live-applies a class to the selected element on ss:mutate', () => {
  const btn = document.querySelector('.btn') as HTMLElement;
  send({ type: 'ss:mutate', className: 'btn p-8' });
  expect(btn.getAttribute('class')).toBe('btn p-8');
});

it('applies an inline style patch on ss:mutate (JIT-independent preview)', () => {
  const btn = document.querySelector('.btn') as HTMLElement;
  // Tailwind may not have compiled `.p-14`; the inline value drives the preview.
  send({ type: 'ss:mutate', className: 'btn p-14', style: { padding: '3.5rem' } });
  expect(btn.getAttribute('class')).toBe('btn p-14');
  expect(btn.style.padding).toBe('3.5rem');
});

it('walks up to the nearest classed ancestor when a bare child is clicked', async () => {
  document.body.innerHTML = '<a class="link"><svg><span>icon</span></svg></a>';
  send({ type: 'ss:activate' });
  const selected = nextSelect();
  // Click the inner <span>, which has no class — should resolve to <a class="link">.
  document.querySelector('span')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const msg = await selected;
  expect(msg.signature.className).toBe('link');
  expect(msg.signature.tagName).toBe('a');
});

it('reports the count of, and live-mutates, ALL elements sharing the class', async () => {
  // Three testimonials rendered from one .map() → identical class attribute.
  document.body.innerHTML =
    '<div class="name">A</div><div class="name">B</div><div class="name">C</div>';
  send({ type: 'ss:activate' });
  const selected = nextSelect();
  document.querySelectorAll('.name')[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const msg = await selected;
  expect(msg.count).toBe(3);

  // A mutation applies to every matching element, not just the clicked one.
  send({ type: 'ss:mutate', className: 'name font-bold' });
  const updated = [...document.querySelectorAll('[class]')].filter(
    (e) => e.getAttribute('class') === 'name font-bold'
  );
  expect(updated).toHaveLength(3);
});
