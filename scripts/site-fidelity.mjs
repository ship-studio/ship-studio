#!/usr/bin/env node
/**
 * Measure how close a rebuild is to the site it was rebuilt from.
 *
 * A migration is judged on one thing — does it still look like the site — and
 * that is the thing most easily left to whoever happens to scroll past it.
 * This turns it into a number a loop can close on:
 *
 *     build → compare → fix → compare → …
 *
 * Works against any site. Nothing here assumes what the original was built
 * with, and the one place that knows about a specific builder says so.
 *
 * Both sides are screenshotted at several widths, because a migration that
 * matches at 1440 and collapses at 767 is the normal failure, not an exotic
 * one. Pass `--breakpoints` with the widths the original's own media queries
 * change at; the defaults are only a starting point.
 *
 * Dependency-free on purpose, matching `harness-capture.mjs`: it speaks the
 * Chrome DevTools Protocol over Node's built-in WebSocket and fetch. The pixel
 * comparison runs *inside* a page rather than in Node, which sidesteps PNG
 * decoding entirely — the browser already has a decoder and a canvas, so the
 * whole image pipeline is a `Runtime.evaluate` away.
 *
 * Usage:
 *   node scripts/site-fidelity.mjs --reference https://example.com/ \
 *                                     --rebuild http://127.0.0.1:4321/ \
 *                                     --out prototypes/site-migration/run
 *
 *   --breakpoints 1440,991,767,479   override the widths
 *   --label hero                     name this template in the report
 *   --settle 1200                    ms to wait after load before capturing
 *   --refresh-reference              re-capture the original, ignoring the cache
 *
 * Writes `<out>/<label>/<width>/{reference,rebuild,diff}.png` and a
 * `report.json` in the shape the Fidelity panel consumes.
 */

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { COMPARE_IN_PAGE, PIXEL_THRESHOLD_SQ } from './site-fidelity-compare.mjs';
import { CHROME, launchChrome } from './headless-chrome.mjs';

/**
 * Preferred debugging port; the launcher moves off it if it is taken.
 *
 * `let`, because the port is only settled once Chrome is up: a fixed one
 * meant a busy port was silently answered by whatever already held it.
 */
let CDP_PORT = Number(process.env.HARBR_FIDELITY_CDP_PORT ?? 9334);

/**
 * Widths to compare at when the caller does not say.
 *
 * A fallback, not a claim about the site. Real breakpoints belong to the
 * original and should be read out of its own media queries and passed with
 * `--breakpoints` — comparing at widths the site does not care about measures
 * the space between its breakpoints rather than its breakpoints.
 */
const DEFAULT_BREAKPOINTS = [1440, 991, 767, 479];



/** How long to wait for images already in flight before taking the shot. */
const IMAGE_WAIT_MS = 6000;

/** How long to wait for webfonts to swap in before giving up on them. */
const FONT_WAIT_MS = 5000;

/**
 * How long a cached capture of the original stays usable.
 *
 * The original is not changing while someone rebuilds it, and re-capturing it
 * every pass doubles the cost of a loop whose whole value is being cheap
 * enough to run often. An hour is far longer than a work session and far
 * shorter than "stale enough to mislead" — and `--refresh-reference` is there
 * for the case where the source really did change.
 */
const REFERENCE_CACHE_MS = 60 * 60 * 1000;

/**
 * Ceiling on a single capture.
 *
 * Every stage below is bounded individually, but a watchdog over the whole
 * thing is what guarantees the tool always terminates and says something. An
 * agent can recover from "this page could not be captured"; it cannot recover
 * from a command that never returns.
 */
