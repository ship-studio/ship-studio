/**
 * Behavior test for the in-iframe selection script (`SELECT_SCRIPT`).
 *
 * The script's canonical source lives in `src-tauri/src/proxy/select_script.html`
 * (Rust injects it via `include_str!`). Here we evaluate that exact source in the
 * jsdom window and exercise the message protocol the rest of the editor depends on:
 * inert-until-activated, click → `ss:select` signature, and `ss:mutate` → live class.
 */

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
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
  affectedNodeIds?: number[];
}> {
  return new Promise((res) => {
    const handler = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type === 'ss:select') {
        window.removeEventListener('message', handler);
        res(
          e.data as {
            signature: Record<string, unknown>;
            count: number;
            leafText?: boolean;
            affectedNodeIds?: number[];
          }
        );
      }
    };
    window.addEventListener('message', handler);
  });
}

function nextMessage<T>(type: string): Promise<T> {
  return new Promise((res) => {
    const handler = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type !== type) return;
      window.removeEventListener('message', handler);
      res(e.data as T);
    };
    window.addEventListener('message', handler);
  });
}

beforeAll(() => {
  window.eval(scriptJs);
});

afterAll(() => {
  // The script debounces its tree-dirty notice by 300ms (select_script.html),
  // and that timer belongs to the evaluated scope, so no handle reaches this
  // file. On a slow runner it fires after vitest has torn the environment
  // down, and the callback touches `window` — which by then is gone. That
  // surfaces as an unhandled "ReferenceError: window is not defined" and fails
  // the run even though every test passed, as it did on Windows CI.
  //
  // Sweeping every pending timeout is blunt but correct here: the environment
  // is being discarded on the next line anyway.
  const highest = setTimeout(() => undefined, 0) as unknown as number;
  for (let id = 0; id <= highest; id += 1) clearTimeout(id);
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
  const elementPath = msg.signature.elementPath as Array<{
    tagName: string;
    className: string;
    domPath: string;
  }>;
  expect(elementPath.map(({ tagName, className }) => ({ tagName, className }))).toEqual([
    { tagName: 'section', className: 'hero' },
    { tagName: 'div', className: 'card' },
    { tagName: 'button', className: 'btn p-4' },
  ]);
  expect(elementPath.every(({ domPath }) => domPath.length > 0)).toBe(true);
  expect(msg.count).toBe(1);
});

it('reports page hover changes so the Elements row can mirror them', () => {
  document.body.innerHTML =
    '<div class="shell"><button class="hover-target">Hover me</button></div>';
  send({ type: 'ss:activate' });
  const post = vi.spyOn(window.parent, 'postMessage');
  try {
    const target = document.querySelector('.hover-target')!;
    target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));

    const hoverMessages = post.mock.calls
      .map(([data]) => data as { type?: string; nodeId?: number | null })
      .filter((data) => data.type === 'ss:hover');
    expect(hoverMessages).toHaveLength(1);
    expect(hoverMessages[0]?.nodeId).toEqual(expect.any(Number));

    // Repeated mousemove events over the same element do not churn the host state.
    target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(
      post.mock.calls.filter(([data]) => (data as { type?: string }).type === 'ss:hover')
    ).toHaveLength(1);

    document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(post.mock.calls[post.mock.calls.length - 1]?.[0]).toEqual({
      type: 'ss:hover',
      nodeId: null,
    });
  } finally {
    send({ type: 'ss:deactivate' });
    document.body.innerHTML =
      '<section class="hero"><div class="card"><button class="btn p-4">Buy now</button></div></section>';
    post.mockRestore();
  }
});

it('reports React development source for an element-tree source anchor', async () => {
  const button = document.querySelector('.btn')!;
  Object.defineProperty(button, '__reactFiber$test', {
    configurable: true,
    value: {
      _debugStack: {
        stack:
          'Error: react-stack-top-frame\n    at Card (http://localhost:5173/src/Card.tsx?t=123:42:7)\n    at react_stack_bottom_frame (react-dom-client.development.js:1:1)',
      },
    },
  });
  send({ type: 'ss:activate' });
  const selected = nextSelect();
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const msg = await selected;
  expect(msg.signature.sourceFile).toBe('http://localhost:5173/src/Card.tsx');
  expect(msg.signature.sourceLine).toBe(42);
  expect(msg.signature.sourceColumn).toBe(7);
});

it('reports a Next/Turbopack server chunk frame for backend source-map resolution', async () => {
  let button = document.querySelector<HTMLElement>('.btn');
  if (!button) {
    button = document.createElement('button');
    button.className = 'btn';
    document.body.appendChild(button);
  }
  Object.defineProperty(button, '__reactFiber$test', {
    configurable: true,
    value: {
      _debugStack: {
        stack:
          'Error: react-stack-top-frame\n    at fakeJSXCallSite (http://localhost:3000/_next/static/chunks/react.js:1:1)\n    at Card (about://React/Server/file:///tmp/project/.next/dev/server/chunks/ssr/%5Broot%5D.js?11:89:292)\n    at react_stack_bottom_frame (react-dom.js:1:1)',
      },
    },
  });
  send({ type: 'ss:activate' });
  const selected = nextSelect();
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const msg = await selected;
  expect(msg.signature.sourceFile).toBe(
    'file:///tmp/project/.next/dev/server/chunks/ssr/%5Broot%5D.js'
  );
  expect(msg.signature.sourceLine).toBe(89);
  expect(msg.signature.sourceColumn).toBe(292);
});

