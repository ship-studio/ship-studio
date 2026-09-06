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

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '../App';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { exposeReactGlobals } from '../lib/plugin-loader';
import { exposePluginContextRef } from '../contexts/PluginContext';
import { installFakeBackend } from './fakeBackend';
import { findScenario, scenarios } from './scenarios';
import { unhandledCalls } from './unhandled';
import { HarnessOverlay } from './HarnessOverlay';

const params = new URLSearchParams(window.location.search);
const scenario = findScenario(params.get('scenario'));
const showChrome = params.get('chrome') !== 'off';

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
    };
  }
}
window.__harness = { scenario, scenarios, unhandled: unhandledCalls };

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
  // One more frame so the opened surface has painted before capture.
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 400)));
  (window as unknown as { __harnessReady?: boolean }).__harnessReady = true;
}

void settle();

if (showChrome) {
  const chrome = document.createElement('div');
  document.body.appendChild(chrome);
  ReactDOM.createRoot(chrome).render(<HarnessOverlay scenario={scenario} />);
}