const CAPTURE_TIMEOUT_MS = 90_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Reject rather than hang, so a stuck stage surfaces as a failure. */
function withTimeout(promise, ms, what) {
  /*
   * The timer is cleared when the work wins, and does not hold the loop open
   * while it is pending.
   *
   * Racing a bare `sleep(ms)` leaks it both ways. Node will not exit while a
   * referenced timer is outstanding, so a run whose work finished in eleven
   * seconds sat for the remaining seventy-nine before the process ended — and
   * a fidelity run is invoked once per page, so every page cost a flat extra
   * ninety seconds of nothing. Measured cold and warm, the wall clock landed
   * within a second of `(time the last timeout was armed) + 90s` every time,
   * which is the signature of exactly this and of nothing else.
   */
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what} did not finish within ${Math.round(ms / 1000)}s`)),
        ms
      );
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

// ─── CDP plumbing ──────────────────────────────────────────────────────────

/** Minimal CDP session over one page target. */
class Page {
  #ws;
  #id = 0;
  #pending = new Map();

  static async attach(wsUrl) {
    const page = new Page();
    page.#ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      page.#ws.addEventListener('open', resolve, { once: true });
      page.#ws.addEventListener('error', reject, { once: true });
    });
    page.#ws.addEventListener('message', (ev) => page.#onMessage(String(ev.data)));
    await page.send('Runtime.enable');
    return page;
  }

  #onMessage(raw) {
    const msg = JSON.parse(raw);
    if (msg.id && this.#pending.has(msg.id)) {
      const { resolve, reject } = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
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

async function newPage(url) {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  const target = await res.json();
  return { page: await Page.attach(target.webSocketDebuggerUrl), targetId: target.id };
}

const closeTarget = (id) => fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${id}`).catch(() => {});

// ─── Capture ───────────────────────────────────────────────────────────────

/**
 * CSS that pins every animation to its *end* state, injected before the page's
 * own scripts run.
 *
 * Pausing an animation freezes it wherever it happens to be, which is a
 * different place on every run — the capture then records timing, not layout.
 * Running it once, instantly, with a negative delay lands every element on its
 * final frame, which is both deterministic and the state a visitor sees a
 * moment after arriving. Lifted from `src/harness/freeze.css`, which learned
 * this the same way.
 */
const FREEZE_CSS = `
*,*::before,*::after{
  animation-delay:-1ms!important;
  animation-duration:1ms!important;
  animation-iteration-count:1!important;
  animation-play-state:paused!important;
  transition-duration:0ms!important;
  transition-delay:0ms!important;
  caret-color:transparent!important;
  scroll-behavior:auto!important;
}
`;

/**
 * Stop the parts of a page that keep moving on their own.
 *
 * The freeze stylesheet handles CSS. What it cannot reach is JavaScript that
 * moves things on a timer — a carousel advancing, a scroll runtime writing
 * inline transforms — so which frame the shutter catches becomes a race, and
 * the comparison starts measuring timing instead of layout.
 *
 * Two parts. The first is generic: pause every media element. The second is a
 * small set of known builder runtimes, each guarded so it is a no-op on a site
 * that does not use it. This is the *only* place in this file that knows what
 * anything was built with, and it is additive — a site built with none of them
 * is unaffected, and one built with something not listed here simply gets less
 * help settling.
 */
const SETTLE_PAGE = `
(() => {
  document.querySelectorAll('video, audio').forEach((el) => {
    try { el.pause(); el.currentTime = 0; } catch {}
  });

  // Webflow: IX2 leaves inline transforms behind, and sliders autoplay.
  try { window.Webflow && window.Webflow.destroy && window.Webflow.destroy(); } catch {}
  document.querySelectorAll('.w-slider').forEach((slider) => {
    const dots = slider.querySelectorAll('.w-slider-dot');
    if (dots.length) dots[0].click();
    const mask = slider.querySelector('.w-slider-mask');
    if (mask) mask.scrollLeft = 0;
    slider.querySelectorAll('.w-slide').forEach((slide, i) => {
      slide.style.transform = 'translateX(' + i * 100 + '%)';
    });
  });

  // Common carousel libraries, each absent on most sites.
  try { document.querySelectorAll('.swiper').forEach((el) => el.swiper && el.swiper.autoplay && el.swiper.autoplay.stop()); } catch {}
  try { document.querySelectorAll('.slick-slider').forEach((el) => window.jQuery && window.jQuery(el).slick('slickPause')); } catch {}

  return true;
})()
`;