it('reports a Next/Turbopack client chunk frame for backend source-map resolution', async () => {
  const button = document.querySelector('.btn')!;
  Object.defineProperty(button, '__reactFiber$test', {
    configurable: true,
    value: {
      _debugStack: {
        stack:
          'Error: react-stack-top-frame\n    at Card (http://localhost:3000/_next/static/chunks/app_playground_Card_tsx.js:44:120)\n    at react_stack_bottom_frame (react-dom.js:1:1)',
      },
    },
  });
  send({ type: 'ss:activate' });
  const selected = nextSelect();
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const msg = await selected;
  expect(msg.signature.sourceFile).toBe(
    'http://localhost:3000/_next/static/chunks/app_playground_Card_tsx.js'
  );
  expect(msg.signature.sourceLine).toBe(44);
  expect(msg.signature.sourceColumn).toBe(120);
});

it('checks every React fiber record for an authored source frame', async () => {
  const node = document.createElement('button');
  node.className = 'multi-fiber-source';
  document.body.appendChild(node);
  Object.defineProperty(node, '__reactFiber$renderer-a', {
    configurable: true,
    value: {},
  });
  Object.defineProperty(node, '__reactFiber$renderer-b', {
    configurable: true,
    value: {
      _debugStack: {
        stack:
          'Error: react-stack-top-frame\n    at Card (http://localhost:5173/src/Card.tsx:27:11)\n    at react_stack_bottom_frame (react-dom-client.development.js:1:1)',
      },
    },
  });
  send({ type: 'ss:activate' });
  const selected = nextSelect();
  node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const msg = await selected;
  expect(msg.signature.sourceFile).toBe('http://localhost:5173/src/Card.tsx');
  expect(msg.signature.sourceLine).toBe(27);
  expect(msg.signature.sourceColumn).toBe(11);

  // Keep the shared script state aligned with the following mutation tests.
  const restored = nextSelect();
  document.querySelector('.btn')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await restored;
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
  expect(msg.affectedNodeIds).toHaveLength(2);

  // The hover box is created first on activation; selection overlays follow it.
  const overlays = [...document.querySelectorAll<HTMLElement>('[data-ss-overlay]')].slice(1);
  expect(overlays[0]?.style.borderStyle).toBe('dashed');
  expect(overlays[0]?.style.borderColor).toBe('rgba(235, 171, 107, 0.95)');
  expect(overlays[1]?.style.borderStyle).toBe('solid');
  expect(overlays[2]?.style.borderStyle).toBe('dashed');

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

it('updates direct text without flattening mixed child markup on ss:setText', async () => {
  document.body.innerHTML =
    '<p class="settings-text">Old copy</p><p class="settings-mixed">Keep <span>formatting</span></p>';
  send({ type: 'ss:activate' });
  await flushMessages();

  const plain = document.querySelector('.settings-text')!;
  const selectedPlain = nextSelect();
  plain.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await selectedPlain;
  send({ type: 'ss:setText', value: 'A & <copy> {title}' });
  expect(plain.textContent).toBe('A & <copy> {title}');

  const mixed = document.querySelector('.settings-mixed')!;
  const nested = mixed.querySelector('span')!;
  const selectedMixed = nextSelect();
  mixed.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await selectedMixed;
  send({ type: 'ss:setText', value: 'Do not remove nested markup' });
  expect(mixed.textContent).toBe('Keep formatting');
  expect(mixed.querySelector('span')).toBe(nested);
});

it('replaces the selected tag while preserving its attributes and child nodes on ss:setTag', async () => {
  document.body.innerHTML =
    '<div class="settings-tag" data-note="keep"><span class="nested">Nested</span> tail</div>';
  send({ type: 'ss:activate' });
  await flushMessages();
  const original = document.querySelector('.settings-tag')!;
  const nested = original.querySelector('.nested')!;
  const selected = nextSelect();
  original.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await selected;

  send({ type: 'ss:setTag', value: 'section' });

  const converted = document.querySelector('section.settings-tag')!;
  expect(converted.getAttribute('data-note')).toBe('keep');
  expect(converted.firstElementChild).toBe(nested);
  expect(converted.textContent).toBe('Nested tail');

  // The handler updates selectedSet as well as the DOM, so later editor messages
  // target the replacement element rather than a detached source node.
  send({ type: 'ss:mutate', className: 'after-conversion' });
  expect(converted.className).toBe('after-conversion');
});

/* ===== Code-first CSS editor: ss:cascade enumeration + raw-text preview ===== */

interface CascadeDecl {
  prop: string;
  value: string;
  important: boolean;
  active: boolean;
}
interface CascadeRule {
  selector: string | null;
  declarations: CascadeDecl[];
  specificity: [number, number, number];
  sourceOrder: number;
  origin: string;
  layered?: boolean;
  selectorMemberIndex?: number;
  runtimeIdentity?: {
    stylesheetIndex: number;
    rulePath: number[];
    href: string | null;
    rootHref: string | null;
    selectorList: string;
    selectorMemberIndex: number;
    declarations: { property: string; value: string; important: boolean }[];
  };
}

/** Resolve with the next `ss:cascade` the script posts to the parent. */
function nextCascade(): Promise<{ rules: CascadeRule[] }> {
  return new Promise((res) => {
    const handler = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type === 'ss:cascade') {
        window.removeEventListener('message', handler);
        res(e.data as { rules: CascadeRule[] });
      }
    };
    window.addEventListener('message', handler);
  });
}

it('does NOT emit ss:cascade unless activated with {cascade:true}', async () => {
  document.body.innerHTML = '<style>.x{color:red}</style><button class="x">x</button>';
  send({ type: 'ss:activate' }); // plain (Tailwind) activation — cascade stays off
  let posted = false;
  const handler = (e: MessageEvent) => {
    if ((e.data as { type?: string })?.type === 'ss:cascade') posted = true;
  };
  window.addEventListener('message', handler);
  document.querySelector('.x')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await flushMessages();
  window.removeEventListener('message', handler);
  expect(posted).toBe(false);
  send({ type: 'ss:deactivate' });
});

