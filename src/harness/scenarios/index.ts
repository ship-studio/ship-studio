/** The scenario registry. `?scenario=<id>`; unknown ids fall back to `dashboard`. */

import type { Scenario } from '../types';
import { appScenarios } from './app';
import { featureScenarios } from './features';
import { hostingScenarios } from './hosting';
import { hostingConnectScenarios } from './hostingConnect';
import { layoutScenarios } from './layout';
import { migrationScenarios } from './migration';
import { teamScenarios } from './team';

export const scenarios: Scenario[] = [
  ...appScenarios,
  ...featureScenarios,
  ...hostingScenarios,
  ...hostingConnectScenarios,
  ...layoutScenarios,
  ...migrationScenarios,
  ...teamScenarios,
];

export const DEFAULT_SCENARIO = 'dashboard';

export function findScenario(id: string | null): Scenario {
  return (
    scenarios.find((s) => s.id === id) ??
    scenarios.find((s) => s.id === DEFAULT_SCENARIO) ??
    scenarios[0]
  );
}
