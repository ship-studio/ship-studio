#!/usr/bin/env node
/**
 * Capture every harness scenario as a PNG plus a machine-readable report.
 *
 * Why this exists: reviewing Ship Studio used to mean a human launching the
 * Tauri app, reproducing a state by hand, and describing what they saw. This
 * drives the real UI in headless Chrome against the fixture backend, so an
 * agent can look at the product itself and say what is wrong.
 *
 * Deliberately dependency-free: it speaks the Chrome DevTools Protocol over
 * Node's built-in WebSocket and fetch. Adding Playwright would download a
 * second browser and a build step for something ~200 lines does.
 *
 * Usage:
 *   node scripts/harness-capture.mjs                # every scenario
 *   node scripts/harness-capture.mjs hosting-       # scenarios matching a prefix
 *   node scripts/harness-capture.mjs --out shots/   # custom output directory
 *
 * Exits non-zero if any scenario crashed or left commands unmocked, so it can
 * gate CI as well as feed a review.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const HARNESS_ORIGIN = 'http://127.0.0.1:1425';
const CDP_PORT = 9333;
const VIEWPORT = { width: 1440, height: 900 };
const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
].find((p) => existsSync(p));

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outDir = path.resolve(outIdx === -1 ? 'hosting/shots' : args[outIdx + 1]);
// `outIdx + 1` is 0 when `--out` is absent, so guard on outIdx before using it
// as the "this arg is the --out value" index.
const outValueIdx = outIdx === -1 ? -1 : outIdx + 1;
const filter = args.filter((a, i) => !a.startsWith('--') && i !== outValueIdx)[0] ?? '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${url}`);
    await sleep(250);
  }
}

/** Minimal CDP session over one page target. */
class Page {
  #ws;
  #id = 0;
  #pending = new Map();
  console = [];

  static async attach(wsUrl) {
    const page = new Page();
    page.#ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      page.#ws.addEventListener('open', resolve, { once: true });
      page.#ws.addEventListener('error', reject, { once: true });
    });
    page.#ws.addEventListener('message', (ev) => page.#onMessage(String(ev.data)));
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    return page;
  }

  #onMessage(raw) {
    const msg = JSON.parse(raw);
    if (msg.id && this.#pending.has(msg.id)) {
      const { resolve, reject } = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      return;
    }
    // Console errors and uncaught exceptions are findings, not noise: a screen
    // can look perfectly fine and still be throwing on every render.
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      this.console.push({
        level: 'exception',
        text: d.exception?.description ?? d.text,
      });
    }
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      this.console.push({
        level: msg.params.type,
        text: msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '),
      });
    }
  }

  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? 'evaluate failed');
    }
    return res.result.value;
  }

  close() {
    this.#ws.close();
  }
}

/** Poll a boolean expression in the page until it is true. */
async function waitFor(page, expression, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await page.eval(`!!(${expression})`).catch(() => false)) return true;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
}

async function newPage(url) {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  const target = await res.json();
  return { page: await Page.attach(target.webSocketDebuggerUrl), targetId: target.id };
}

async function closeTarget(targetId) {
  await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${targetId}`).catch(() => {});
}

async function main() {
  if (!CHROME) throw new Error('No Chrome/Chromium found. Install Google Chrome.');
  await waitForServer(`${HARNESS_ORIGIN}/harness.html`).catch(() => {
    throw new Error(`The harness is not running. Start it with:  pnpm harness`);
  });

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
      '--no-first-run',
      '--no-default-browser-check',
      '--user-data-dir=' + path.join(process.env.TMPDIR ?? '/tmp', 'shipstudio-harness-chrome'),
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  await waitForServer(`http://127.0.0.1:${CDP_PORT}/json/version`);

  // Ask the running harness which scenarios exist, so this script never holds
  // a second, drifting copy of the list.
  const probe = await newPage(`${HARNESS_ORIGIN}/harness.html?chrome=off`);
  await waitFor(probe.page, 'window.__harness', 20_000, 'the harness module to load');
  const all = await probe.page.eval(
    'JSON.stringify(window.__harness.scenarios.map(s=>({id:s.id,title:s.title,looksRightWhen:s.looksRightWhen,clipSelector:s.clipSelector})))'
  );
  probe.page.close();
  await closeTarget(probe.targetId);
  const scenarios = JSON.parse(all).filter((s) => s.id.startsWith(filter));

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const results = [];
  for (const scenario of scenarios) {
    const url = `${HARNESS_ORIGIN}/harness.html?chrome=off&scenario=${scenario.id}`;
    const { page, targetId } = await newPage(url);

    const ready = await waitFor(page, 'window.__harnessReady', 20_000, `${scenario.id} to settle`)
      .then(() => true)
      .catch(() => false);

    let missingClip = null;
    const state = await page.eval(`JSON.stringify({
      unmocked: (window.__harness?.unhandled() ?? []).map(u => u.cmd),
      crashed: !!document.querySelector('.error-boundary, [class*="error-boundary"]')
        || document.body.innerText.includes('Something went wrong'),
      title: document.title
    })`);
    const parsed = JSON.parse(state);

    // A scenario may ask to be reviewed on one element rather than the whole
    // window. Falls back to the full viewport if the selector isn't there,
    // and says so, rather than silently capturing the wrong thing.
    let clip;
    if (scenario.clipSelector) {
      const box = await page.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(scenario.clipSelector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const pad = 12;
        return JSON.stringify({
          x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad),
          width: r.width + pad * 2, height: r.height + pad * 2, scale: 1
        });
      })()`);
      if (box) clip = JSON.parse(box);
      else missingClip = scenario.clipSelector;
    }

    const shot = await page.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      ...(clip ? { clip } : {}),
    });
    const file = path.join(outDir, `${scenario.id}.png`);
    await writeFile(file, Buffer.from(shot.data, 'base64'));

    results.push({
      ...scenario,
      file: path.relative(process.cwd(), file),
      ready,
      ...parsed,
      ...(missingClip ? { missingClip } : {}),
      console: page.console.slice(0, 10),
    });

    page.close();
    await closeTarget(targetId);
    process.stdout.write(
      `${parsed.crashed ? '✗' : parsed.unmocked.length ? '!' : '✓'} ${scenario.id}\n`
    );
  }

  chrome.kill();

  const report = { capturedAt: new Date().toISOString(), viewport: VIEWPORT, results };
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');

  const broken = results.filter((r) => r.crashed || !r.ready);
  const incomplete = results.filter((r) => !r.crashed && r.unmocked.length);
  console.log(`\n${results.length} scenarios → ${path.relative(process.cwd(), outDir)}`);
  if (incomplete.length) {
    console.log(`\n${incomplete.length} incomplete (unmocked commands):`);
    for (const r of incomplete) console.log(`  ${r.id}: ${r.unmocked.join(', ')}`);
  }
  if (broken.length) {
    console.log(`\n${broken.length} FAILED:`);
    for (const r of broken) {
      console.log(`  ${r.id}: ${r.crashed ? 'crashed' : 'never became ready'}`);
      for (const c of r.console) console.log(`      ${c.level}: ${c.text.split('\n')[0]}`);
    }
  }
  process.exitCode = broken.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