it('emits the matching rules in cascade order with active/overridden flags', async () => {
  // `.btn--primary` comes later in source and (equal specificity) wins `background`.
  document.body.innerHTML =
    '<style>.btn{padding:10px;background:gray;color:#000}.btn--primary{background:blue}</style>' +
    '<button class="btn btn--primary">Buy</button>';
  send({ type: 'ss:activate', cascade: true });
  await flushMessages();
  const got = nextCascade();
  document.querySelector('.btn')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const { rules } = await got;

  const byScope = (s: string) => rules.find((r) => r.selector === s)!;
  expect(byScope('.btn')).toBeTruthy();
  expect(byScope('.btn--primary')).toBeTruthy();

  // Winner-per-property: `.btn--primary` wins background; `.btn`'s background is overridden.
  const primaryBg = byScope('.btn--primary').declarations.find((d) => d.prop === 'background')!;
  const baseBg = byScope('.btn').declarations.find((d) => d.prop === 'background')!;
  expect(primaryBg.active).toBe(true);
  expect(baseBg.active).toBe(false);
  // Uncontested declarations on `.btn` stay active.
  expect(byScope('.btn').declarations.find((d) => d.prop === 'padding')!.active).toBe(true);

  // Devtools-style ordering: the winning rule sorts to the top.
  expect(rules[0].selector).toBe('.btn--primary');
  send({ type: 'ss:deactivate' });
});

it('reports changed media activity for the selected element when its viewport resizes', async () => {
  let matches = false;
  const original = window.matchMedia;
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches }));
  try {
    document.body.innerHTML =
      '<style>.resize-test{color:red}@media (min-width: 700px){.resize-test{color:blue}}</style>' +
      '<button class="resize-test">x</button>';
    send({ type: 'ss:activate', cascade: true });
    const selected = nextSelect();
    const initial = nextCascade();
    document
      .querySelector('.resize-test')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const selection = await selected;
    const before = await initial;
    const responsiveColor = (rules: CascadeRule[]) =>
      rules
        .find(
          (rule) =>
            rule.selector === '.resize-test' &&
            rule.declarations.some((declaration) => declaration.value === 'blue')
        )!
        .declarations.find((declaration) => declaration.prop === 'color')!;

    // sourceOrder spans every stylesheet, including the persistent #ss-preview sheet.
    expect(responsiveColor(before.rules).active).toBe(false);
    matches = true;
    const updated = nextMessage<{ selectionId: string; rules: CascadeRule[] }>(
      'ss:cascadeActivity'
    );
    window.dispatchEvent(new Event('resize'));
    const after = await updated;
    expect(after.selectionId).toBeTruthy();
    expect(selection.signature.className).toBe('resize-test');
    expect(responsiveColor(after.rules).active).toBe(true);
  } finally {
    send({ type: 'ss:deactivate' });
    window.matchMedia = original;
  }
});

it('ranks a higher-specificity selector above a later equal-class rule', async () => {
  // `#hero .btn` (id+class) beats both single-class rules regardless of source order.
  document.body.innerHTML =
    '<style>.btn{background:gray}.btn--p{background:blue}#hero .btn{background:green}</style>' +
    '<div id="hero"><button class="btn btn--p">x</button></div>';
  send({ type: 'ss:activate', cascade: true });
  await flushMessages();
  const got = nextCascade();
  document.querySelector('.btn')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const { rules } = await got;
  const win = rules.find((r) => r.declarations.some((d) => d.prop === 'background' && d.active))!;
  expect(win.selector).toBe('#hero .btn');
  expect(win.specificity).toEqual([1, 1, 0]);
  send({ type: 'ss:deactivate' });
});

it('unlayered normal declarations win over layered ones (cascade layers)', async () => {
  // The layered rule comes LATER in source, so only cascade-layer awareness — not source
  // order — makes the unlayered `.b` win. (jsdom omits the layer NAME but the `layered`
  // flag is tracked by rule type, which is what cascade precedence actually depends on.)
  document.body.innerHTML =
    '<style>.b{color:blue}@layer base{.b{color:red}}</style><div class="b">x</div>';
  send({ type: 'ss:activate', cascade: true });
  await flushMessages();
  const got = nextCascade();
  document.querySelector('.b')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const { rules } = await got;
  const unlayered = rules.find((r) => r.selector === '.b' && !r.layered)!;
  const layered = rules.find((r) => r.selector === '.b' && r.layered)!;
  expect(unlayered).toBeTruthy();
  expect(layered).toBeTruthy();
  expect(unlayered.declarations.find((d) => d.prop === 'color')!.active).toBe(true);
  expect(layered.declarations.find((d) => d.prop === 'color')!.active).toBe(false);
  send({ type: 'ss:deactivate' });
});

it('an !important layered declaration wins over an unlayered one (layer order inverts)', async () => {
  // With `!important`, cascade-layer order reverses: the layered rule wins even though the
  // unlayered one would win for normal declarations.
  document.body.innerHTML =
    '<style>.c{color:blue!important}@layer base{.c{color:red!important}}</style>' +
    '<div class="c">x</div>';
  send({ type: 'ss:activate', cascade: true });
  await flushMessages();
  const got = nextCascade();
  document.querySelector('.c')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const { rules } = await got;
  const unlayered = rules.find((r) => r.selector === '.c' && !r.layered)!;
  const layered = rules.find((r) => r.selector === '.c' && r.layered)!;
  expect(layered.declarations.find((d) => d.prop === 'color')!.active).toBe(true);
  expect(unlayered.declarations.find((d) => d.prop === 'color')!.active).toBe(false);
  send({ type: 'ss:deactivate' });
});

