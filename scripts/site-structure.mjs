#!/usr/bin/env node
/**
 * Say what is different between two pages, in terms someone can act on.
 *
 * The pixel score is a good regression signal and a poor diagnostic. A
 * container sixty pixels too narrow shifts every image on the page, so a tenth
 * of it turns magenta and the finding reads "a lot is wrong here" — which is
 * true, unhelpful, and does not name the one number that caused it.
 *
 * This answers the other question. It reads the *design* of both pages out of
 * their computed styles — the widths content is actually constrained to, the
 * type sizes actually in use, the colours actually painted, the vertical
 * rhythm actually applied — and reports where the two disagree, weighted by
 * how much of the page each value covers.
 *
 * Deliberately not an element-by-element diff. Aligning two DOMs that were
 * written by different people is a research problem, and the answer would be
 * fragile precisely when the rebuild is most different. Aggregates need no
 * alignment: "the widest content box is 1140 here and 1200 there" is true
 * regardless of how either page is structured, and it is the sentence that
 * fixes the bug.
 *
 * Usage:
 *   node scripts/site-structure.mjs --reference https://x.com/ \
 *                                   --rebuild http://localhost:4321/ \
 *                                   --width 1240
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { CHROME, launchChrome } from './headless-chrome.mjs';

/** Preferred debugging port; the launcher moves off it if it is taken. */
let CDP_PORT = Number(process.env.HARBR_STRUCTURE_CDP_PORT ?? 9338);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Read a page's design as numbers, from inside it.
 *
 * Every measurement is taken from `getComputedStyle` on elements that are
 * actually rendered and actually visible — not from the stylesheet, which
 * says what was declared rather than what won, and not from a screenshot,
 * which cannot say why.
 *
 * Values are weighted by the area or character count they cover so that the
 * report leads with what a visitor mostly sees. A colour used once in a footer
 * badge and a colour used for every heading are not the same finding.
 */
const FINGERPRINT = `
(() => {
  const visible = (el, r) =>
    r.width > 1 && r.height > 1 &&
    getComputedStyle(el).visibility !== 'hidden' &&
    getComputedStyle(el).display !== 'none';

  const nodes = [...document.body.querySelectorAll('*')];
  const type = new Map();      // "size/weight/family" -> characters shown
  const colours = new Map();   // colour -> characters shown
  const surfaces = new Map();  // background colour -> area painted
  const widths = new Map();    // content-box width -> how many blocks use it
  const rhythm = new Map();    // vertical padding on big blocks -> count
  let widest = 0;

  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    const cs = getComputedStyle(el);

    // Text: attribute the characters this element renders itself, so a
    // wrapper does not inherit the weight of everything inside it.
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join(' ')
      .replace(/\\s+/g, ' ')
      .trim();
    if (own.length) {
      const family = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
      const key = Math.round(parseFloat(cs.fontSize)) + 'px/' +
        Math.round(parseFloat(cs.lineHeight) || 0) + ' ' + cs.fontWeight + ' ' + family;
      type.set(key, (type.get(key) ?? 0) + own.length);
      colours.set(cs.color, (colours.get(cs.color) ?? 0) + own.length);
    }

    const bg = cs.backgroundColor;
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
      surfaces.set(bg, (surfaces.get(bg) ?? 0) + Math.round(r.width * r.height));
    }

    // Layout: only blocks wide and tall enough to be structure rather than a
    // chip or an icon.
    if (r.width >= 240 && r.height >= 40 && cs.display !== 'inline') {
      const w = Math.round(r.width);
      widths.set(w, (widths.get(w) ?? 0) + 1);
      if (w > widest) widest = w;

      const pt = Math.round(parseFloat(cs.paddingTop));
      const pb = Math.round(parseFloat(cs.paddingBottom));
      if (pt >= 16) rhythm.set(pt, (rhythm.get(pt) ?? 0) + 1);
      if (pb >= 16) rhythm.set(pb, (rhythm.get(pb) ?? 0) + 1);
    }
  }

  const top = (map, n) =>
    [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([value, weight]) => ({ value: String(value), weight }));

  return {
    documentHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    widestBlock: widest,
    // The width most blocks share is the container, whatever it is called.
    container: top(widths, 6),
    type: top(type, 10),
    textColours: top(colours, 8),
    surfaces: top(surfaces, 6),
    rhythm: top(rhythm, 8),
  };
})()
`;

