/**
 * Flexible panels — arrangements, captured.
 *
 * A layout is a stored preference, so every one of these is one `storage` key
 * away rather than a sequence of drags the harness cannot perform. That is the
 * point of keeping the arrangement as data: an arrangement somebody could only
 * reach by dragging would have no coverage at all.
 *
 * What these are looking for, in every case, is a **blank column**. A docked
 * panel's surface is body-portaled and positioned over a measured slot, so the
 * failure mode of the whole design is a slot that renders with no panel over
 * it — which is why each scenario names a real element inside the panel it
 * expects to see, not the slot.
 *
 * See docs/flexible-panels.md.
 */

import type { Scenario } from '../types';
import { teamSnapshotCommand, workspaceCommands, WORKSPACE_PROJECT } from './workspace';

const LAYOUT_KEY = `shipstudio.layout.project:${WORKSPACE_PROJECT}`;

function layout(order: string[], floating: string[], widths: Record<string, number> = {}) {
  return JSON.stringify({ order, floating, widths });
}

function stackedLayout(
  columns: Array<
    | { kind: 'preview' }
    | { kind: 'panels'; width?: number; panels: Array<{ panel: string; weight: number }> }
  >,
  floating: string[] = []
) {
  return JSON.stringify({ version: 2, columns, floating });
}

/** Team's panel needs its snapshot, and it must be open to occupy a column. */
const teamOpen = {
  [`shipstudio.team.panelOpen:${WORKSPACE_PROJECT}`]: '1',
};
const teamCommands = { get_team_snapshot: teamSnapshotCommand };

export const layoutScenarios: Scenario[] = [
  {
    id: 'layout-agent-elements-stacked',
    title: 'Flexible panels — Agent and Elements stacked in one column',
    looksRightWhen:
      'Agent and Elements share one column beside the preview. Both panel surfaces are visible, the horizontal divider can be dragged, and the two panels keep their 50/50 balance while the preview remains a separate locked column.',
    project: WORKSPACE_PROJECT,
    storage: {
      [LAYOUT_KEY]: stackedLayout([
        {
          kind: 'panels',
          width: 420,
          panels: [
            { panel: 'agent', weight: 1 },
            { panel: 'navigator', weight: 1 },
          ],
        },
        { kind: 'preview' },
        { kind: 'panels', panels: [{ panel: 'editor', weight: 1 }] },
      ]),
    },
    requires: '.workspace-dock__slot[data-panel="agent"]',
    commands: workspaceCommands,
  },

  {
    id: 'layout-agent-on-the-right',
    title: 'Flexible panels — the agent moved to the right of the preview',
    looksRightWhen:
      'The agent terminal is the RIGHT-hand column and the preview is on the left. This is the arrangement the old layout could not express at all: the agent was the left half of a two-pane split, so "put it on the other side" had nowhere to be written down.',
    project: WORKSPACE_PROJECT,
    storage: { [LAYOUT_KEY]: layout(['preview', 'agent'], []) },
    requires: '.terminal-agent-header',
    commands: workspaceCommands,
  },

  {
    id: 'layout-focus-mode',
    title: 'Flexible panels — Focus mode with the agent docked right',
    looksRightWhen:
      'The agent fills the whole workspace. No preview, no "Starting dev server…" and no code viewer beside it: Focus hides the preview column, and a hidden column that still took half the width left the agent stuck on the right with no handle to widen it (issue #1019).',
    project: WORKSPACE_PROJECT,
    storage: { [LAYOUT_KEY]: layout(['preview', 'agent'], []) },
    steps: [{ click: '.workspace-tab[aria-label="Focus"]' }],
    requires: '.workspace-dock__center[hidden]',
    commands: workspaceCommands,
  },

  {
    id: 'layout-three-docked',
    title: 'Flexible panels — Team, Agent and the preview, all docked',
    looksRightWhen:
      'Three columns side by side, each with a real panel drawn over it and none of them blank. A column with nothing in it is the failure this exists to catch: every docked surface is body-portaled and positioned over a measured slot, so an unmeasured slot leaves an empty band.',
    project: WORKSPACE_PROJECT,
    storage: {
      [LAYOUT_KEY]: layout(['team', 'agent', 'preview'], [], { team: 340, agent: 320 }),
      ...teamOpen,
    },
    requires:
      '.workspace-dock__column:has(.workspace-dock__slot[data-panel="team"]) .workspace-dock__resize',
    commands: { ...workspaceCommands, ...teamCommands },
  },

  {
    id: 'layout-team-right-of-preview',
    title: 'Flexible panels — Team on the far side of the preview',
    looksRightWhen:
      'Agent, preview, then Team — Team docked to the RIGHT of the canvas. Its resize handle is on its left edge, the side facing the preview, because that is the edge dragging it makes sense from.',
    project: WORKSPACE_PROJECT,
    storage: {
      [LAYOUT_KEY]: layout(['agent', 'preview', 'team'], [], { team: 360 }),
      ...teamOpen,
    },
    requires: '.workspace-dock__resize--right',
    commands: { ...workspaceCommands, ...teamCommands },
  },

  {
    id: 'layout-everything-floating',
    title: 'Flexible panels — nothing docked but the preview',
    looksRightWhen:
      'The preview has the whole workspace and the agent floats over it as a window. No leftover column, no gap where a panel used to be: a floating panel keeps its place in the order but claims no width.',
    project: WORKSPACE_PROJECT,
    storage: {
      [LAYOUT_KEY]: layout(['agent', 'preview', 'team'], ['agent', 'team']),
    },
    requires: '.dockable-panel__surface--floating.dockable-panel__surface--agent',
    commands: workspaceCommands,
  },

  {
    id: 'layout-menu',
    title: 'Flexible panels — the Layout menu',
    looksRightWhen:
      'Every panel with where it currently is (Left / Right / Floating) and three controls to move it, then the presets, then save-as-default and reset. Everything a drag can do is here, because a drag must never be the only way.',
    project: WORKSPACE_PROJECT,
    storage: { [LAYOUT_KEY]: layout(['team', 'agent', 'preview', 'editor'], ['team', 'editor']) },
    openSelector: '[data-workspace-panel="layout"]',
    requires: '.workspace-layout-menu',
    clipSelector: '.workspace-layout-menu',
    commands: workspaceCommands,
  },

  {
    id: 'layout-repairs-nonsense',
    title: 'Flexible panels — a saved layout that makes no sense',
    looksRightWhen:
      'A workspace, not an error. The stored layout here names a panel that does not exist, lists the agent twice, has no preview at all and asks for a five-thousand-pixel column — every repair `normalizeLayout` makes, in one preference. A layout is a convenience; no state of it may cost somebody their workspace.',
    project: WORKSPACE_PROJECT,
    storage: {
      [LAYOUT_KEY]: layout(['agent', 'agent', 'ghost-panel'], ['ghost-panel'], { agent: 5000 }),
    },
    requires: '.terminal-agent-header',
    commands: workspaceCommands,
  },
];