it('takes :is()/:not() specificity as the MAX of args, not a flat count', async () => {
  // `.btn:is(.x, .y, .z)` is (0,2,0) — `.btn` + the most-specific arg `.x` — NOT (0,4,0).
  // So `.a.b.c` (0,3,0) wins. A flat count would give the :is() rule (0,4,0) and flip it.
  document.body.innerHTML =
    '<style>.btn:is(.x, .y, .z){color:blue}.a.b.c{color:red}</style>' +
    '<button class="btn x a b c">x</button>';
  send({ type: 'ss:activate', cascade: true });
  await flushMessages();
  const got = nextCascade();
  document.querySelector('.btn')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const { rules } = await got;
  const isRule = rules.find((r) => r.selector!.includes(':is'))!;
  const abc = rules.find((r) => r.selector === '.a.b.c')!;
  expect(isRule.specificity).toEqual([0, 2, 0]);
  expect(abc.declarations.find((d) => d.prop === 'color')!.active).toBe(true); // .a.b.c wins
  expect(isRule.declarations.find((d) => d.prop === 'color')!.active).toBe(false);
  send({ type: 'ss:deactivate' });
});

it('orders layer-vs-layer: a later layer beats an earlier one regardless of specificity', async () => {
  // @layer a then @layer b. `#hero .btn` lives in a (higher specificity); `.btn` in b.
  // A later layer wins for normal declarations → `.btn` (in b) wins despite lower specificity.
  document.body.innerHTML =
    '<style>@layer a{#hero .btn{color:red}}@layer b{.btn{color:blue}}</style>' +
    '<div id="hero"><button class="btn">x</button></div>';
  send({ type: 'ss:activate', cascade: true });
  await flushMessages();
  const got = nextCascade();
  document.querySelector('.btn')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const { rules } = await got;
  const later = rules.find((r) => r.selector === '.btn')!;
  const earlier = rules.find((r) => r.selector === '#hero .btn')!;
  expect(later.declarations.find((d) => d.prop === 'color')!.active).toBe(true);
  expect(earlier.declarations.find((d) => d.prop === 'color')!.active).toBe(false);
  send({ type: 'ss:deactivate' });
});

it('treats a rule inside an unsupported @supports as inactive', async () => {
  // jsdom has no CSS.supports, so inject one: the bogus feature query is unsupported.
  const realCSS = (globalThis as { CSS?: unknown }).CSS;
  (globalThis as { CSS?: unknown }).CSS = { supports: (c: string) => !/bogus-feature/.test(c) };
  try {
    document.body.innerHTML =
      '<style>.s{color:blue}@supports (bogus-feature: 1){.s{color:red}}</style>' +
      '<div class="s">x</div>';
    send({ type: 'ss:activate', cascade: true });
    await flushMessages();
    const got = nextCascade();
    document.querySelector('.s')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const { rules } = await got;
    // The unsupported rule comes later in source but must NOT win — it doesn't apply.
    const supported = rules.find((r) => r.declarations.some((d) => d.value === 'blue'))!;
    const unsupported = rules.find((r) => r.declarations.some((d) => d.value === 'red'))!;
    expect(supported.declarations.find((d) => d.prop === 'color')!.active).toBe(true);
    expect(unsupported.declarations.find((d) => d.prop === 'color')!.active).toBe(false);
    send({ type: 'ss:deactivate' });
  } finally {
    (globalThis as { CSS?: unknown }).CSS = realCSS;
  }
});

it('previews the exact CSSOM rule identity when a selector occurs in several rules', async () => {
  // `.q` exists twice (base + inside @layer). The CSSOM path and declaration
  // fingerprint must target the layered rule without a selector/order fallback.
  document.body.innerHTML =
    '<style data-vite-dev-id="/project/src/app.css">.q{color:red}@layer x{.q{color:blue}}</style><div class="q">x</div>';
  send({ type: 'ss:activate', cascade: true });
  await flushMessages();
  const got = nextCascade();
  document.querySelector('.q')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const { rules } = await got;
  const layered = rules.find((r) => r.selector === '.q' && r.layered)!;
  const identity = layered.runtimeIdentity!;
  expect(identity.rulePath).toEqual([1, 0]);
  expect(identity.rootHref).toBe('/project/src/app.css');
  send({
    type: 'ss:previewRuleText',
    ruleKey: 'stale',
    identity: { ...identity, rulePath: [0, 0] },
    cssText: '.q { color: purple; }',
  });
  const sheet = document.body.querySelector('style')!.sheet!;
  const base = sheet.cssRules[0] as CSSStyleRule;
  const inLayer = (sheet.cssRules[1] as CSSGroupingRule).cssRules[0] as CSSStyleRule;
  expect(base.style.color).toBe('red');
  expect(inLayer.style.color).toBe('blue');
  send({
    type: 'ss:previewRuleText',
    ruleKey: 'k',
    identity,
    cssText: '.q { color: green; }',
  });
  // Target the project's own <style> in <body>, not the script's #ss-preview in <head>.
  expect(base.style.color).toBe('red'); // untouched
  expect(((sheet.cssRules[1] as CSSGroupingRule).cssRules[0] as CSSStyleRule).style.color).toBe(
    'green'
  ); // the exact layered CSSOM rule was replaced in place
  send({ type: 'ss:deactivate' });
});

