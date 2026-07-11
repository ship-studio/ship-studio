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

it('previews the EXACT rule by source order when a selector occurs in several rules', async () => {
  // `.q` exists twice (base + inside @layer). Previewing by sourceOrder must hit the
  // layered one, not the first `.q` a selector match would find.
  document.body.innerHTML =
    '<style>.q{color:red}@layer x{.q{color:blue}}</style><div class="q">x</div>';
  send({ type: 'ss:activate', cascade: true });
  await flushMessages();
  const got = nextCascade();
  document.querySelector('.q')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const { rules } = await got;
  const layered = rules.find((r) => r.selector === '.q' && r.layered)!;
  send({
    type: 'ss:previewRuleText',
    ruleKey: 'k',
    selector: '.q',
    mediaText: null,
    order: layered.sourceOrder,
    cssText: '.q { color: green; }',
  });
  // Target the project's own <style> in <body>, not the script's #ss-preview in <head>.
  const sheet = document.body.querySelector('style')!.sheet!;
  const base = sheet.cssRules[0] as CSSStyleRule;
  const inLayer = (sheet.cssRules[1] as CSSGroupingRule).cssRules[0] as CSSStyleRule;
  expect(base.style.color).toBe('red'); // untouched
  expect(inLayer.style.color).toBe('green'); // the layered rule was the one edited
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

it('previews by replacing the REAL rule in place, and restores it on clear', () => {
  document.body.innerHTML = '<style>.q{color:red}</style><button class="q">x</button>';
  // Target the project's own <style> (not a leftover #ss-preview sheet in <head>).
  const sheet = document.body.querySelector('style')!.sheet!;
  const ruleOf = () => (sheet.cssRules[0] as CSSStyleRule).style.getPropertyValue('color');
  send({ type: 'ss:activate', cascade: true });
  document.querySelector('.q')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  // Edit the rule's real source — the live rule itself changes (not an override layer).
  send({
    type: 'ss:previewRuleText',
    ruleKey: 'styles.css|.q',
    selector: '.q',
    mediaText: null,
    cssText: '.q { color: green; }',
  });
  expect(ruleOf()).toBe('green');

  // A removal is reflectable too: an empty body drops the declaration entirely.
  send({
    type: 'ss:previewRuleText',
    ruleKey: 'styles.css|.q',
    selector: '.q',
    mediaText: null,
    cssText: '.q {  }',
  });
  expect(ruleOf()).toBe('');

  // Clearing restores the original source rule.
  send({ type: 'ss:clearRulePreview', ruleKey: 'styles.css|.q' });
  expect(ruleOf()).toBe('red');
  send({ type: 'ss:deactivate' });
});

it('removes the live rule on ss:deleteRulePreview', () => {
  document.body.innerHTML =
    '<style>.del{color:red}.keep{color:blue}</style><button class="del">x</button>';
  const sheet = document.body.querySelector('style')!.sheet!;
  expect(sheet.cssRules).toHaveLength(2);
  send({ type: 'ss:activate', cascade: true });
  document.querySelector('.del')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  send({ type: 'ss:deleteRulePreview', selector: '.del', mediaText: null });
  // The .del rule is gone; .keep survives.
  expect(sheet.cssRules).toHaveLength(1);
  expect((sheet.cssRules[0] as CSSStyleRule).selectorText).toBe('.keep');
  send({ type: 'ss:deactivate' });
});
