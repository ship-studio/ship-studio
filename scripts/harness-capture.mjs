#!/usr/bin/env node
/**
 * Capture Ship Studio's UI so an agent can review it without a human driving
 * the app.
 *
 * Two modes, both writing PNGs plus a `report.md` digest and `report.json`:
 *
 *   scenarios  Hand-written states that are hard or slow to reach for real —
 *              an empty account, a fresh machine, a failed deploy, an expired
 *              token. Each carries a `looksRightWhen` caption saying what a
 *              reviewer is meant to check.
 *
 *   commands   Every action registered in the Cmd+K palette, run one per page
 *              load. `CLAUDE.md` requires each user-facing feature to register
 *              there, which makes the registry the app's own inventory — so
 *              this mode tracks the app automatically instead of drifting from
 *              a hand-written screen list.
 *
 * Dependency-free on purpose: it speaks the Chrome DevTools Protocol over
 * Node's built-in WebSocket and fetch. Playwright would add a second browser
 * download and a build step for roughly this much code.
 *
 * Usage:
 *   pnpm harness                              # in another shell, first
 *   node scripts/harness-capture.mjs          # scenarios
 *   node scripts/harness-capture.mjs --commands
 *   node scripts/harness-capture.mjs --all
 *   node scripts/harness-capture.mjs hosting- # filter by id prefix
 *   node scripts/harness-capture.mjs --out /tmp/shots
 *
 * Exits non-zero when anything crashed, never settled, or left Tauri commands
 * unmocked — so it gates CI as well as feeding a review.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const HARNESS_PORT = Number(process.env.SHIPSTUDIO_HARNESS_PORT ?? 1425);
const HARNESS_ORIGIN = `http://127.0.0.1:${HARNESS_PORT}`;
const CDP_PORT = 9333;
const VIEWPORT = { width: 1440, height: 900 };
const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
].find((p) => existsSync(p));

/**
 * Commands that are noise in a visual sweep: they navigate away from the thing
 * under review, or they have no UI at all. Skipped by id or prefix, and every
 * skip is listed in the report so this list can't quietly hide a broken
 * feature.
 */
const SKIP_COMMANDS = [
  'project.goto.', // opens another project; covered by the workspace scenarios
  'spotify.', // controls a third-party widget, nothing of ours to look at
  'settings.checkUpdates', // hits the updater, which is stubbed inert
  'nav.home', // just returns to the dashboard scenario
];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const outIdx = args.indexOf('--out');
const outValueIdx = outIdx === -1 ? -1 : outIdx + 1;
const outDir = path.resolve(outIdx === -1 ? 'harness/shots' : args[outValueIdx]);
const filter = args.filter((a, i) => !a.startsWith('--') && i !== outValueIdx)[0] ?? '';
const wantCommands = flag('--commands') || flag('--all');
const wantScenarios = !flag('--commands') || flag('--all');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 12);

/**
 * Confirm the harness on the port is serving THIS checkout.
 *
 * "Something answers on 1425" is not "my harness is up". Several worktrees live
 * on this machine, `strictPort` means only one harness can hold the port, and a
 * capture that attaches to a neighbour's server produces a full set of
 * screenshots labelled with this checkout's scenario names — real images, wrong
 * tree, no warning. Refusing to guess is the whole point of the tool, so it
 * refuses here too.
 */