async function newPage(url) {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  return { send, close: () => ws.close(), targetId: target.id };
}

async function fingerprint(url, width) {
  const page = await newPage('about:blank');
  try {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width <= 767,
    });
    await page.send('Page.enable');
    await page.send('Page.navigate', { url });

    const deadline = Date.now() + 25000;
    for (;;) {
      const res = await page.send('Runtime.evaluate', {
        expression: `document.readyState === 'complete'`,
        returnByValue: true,
      });
      if (res.result?.result?.value || Date.now() > deadline) break;
      await sleep(200);
    }
    // Scroll so lazy content mounts, then let it settle. Bounded, like the
    // capture tool: a page that never finishes must not stop the report.
    await page.send('Runtime.evaluate', {
      expression: `(async () => {
        const s = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let y = 0; y < document.body.scrollHeight; y += 800) { window.scrollTo(0, y); await s(60); }
        window.scrollTo(0, 0); await s(300);
      })()`,
      awaitPromise: true,
    });

    const res = await page.send('Runtime.evaluate', {
      expression: FINGERPRINT,
      returnByValue: true,
    });
    if (res.result?.exceptionDetails) {
      throw new Error(res.result.exceptionDetails.exception?.description ?? 'fingerprint failed');
    }
    return res.result.result.value;
  } finally {
    page.close();
    fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${page.targetId}`).catch(() => {});
  }
}

/** Values present on one side and not the other, heaviest first. */
function onlyIn(a, b) {
  const others = new Set(b.map((x) => x.value));
  return a.filter((x) => !others.has(x.value));
}

function section(title, ref, reb, unit) {
  const lines = [];
  const missing = onlyIn(ref, reb);
  const extra = onlyIn(reb, ref);
  if (missing.length === 0 && extra.length === 0) {
    return `${title}\n  matches\n`;
  }
  for (const m of missing.slice(0, 5)) {
    lines.push(`  original has   ${m.value}   (${m.weight}${unit})`);
  }
  for (const e of extra.slice(0, 5)) {
    lines.push(`  rebuild has    ${e.value}   (${e.weight}${unit})`);
  }
  return `${title}\n${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1]?.startsWith('--') ? 'true' : argv[++i];
    args[key] = value ?? 'true';
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.reference || !args.rebuild) {
    console.error('Usage: --reference <url> --rebuild <url> [--width 1240]');
    process.exit(2);
  }
  if (!CHROME) {
    console.error('No Chrome or Chromium found.');
    process.exit(2);
  }
  const width = Number(args.width ?? 1440);

  const chrome = await launchChrome({ tool: 'structure', basePort: CDP_PORT });
  CDP_PORT = chrome.port;

  try {

    const ref = await fingerprint(args.reference, width);
    const reb = await fingerprint(args.rebuild, width);

    console.log(`\nStructure at ${width}px\n`);
    console.log(
      `page height    original ${ref.documentHeight}px   rebuild ${reb.documentHeight}px` +
        (ref.documentHeight === reb.documentHeight
          ? ''
          : `   (${reb.documentHeight - ref.documentHeight > 0 ? '+' : ''}${reb.documentHeight - ref.documentHeight})`)
    );
    console.log(
      `widest block   original ${ref.widestBlock}px   rebuild ${reb.widestBlock}px` +
        (ref.widestBlock === reb.widestBlock ? '' : '   ← content is constrained differently')
    );
    console.log('');
    console.log(section('container widths', ref.container, reb.container, ' blocks'));
    console.log(section('type', ref.type, reb.type, ' chars'));
    console.log(section('text colour', ref.textColours, reb.textColours, ' chars'));
    console.log(section('surfaces', ref.surfaces, reb.surfaces, 'px²'));
    console.log(section('vertical rhythm', ref.rhythm, reb.rhythm, ' blocks'));
  } finally {
    chrome.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
