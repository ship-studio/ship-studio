/** The scenario registry. `?scenario=<id>`; unknown ids fall back to `dashboard`. */

import type { Scenario } from '../types';
import { agentsScenarios } from './agents';
import { agentsDesktopScenarios } from './agentsDesktop';
import { agentsProjectScenarios } from './agentsProject';
import { appScenarios } from './app';
import { featureScenarios } from './features';
import { hostingScenarios } from './hosting';
import { hostingConnectScenarios } from './hostingConnect';
import { issueReportScenarios } from './issueReports';
import { layoutScenarios } from './layout';
import { migrationScenarios } from './migration';
import { phoneScenarios } from './phone';
import { phoneInstallScenarios } from './phoneInstall';
import { remoteScenarios } from './remote';
import { teamScenarios } from './team';

export const scenarios: Scenario[] = [
  ...agentsScenarios,
  ...agentsDesktopScenarios,
  ...agentsProjectScenarios,
  ...appScenarios,
  ...featureScenarios,
  ...hostingScenarios,
  ...hostingConnectScenarios,
  ...issueReportScenarios,
  ...layoutScenarios,
  ...migrationScenarios,
  ...phoneScenarios,
  ...phoneInstallScenarios,
  ...remoteScenarios,
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