async function fetchIdentity() {
  const res = await fetch(`${HARNESS_ORIGIN}/__harness/identity`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Re-check between captures.
 *
 * Checking once at startup is not enough: `strictPort` frees the port the
 * instant a harness dies, so a server can be replaced *mid-run* and every
 * capture after that point silently belongs to another tree. That is not
 * hypothetical — it happened, and `ready` and `stable` both agreed with each
 * other about a page serving a different product, because those signals only
 * describe the page that answered, never which page ought to have.
 */
async function assertStillSameCheckout(expected, label) {
  let identity;
  try {
    identity = await fetchIdentity();
  } catch (e) {
    throw new Error(
      `The harness stopped answering /__harness/identity partway through ` +
        `(at "${label}": ${e.message}). Captures before this point are fine; ` +
        `anything after would be of whatever took the port. Aborting.`
    );
  }
  if (path.resolve(identity.root) !== path.resolve(expected.root)) {
    throw new Error(
      `The harness changed underneath this run (at "${label}").\n` +
        `  started against : ${expected.root}\n` +
        `  now serving     : ${identity.root}\n` +
        `A server was replaced mid-run. Aborting rather than captioning ` +
        `another tree's screenshots with this one's scenario names.`
    );
  }
  if (identity.head !== expected.head) {
    throw new Error(
      `The harness's HEAD moved during this run (at "${label}"): ` +
        `${expected.head.slice(0, 12)} -> ${identity.head.slice(0, 12)}. ` +
        `Half these captures would be of a different commit. Aborting.`
    );
  }
}

async function assertHarnessIsThisCheckout() {
  const expected = process.cwd();
  let identity;
  try {
    identity = await fetchIdentity();
  } catch (e) {
    throw new Error(
      `Something is listening on ${HARNESS_ORIGIN} but it does not answer ` +
        `/__harness/identity (${e.message}).\n` +
        `That is either a stale harness from before this check existed, or an ` +
        `unrelated server. Restart the harness in this checkout, or set ` +
        `SHIPSTUDIO_HARNESS_PORT to a free port in both shells.`
    );
  }

  if (path.resolve(identity.root) !== path.resolve(expected)) {
    throw new Error(
      `The harness on ${HARNESS_ORIGIN} is serving a different checkout.\n` +
        `  it is serving : ${identity.root}\n` +
        `  you are in    : ${expected}\n` +
        `Capturing anyway would screenshot that tree and label the images with ` +
        `this one's scenarios. Stop that harness, or run both with different ` +
        `SHIPSTUDIO_HARNESS_PORT values.`
    );
  }
  return identity;
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
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
    // A screen can look perfectly fine and still throw on every render, so
    // console errors are findings rather than noise.
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      this.console.push({ level: 'exception', text: d.exception?.description ?? d.text });
    }
    if (
      msg.method === 'Runtime.consoleAPICalled' &&
      ['error', 'warning'].includes(msg.params.type)
    ) {
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

const closeTarget = (id) =>
  fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${id}`).catch(() => {});

/**
 * Load one harness URL, wait for it to settle, capture it, and report what the
 * page knows about itself.
 */
/**
 * Elements whose text is being cut off.
 *
 * Truncation is technically visible in a screenshot and practically invisible
 * to a reviewer: a sentence clipped at 184px ends in a "…" a few pixels wide,
 * and it is entirely possible to read a set of captures twice, conclude they
 * pass, and have missed that every status line lost its informative half.
 * Listing them turns "look carefully" into something the runner can point at.
 *
 * Reported, never failed — plenty of truncation is deliberate. Credit to the
 * session that hit this the hard way and proposed the check.
 */
const CLIPPED_TEXT_PROBE = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    if (out.length >= 25) break;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const ellipsis = cs.textOverflow === 'ellipsis';
    const clampedLines = cs.webkitLineClamp && cs.webkitLineClamp !== 'none';
    if (!ellipsis && !clampedLines) continue;
    const overflowsX = el.scrollWidth > el.clientWidth + 1;
    const overflowsY = clampedLines && el.scrollHeight > el.clientHeight + 1;
    if (!overflowsX && !overflowsY) continue;
    const text = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (!text) continue;
    out.push({
      text: text.slice(0, 120),
      chars: text.length,
      shownPx: Math.round(el.clientWidth),
      neededPx: Math.round(el.scrollWidth),
      where: el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
        : el.tagName.toLowerCase(),
    });
  }
  return JSON.stringify(out);
})()`;

async function capture({ url, file, clipSelector, identity, label, requires }) {
  const { page, targetId } = await newPage(url);
  try {
    const ready = await waitFor(page, 'window.__harnessReady', 25_000, `${file} to settle`)
      .then(() => true)
      .catch(() => false);

    const state = JSON.parse(
      await page.eval(`JSON.stringify({
        unmocked: (window.__harness?.unhandled() ?? []).map(u => u.cmd),
        commandMissing: !!window.__harness?.commandMissing,
        crashed: document.body.innerText.includes('Something went wrong')
      })`)
    );

    let clip;
    let missingClip;
    if (clipSelector) {
      const box = await page.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(clipSelector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const pad = 12;
        return JSON.stringify({
          x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad),
          width: r.width + pad * 2, height: r.height + pad * 2, scale: 1
        });
      })()`);
      if (box) clip = JSON.parse(box);
      else missingClip = clipSelector;
    }

    // The page is settled and about to be photographed: confirm the server
    // still belongs to this checkout before the image is written.
    if (identity) await assertStillSameCheckout(identity, label ?? file);

    const clipped = JSON.parse(await page.eval(CLIPPED_TEXT_PROBE).catch(() => '[]'));

    // The scenario's subject must actually be on screen. Without this a
    // scenario whose surface has vanished still yields a clean screenshot of
    // whatever else was rendered, under this scenario's name.
    const missingRequired = requires
      ? !(await page.eval(`!!document.querySelector(${JSON.stringify(requires)})`).catch(() => false))
      : false;

    // Capture a *stable* frame rather than whichever frame happened to be on
    // screen. Polling hooks re-render on their own schedule, so a single shot
    // catches a transient state roughly one time in six and two runs of the
    // same scenario then disagree for no real reason. Shooting until two
    // consecutive frames match is what makes a screenshot diffable.
    const shoot = async () => {
      const s = await page.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
        ...(clip ? { clip } : {}),
      });
      return Buffer.from(s.data, 'base64');
    };

    let buf = await shoot();
    let stable = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      await sleep(250);
      const next = await shoot();
      if (hash(next) === hash(buf)) {
        stable = true;
        break;
      }
      buf = next;
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, buf);

    return {
      file: path.relative(process.cwd(), file),
      ready,
      // False means the screen never stopped changing. The image is still
      // written, but it is a frame from a moving picture — say so rather than
      // letting a reviewer diff it against another run.
      stable,
      ...state,
      ...(missingClip ? { missingClip } : {}),
      imageHash: hash(buf),
      clipped,
      ...(requires ? { requires, missingRequired } : {}),
      console: page.console.slice(0, 8),
    };
  } finally {
    page.close();
    await closeTarget(targetId);
  }
}

const mark = (r) =>
  r.crashed || !r.ready || r.missingRequired ? '✗' : r.unmocked.length ? '!' : '✓';

function renderReport({ scenarios, commands, skipped, meta }) {
  const lines = [
    '# Ship Studio UI harness — capture report',
    '',
    `Captured ${new Date().toISOString()} at ${VIEWPORT.width}×${VIEWPORT.height}.`,
    '',
    `Checkout: \`${meta.checkout}\``,
    `HEAD: \`${meta.head}\``,
    '',
    'Regenerate: `pnpm harness` in one shell, then `node scripts/harness-capture.mjs --all`.',
    '',
    '`!` means the screen asked for a Tauri command with no fixture. Its',
    'screenshot is incomplete and must not be used as evidence — add the',
    'fixture in `src/harness/scenarios/` first.',
    '',
  ];

  if (scenarios.length) {
    lines.push('## Scenarios', '');
    lines.push('| | id | what to check | image |', '| - | - | - | - |');
    for (const r of scenarios) {
      lines.push(`| ${mark(r)} | \`${r.id}\` | ${r.looksRightWhen ?? ''} | \`${r.file}\` |`);
    }
    lines.push('');
  }

  if (commands.length) {
    lines.push('## Palette commands', '');
    lines.push(
      'One page load per command, run against a settled app. Sourced from the',
      'Cmd+K registry, so this list is whatever the app currently registers.',
      ''
    );
    lines.push('| | command | context | title | image |', '| - | - | - | - | - |');
    for (const r of commands) {
      lines.push(
        `| ${mark(r)} | \`${r.id}\` | ${r.context} | ${r.title} | \`${r.file}\` |`
      );
    }
    lines.push('');
    const noChange = commands.filter((r) => r.noVisibleChange);
    if (noChange.length) {
      lines.push(
        '### Produced no visible change',
        '',
        'These rendered identically to the untouched view. Either the command is',
        'non-visual, or it silently did nothing — worth a look either way.',
        '',
        ...noChange.map((r) => `- \`${r.id}\` — ${r.title}`),
        ''
      );
    }
  }

  const withClipped = [...scenarios, ...commands].filter((r) => r.clipped?.length);
  if (withClipped.length) {
    lines.push(
      '## Text being cut off',
      '',
      'Elements whose content is wider than the box drawn for it. Not a',
      'failure — plenty of truncation is deliberate — but a clipped sentence',
      'is a few pixels of "…" in a screenshot and is very easy to read past.',
      'Check that what got cut is not the informative half.',
      ''
    );
    for (const r of withClipped) {
      lines.push(`**\`${r.id}\`**`, '');
      for (const c of r.clipped.slice(0, 8)) {
        lines.push(`- \`${c.where}\` ${c.shownPx}px shown / ${c.neededPx}px needed — "${c.text}"`);
      }
      lines.push('');
    }
  }

  if (skipped.length) {
    lines.push(
      '## Skipped commands',
      '',
      'Excluded by `SKIP_COMMANDS` in `scripts/harness-capture.mjs`.',
      '',
      ...skipped.map((id) => `- \`${id}\``),
      ''
    );
  }

  const bad = [...scenarios, ...commands].filter(
    (r) => r.crashed || !r.ready || r.missingRequired
  );
  if (bad.length) {
    lines.push('## Failures', '');
    for (const r of bad) {
      const why = r.crashed
        ? 'crashed'
        : !r.ready
          ? 'never settled'
          : `subject missing — nothing matched \`${r.requires}\`, so this capture is not of what the scenario claims`;
      lines.push(`### \`${r.id}\` — ${why}`, '');
      for (const c of r.console) lines.push(`- **${c.level}**: ${c.text.split('\n')[0]}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

async function main() {
  if (!CHROME) throw new Error('No Chrome/Chromium found. Install Google Chrome.');
  await waitForServer(`${HARNESS_ORIGIN}/harness.html`).catch(() => {
    throw new Error(`The harness is not running on ${HARNESS_ORIGIN}. Start it with:  pnpm harness`);
  });
  // Before anything is captured: prove the server belongs to this checkout.
  const identity = await assertHarnessIsThisCheckout();

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      '--hide-scrollbars',
      // Hermetic by construction. Components like the GitHub contributions
      // calendar fetch from the real internet; letting those resolve makes a
      // capture depend on the network's mood, and two runs disagree for
      // reasons that have nothing to do with the app. Everything but the
      // harness origin fails to resolve, fast and identically every time.
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--force-device-scale-factor=2',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${path.join(process.env.TMPDIR ?? '/tmp', 'shipstudio-harness-chrome')}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  await waitForServer(`http://127.0.0.1:${CDP_PORT}/json/version`);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // Ask the running harness what exists, so this script never keeps a second,
  // drifting copy of either list.
  const probe = await newPage(`${HARNESS_ORIGIN}/harness.html?chrome=off`);
  await waitFor(probe.page, 'window.__harness', 20_000, 'the harness module to load');
  const allScenarios = JSON.parse(
    await probe.page.eval(
      'JSON.stringify(window.__harness.scenarios.map(s=>({id:s.id,title:s.title,looksRightWhen:s.looksRightWhen,clipSelector:s.clipSelector,requires:s.requires,command:s.command})))'
    )
  );
  probe.page.close();
  await closeTarget(probe.targetId);

  const scenarioResults = [];
  if (wantScenarios) {
    for (const s of allScenarios.filter((s) => s.id.startsWith(filter))) {
      const r = await capture({
        url:
          `${HARNESS_ORIGIN}/harness.html?chrome=off&scenario=${s.id}` +
          (s.command ? `&command=${encodeURIComponent(s.command)}` : ''),
        file: path.join(outDir, `${s.id}.png`),
        clipSelector: s.clipSelector,
        requires: s.requires,
        identity,
        label: s.id,
      });
      scenarioResults.push({ ...s, ...r });
      process.stdout.write(`${mark(r)} ${s.id}\n`);
    }
  }

  const commandResults = [];
  const skipped = [];
  if (wantCommands) {
    // Enumerate in both contexts: the palette gates commands on where you are,
    // so the home registry and the project registry are different lists.
    const contexts = [
      { name: 'home', scenario: 'dashboard' },
      { name: 'project', scenario: 'workspace' },
    ];

    for (const ctx of contexts) {
      const base = await capture({
        url: `${HARNESS_ORIGIN}/harness.html?chrome=off&scenario=${ctx.scenario}`,
        file: path.join(outDir, 'commands', `_baseline-${ctx.name}.png`),
        identity,
        label: `baseline-${ctx.name}`,
      });

      const listPage = await newPage(
        `${HARNESS_ORIGIN}/harness.html?chrome=off&scenario=${ctx.scenario}`
      );
      await waitFor(listPage.page, 'window.__harnessReady', 25_000, 'the app to settle');
      const cmds = JSON.parse(
        await listPage.page.eval(
          'window.__harness.commandsWhenReady().then(c=>JSON.stringify(c))'
        )
      );
      listPage.page.close();
      await closeTarget(listPage.targetId);

      for (const cmd of cmds) {
        if (!cmd.id.startsWith(filter)) continue;
        // A command gated to the other context can't run here.
        if (cmd.context !== 'any' && cmd.context !== ctx.name) continue;
        if (commandResults.some((r) => r.id === cmd.id)) continue;
        if (SKIP_COMMANDS.some((s) => cmd.id === s || cmd.id.startsWith(s))) {
          if (!skipped.includes(cmd.id)) skipped.push(cmd.id);
          continue;
        }

        const r = await capture({
          url: `${HARNESS_ORIGIN}/harness.html?chrome=off&scenario=${ctx.scenario}&command=${encodeURIComponent(cmd.id)}`,
          file: path.join(outDir, 'commands', `${cmd.id}.png`),
          identity,
          label: cmd.id,
        });
        commandResults.push({
          ...cmd,
          ...r,
          contextScenario: ctx.scenario,
          noVisibleChange: r.imageHash === base.imageHash,
        });
        process.stdout.write(`${mark(r)} ${cmd.id}\n`);
      }
    }
  }

  chrome.kill();

  const report = {
    capturedAt: new Date().toISOString(),
    // Recorded so a screenshot can be traced to the tree it came from. An
    // image with no provenance is not evidence.
    checkout: identity.root,
    head: identity.head,
    viewport: VIEWPORT,
    scenarios: scenarioResults,
    commands: commandResults,
    skipped,
  };
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(
    path.join(outDir, 'report.md'),
    renderReport({
      scenarios: scenarioResults,
      commands: commandResults,
      skipped,
      meta: { checkout: identity.root, head: identity.head },
    })
  );

  const all = [...scenarioResults, ...commandResults];
  const broken = all.filter((r) => r.crashed || !r.ready || r.missingRequired);
  const incomplete = all.filter((r) => !r.crashed && r.unmocked.length);
  const missing = commandResults.filter((r) => r.commandMissing);

  console.log(`\n${all.length} captures → ${path.relative(process.cwd(), outDir)}`);
  console.log(`   report: ${path.relative(process.cwd(), path.join(outDir, 'report.md'))}`);
  if (incomplete.length) {
    console.log(`\n${incomplete.length} incomplete (unmocked commands):`);
    for (const r of incomplete) console.log(`  ${r.id}: ${r.unmocked.join(', ')}`);
  }
  if (missing.length) {
    console.log(`\n${missing.length} command ids not found in the registry:`);
    for (const r of missing) console.log(`  ${r.id}`);
  }
  if (broken.length) {
    console.log(`\n${broken.length} FAILED:`);
    for (const r of broken) {
      console.log(
        `  ${r.id}: ${
          r.crashed
            ? 'crashed'
            : !r.ready
              ? 'never became ready'
              : `subject missing (${r.requires})`
        }`
      );
      for (const c of r.console) console.log(`      ${c.level}: ${c.text.split('\n')[0]}`);
    }
  }
  process.exitCode = broken.length || incomplete.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
