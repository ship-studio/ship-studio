/**
 * Browser harness entry point.
 *
 * Boots the real Ship Studio UI against a fixture backend so a change can be
 * looked at — and screenshotted — without a Tauri build, a real machine state,
 * or a real hosting account. `src/main.tsx` stays the production entry; this
 * file exists only so the app is *observable*.
 *
 * Usage: `pnpm harness` then `http://127.0.0.1:1425/harness.html?scenario=<id>`.
 */

// Must precede every app import: it clears storage that app modules read at
// module scope. See the module docblock.
import './resetStorage';
import './freeze.css';

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '../App';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { exposeReactGlobals } from '../lib/plugin-loader';
import { exposePluginContextRef } from '../contexts/PluginContext';
import { installFakeBackend, whenIpcQuiet } from './fakeBackend';
import { findScenario, scenarios } from './scenarios';
import { unhandledCalls } from './unhandled';
import { listCommands, runCommand, whenRegistryStable } from './commandBridge';
import { HarnessOverlay } from './HarnessOverlay';

const params = new URLSearchParams(window.location.search);
const scenario = findScenario(params.get('scenario'));
const showChrome = params.get('chrome') !== 'off';
/**
 * `?command=<palette id>` runs one registered command once the app has
 * settled. This is how the harness reaches a surface it has no hand-written
 * scenario for — the palette registry is the app's own list of features.
 */
const commandId = params.get('command');
/**
 * Motion is frozen by default so two capture runs agree pixel-for-pixel.
 * `?freeze=off` restores animation for watching a transition by hand.
 */
if (params.get('freeze') !== 'off') {
  document.documentElement.setAttribute('data-harness-freeze', '');
}

// The IPC bridge must exist before any app module runs an effect.
installFakeBackend(scenario);

exposeReactGlobals(React, ReactDOM);
exposePluginContextRef();

/** Handle for scripted capture runs and for asking the page what it knows. */
declare global {
  interface Window {
    __harness: {
      scenario: typeof scenario;
      scenarios: typeof scenarios;
      unhandled: typeof unhandledCalls;
      /** Every command the app has registered in the Cmd+K palette. */
      commands: typeof listCommands;
      /** Wait for the registry to stop churning, then list it. */
      commandsWhenReady: typeof whenRegistryStable;
      /** Run one registered command by id. */
      run: typeof runCommand;
      /** Which command this page was asked to run, if any. */
      commandId: string | null;
      /** Set when `?command=` named an id the registry doesn't have. */
      commandMissing?: boolean;
    };
  }
}
window.__harness = {
  scenario,
  scenarios,
  unhandled: unhandledCalls,
  commands: listCommands,
  commandsWhenReady: whenRegistryStable,
  run: runCommand,
  commandId,
};

document.title = `Ship Studio harness — ${scenario.id}`;

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App initialProjectPath={params.get('project') ?? scenario.project ?? null} />
    </ErrorBoundary>
  </React.StrictMode>
);

/**
 * Click the scenario's control once the app has settled, and announce
 * readiness on `window.__harnessReady`. A capture runner waits on that flag
 * rather than on a fixed sleep, so a slow machine produces the same screenshot
 * as a fast one instead of a half-painted one.
 */
async function settle(): Promise<void> {
  const deadline = Date.now() + 8000;
  if (scenario.openSelector) {
    for (;;) {
      const el = document.querySelector<HTMLElement>(scenario.openSelector);
      if (el) {
        el.click();
        break;
      }
      if (Date.now() > deadline) {
        console.error(`[harness] openSelector never appeared: ${scenario.openSelector}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (commandId) {
    // Wait for every feature hook to have registered before looking the
    // command up, otherwise a slow bucket reads as a missing command.
    await whenRegistryStable();
    const ran = await runCommand(commandId).catch((e) => {
      console.error(`[harness] command ${commandId} threw:`, e);
      return true; // it exists; it failed. That is a finding, not a lookup miss.
    });
    if (!ran) {
      window.__harness.commandMissing = true;
      console.error(`[harness] no such palette command: ${commandId}`);
    }
  }

  // Wait for the app to stop asking the backend for things, then for one
  // paint. This is what makes two capture runs agree: a fixed delay races
  // any panel whose state arrives on a later round-trip.
  await whenIpcQuiet();
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 250)));
  (window as unknown as { __harnessReady?: boolean }).__harnessReady = true;
}

void settle();

if (showChrome) {
  const chrome = document.createElement('div');
  document.body.appendChild(chrome);
  ReactDOM.createRoot(chrome).render(<HarnessOverlay scenario={scenario} />);
}
