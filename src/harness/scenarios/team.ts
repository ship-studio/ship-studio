/**
 * Team — multiplayer, captured.
 *
 * `get_team_snapshot` reads a real repository: git history, `gh pr list`, and
 * any records under `.shipstudio-team/`. A capture machine has none of those —
 * no teammates, no pull requests, usually no remote — so these scenarios answer
 * that one command from `harness/fixtures/team`, which is the only invented
 * data left anywhere in the feature.
 *
 * Every scenario opens the workspace panel, because that is the only place
 * Team exists. There was briefly a home-level screen reading across eight
 * projects at once; what it answered from outside a project was worth less
 * than the hundreds of git processes it cost.
 *
 * `requires` names something only the intended surface renders, so a capture
 * that lands somewhere else fails the run instead of quietly photographing the
 * wrong screen.
 */

import type { Scenario } from '../types';
import { buildTeamFixture } from '../fixtures/team';
import { teamSnapshotCommand, workspaceCommands, WORKSPACE_PROJECT } from './workspace';

/**
 * What the Team screens read.
 *
 * `install_commit_guidance` is here because the coverage note offers it: an
 * unmocked command fails the run rather than being given a plausible default,
 * and the whole point of that note is the button.
 */
const teamCommands = {
  get_team_snapshot: teamSnapshotCommand,
  install_commit_guidance: `${WORKSPACE_PROJECT}/CLAUDE.md`,
};

export const teamScenarios: Scenario[] = [
  {
    id: 'team-coverage',
    title: 'Team — the half of the team who are not in Ship Studio',
    looksRightWhen:
      'The coverage note names who pushes straight to GitHub, says exactly what is missing from their rows (the why, not the fact), and offers one action. It is a footnote after the feed, not a banner in front of it.',
    project: WORKSPACE_PROJECT,
    openSelector: '.team-presence',
    requires: '.team-coverage',
    clipSelector: '.team-coverage',
    commands: { ...workspaceCommands, ...teamCommands },
  },

  {
    id: 'team-in-workspace',
    title: 'Team — inside the project you are working in',
    looksRightWhen:
      'The workspace header carries a face stack with a count of what has landed since you last looked, and the panel floats over the preview showing what people actually did — headline, why, what changed — rather than a list of pushes.',
    project: WORKSPACE_PROJECT,
    openSelector: '.team-presence',
    requires: '.team-update-headline',
    commands: { ...workspaceCommands, ...teamCommands },
  },
  {
    id: 'team-in-workspace-comments',
    title: 'Team — the comments on this project, in the workspace panel',
    looksRightWhen:
      'The Comments tab lists the open threads with their pin number, what they are about and who is in them. An empty body under a filter that says "Open (2)" is the bug this exists to catch.',
    project: WORKSPACE_PROJECT,
    openSelector: '.team-presence',
    steps: [{ click: '[data-tab-value="comments"]' }],
    requires: '.team-thread-item',
    commands: { ...workspaceCommands, ...teamCommands },
  },
  {
    id: 'team-comments-selected',
    title: 'Team — comments ticked for an agent',
    looksRightWhen:
      'Ticking a comment reveals the send button naming how many are going, and the wording is singular for one. Nothing is ticked until someone ticks it.',
    project: WORKSPACE_PROJECT,
    openSelector: '.team-presence',
    steps: [
      { click: '[data-tab-value="comments"]' },
      { click: '.team-thread-item .checkbox__input' },
    ],
    requires: '.team-threads-send',
    commands: { ...workspaceCommands, ...teamCommands },
  },
  {
    id: 'team-in-workspace-pinned',
    title: 'Team — pinned to the window rather than floating',
    looksRightWhen:
      'The panel takes a column of the workspace and the preview reflows beside it, instead of hovering over it. A blank column is the failure this exists to catch: a docked panel whose placeholder has no size never gets positioned.',
    project: WORKSPACE_PROJECT,
    openSelector: '.team-presence',
    steps: [{ click: '.team-float-header .panel-pin-toggle' }],
    // The rail slot is the column the panel takes, and its resize handle is the
    // thing you drag to size it. Its absence is the bug: a docked column that is
    // either not there or cannot be sized.
    requires: '.workspace-dock__slot[data-panel="team"] .workspace-dock__resize',
    commands: { ...workspaceCommands, ...teamCommands },
  },
  {
    id: 'team-pinned-then-closed',
    title: 'Team — closed while pinned leaves no gap',
    looksRightWhen:
      'Closing a pinned panel gives its column back to the workspace. An empty band where the panel used to be is the bug: the dock slot reserves width whether or not the surface is visible.',
    project: WORKSPACE_PROJECT,
    openSelector: '.team-presence',
    steps: [
      { click: '.team-float-header .panel-pin-toggle' },
      { click: '.team-float-header [aria-label="Close"]' },
    ],
    requires: '.workspace-content',
    commands: { ...workspaceCommands, ...teamCommands },
  },
  {
    id: 'team-in-workspace-people',
    title: 'Team — who is on what, without leaving the project',
    looksRightWhen:
      'Each teammate shows the branch they are on and the sentence describing what they are doing, not just a branch name and a timestamp.',
    project: WORKSPACE_PROJECT,
    openSelector: '.team-presence',
    steps: [{ click: '[data-tab-value="people"]' }],
    requires: '.team-person-doing',
    commands: { ...workspaceCommands, ...teamCommands },
  },

  {
    id: 'team-self-coverage',
    title: 'Team \u2014 your own pushes are not writing summaries',
    looksRightWhen:
      'The note says the app can see the push but only the agent knows why, and offers to write the guidance into this project\u2019s agent instructions — a file every future session reads, not a prompt that fixes one. It must not appear at all once that block is in place.',
    project: WORKSPACE_PROJECT,
    openSelector: '.team-presence',
    requires: '.team-coverage',
    clipSelector: '.team-coverage',
    commands: {
      ...workspaceCommands,
      ...teamCommands,
      // Thin rows of your own, and no guidance installed: the one state this
      // note exists for.
      get_team_snapshot: buildTeamFixture({ selfRowsAreThin: true }),
    },
  },

  {
    id: 'team-attribution-setting',
    title: 'Team \u2014 the one switch for what lands in your history',
    looksRightWhen:
      'The row names the trailer and says where it does not appear: not in the subject line, not in `git log --oneline`. Default on, reading as a choice rather than as a warning.',
    project: WORKSPACE_PROJECT,
    openSelector: '[aria-label="App settings"]',
    requires: '[aria-label="Credit Ship Studio in commits"]',
    commands: { ...workspaceCommands, ...teamCommands },
  },
];
