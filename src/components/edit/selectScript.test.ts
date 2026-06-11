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
function nextSelect(): Promise<{
  signature: Record<string, unknown>;
  count: number;
  leafText?: boolean;
}> {
  return new Promise((res) => {
    const handler = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type === 'ss:select') {
        window.removeEventListener('message', handler);
        res(e.data as { signature: Record<string, unknown>; count: number; leafText?: boolean });
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

it('previews a freshly-typed class via an injected stylesheet, not inline styles', () => {
  const btn = document.querySelector('.btn') as HTMLElement;
  // Tailwind may not have compiled `.p-14`; a stylesheet rule keyed to a marker
  // attribute drives the preview (NOT an inline style — that can't be width-scoped).
  send({
    type: 'ss:mutate',
    className: 'btn p-14',
    rules: [{ minPx: 0, decls: { padding: '3.5rem' } }],
  });
  expect(btn.getAttribute('class')).toBe('btn p-14');
  expect(btn.style.padding).toBe(''); // no inline style
  const mark = btn.getAttribute('data-ss-sel');
  expect(mark).toBeTruthy();
  const sheet = document.getElementById('ss-preview')!.textContent!;
  expect(sheet).toContain('padding:3.5rem !important');
  expect(sheet).toContain(`[data-ss-sel="${mark}"]`);
});

it('wraps a breakpoint edit in a min-width media query, base before variant', () => {
  // Mutate targets the currently-selected `.btn` (from the prior test).
  send({
    type: 'ss:mutate',
    className: 'btn p-14 md:p-20',
    rules: [
      { minPx: 0, decls: { padding: '3.5rem' } },
      { minPx: 768, decls: { padding: '5rem' } },
    ],
  });
  const sheet = document.getElementById('ss-preview')!.textContent!;
  expect(sheet).toContain('@media (min-width:768px)');
  // Ascending minPx order: base rule precedes the media rule so the larger
  // breakpoint wins by source order without needing extra specificity.
  expect(sheet.indexOf('padding:3.5rem')).toBeLessThan(sheet.indexOf('@media'));
});

it('walks up to the nearest classed ancestor when a bare non-text child is clicked', async () => {
  // The clicked <div> is classless and holds an element child (not plain text), so
  // it isn't a text leaf — selection resolves to the nearest classed ancestor.
  document.body.innerHTML = '<a class="link"><div><svg></svg></div></a>';
  send({ type: 'ss:activate' });
  const selected = nextSelect();
  document.querySelector('div')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const msg = await selected;
  expect(msg.signature.className).toBe('link');
  expect(msg.signature.tagName).toBe('a');
});

it('selects a classless text leaf directly (so its text is editable)', async () => {
  // A classless heading with text + <br> is a text leaf — clicking selects it
  // directly (not its classed wrapper), flagged leafText so the parent resolves text.
  document.body.innerHTML =
    '<section class="hero"><h2>Trusted Where Failure Is<br>Not An Option.</h2></section>';
  send({ type: 'ss:activate' });
  const selected = nextSelect();
  document.querySelector('h2')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const msg = await selected;
  expect(msg.signature.className).toBe('');
  expect(msg.signature.tagName).toBe('h2');
  expect(msg.leafText).toBe(true);
});

it('selects the outermost editable element, not a nested inline tag', async () => {
  // Clicking the inner <strong> must resolve to the <h1> (the run the resolver
  // indexes), not the <strong> — otherwise the text wouldn't match source.
  document.body.innerHTML =
    '<div class="wrap"><h1 class="title"><span><strong>Big bold heading</strong>.</span></h1></div>';
  send({ type: 'ss:activate' });
  const selected = nextSelect();
  document.querySelector('strong')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const msg = await selected;
  expect(msg.signature.tagName).toBe('h1');
  expect(msg.signature.className).toBe('title');
  expect(msg.leafText).toBe(true);
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

it('reverts an UNCOMMITTED preview on deactivate (class, marker, stylesheet)', () => {
  document.body.innerHTML = '<button class="orig">x</button>';
  send({ type: 'ss:activate' });
  document.querySelector('.orig')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const btn = document.querySelector('button') as HTMLElement;
  send({
    type: 'ss:mutate',
    className: 'orig p-8',
    rules: [{ minPx: 0, decls: { padding: '2rem' } }],
  });
  expect(btn.getAttribute('class')).toBe('orig p-8');
  send({ type: 'ss:deactivate' });
  expect(btn.getAttribute('class')).toBe('orig'); // reverted to source baseline
  expect(btn.getAttribute('data-ss-sel')).toBeNull(); // marker removed
  expect(document.getElementById('ss-preview')!.textContent).toBe(''); // rule dropped
});

it('KEEPS a committed preview after deactivate (saved edit stays until HMR)', () => {
  document.body.innerHTML = '<button class="keep">x</button>';
  send({ type: 'ss:activate' });
  document.querySelector('.keep')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const btn = document.querySelector('button') as HTMLElement;
  send({
    type: 'ss:mutate',
    className: 'keep md:p-8',
    rules: [{ minPx: 768, decls: { padding: '2rem' } }],
  });
  send({ type: 'ss:commit' }); // saved to source
  send({ type: 'ss:deactivate' });
  // Committed: class stays, marker + media rule persist so the edit doesn't vanish
  // before HMR recompiles the real Tailwind CSS.
  expect(btn.getAttribute('class')).toBe('keep md:p-8');
  expect(btn.getAttribute('data-ss-sel')).toBeTruthy();
  expect(document.getElementById('ss-preview')!.textContent).toContain('@media (min-width:768px)');
});

it('accumulates preview rules across multiple properties', () => {
  document.body.innerHTML = '<button class="acc">x</button>';
  send({ type: 'ss:activate' });
  document.querySelector('.acc')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const mark = document.querySelector('.acc')!.getAttribute('data-ss-sel')!;
  // This selection's base rule body (scoped past any leftover committed entries).
  const block = () => {
    const css = document.getElementById('ss-preview')!.textContent ?? '';
    const m = new RegExp(`\\[data-ss-sel="${mark}"\\]\\{([^}]*)\\}`).exec(css);
    return m ? m[1] : '';
  };

  send({
    type: 'ss:mutate',
    className: 'acc p-14',
    rules: [{ minPx: 0, decls: { padding: '3.5rem' } }],
  });
  send({
    type: 'ss:mutate',
    className: 'acc p-14 gap-10',
    rules: [{ minPx: 0, decls: { gap: '2.5rem' } }],
  });
  // Both properties preview at once (the second mutate doesn't drop the first).
  expect(block()).toContain('padding:3.5rem !important');
  expect(block()).toContain('gap:2.5rem !important');

  // A null decl resets (removes) just that one property — the other stays.
  send({
    type: 'ss:mutate',
    className: 'acc gap-10',
    rules: [{ minPx: 0, decls: { padding: null } }],
  });
  expect(block()).not.toContain('padding:');
  expect(block()).toContain('gap:2.5rem !important');
});

/** Drain jsdom's async postMessage queue so a prior test's un-awaited `ss:select`
 *  can't be the one a fresh `nextSelect()` resolves with. */
const flushMessages = () => new Promise((r) => setTimeout(r, 0));

it('selects a clicked image directly — even classless — and reports its src', async () => {
  document.body.innerHTML = '<div class="figure"><img src="/images/hero.png" alt="Hero" /></div>';
  send({ type: 'ss:activate' });
  await flushMessages();
  const selected = nextSelect();
  document.querySelector('img')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const msg = await selected;
  // The image itself is the selection target (not the classed parent div).
  expect(msg.signature.tagName).toBe('img');
  expect(msg.signature.className).toBe('');
  expect(msg.signature.attrSrc).toBe('/images/hero.png');
});

it('swaps the selected image src on ss:setSrc and clears a stale srcset', async () => {
  document.body.innerHTML =
    '<img class="logo" src="/old.png" srcset="/old.png 1x, /old@2x.png 2x" />';
  send({ type: 'ss:activate' });
  await flushMessages();
  const selected = nextSelect();
  document.querySelector('img')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await selected;
  send({ type: 'ss:setSrc', value: '/new.png' });
  const img = document.querySelector('img')!;
  expect(img.getAttribute('src')).toBe('/new.png');
  // srcset would keep showing the old candidate set — it's cleared until HMR re-renders.
  expect(img.getAttribute('srcset')).toBe('');
});