it('reports a distinct domPath for same-tag, same-class siblings (no aliasing)', async () => {
  document.body.innerHTML =
    '<div><button class="btn">A</button><button class="btn">B</button></div>';
  send({ type: 'ss:activate', cascade: true });
  const a = nextSelect();
  document.querySelectorAll('.btn')[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const sigA = await a;
  const b = nextSelect();
  document.querySelectorAll('.btn')[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const sigB = await b;
  expect(sigA.signature.tagName).toBe(sigB.signature.tagName);
  expect(sigA.signature.className).toBe(sigB.signature.className);
  expect(sigA.signature.domPath).toBeTruthy();
  expect(sigA.signature.domPath).not.toBe(sigB.signature.domPath); // the discriminator
  send({ type: 'ss:deactivate' });
});

it('uses domPath to reselect the exact classless empty sibling', async () => {
  document.body.innerHTML = '<section><div></div><div id="target"></div></section>';
  send({ type: 'ss:activate' });
  const selected = nextSelect();
  send({
    type: 'ss:reselect',
    signature: {
      className: '',
      tagName: 'div',
      text: '',
      ancestorClasses: [],
      domPath: 'body:1>section:0>div:1',
    },
  });
  const msg = await selected;
  expect(msg.signature.domPath).toBe('body:1>section:0>div:1');
  expect(document.querySelector('#target')!.hasAttribute('data-ss-sel')).toBe(true);
  send({ type: 'ss:deactivate' });
});

it('falls back to class/text scoring when the saved domPath now holds a different element', async () => {
  // The element moved (an HMR render inserted a sibling above it): the saved path
  // now points at a different card, so the structural fast path must not take it.
  document.body.innerHTML =
    '<section><div class="filler"></div><div class="other">Other</div><div class="card">Card</div></section>';
  send({ type: 'ss:activate' });
  const selected = nextSelect();
  send({
    type: 'ss:reselect',
    signature: {
      className: 'card',
      tagName: 'div',
      text: 'Card',
      ancestorClasses: [],
      domPath: 'body:1>section:0>div:1',
    },
  });
  const msg = await selected;
  expect(msg.signature.className).toBe('card');
  expect(document.querySelector('.card')!.hasAttribute('data-ss-sel')).toBe(true);
  expect(document.querySelector('.other')!.hasAttribute('data-ss-sel')).toBe(false);
  send({ type: 'ss:deactivate' });
});

it('never resolves a signature to an editor overlay sitting at the saved domPath', async () => {
  document.body.innerHTML = '<div data-ss-overlay="1"></div><div id="real">Hello</div>';
  send({ type: 'ss:activate' });
  const selected = nextSelect();
  send({
    type: 'ss:reselect',
    signature: {
      className: '',
      tagName: 'div',
      text: 'Hello',
      ancestorClasses: [],
      domPath: 'body:1>div:0', // the overlay's slot
    },
  });
  const msg = await selected;
  expect(msg.signature.text).toBe('Hello');
  expect(document.querySelector('#real')!.hasAttribute('data-ss-sel')).toBe(true);
  expect(document.querySelector('[data-ss-overlay]')!.hasAttribute('data-ss-sel')).toBe(false);
  send({ type: 'ss:deactivate' });
});

it('omits hidden comment-only Next streaming wrappers from the element tree', async () => {
  document.body.innerHTML =
    '<div hidden><!--$--><!--/$--></div><main><div id="authored"></div></main>';
  send({ type: 'ss:activate' });
  const treeMessage = nextMessage<{
    tree: { t: string; k: Array<{ t: string; k: unknown[] }> };
  }>('ss:tree');
  send({ type: 'ss:requestTree' });
  const { tree } = await treeMessage;
  expect(tree.t).toBe('body');
  expect(tree.k).toHaveLength(1);
  expect(tree.k[0].t).toBe('main');
  expect(tree.k[0].k).toHaveLength(1);
  send({ type: 'ss:deactivate' });
});

it('resolves fresh drag source and target snapshots from current tree ids', async () => {
  document.body.innerHTML =
    '<main class="page"><section class="source"><p class="child">Child</p></section><div class="target">Target</div></main>';
  send({ type: 'ss:activate' });
  type TreeNode = { i: number; k: TreeNode[] };
  const treeMessage = nextMessage<{ tree: TreeNode }>('ss:tree');
  send({ type: 'ss:requestTree' });
  const { tree } = await treeMessage;
  const source = tree.k[0].k[0];
  const target = tree.k[0].k[1];
  const resolved = nextMessage<{
    type: string;
    source: { signature: { className: string } };
    target: { signature: { className: string } };
  }>('ss:resolvedDragNodes');
  send({
    type: 'ss:resolveDragNodes',
    requestId: 'move-1',
    sourceId: source.i,
    targetId: target.i,
  });
  const message = await resolved;
  expect(message.source.signature.className).toBe('source');
  expect(message.target.signature.className).toBe('target');
  expect(message.source).not.toHaveProperty('html');
  expect(message.target).not.toHaveProperty('html');

  document.querySelector('.target')?.remove();
  const stale = nextMessage<{ type: string; target: null }>('ss:resolvedDragNodes');
  send({
    type: 'ss:resolveDragNodes',
    requestId: 'move-2',
    sourceId: source.i,
    targetId: target.i,
  });
  expect((await stale).target).toBeNull();
  send({ type: 'ss:deactivate' });
});

it('previews by replacing the REAL rule in place, and restores it on clear', async () => {
  document.body.innerHTML = '<style>.q{color:red}</style><button class="q">x</button>';
  // Target the project's own <style> (not a leftover #ss-preview sheet in <head>).
  const sheet = document.body.querySelector('style')!.sheet!;
  const ruleOf = () => (sheet.cssRules[0] as CSSStyleRule).style.getPropertyValue('color');
  send({ type: 'ss:activate', cascade: true });
  const got = nextCascade();
  document.querySelector('.q')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const { rules } = await got;
  const identity = rules.find((rule) => rule.selector === '.q')!.runtimeIdentity!;

  // Edit the rule's real source — the live rule itself changes (not an override layer).
  send({
    type: 'ss:previewRuleText',
    ruleKey: 'styles.css|.q',
    identity,
    cssText: '.q { color: green; }',
  });
  expect(ruleOf()).toBe('green');

  // A removal is reflectable too: an empty body drops the declaration entirely.
  send({
    type: 'ss:previewRuleText',
    ruleKey: 'styles.css|.q',
    identity,
    cssText: '.q {  }',
  });
  expect(ruleOf()).toBe('');

  // Clearing restores the original source rule.
  send({ type: 'ss:clearRulePreview', ruleKey: 'styles.css|.q' });
  expect(ruleOf()).toBe('red');
  send({ type: 'ss:deactivate' });
});

it('removes the exact live rule on ss:deleteRulePreview', async () => {
  document.body.innerHTML =
    '<style>.del{color:red}.keep{color:blue}</style><button class="del">x</button>';
  const sheet = document.body.querySelector('style')!.sheet!;
  expect(sheet.cssRules).toHaveLength(2);
  send({ type: 'ss:activate', cascade: true });
  const got = nextCascade();
  document.querySelector('.del')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const { rules } = await got;
  const identity = rules.find((rule) => rule.selector === '.del')!.runtimeIdentity!;
  send({ type: 'ss:deleteRulePreview', identity });
  // The .del rule is gone; .keep survives.
  expect(sheet.cssRules).toHaveLength(1);
  expect((sheet.cssRules[0] as CSSStyleRule).selectorText).toBe('.keep');
  send({ type: 'ss:deactivate' });
});

it('removes only the selected selector-list member from the exact live rule', async () => {
  document.body.innerHTML =
    '<style>.member-a, .member-b { color: red; }</style><button class="member-b">x</button>';
  const sheet = document.body.querySelector('style')!.sheet!;
  send({ type: 'ss:activate', cascade: true });
  const got = nextCascade();
  document.querySelector('.member-b')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const { rules } = await got;
  const matched = rules.find((rule) => rule.selector === '.member-b')!;
  expect(matched.selectorMemberIndex).toBe(1);
  send({ type: 'ss:removeSelectorMemberPreview', identity: matched.runtimeIdentity });
  expect((sheet.cssRules[0] as CSSStyleRule).selectorText).toBe('.member-a');
  expect((sheet.cssRules[0] as CSSStyleRule).style.color).toBe('red');
  send({ type: 'ss:deactivate' });
});

it('splits only the selected member from the exact live rule', async () => {
  document.body.innerHTML =
    '<style>.split-a, .split-b { color: red; } .split-b { color: blue; }</style><button class="split-b">x</button>';
  const sheet = document.body.querySelector('style')!.sheet!;
  send({ type: 'ss:activate', cascade: true });
  const got = nextCascade();
  document.querySelector('.split-b')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const { rules } = await got;
  const shared = rules.find(
    (rule) =>
      rule.selector === '.split-b' &&
      rule.declarations.some((declaration) => declaration.value === 'red')
  )!;
  send({ type: 'ss:splitSelectorMemberPreview', identity: shared.runtimeIdentity });
  expect(sheet.cssRules).toHaveLength(3);
  expect((sheet.cssRules[0] as CSSStyleRule).selectorText).toBe('.split-a');
  expect((sheet.cssRules[1] as CSSStyleRule).selectorText).toBe('.split-b');
  expect((sheet.cssRules[1] as CSSStyleRule).style.color).toBe('red');
  expect((sheet.cssRules[2] as CSSStyleRule).style.color).toBe('blue');
  send({ type: 'ss:deactivate' });
});

it('posts ss:selRect on scroll while selected (host toolbar tracking)', async () => {
  document.body.innerHTML = '<div class="wrap"><p class="para">Hi</p></div>';
  send({ type: 'ss:activate' });
  const selected = nextSelect();
  document.querySelector('.para')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await selected;

  const rectMsg = new Promise<{ rect: Record<string, number> }>((res) => {
    const handler = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type === 'ss:selRect') {
        window.removeEventListener('message', handler);
        res(e.data as { rect: Record<string, number> });
      }
    };
    window.addEventListener('message', handler);
  });
  window.dispatchEvent(new Event('scroll'));
  const { rect } = await rectMsg;
  for (const key of ['top', 'left', 'width', 'height'] as const) {
    expect(typeof rect[key]).toBe('number');
  }
  send({ type: 'ss:deactivate' });
});

