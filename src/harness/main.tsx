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
import { OnboardingPlayground } from './OnboardingPlayground';
import './playground.css';

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

/**
 * What each scripted step did, so a capture can say a step never happened
 * rather than quietly photographing the screen before it.
 */
const stepLog: string[] = [];

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
      /** What the scenario's scripted steps did, in order. */
      steps?: string[];
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
  steps: stepLog,
};

document.title = `Ship Studio harness — ${scenario.id}`;

/**
 * The playground drives one flow directly rather than booting the whole app.
 *
 * `App` decides for itself whether onboarding should show, based on setup
 * status and completion flags — reasonable for the product, useless for a
 * workbench whose entire purpose is to sit on a screen and change one variable
 * at a time. So this scenario mounts the flow itself.
 */
const isPlayground = scenario.id === 'onboarding-playground';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      {isPlayground ? (
        <OnboardingPlayground />
      ) : (
        <App initialProjectPath={params.get('project') ?? scenario.project ?? null} />
      )}
    </ErrorBoundary>
  </React.StrictMode>
);

/**
 * Click the scenario's control once the app has settled, and announce
 * readiness on `window.__harnessReady`. A capture runner waits on that flag
 * rather than on a fixed sleep, so a slow machine produces the same screenshot
 * as a fast one instead of a half-painted one.
 */
/** Wait for a selector to exist, or give up after `timeoutMs`. */
async function waitFor(selector: string, timeoutMs = 8000): Promise<HTMLElement | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) return el;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Type into a controlled input the way a user does.
 *
 * Setting `el.value` directly is invisible to React: the DOM updates, the
 * component's state does not, and the capture shows a filled field above a
 * still-disabled Save button — a screen the app cannot actually produce. Going
 * through the prototype's own setter and dispatching `input` is what React's
 * synthetic event system reads.
 */
function fillInput(el: HTMLElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  // Deliberately an unbound setter, applied to this element: that is the whole
  // technique. `unbound-method` is guarding against losing `this`, which the
  // explicit receiver here supplies.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const setValue = descriptor?.set;
  if (setValue) Reflect.apply(setValue, el, [value]);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Perform the scenario's interactions in order: `openSelector` first, then any
 * `steps`. A step that never finds its selector stops the sequence — later
 * steps are written against the screen it was supposed to open, so continuing
 * would click whatever happens to match on the wrong one.
 */
async function runSteps(): Promise<void> {
  const steps = [
    ...(scenario.openSelector ? [{ click: scenario.openSelector }] : []),
    ...(scenario.steps ?? []),
  ];

  for (const step of steps) {
    const selector = step.click ?? step.fill;
    if (!selector) continue;
    const el = await waitFor(selector);
    if (!el) {
      stepLog.push(`never appeared: ${selector}`);
      console.error(`[harness] step never appeared: ${selector}`);
      return;
    }
    if (step.click) {
      el.click();
      stepLog.push(`clicked ${selector}`);
    } else {
      fillInput(el, step.value ?? '');
      stepLog.push(`filled ${selector}`);
    }
    // One frame, so this step's render lands before the next step looks for
    // the element it produces.
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  }
}

async function settle(): Promise<void> {
  await runSteps();
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
