#!/usr/bin/env node
/**
 * Rasterise the menu-bar icon sources (`src-tauri/icons/tray/*.svg`) into the
 * PNGs the backend embeds (`agents/tray.rs`).
 *
 * macOS draws a menu-bar icon 18pt tall, so each source is drawn at 36×36 for
 * Retina. The artwork is black on transparent: it is a template image, and the
 * menu bar tints it for light, dark and highlighted states. Only the alpha
 * channel matters.
 *
 * Uses headless Chrome (the same browser the UI harness drives), so it needs
 * no new dependency.
 *
 *   pnpm icons:tray
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DIR = path.resolve('src-tauri/icons/tray');
const SIZE = 36;
const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
].find((p) => p && existsSync(p));

if (!CHROME) {
  console.error('tray-icons: no Chrome found (set CHROME_PATH)');
  process.exit(1);
}

for (const file of readdirSync(DIR).filter((f) => f.endsWith('.svg'))) {
  const out = path.join(DIR, file.replace(/\.svg$/, '.png'));
  const run = spawnSync(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--default-background-color=00000000',
      `--window-size=${SIZE},${SIZE}`,
      `--screenshot=${out}`,
      pathToFileURL(path.join(DIR, file)).href,
    ],
    { stdio: 'pipe' }
  );
  if (run.status !== 0 || !existsSync(out)) {
    console.error(`tray-icons: ${file} failed\n${run.stderr}`);
    process.exit(1);
  }
  console.log(`tray-icons: ${path.relative(process.cwd(), out)}`);
}