/* ===== Ancestor-style inheritance (typography + text color) ===== */

interface InheritedPropMsg {
  cssValue: string;
  tagName: string;
  className: string;
  ancestorClasses: string[];
  token?: string | null;
}

/** jsdom doesn't cascade computed styles (an `inherit:` keyword comes back
 *  unresolved), so "inherited" chains are simulated by declaring the SAME value
 *  on child and ancestor — the equal-consecutive-values condition the scan's
 *  walk-up actually keys on, identical to what real browsers produce for an
 *  unstyled child under a styled parent. These tests live at the END of the
 *  file: they replace document.body, which earlier mutate tests still rely on. */
it('flags typography values inherited from a classed ancestor and attributes tokens', async () => {
  document.body.innerHTML =
    '<style>.card{font-size:18px;font-weight:600}.leaf{font-size:18px;font-weight:600}</style>' +
    '<section class="hero"><div class="card text-lg font-semibold"><p class="leaf">x</p></div></section>';
  send({ type: 'ss:activate' });
  const selected = nextSelect();
  document.querySelector('.leaf')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const msg = await selected;
  const inh = msg.signature.inheritedProps as Record<string, InheritedPropMsg>;
  // 18px == text-lg (1.125rem × 16px root); weight 600 == font-semibold.
  expect(inh['font-size']).toMatchObject({
    cssValue: '18px',
    tagName: 'div',
    className: 'card text-lg font-semibold',
    token: 'text-lg',
  });
  // Classes ABOVE the definer anchor resolving the definer's own source.
  expect(inh['font-size'].ancestorClasses).toEqual(['hero']);
  expect(inh['font-weight']).toMatchObject({ cssValue: '600', token: 'font-semibold' });
});

