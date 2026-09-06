/**
 * Feature-surface scenarios: the states that carry real data.
 *
 * The `--commands` sweep already reaches every surface the palette can open,
 * but it reaches them against the default fixtures — which are mostly empty.
 * An empty list is a state worth reviewing exactly once; what needs looking at
 * repeatedly is a populated one, where truncation, wrapping, overflow, and
 * ordering actually happen. That is what lives here.
 */

import type { Scenario } from '../types';
import { workspaceCommands, WORKSPACE_PROJECT } from './workspace';

const HOUR = 3_600_000;

const pr = (n: number, title: string, over: Record<string, unknown> = {}) => ({
  number: n,
  title,
  head_ref: `feat/branch-${n}`,
  base_ref: 'main',
  author: 'harness-user',
  state: 'OPEN',
  mergeable: true,
  is_draft: false,
  url: `https://github.com/harness-user/acme-marketing/pull/${n}`,
  created_at: new Date(Date.now() - n * HOUR).toISOString(),
  ...over,
});

const branch = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  is_current: false,
  is_remote: false,
  is_default: false,
  last_commit_date: Date.now() - HOUR,
  last_commit_author: 'Harness User',
  ahead_of_main: 0,
  behind_main: 0,
  ...over,
});

const workflow = (slug: string, name: string, over: Record<string, unknown> = {}) => ({
  id: `${WORKSPACE_PROJECT}::${slug}`,
  slug,
  name,
  icon: null,
  description: 'Checks the things that keep breaking.',
  agentId: null,
  projectPath: WORKSPACE_PROJECT,
  projectName: 'acme-marketing',
  trigger: { kind: 'manual' },
  permission: 'read-only',
  prompt: 'Review the diff and report anything that would break in production.',
  severityFloor: 'info',
  autoRun: false,
  filePath: `${WORKSPACE_PROJECT}/.shipstudio/workflows/${slug}.md`,
  updatedAt: Date.now() - HOUR,
  nextRunAt: null,
  isRunning: false,
  runningSince: null,
  runs: [],
  ...over,
});

const finding = (id: string, severity: string, title: string, summary: string) => ({
  id,
  workflowId: `${WORKSPACE_PROJECT}::pre-release`,
  workflowName: 'Pre-release check',
  projectName: 'acme-marketing',
  projectPath: WORKSPACE_PROJECT,
  severity,
  title,
  summary,
  bodyMd: `## ${title}\n\n${summary}\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n`,
  createdAt: Date.now() - HOUR,
  read: false,
  archived: false,
  fingerprint: id,
  occurrences: 1,
  firstSeenAt: Date.now() - HOUR,
  locations: [{ path: 'src/app/page.tsx', line: 42 }],
  suggestedPrompt: `Fix: ${title}`,
  runId: 'run_1',
});

export const featureScenarios: Scenario[] = [
  {
    id: 'workspace',
    title: 'Workspace — a project open',
    looksRightWhen:
      'Header, sidebar, agent pane, and preview all render. This is the baseline every command capture is diffed against.',
    project: WORKSPACE_PROJECT,
    commands: { ...workspaceCommands },
  },
  {
    id: 'branches-many',
    title: 'Branches — a busy repo',
    looksRightWhen:
      'Long branch names truncate rather than overflow; ahead/behind counts read clearly; the current branch is unmistakable.',
    project: WORKSPACE_PROJECT,
    commands: {
      ...workspaceCommands,
      list_branches: [
        branch('main', { is_current: true, is_default: true }),
        branch('feat/pricing-page', { ahead_of_main: 3, behind_main: 1 }),
        branch('fix/a-very-long-branch-name-that-should-truncate-not-overflow', {
          ahead_of_main: 12,
          behind_main: 40,
        }),
        branch('chore/deps', { behind_main: 2 }),
        branch('origin/main', { is_remote: true }),
      ],
    },
  },
  {
    id: 'prs-open',
    title: 'Pull requests — several open',
    looksRightWhen:
      'Each row shows number, title, author and branch without collision. Draft and non-mergeable states are visually distinct.',
    project: WORKSPACE_PROJECT,
    commands: {
      ...workspaceCommands,
      list_pull_requests: [
        pr(128, 'Add the pricing page'),
        pr(127, 'Bump dependencies', { is_draft: true }),
        pr(126, 'Refactor the checkout flow so that it no longer depends on the legacy cart', {
          mergeable: false,
        }),
      ],
    },
  },
  {
    id: 'conflicts',
    title: 'Merge conflicts — resolution UI',
    looksRightWhen:
      'Both sides are readable and equally weighted; it is obvious which file is being resolved and how many blocks remain.',
    project: WORKSPACE_PROJECT,
    commands: {
      ...workspaceCommands,
      // `get_conflict_info`, snake_case — the shape at the real call site in
      // `src/lib/conflicts.ts`, which differs from the camelCase
      // `ConflictedFile` the lib maps it into.
      get_conflict_info: [
        {
          file_path: 'src/app/page.tsx',
          is_binary: false,
          ours_branch: 'main',
          theirs_branch: 'feat/pricing-page',
          unsupported_reason: null,
          conflicts: [
            {
              line_start: 12,
              line_end: 16,
              current_content: '        <h1>Welcome</h1>',
              incoming_content: '        <h1>Welcome to Acme</h1>',
              context_before: 'export default function Page() {\n  return (\n    <main>',
              context_after: '    </main>\n  );\n}',
            },
          ],
        },
      ],
    },
  },
  {
    id: 'workflows-populated',
    title: 'Workflows — several configured',
    looksRightWhen:
      'Trigger descriptions are legible, and a running workflow is distinguishable from an idle one.',
    project: WORKSPACE_PROJECT,
    commands: {
      ...workspaceCommands,
      list_all_workflows: [
        workflow('pre-release', 'Pre-release check'),
        workflow('a11y', 'Accessibility sweep', {
          trigger: { kind: 'daily', atHour: 9, atMinute: 0 },
          autoRun: true,
          nextRunAt: Date.now() + HOUR,
        }),
        workflow('deps', 'Dependency audit', {
          isRunning: true,
          runningSince: Date.now() - 30_000,
        }),
      ],
    },
  },
  {
    id: 'inbox-populated',
    title: 'Inbox — findings to triage',
    looksRightWhen:
      'Severities are distinguishable at a glance, unread stands out, and the detail pane renders markdown without breaking the layout.',
    project: WORKSPACE_PROJECT,
    commands: {
      ...workspaceCommands,
      list_inbox_items: [
        finding(
          'f1',
          'critical',
          'Preview URL is constructed, not observed',
          'The card builds a URL from the project name, which 404s past 63 characters.'
        ),
        finding(
          'f2',
          'warning',
          'Unbounded CLI call on the boot path',
          'A network CLI call without a timeout can hang the window indefinitely.'
        ),
        finding(
          'f3',
          'info',
          'Off-scale font size',
          'A 15px literal should round to the nearest type-scale token.'
        ),
      ],
    },
  },
];
