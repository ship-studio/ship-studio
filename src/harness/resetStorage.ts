/**
 * Wipe per-viewer browser storage before any app module reads it.
 *
 * Captures share one Chrome profile, so without this a preference written by
 * an earlier capture (dashboard grid/list, onboarding mode, a dismissed
 * banner) silently changes what a later one renders. That makes a run
 * order-dependent, which makes a screenshot unfalsifiable: you cannot tell a
 * regression from a leftover.
 *
 * This module is imported *before* `../App` in `main.tsx` on purpose — ES
 * module side effects run in import order, and the app reads `localStorage`
 * at module scope.
 *
 * A scenario that needs a stored value declares it via `Scenario.storage`,
 * which is seeded here after the wipe.
 */

import { findScenario } from './scenarios';

const params = new URLSearchParams(window.location.search);
const scenario = findScenario(params.get('scenario'));

try {
  localStorage.clear();
  sessionStorage.clear();
} catch {
  // Private mode or blocked site data. Nothing to clear, nothing to fix.
}

for (const [key, value] of Object.entries(scenario.storage ?? {})) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Same as above — a scenario that depends on storage will simply render
    // its default state, and the screenshot shows that honestly.
  }
}