it('reports an inherited value without a token when no utility matches it', async () => {
  document.body.innerHTML =
    '<style>.big{font-size:19px}.leaf{font-size:19px}</style>' +
    '<div class="big"><p class="leaf">x</p></div>';
  send({ type: 'ss:activate' });
  const selected = nextSelect();
  document.querySelector('.leaf')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const msg = await selected;
  const inh = msg.signature.inheritedProps as Record<string, InheritedPropMsg>;
  // 19px is on no static Tailwind scale (and custom CSS may be the real source),
  // so the popover gets the honest raw value instead of a guessed token.
  expect(inh['font-size']).toMatchObject({ cssValue: '19px', className: 'big', token: null });
});

it('does not flag locally-defined values or classless/global definers', async () => {
  document.body.innerHTML =
    '<style>.own{font-size:20px}.plain{font-size:21px}</style>' +
    '<div style="font-size:21px"><span class="plain">a</span><span class="own">b</span></div>';
  send({ type: 'ss:activate' });
  const selected = nextSelect();
  document.querySelector('.own')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const msg = await selected;
  let inh = (msg.signature.inheritedProps ?? {}) as Record<string, InheritedPropMsg>;
  // Set on the element itself — differs right at the parent, so not inherited.
  expect(inh['font-size']).toBeUndefined();

  // The value's definer has NO class (inline styles on a plain div): baseline
  // styling, not an authored ancestor utility worth surfacing.
  const second = nextSelect();
  document.querySelector('.plain')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const msg2 = await second;
  inh = (msg2.signature.inheritedProps ?? {}) as Record<string, InheritedPropMsg>;
  expect(inh['font-size']).toBeUndefined();
});

it('flags a decoration PROPAGATING from an ancestor (not inherited — drawn through)', async () => {
  // text-decoration never computes as inherited (children stay 'none' while the
  // line is drawn through them), so this needs its own ancestor scan.
  document.body.innerHTML =
    '<style>.deco{text-decoration-line:underline}</style>' +
    '<div class="deco underline"><p class="leaf">x</p></div>';
  send({ type: 'ss:activate' });
  const selected = nextSelect();
  document.querySelector('.leaf')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const msg = await selected;
  const inh = msg.signature.inheritedProps as Record<string, InheritedPropMsg>;
  expect(inh['text-decoration-line']).toMatchObject({
    cssValue: 'underline',
    tagName: 'div',
    className: 'deco underline',
    token: 'underline',
  });
});

it('does not flag decoration when the element draws its own line', async () => {
  document.body.innerHTML =
    '<style>.deco{text-decoration-line:underline}.own{text-decoration-line:line-through}</style>' +
    '<div class="deco"><p class="own">x</p></div>';
  send({ type: 'ss:activate' });
  const selected = nextSelect();
  document.querySelector('.own')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const msg = await selected;
  const inh = (msg.signature.inheritedProps ?? {}) as Record<string, InheritedPropMsg>;
  expect(inh['text-decoration-line']).toBeUndefined();
});

it('draws selection immediately and only inspects the latest click after a frame', async () => {
  document.body.innerHTML =
    '<button class="first">First</button><button class="second">Second</button>';
  send({ type: 'ss:activate' });
  const post = vi.spyOn(window.parent, 'postMessage');
  try {
    document.querySelector('.first')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.first')!.hasAttribute('data-ss-sel')).toBe(true);
    expect(
      Array.from(document.querySelectorAll<HTMLElement>('[data-ss-overlay]')).some(
        (box) => box.style.display === 'block' && box.style.borderStyle === 'solid'
      )
    ).toBe(true);
    expect(post.mock.calls.some(([data]) => (data as { type?: string }).type === 'ss:select')).toBe(
      false
    );
    const selected = nextSelect();
    document.querySelector('.second')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect((await selected).signature.className).toBe('second');
    expect(
      post.mock.calls.filter(([data]) => (data as { type?: string }).type === 'ss:select')
    ).toHaveLength(1);
  } finally {
    send({ type: 'ss:deactivate' });
    post.mockRestore();
  }
});

it('cancels pending selection inspection when edit mode closes', async () => {
  document.body.innerHTML = '<button class="cancel">Cancel</button>';
  send({ type: 'ss:activate' });
  const post = vi.spyOn(window.parent, 'postMessage');
  try {
    document.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    send({ type: 'ss:deactivate' });
    await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    expect(post.mock.calls.some(([data]) => (data as { type?: string }).type === 'ss:select')).toBe(
      false
    );
  } finally {
    post.mockRestore();
  }
});

/* ── Inline text editing waits for the parent's verdict (#1100, #1120) ──
   Both clicks of a double-click re-select, so the verdict is always still in
   flight when the dblclick lands. Editing used to start optimistically anyway, and
   data/code text could only fail at save — discarding what the user typed. */

type PostedMsg = { type?: string; [k: string]: unknown };

/** Click twice then double-click, the way a real double-click arrives. */
function doubleClick(el: Element) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
}

function postedOfType(post: { mock: { calls: unknown[][] } }, type: string): PostedMsg[] {
  return post.mock.calls.map(([data]) => data as PostedMsg).filter((data) => data?.type === type);
}

it('never enters editing on data/code text: a double-click waits for the verdict, then bounces', async () => {
  document.body.innerHTML = '<p class="price">$42</p>';
  send({ type: 'ss:activate' });
  const post = vi.spyOn(window.parent, 'postMessage');
  try {
    const p = document.querySelector('p')!;
    const selected = nextSelect();
    doubleClick(p);
    // No verdict yet → no edit has started.
    expect(p.hasAttribute('contenteditable')).toBe(false);
    expect(postedOfType(post, 'ss:textBegin')).toHaveLength(0);

    const { selectionId } = (await selected) as unknown as { selectionId: string };
    send({ type: 'ss:textInfo', editable: false, selectionId });

    expect(p.hasAttribute('contenteditable')).toBe(false);
    expect(postedOfType(post, 'ss:textBegin')).toHaveLength(0);
    expect(postedOfType(post, 'ss:textCommit')).toHaveLength(0);
    // The parent is told so it can pulse the dynamic-text hand-off.
    expect(postedOfType(post, 'ss:textBlocked')).toHaveLength(1);

    // A later double-click on the known read-only element still never edits.
    p.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(p.hasAttribute('contenteditable')).toBe(false);
    expect(postedOfType(post, 'ss:textBlocked')).toHaveLength(2);
  } finally {
    send({ type: 'ss:deactivate' });
    post.mockRestore();
  }
});