/**
 * Full-page screenshot of `url` as it renders at `width`.
 *
 * The device metrics override is what makes this a *breakpoint* capture rather
 * than a window resize: the page's media queries evaluate against the width we
 * set, and `deviceScaleFactor: 1` keeps the pixel grid comparable between the
 * two sides regardless of the host display.
 *
 * Captures are taken one at a time by the caller, never in parallel. Two tabs
 * rendering at once contend for the same CPU, and the slower one settles its
 * animations and lazy images at a different point — which shows up in the diff
 * as error the rebuild did not cause.
 */
async function capture(url, width, settleMs, extraCss) {
  const { page, targetId } = await newPage('about:blank');
  try {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width <= 767,
    });
    await page.send('Page.enable');
    // Before any page script: the freeze has to be in the cascade from the
    // first paint, or load-time interactions have already run somewhere
    // arbitrary by the time we could inject it.
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        document.addEventListener('DOMContentLoaded', () => {
          const s = document.createElement('style');
          s.textContent = ${JSON.stringify(FREEZE_CSS)};
          document.head.appendChild(s);
        });
      `,
    });
    /*
     * A navigation that failed must not become a score.
     *
     * CDP reports the failure in the reply and then leaves Chrome showing its
     * own error page — which screenshots perfectly well. A trial against a
     * host with a TLS problem duly produced "39.77%", a number derived
     * entirely from comparing an error page to a rebuild, and the agent spent
     * the next ten minutes trying to improve it.
     *
     * A number nobody can tell is meaningless is worse than no number, so this
     * is loud and it names the URL.
     */
    const nav = await page.send('Page.navigate', { url });
    if (nav?.errorText) {
      throw new Error(`could not load ${url}: ${nav.errorText}`);
    }

    /*
     * Settle: document ready first, then webfonts, on separate budgets.
     *
     * They were one condition on one 20s budget, which meant a site whose
     * `document.fonts.status` never reaches `loaded` — common enough, a single
     * face requested and never used is sufficient — paid the full twenty
     * seconds on both sides of every comparison. Forty seconds a breakpoint,
     * for a signal that is nice to have. Ready is worth waiting for; fonts are
     * worth a few seconds and then a shrug.
     */
    const readyBy = Date.now() + 20000;
    for (;;) {
      const ready = await page.eval(`document.readyState === 'complete'`).catch(() => false);
      if (ready || Date.now() > readyBy) break;
      await sleep(200);
    }
    const fontsBy = Date.now() + FONT_WAIT_MS;
    for (;;) {
      const swapped = await page.eval(`document.fonts.status === 'loaded'`).catch(() => true);
      if (swapped || Date.now() > fontsBy) break;
      await sleep(150);
    }
    /*
     * Scroll the page to trigger lazy loading, then give the images that
     * started a bounded chance to finish.
     *
     * Bounded is the whole point. An earlier version awaited every incomplete
     * image's `onload`/`onerror` with no deadline, which is only correct if
     * every image eventually does one or the other — and on a real site they
     * do not. An `<img>` whose observer never fires, one pointed at a host
     * that black-holes the request, one behind consent: any single such image
     * left the promise pending forever, and because the call is made with
     * `awaitPromise`, the whole tool hung with no output and no error. That is
     * exactly what a migration looks like when it "gets stuck on the parity
     * check", and it took the agent down with it.
     *
     * A slightly-early shutter costs a few pixels of difference. A hang costs
     * the run.
     */
    await page.eval(`
      (async () => {
        const settle = (ms) => new Promise((r) => setTimeout(r, ms));
        const step = Math.max(400, Math.round(window.innerHeight * 0.9));
        for (let y = 0; y < document.body.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await settle(80);
        }
        window.scrollTo(0, 0);
        await settle(200);

        const pending = [...document.images].filter((i) => !i.complete);
        await Promise.race([
          Promise.all(
            pending.map((i) => new Promise((r) => { i.onload = i.onerror = r; }))
          ),
          settle(${IMAGE_WAIT_MS}),
        ]);
        return pending.length;
      })()
    `);
    await sleep(settleMs);
    await page.eval(SETTLE_PAGE);

    // Stand-in for generated code (see docs/site-migration.md):
    // overlaying CSS on the live page produces a rendering that differs from
    // the reference in specific, nameable ways, which is what the loop needs
    // to be exercised against before any real migration output exists.
    if (extraCss) {
      await page.eval(`
        (() => {
          const s = document.createElement('style');
          s.textContent = ${JSON.stringify(extraCss)};
          document.head.appendChild(s);
          return true;
        })()
      `);
      await sleep(250);
    }
    await sleep(200);

    const { data } = await page.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    });
    const height = await page.eval(
      `Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)`
    );
    return { data, height };
  } finally {
    page.close();
    closeTarget(targetId);
  }
}

/**
 * Where a captured original is kept between passes.
 *
 * Keyed by URL and width so two templates, or two breakpoints, never collide.
 * Kept inside the project rather than a temp directory, so it is obvious what
 * it is, it is cleaned up with the project, and a stale one can be deleted.
 *
 * Anchored to `.shipstudio/` by searching upward rather than by counting
 * directories up from `--out`. An earlier version went two levels up, which
 * assumed every run sits at `<fidelity>/<run>` — and agents batch pages, so a
 * real run wrote to `<fidelity>/<batch>/<page>` and put the cache straight
 * back among the runs it was moved out of. Depth is not something to assume
 * about a path someone else chose.
 */
function referenceCachePath(outDir, url, width) {
  const key = createHash('sha1').update(`${url}@${width}`).digest('hex').slice(0, 12);

  let dir = path.resolve(outDir);
  for (let i = 0; i < 12; i += 1) {
    if (path.basename(dir) === '.shipstudio') {
      return path.join(dir, '.reference-cache', `${key}.png`);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Outside a project — a bare comparison run by hand. Beside the output is
  // the only place that is certainly writable.
  return path.join(path.resolve(outDir), '..', '.reference-cache', `${key}.png`);
}

/**
 * The original at this width — from cache when it is fresh, otherwise captured.
 *
 * Only the *original* is ever cached. The rebuild is the thing being changed,
 * and serving a stale capture of it would report a fix that has not happened,
 * which is the one failure this whole tool exists to prevent.
 */
async function referenceCapture(url, width, settleMs, outDir, refresh) {
  const cached = referenceCachePath(outDir, url, width);

  if (!refresh) {
    try {
      const age = Date.now() - (await stat(cached)).mtimeMs;
      if (age < REFERENCE_CACHE_MS) {
        const data = await readFile(cached);
        return { data: data.toString('base64'), cached: true };
      }
    } catch {
      /* not cached yet */
    }
  }

  const shot = await withTimeout(
    capture(url, width, settleMs),
    CAPTURE_TIMEOUT_MS,
    `capturing ${url} at ${width}px`
  );
  await mkdir(path.dirname(cached), { recursive: true });
  await writeFile(cached, Buffer.from(shot.data, 'base64'));
  return { ...shot, cached: false };
}

// ─── Comparison ────────────────────────────────────────────────────────────



async function compare(referenceB64, rebuildB64, width) {
  const { page, targetId } = await newPage('about:blank');
  try {
    const args = JSON.stringify({
      referenceUrl: `data:image/png;base64,${referenceB64}`,
      rebuildUrl: `data:image/png;base64,${rebuildB64}`,
      width,
      threshold: PIXEL_THRESHOLD_SQ,
    });
    return await page.eval(`(${COMPARE_IN_PAGE})(${args})`);
  } finally {
    page.close();
    closeTarget(targetId);
  }
}

/**
 * Write what has been measured so far.
 *
 * `complete` says whether every requested width was reached, so a reader can
 * tell a finished run from an interrupted one rather than inferring it from
 * how many entries happen to be present — and so a score from two widths is
 * never mistaken for a verdict across four.
 */
async function writeReport(outDir, results, meta) {
  const report = {
    ...meta,
    capturedAt: new Date().toISOString(),
    // The worst breakpoint is the score, not the mean. A migration that is
    // perfect on desktop and broken on mobile is a broken migration, and an
    // average is exactly the statistic that would hide it.
    score: Math.min(...results.map((r) => r.score)),
    breakpoints: results,
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}

// ─── Runner ────────────────────────────────────────────────────────────────

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
  const reference = args.reference;
  const rebuild = args.rebuild;
  if (!reference || !rebuild) {
    console.error('Usage: --reference <url> --rebuild <url> [--out dir] [--label name]');
    process.exit(2);
  }
  if (!CHROME) {
    console.error('No Chrome or Chromium found.');
    process.exit(2);
  }

  const label = args.label ?? 'home';
  const outDir = path.resolve(args.out ?? 'prototypes/site-migration/run');
  const settleMs = Number(args.settle ?? 900);
  const refreshReference = args['refresh-reference'] === 'true' || args['refresh-reference'] === '';
  const rebuildCss = args['rebuild-css']
    ? await readFile(path.resolve(args['rebuild-css']), 'utf8')
    : null;
  const breakpoints = (args.breakpoints ?? DEFAULT_BREAKPOINTS.join(','))
    .split(',')
    .map((n) => Number(n.trim()))
    .filter(Boolean);

  const chrome = await launchChrome({ tool: 'fidelity', basePort: CDP_PORT });
  CDP_PORT = chrome.port;
  if (chrome.swept) {
    console.log(`  (reaped ${chrome.swept} leftover browser${chrome.swept > 1 ? 's' : ''})`);
  }

  try {

    const results = [];
    for (const width of breakpoints) {
      process.stdout.write(`  ${label} @ ${width}px … `);
      const ref = await referenceCapture(reference, width, settleMs, outDir, refreshReference);
      const reb = await withTimeout(
        capture(rebuild, width, settleMs, rebuildCss),
        CAPTURE_TIMEOUT_MS,
        `capturing ${rebuild} at ${width}px`
      );
      const cmp = await withTimeout(
        compare(ref.data, reb.data, width),
        CAPTURE_TIMEOUT_MS,
        `comparing at ${width}px`
      );

      const dir = path.join(outDir, label, String(width));
      await mkdir(dir, { recursive: true });
      await Promise.all([
        writeFile(path.join(dir, 'reference.png'), Buffer.from(ref.data, 'base64')),
        writeFile(path.join(dir, 'rebuild.png'), Buffer.from(reb.data, 'base64')),
        writeFile(path.join(dir, 'diff.png'), Buffer.from(cmp.diff, 'base64')),
      ]);

      const { diff: _diff, ...summary } = cmp;
      results.push({ breakpoint: width, ...summary, dir: path.relative(process.cwd(), dir) });

      // Written after every breakpoint, not once at the end.
      //
      // A four-width run takes about four minutes, and an agent's shell call
      // is routinely killed before that. Writing only on completion meant a
      // run that captured three widths and was then interrupted left three
      // directories of images and no report at all — the work was done and
      // entirely unreadable, and from outside it looked like the tool had
      // produced nothing. Three separate trials lost confirmation runs that
      // way. A partial report is worth having; a lost one never is.
      await writeReport(outDir, results, {
        label,
        reference,
        rebuild,
        // Recorded so the panel can say the rebuild side is a stand-in rather
        // than letting two identical URLs imply the comparison is meaningless.
        rebuildCss: args['rebuild-css'] ? path.basename(args['rebuild-css']) : null,
        complete: results.length === breakpoints.length,
      });
      console.log(
        `${summary.score}%  (${summary.referenceHeight}px vs ${summary.rebuildHeight}px)` +
          (ref.cached ? '  [original from cache]' : '')
      );
    }

    console.log(
      `\n  worst breakpoint: ${Math.min(...results.map((r) => r.score))}%` +
        `  →  ${path.relative(process.cwd(), outDir)}/report.json`
    );
  } finally {
    chrome.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