it('starts a parked double-click once the verdict says editable, and the commit identifies its element', async () => {
  document.body.innerHTML = '<p class="lead">Old copy</p>';
  send({ type: 'ss:activate' });
  const post = vi.spyOn(window.parent, 'postMessage');
  try {
    const p = document.querySelector('p')!;
    const selected = nextSelect();
    doubleClick(p);
    const { selectionId } = (await selected) as unknown as { selectionId: string };

    // A verdict for some other (older) selection must not unlock this one.
    send({ type: 'ss:textInfo', editable: true, selectionId: 'stale-selection' });
    expect(p.hasAttribute('contenteditable')).toBe(false);

    send({ type: 'ss:textInfo', editable: true, selectionId });
    expect(p.getAttribute('contenteditable')).toBe('true');

    p.textContent = 'New copy';
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    const commits = postedOfType(post, 'ss:textCommit');
    expect(commits).toHaveLength(1);
    expect(commits[0].text).toBe('New copy');
    // Self-describing: the parent can save this even if it lost the selection.
    expect(commits[0].selectionId).toBe(selectionId);
    const signature = commits[0].signature as { className: string; text: string };
    expect(signature.className).toBe('lead');
    expect(signature.text).toBe('Old copy');
  } finally {
    send({ type: 'ss:deactivate' });
    post.mockRestore();
  }
});

it('drops a parked double-click when the selection moves on before the verdict', async () => {
  document.body.innerHTML = '<p class="a">First</p><p class="b">Second</p>';
  send({ type: 'ss:activate' });
  try {
    const firstSelect = nextSelect();
    doubleClick(document.querySelector('.a')!);
    const { selectionId: firstId } = (await firstSelect) as unknown as { selectionId: string };
    const secondSelect = nextSelect();
    document.querySelector('.b')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await secondSelect;
    // The first selection's verdict arrives late — it must not start editing anything.
    send({ type: 'ss:textInfo', editable: true, selectionId: firstId });
    expect(document.querySelector('[contenteditable]')).toBeNull();
  } finally {
    send({ type: 'ss:deactivate' });
  }
});

function variableIdentity(
  overrides: Partial<{
    key: string;
    file: string;
    selector: string;
    line: number | null;
    name: string;
  }> = {}
) {
  return {
    key: ['src/theme.css', '.theme-dark', '8', '--surface'].join('\0'),
    file: 'src/theme.css',
    selector: '.theme-dark',
    line: 8,
    name: '--surface',
    ...overrides,
  };
}

function stylesheet(sourceFile: string, cssText: string) {
  const node = document.createElement('style');
  node.setAttribute('data-vite-dev-id', `/project/${sourceFile}`);
  node.textContent = cssText;
  document.head.appendChild(node);
  return node;
}

it('previews a scoped variable on its unique source rule and restores the authored value on clear', () => {
  const node = stylesheet('src/theme.css', '.theme-dark { --surface: white; }');
  const rule = node.sheet!.cssRules[0] as CSSStyleRule;
  const identity = variableIdentity();
  try {
    send({ type: 'ss:setVar', identity, value: 'ivory' });
    expect(rule.style.getPropertyValue('--surface')).toBe('ivory');
    expect(document.documentElement.style.getPropertyValue('--surface')).toBe('');

    send({ type: 'ss:clearVar', identity });
    expect(rule.style.getPropertyValue('--surface')).toBe('white');
    expect(document.documentElement.style.getPropertyValue('--surface')).toBe('');
  } finally {
    node.remove();
  }
});

it('skips a scoped preview when the source selector appears in multiple media contexts', () => {
  const node = stylesheet(
    'src/theme.css',
    '.theme-dark { --surface: white; } @media (prefers-color-scheme: dark) { .theme-dark { --surface: black; } }'
  );
  const firstRule = node.sheet!.cssRules[0] as CSSStyleRule;
  const mediaRule = node.sheet!.cssRules[1] as CSSMediaRule;
  const secondRule = mediaRule.cssRules[0] as CSSStyleRule;
  const identity = variableIdentity();
  try {
    send({ type: 'ss:setVar', identity, value: 'ivory' });

    expect(firstRule.style.getPropertyValue('--surface')).toBe('white');
    expect(secondRule.style.getPropertyValue('--surface')).toBe('black');
    expect(document.documentElement.style.getPropertyValue('--surface')).toBe('');
  } finally {
    node.remove();
  }
});

it('keeps the new-root fallback until HMR exposes the authored declaration', async () => {
  const node = stylesheet('src/new.css', 'body { color: red; }');
  const identity = variableIdentity({
    key: 'pending\0src/new.css\0:root\0--new-token',
    file: 'src/new.css',
    selector: ':root',
    line: null,
    name: '--new-token',
  });
  document.documentElement.style.setProperty('--new-token', 'var(--existing)');
  try {
    send({ type: 'ss:setVar', identity, value: 'purple' });
    expect(document.documentElement.style.getPropertyValue('--new-token')).toBe('purple');

    send({ type: 'ss:clearVar', identity, commit: true });
    expect(document.documentElement.style.getPropertyValue('--new-token')).toBe('purple');

    node.textContent = ':root { --new-token: purple; }';
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.documentElement.style.getPropertyValue('--new-token')).toBe('var(--existing)');
  } finally {
    document.documentElement.style.removeProperty('--new-token');
    node.remove();
  }
});
