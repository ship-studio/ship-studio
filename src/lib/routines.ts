/**
 * Routines & Inbox — prototype data layer.
 *
 * PROTOTYPE ONLY. Every value below is a fixture. Nothing here schedules,
 * spawns an agent, reads a file, or writes to disk. The types are the ones the
 * real feature would use so the UI is built against the eventual shape; the
 * store is an in-memory `useSyncExternalStore` source so the prototype feels
 * live (toggling, archiving, marking read) without a backend.
 *
 * The design this stands in for is documented in `docs/routines-inbox.md`.
 *
 * @module lib/routines
 */

import { CLAUDE_CODE, CODEX, OPENCODE, type AgentConfig } from './agent';

/* ------------------------------------------------------------------ types */

/** How severe a finding is. Drives colour, sort order, and delivery floor. */
export type Severity = 'critical' | 'warning' | 'info';

/** Outcome of a single routine run. */
export type RunStatus = 'ok' | 'findings' | 'failed' | 'running';

/** What a routine's agent is allowed to do while it runs. */
export type RoutinePermission = 'read-only' | 'can-edit';

/**
 * What sets a routine off.
 *
 * Pressing Run is the default and always works. Everything else is an opt-in on
 * top of it, and what is honestly possible depends on where the trigger is
 * evaluated — see {@link RoutineHost}.
 */
export type RoutineTrigger =
  | { kind: 'manual' }
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'daily'; atHour: number; atMinute: number }
  | { kind: 'weekly'; weekday: number; atHour: number; atMinute: number }
  | { kind: 'event'; event: RoutineEvent };

/**
 * Where a trigger is evaluated, which is the whole honesty question.
 *
 * `app` — Ship Studio's own scheduler, a tokio tick in the running app. Nothing
 * is installed and nothing touches the system, but nothing fires while the app
 * is closed either.
 *
 * `background` — a per-user launchd agent in `~/Library/LaunchAgents` (Windows:
 * a Task Scheduler task) running the *same* `claude -p` command. It fires at the
 * wall-clock time whether or not Ship Studio is open, so the findings are
 * waiting in the Inbox when you next open the app.
 *
 * `man launchd.plist` on the exact semantics that make this worth offering:
 *
 *   "Unlike cron which skips job invocations when the computer is asleep,
 *   launchd will start the job the next time the computer wakes up. If multiple
 *   intervals transpire before the computer is woken, those events will be
 *   coalesced into one event upon wake from sleep."
 *
 * So a daily 10:00 routine survives a closed lid: it runs on wake, once, not
 * once per missed day. The conditions it cannot escape, and which the UI states
 * plainly: the Mac has to be powered on or asleep (a shut-down machine runs
 * nothing), and you have to be logged in, because LaunchAgents are per-user.
 *
 * Background is offered for `daily` and `weekly` only, and that falls straight
 * out of the primitive: launchd's `StartInterval` explicitly *misses* a firing
 * if the system is asleep for it, while `StartCalendarInterval` catches up. An
 * interval that silently skips overnight would be exactly the dishonest
 * scheduling this design is trying to avoid.
 */
export type RoutineHost = 'app' | 'background';

/**
 * Non-time triggers, all of which Ship Studio already observes today. These
 * are the best fit for the model: they fire during work, which is exactly when
 * the app is open.
 */
export type RoutineEvent = 'push' | 'pr-opened' | 'branch-merged' | 'project-open';

/** Which project(s) a routine runs against. */
export interface RoutineScope {
  kind: 'project' | 'all-projects';
  projectName?: string;
  projectPath?: string;
}

/** One recorded execution of a routine. */
export interface RoutineRun {
  id: string;
  startedAt: number;
  durationMs: number;
  status: RunStatus;
  /** Findings filed to the inbox by this run. */
  findings: number;
  /** Tokens billed to the user's own agent subscription. */
  tokens: number;
  /** Headless transcript, trimmed for display. */
  transcript: string;
}

/** A standing instruction. On disk this is one markdown file with frontmatter. */
export interface Routine {
  id: string;
  name: string;
  /** One-line description shown under the name in the list. */
  description: string;
  agentId: string;
  scope: RoutineScope;
  trigger: RoutineTrigger;
  permission: RoutinePermission;
  /** The user-authored body of the routine file. */
  prompt: string;
  /** Findings below this level are recorded but not surfaced in the inbox. */
  severityFloor: Severity;
  /** Send an OS notification as well as filing to the inbox. */
  notify: boolean;
  /**
   * Whether the trigger is armed. Irrelevant for a manual routine, which is
   * always runnable from its Run button — pressing Run is the whole trigger.
   */
  autoRun: boolean;
  /** Absolute path of the markdown file this routine lives in. */
  filePath: string;
  /** Where the trigger is evaluated. Meaningless for manual and event triggers. */
  host: RoutineHost;
  /** When the trigger next comes due. Null for manual and event routines. */
  nextRunAt: number | null;
  runs: RoutineRun[];
}

/** A file/line the finding points at. */
export interface FindingLocation {
  path: string;
  line?: number;
  note?: string;
}

/** One report filed by a routine run. */
export interface InboxItem {
  id: string;
  routineId: string;
  routineName: string;
  projectName: string;
  projectPath: string;
  severity: Severity;
  title: string;
  /** One-line summary shown in the list. */
  summary: string;
  /** Markdown body shown in the detail pane. */
  bodyMd: string;
  createdAt: number;
  read: boolean;
  archived: boolean;
  /** Stable identity across runs — a repeat bumps `occurrences`, not a new item. */
  fingerprint: string;
  occurrences: number;
  firstSeenAt: number;
  locations: FindingLocation[];
  /** What "Fix with agent" would type into a fresh terminal tab. */
  suggestedPrompt: string;
  runId: string;
}

/** A starter routine offered when creating a new one. */
export interface RoutineTemplate {
  id: string;
  name: string;
  description: string;
  /** Emoji-free category label used for grouping in the picker. */
  category: 'Quality' | 'Security' | 'Maintenance' | 'Research';
  trigger: RoutineTrigger;
  permission: RoutinePermission;
  scopeKind: RoutineScope['kind'];
  prompt: string;
}

/* -------------------------------------------------------------- formatting */

const EVENT_LABELS: Record<RoutineEvent, string> = {
  push: 'After every push',
  'pr-opened': 'When a PR opens',
  'branch-merged': 'After a branch merges',
  'project-open': 'When the project opens',
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

/** Human label for a trigger, e.g. "Every 30 min" or "Daily at 10:00". */
export function formatTrigger(trigger: RoutineTrigger): string {
  switch (trigger.kind) {
    case 'manual':
      return 'Manual';
    case 'interval': {
      const minutes = trigger.everyMinutes;
      if (minutes < 60) return `Every ${minutes} min`;
      const hours = minutes / 60;
      return hours === 1 ? 'Every hour' : `Every ${hours} hours`;
    }
    case 'daily':
      return `Daily at ${pad(trigger.atHour)}:${pad(trigger.atMinute)}`;
    case 'weekly':
      return `${WEEKDAYS[trigger.weekday]}s at ${pad(trigger.atHour)}:${pad(trigger.atMinute)}`;
    case 'event':
      return EVENT_LABELS[trigger.event];
  }
}

/** Whether a trigger can be handed to launchd — calendar entries only. */
export function supportsBackground(trigger: RoutineTrigger): boolean {
  return trigger.kind === 'daily' || trigger.kind === 'weekly';
}

/** Whether a trigger is a clock/interval one at all (vs manual or an event). */
export function isTimeTrigger(trigger: RoutineTrigger): boolean {
  return trigger.kind === 'interval' || supportsBackground(trigger);
}

/** Short form of where a routine runs, for the list row. */
export function formatHost(host: RoutineHost): string {
  return host === 'background' ? 'in the background' : 'when Ship Studio is open';
}

/**
 * The list-row schedule line: what fires it, and — the part that actually
 * matters — whether it can fire while the app is closed.
 *
 * A disarmed routine must not advertise a cadence it is not keeping.
 */
export function describeSchedule(routine: Pick<Routine, 'trigger' | 'autoRun' | 'host'>): string {
  const { trigger } = routine;
  if (trigger.kind === 'manual') return 'Manual — runs when you press Run';
  if (!routine.autoRun) return `${formatTrigger(trigger)} — auto-run off`;
  if (trigger.kind === 'event') return `${formatTrigger(trigger)}, when Ship Studio is open`;
  return `${formatTrigger(trigger)}, ${formatHost(routine.host)}`;
}

/** The honest sentence about when a trigger can actually fire. */
export function describeTriggerReality(trigger: RoutineTrigger, host: RoutineHost): string {
  switch (trigger.kind) {
    case 'manual':
      return 'Runs only when you press Run. Nothing happens on its own.';
    case 'event':
      return 'Fires when Ship Studio sees the event, which is while you are working in it. Events that happen elsewhere are not replayed.';
    case 'interval':
      return 'Not a clock — a minimum gap. While Ship Studio is open it checks whether that long has passed since the last run, and runs if it has. Close the app for a day and it runs once when you reopen, never a backlog.';
    case 'daily':
    case 'weekly':
      return host === 'background'
        ? 'Fires at this time whether or not Ship Studio is open, and if the Mac is asleep, once when it next wakes — not once per missed day.'
        : 'Ship Studio checks this while it is open. If the app is closed at this time nothing happens and that run is skipped — switch it to the background if it has to happen regardless.';
  }
}

/**
 * How long until the routine is eligible to run again, e.g. "in 12 min".
 *
 * "Due", not "next": the gap elapsing makes it eligible, and it runs at the
 * first check while the app is open. Null when nothing is armed.
 */
export function formatCountdown(nextRunAt: number | null, now = Date.now()): string | null {
  if (nextRunAt === null) return null;
  const ms = nextRunAt - now;
  if (ms <= 0) return 'due now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? 'in 1 hour' : `in ${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'tomorrow' : `in ${days} days`;
}

/** Compact relative time for list rows, e.g. "12m", "3h", "2d". */
export function formatAge(timestamp: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

/**
 * Past-tense age for a timestamp: "just now", "18m ago", "2d ago".
 *
 * Callers must not append " ago" to `formatAge` themselves — the sub-minute
 * case reads "now", and "now ago" is not a thing.
 */
export function formatAgo(timestamp: number, now = Date.now()): string {
  const age = formatAge(timestamp, now);
  return age === 'now' ? 'just now' : `${age} ago`;
}

/** Run duration as "1.4s" / "48s" / "2m 10s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Token counts read better rounded: 18400 → "18.4k". */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(1)}k`;
}

/** Rolling seven-day rollup for the Routines summary strip. */
export function summarizeWeek(routines: Routine[]): {
  runs: number;
  findings: number;
  tokens: number;
} {
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const runs = routines.flatMap((routine) => routine.runs.filter((run) => run.startedAt >= since));
  return {
    runs: runs.length,
    findings: runs.reduce((total, run) => total + run.findings, 0),
    tokens: runs.reduce((total, run) => total + run.tokens, 0),
  };
}

const AGENTS: AgentConfig[] = [CLAUDE_CODE, CODEX, OPENCODE];

/** Agent config for a routine, falling back to Claude Code. */
export function agentForRoutine(agentId: string): AgentConfig {
  return AGENTS.find((agent) => agent.id === agentId) ?? CLAUDE_CODE;
}

/**
 * The literal command a run would execute.
 *
 * Shown verbatim in the routine editor: the point of the feature is that
 * there's no hidden orchestration, so the user should be able to read the
 * command and, if they want, paste it into their own terminal.
 */
export function buildCommandPreview(routine: Pick<Routine, 'agentId' | 'permission'>): string {
  const agent = agentForRoutine(routine.agentId);
  if (agent.id === 'codex') {
    const sandbox = routine.permission === 'read-only' ? 'read-only' : 'workspace-write';
    return `${agent.binaryName} exec --sandbox ${sandbox} \\\n  --cd <project> \\\n  "$(cat <routine>.md)"`;
  }
  const mode = routine.permission === 'read-only' ? 'plan' : 'acceptEdits';
  return [
    `${agent.binaryName} --print --output-format stream-json \\`,
    `  --permission-mode ${mode} \\`,
    `  --mcp-config <ship-studio-inbox> \\`,
    `  < <routine>.md            # cwd: <project>`,
  ].join('\n');
}

/* ------------------------------------------------------------- fixtures */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Fixed "now" anchor so the fixtures keep sensible relative times. */
const NOW = Date.now();

const CLAUDE_TRANSCRIPT = `$ claude --print --output-format stream-json \\
    --permission-mode plan \\
    --mcp-config /tmp/shipstudio-inbox-8f21.json
  cwd /Users/you/ShipStudio/hexa-storefront

[init]   model claude-opus-5 · plan mode · 1 mcp server (ship-studio)
[scope]  diff 4c19aa2..HEAD — 14 files changed, 402 insertions(+), 96 deletions(-)
[memory] 3 open findings from previous runs supplied to the agent

  Reading src/app/api/checkout/route.ts
  Reading src/lib/session.ts
  Grep  "process.env" (28 matches across 9 files)
  Reading src/app/api/checkout/route.ts:40-96

  I found one issue that matters and two that don't. Filing the one.

[tool]   ship_studio_report
           severity: critical
           title:    Checkout route reads the session cookie without verifying it
           files:    src/app/api/checkout/route.ts:52
           → wrote .shipstudio/inbox/2026-09-03T0912-security-sweep-a3f1.md

[done]   1 finding · 41.2s · 18.4k tokens`;

const CODEX_TRANSCRIPT = `$ codex exec --sandbox read-only \\
    --cd /Users/you/ShipStudio/client-atlas
  "$(cat .shipstudio/routines/dependency-drift.md)"

[scope]  package.json + pnpm-lock.yaml unchanged since last run
         advisory database refreshed 6 minutes ago

  Running pnpm audit --json
  Running pnpm outdated --json
  Reading package.json

  2 advisories, 1 above the warning floor. 6 majors behind, 1 with a
  migration worth flagging.

[tool]   ship_studio_report  (severity: warning)  → esbuild advisory
[tool]   ship_studio_report  (severity: info)     → react-router v7 migration

[done]   2 findings · 1m 8s · 22.9k tokens`;

const RESEARCH_TRANSCRIPT = `$ claude --print --output-format stream-json \\
    --permission-mode plan \\
    --mcp-config /tmp/shipstudio-inbox-8f21.json
  cwd /Users/you/ShipStudio/hexa-storefront

[memory] last run 7 days ago — 4 posts already reported, titles supplied

  WebFetch  https://linear.app/blog
  WebFetch  https://vercel.com/blog
  WebFetch  https://railway.com/changelog

  9 posts since the last run, 4 already reported. Of the 5 new ones, 2 are
  relevant to what this project is doing.

[tool]   ship_studio_report  (severity: info)  → weekly competitor digest

[done]   1 finding · 2m 4s · 31.7k tokens`;

const FAILED_TRANSCRIPT = `$ claude --print --output-format stream-json \\
    --permission-mode plan
  cwd /Users/you/ShipStudio/portfolio-v3

[scope]  diff 9ab3f01..HEAD — 2 files changed

  Reading src/content/config.ts

[error]  run exceeded its 5 minute timeout and was terminated
         partial output discarded — nothing filed

[done]   0 findings · 5m 0s · 12.1k tokens`;

/** Fixture routines. */
export const FIXTURE_ROUTINES: Routine[] = [
  {
    id: 'security-sweep',
    name: 'Security sweep',
    description: 'Reviews each new diff for secrets, auth gaps, and unsafe input handling.',
    agentId: 'claude-code',
    scope: {
      kind: 'project',
      projectName: 'hexa-storefront',
      projectPath: '~/ShipStudio/hexa-storefront',
    },
    trigger: { kind: 'interval', everyMinutes: 30 },
    permission: 'read-only',
    severityFloor: 'warning',
    notify: true,
    autoRun: true,
    host: 'app',
    filePath: 'hexa-storefront/.shipstudio/routines/security-sweep.md',
    nextRunAt: NOW + 12 * MINUTE,
    prompt: `Review everything that changed since your last run for security regressions: secrets committed to source, unvalidated user input reaching the filesystem or a shell, auth checks removed from a route, dependencies pulled in from an unfamiliar registry.

Report each finding with ship_studio_report. Include the exact file and line. If nothing is wrong, report nothing — do not file an "all clear".`,
    runs: [
      {
        id: 'run-sec-3',
        startedAt: NOW - 18 * MINUTE,
        durationMs: 41_200,
        status: 'findings',
        findings: 1,
        tokens: 18_400,
        transcript: CLAUDE_TRANSCRIPT,
      },
      {
        id: 'run-sec-2',
        startedAt: NOW - 48 * MINUTE,
        durationMs: 22_800,
        status: 'ok',
        findings: 0,
        tokens: 9_100,
        transcript: CLAUDE_TRANSCRIPT,
      },
      {
        id: 'run-sec-1',
        startedAt: NOW - 78 * MINUTE,
        durationMs: 26_400,
        status: 'ok',
        findings: 0,
        tokens: 8_700,
        transcript: CLAUDE_TRANSCRIPT,
      },
    ],
  },
  {
    id: 'dependency-drift',
    name: 'Dependency drift',
    description: 'Daily advisory check plus a read on which majors are worth taking.',
    agentId: 'codex',
    scope: { kind: 'all-projects' },
    trigger: { kind: 'daily', atHour: 9, atMinute: 0 },
    permission: 'read-only',
    severityFloor: 'info',
    notify: false,
    autoRun: true,
    host: 'background',
    filePath: '~/ShipStudio/.shipstudio/routines/dependency-drift.md',
    nextRunAt: NOW + 19 * HOUR,
    prompt: `Run the project's audit and outdated commands. For each advisory above "low", tell me whether the vulnerable path is actually reachable from this codebase — I don't want noise about a transitive dev dependency I never call.

For major versions we're behind on, give me a one-line read on whether the migration is worth doing now, later, or never.`,
    runs: [
      {
        id: 'run-dep-2',
        startedAt: NOW - 5 * HOUR,
        durationMs: 68_000,
        status: 'findings',
        findings: 2,
        tokens: 22_900,
        transcript: CODEX_TRANSCRIPT,
      },
      {
        id: 'run-dep-1',
        startedAt: NOW - 29 * HOUR,
        durationMs: 71_500,
        status: 'ok',
        findings: 0,
        tokens: 21_300,
        transcript: CODEX_TRANSCRIPT,
      },
    ],
  },
  {
    id: 'competitor-watch',
    name: 'Competitor watch',
    description: 'Reads three competitors’ blogs and changelogs, reports what is new.',
    agentId: 'claude-code',
    scope: {
      kind: 'project',
      projectName: 'hexa-storefront',
      projectPath: '~/ShipStudio/hexa-storefront',
    },
    trigger: { kind: 'manual' },
    permission: 'read-only',
    severityFloor: 'info',
    notify: false,
    autoRun: false,
    host: 'app',
    filePath: 'hexa-storefront/.shipstudio/routines/competitor-watch.md',
    nextRunAt: null,
    prompt: `Read the blog and changelog of linear.app, vercel.com and railway.com.

Report anything published since your last run that changes what we should be building. Skip launch posts for things we don't compete with, skip hiring posts, and skip anything you've already told me about.

Group the digest by theme, not by company, and end with one paragraph on what it means for this project specifically.`,
    runs: [
      {
        id: 'run-comp-1',
        startedAt: NOW - 4 * DAY,
        durationMs: 124_000,
        status: 'findings',
        findings: 1,
        tokens: 31_700,
        transcript: RESEARCH_TRANSCRIPT,
      },
    ],
  },
  {
    id: 'design-drift',
    name: 'Design-system drift',
    description: 'Checks each push for raw hex, off-scale spacing, and hand-rolled primitives.',
    agentId: 'claude-code',
    scope: {
      kind: 'project',
      projectName: 'client-atlas',
      projectPath: '~/ShipStudio/client-atlas',
    },
    trigger: { kind: 'event', event: 'push' },
    permission: 'read-only',
    severityFloor: 'warning',
    notify: false,
    autoRun: true,
    host: 'app',
    filePath: 'client-atlas/.shipstudio/routines/design-drift.md',
    nextRunAt: null,
    prompt: `Read CLAUDE.md and the design-system docs first, then review the pushed diff for drift: raw hex colours, off-scale spacing, a hand-rolled component where a primitive exists, a new button class.

Only report things the docs actually forbid. If you're unsure whether something is a rule or a preference, don't file it.`,
    runs: [
      {
        id: 'run-design-1',
        startedAt: NOW - 6 * HOUR,
        durationMs: 33_100,
        status: 'findings',
        findings: 1,
        tokens: 14_200,
        transcript: CLAUDE_TRANSCRIPT,
      },
    ],
  },
  {
    id: 'broken-links',
    name: 'Broken links & images',
    description: 'Crawls the running preview and reports anything that 404s.',
    agentId: 'claude-code',
    scope: {
      kind: 'project',
      projectName: 'portfolio-v3',
      projectPath: '~/ShipStudio/portfolio-v3',
    },
    trigger: { kind: 'weekly', weekday: 1, atHour: 18, atMinute: 0 },
    permission: 'read-only',
    severityFloor: 'warning',
    notify: false,
    autoRun: false,
    host: 'app',
    filePath: 'portfolio-v3/.shipstudio/routines/broken-links.md',
    nextRunAt: null,
    prompt: `Crawl every page of the running dev server. Report links that 404, images that fail to load, and any page that throws in the console on first paint.

Use the Ship Studio preview bridge rather than starting your own browser.`,
    runs: [
      {
        id: 'run-links-1',
        startedAt: NOW - 2 * DAY,
        durationMs: 300_000,
        status: 'failed',
        findings: 0,
        tokens: 12_100,
        transcript: FAILED_TRANSCRIPT,
      },
    ],
  },
];

const SECRET_BODY = `The checkout route trusts \`session\` straight off the cookie jar and never
calls \`verifySession()\`. Anyone can mint a cookie with an arbitrary \`userId\`
and complete a checkout as another customer.

\`\`\`ts
// src/app/api/checkout/route.ts:52
const session = JSON.parse(cookies().get('session')?.value ?? '{}');
const cart = await getCart(session.userId);   // ← unverified
\`\`\`

Every other route in \`src/app/api\` goes through \`requireSession()\` from
\`src/lib/session.ts\`. This one was added in \`4c19aa2\` and skipped it — most
likely because it started life as a public preview endpoint.

**The fix is one line:** replace the manual parse with \`await requireSession()\`,
which throws a 401 and already handles the refresh-token path.

I checked the other two routes added in the same commit — \`/api/quote\` and
\`/api/ship-estimate\` — and both call \`requireSession()\` correctly.`;

const ESBUILD_BODY = `\`esbuild@0.19.11\` is pulled in transitively by \`vite@5\` and has a moderate
advisory (GHSA-67mh-4wv8-2f99): the dev server responds to any origin, so a
malicious page can read your source while \`pnpm dev\` is running.

**It is reachable here** — you run the dev server daily, and Ship Studio's
preview proxy doesn't isolate it.

\`\`\`
pnpm up vite@latest        # pulls esbuild 0.25.x, patched
\`\`\`

Vite 5.4.x → 6.x is not required; the patched esbuild is available on the 5.x
line. I checked your \`vite.config.ts\` for plugins that pin esbuild and found
none, so this should be a clean bump.

The other advisory (\`tmp\`, low) is only reachable from a build-time codegen
script you don't run in CI. Not worth acting on.`;

const REACT_ROUTER_BODY = `You are 1 major behind on \`react-router\` (6.28 → 7.9).

**My read: take it, but not this week.** v7 merges Remix into React Router, and
the codemod handles the import rewrites cleanly. The part that won't codemod is
your three \`useMatches()\` call sites in \`src/routes/breadcrumbs.tsx\`, which
depend on the v6 handle shape.

Realistically half a day. There's nothing in v7 you currently need, so this is
maintenance, not a blocker — worth scheduling once the checkout work lands.

Everything else is patch-level and safe to take together:

| Package | Current | Latest |
|---|---|---|
| \`zod\` | 3.23.8 | 3.24.1 |
| \`@tanstack/react-query\` | 5.51.1 | 5.59.0 |
| \`tailwindcss\` | 3.4.9 | 3.4.14 |`;

const DIGEST_BODY = `Three things worth your attention this week, grouped by what they mean rather
than who shipped them.

### Everyone is converging on agent-native surfaces

Linear shipped agent sessions as a first-class object in their API, and Vercel's
changelog added a "background tasks" primitive. Both are the same bet: the unit
of work is no longer a request, it's a long-running job you check back on.

### Pricing is moving to usage, quietly

Railway's changelog buried a switch to per-second billing on build minutes.
Vercel did something similar with Fluid compute last quarter. Nobody is
announcing it loudly, which usually means it's working.

### Nothing happened in the storefront space

Two of the three published only hiring and conference posts. I skipped four
posts you'd already seen.

**What this means for hexa-storefront:** the background-task primitive is
directly relevant — your order-sync cron is currently a Vercel cron hitting an
API route, and the new primitive would let it run past the 60s ceiling you hit
last month. Worth 20 minutes of reading.`;

const DESIGN_BODY = `The push adds \`src/components/reports/ReportCard.tsx\`, which hand-rolls a
spinner and a button instead of using the primitives:

\`\`\`tsx
// src/components/reports/ReportCard.tsx:38
<div className="report-spinner" />                      // → <Spinner size="sm" />
<button className="report-refresh-btn">Refresh</button>  // → <Button variant="secondary">
\`\`\`

\`report-spinner\` is the fourth copy of the \`border-top-color\` + \`spin\`
pattern in this repo. \`CLAUDE.md\` names this one explicitly.

Two raw colours in \`src/styles/features/reports.css\`:

\`\`\`css
color: #f59e0b;              /* line 24 → var(--accent-warning) */
background: #1a1a1a;         /* line 31 → var(--surface-panel) */
\`\`\`

I did **not** file the \`gap: 13px\` on line 44 — it's off-scale, but the docs
call off-scale spacing migration debt rather than a rule, so it's your call.`;

const THUMBNAIL_BODY = `\`public/og-default.png\` is 4.1 MB and is served on every page as the Open
Graph image. It's a 3200×1680 PNG of what appears to be a screenshot.

At the size it's actually consumed (1200×630, and social scrapers re-encode
anyway) a WebP would be roughly 90 KB.

This isn't urgent — OG images aren't on the critical render path — but it is
4 MB of your repo and it grew by 3.8 MB in \`0e5e254\`.`;

/** Fixture inbox items. */
export const FIXTURE_INBOX: InboxItem[] = [
  {
    id: 'inbox-1',
    routineId: 'security-sweep',
    routineName: 'Security sweep',
    projectName: 'hexa-storefront',
    projectPath: '~/ShipStudio/hexa-storefront',
    severity: 'critical',
    title: 'Checkout route reads the session cookie without verifying it',
    summary: 'Any client can set a userId and check out as another customer.',
    bodyMd: SECRET_BODY,
    createdAt: NOW - 18 * MINUTE,
    read: false,
    archived: false,
    fingerprint: 'a3f1c9',
    occurrences: 1,
    firstSeenAt: NOW - 18 * MINUTE,
    locations: [
      { path: 'src/app/api/checkout/route.ts', line: 52, note: 'unverified session read' },
      { path: 'src/lib/session.ts', line: 14, note: 'requireSession() lives here' },
    ],
    suggestedPrompt:
      'The Security sweep routine found that src/app/api/checkout/route.ts:52 parses the session cookie directly instead of calling requireSession() from src/lib/session.ts. Replace it with the verified path, keep the existing 401 behaviour, and check nothing else in this commit skipped the same guard.',
    runId: 'run-sec-3',
  },
  {
    id: 'inbox-2',
    routineId: 'dependency-drift',
    routineName: 'Dependency drift',
    projectName: 'client-atlas',
    projectPath: '~/ShipStudio/client-atlas',
    severity: 'warning',
    title: 'esbuild advisory is reachable through your dev server',
    summary: 'GHSA-67mh-4wv8-2f99 — patched by bumping vite on the 5.x line.',
    bodyMd: ESBUILD_BODY,
    createdAt: NOW - 5 * HOUR,
    read: false,
    archived: false,
    fingerprint: 'b7e204',
    occurrences: 3,
    firstSeenAt: NOW - 3 * DAY,
    locations: [{ path: 'package.json', line: 31, note: 'vite ^5.4.2' }],
    suggestedPrompt:
      'Bump vite to the latest 5.x so the patched esbuild (0.25.x) comes along, then run the build and the test suite and tell me if anything broke.',
    runId: 'run-dep-2',
  },
  {
    id: 'inbox-3',
    routineId: 'design-drift',
    routineName: 'Design-system drift',
    projectName: 'client-atlas',
    projectPath: '~/ShipStudio/client-atlas',
    severity: 'warning',
    title: 'New ReportCard hand-rolls a spinner and a button',
    summary: 'Fourth copy of the spinner pattern; two raw hex colours alongside it.',
    bodyMd: DESIGN_BODY,
    createdAt: NOW - 6 * HOUR,
    read: false,
    archived: false,
    fingerprint: 'c1d883',
    occurrences: 1,
    firstSeenAt: NOW - 6 * HOUR,
    locations: [
      { path: 'src/components/reports/ReportCard.tsx', line: 38 },
      { path: 'src/styles/features/reports.css', line: 24 },
    ],
    suggestedPrompt:
      'In src/components/reports/ReportCard.tsx replace the hand-rolled .report-spinner with <Spinner size="sm" /> and .report-refresh-btn with <Button variant="secondary">, then swap the two raw hex values in src/styles/features/reports.css for the matching tokens. Leave the gap: 13px alone.',
    runId: 'run-design-1',
  },
  {
    id: 'inbox-4',
    routineId: 'competitor-watch',
    routineName: 'Competitor watch',
    projectName: 'hexa-storefront',
    projectPath: '~/ShipStudio/hexa-storefront',
    severity: 'info',
    title: 'Weekly digest — background tasks, quiet pricing shifts',
    summary: 'Vercel’s new background primitive solves your order-sync timeout.',
    bodyMd: DIGEST_BODY,
    createdAt: NOW - 4 * DAY,
    read: true,
    archived: false,
    fingerprint: 'd4a017',
    occurrences: 1,
    firstSeenAt: NOW - 4 * DAY,
    locations: [],
    suggestedPrompt:
      'Look at src/app/api/cron/order-sync and tell me what it would take to move it onto a background task primitive instead of a cron-triggered route, given it currently hits the 60s ceiling.',
    runId: 'run-comp-1',
  },
  {
    id: 'inbox-5',
    routineId: 'dependency-drift',
    routineName: 'Dependency drift',
    projectName: 'client-atlas',
    projectPath: '~/ShipStudio/client-atlas',
    severity: 'info',
    title: 'react-router v7 is worth taking, but not this week',
    summary: 'Codemod handles most of it; three useMatches() call sites will not.',
    bodyMd: REACT_ROUTER_BODY,
    createdAt: NOW - 5 * HOUR,
    read: true,
    archived: false,
    fingerprint: 'e90b45',
    occurrences: 2,
    firstSeenAt: NOW - 29 * HOUR,
    locations: [{ path: 'src/routes/breadcrumbs.tsx', line: 22 }],
    suggestedPrompt:
      'Walk me through what the react-router v6 → v7 migration would touch in this project, paying particular attention to the useMatches() call sites in src/routes/breadcrumbs.tsx. Do not change anything yet.',
    runId: 'run-dep-2',
  },
  {
    id: 'inbox-6',
    routineId: 'security-sweep',
    routineName: 'Security sweep',
    projectName: 'hexa-storefront',
    projectPath: '~/ShipStudio/hexa-storefront',
    severity: 'info',
    title: 'og-default.png is 4.1 MB',
    summary: 'A 3200×1680 PNG shipped as the Open Graph image on every page.',
    bodyMd: THUMBNAIL_BODY,
    createdAt: NOW - 2 * DAY,
    read: true,
    archived: false,
    fingerprint: 'f22a68',
    occurrences: 1,
    firstSeenAt: NOW - 2 * DAY,
    locations: [{ path: 'public/og-default.png' }],
    suggestedPrompt:
      'Convert public/og-default.png to a 1200×630 WebP, update whatever references it in the metadata config, and delete the original.',
    runId: 'run-sec-1',
  },
];

/** Starter routines offered in the "New routine" flow. */
export const ROUTINE_TEMPLATES: RoutineTemplate[] = [
  {
    id: 'tpl-security',
    name: 'Security sweep',
    description: 'Reviews each new diff for secrets, auth gaps, and unsafe input.',
    category: 'Security',
    trigger: { kind: 'interval', everyMinutes: 30 },
    permission: 'read-only',
    scopeKind: 'project',
    prompt: `Review everything that changed since your last run for security regressions: secrets committed to source, unvalidated user input reaching the filesystem or a shell, auth checks removed from a route, dependencies from an unfamiliar registry.

Report each finding with ship_studio_report. Include the exact file and line. If nothing is wrong, report nothing — do not file an "all clear".`,
  },
  {
    id: 'tpl-deps',
    name: 'Dependency drift',
    description: 'Daily advisory check plus a read on which majors are worth taking.',
    category: 'Maintenance',
    trigger: { kind: 'daily', atHour: 9, atMinute: 0 },
    permission: 'read-only',
    scopeKind: 'all-projects',
    prompt: `Run the project's audit and outdated commands. For each advisory above "low", tell me whether the vulnerable path is actually reachable from this codebase. For majors we're behind on, give me a one-line read on whether the migration is worth doing now, later, or never.`,
  },
  {
    id: 'tpl-competitors',
    name: 'Competitor watch',
    description: 'Reads competitor blogs and changelogs, reports what changed.',
    category: 'Research',
    trigger: { kind: 'manual' },
    permission: 'read-only',
    scopeKind: 'project',
    prompt: `Read the blog and changelog of <competitor 1>, <competitor 2> and <competitor 3>.

Report anything published since your last run that changes what we should be building. Skip launch posts for things we don't compete with, skip hiring posts, and skip anything you've already told me about. End with one paragraph on what it means for this project specifically.`,
  },
  {
    id: 'tpl-design',
    name: 'Design-system drift',
    description: 'Checks each push against the repo’s own design rules.',
    category: 'Quality',
    trigger: { kind: 'event', event: 'push' },
    permission: 'read-only',
    scopeKind: 'project',
    prompt: `Read CLAUDE.md and the design-system docs first, then review the pushed diff for drift: raw hex colours, off-scale spacing, a hand-rolled component where a primitive exists, a new button class.

Only report things the docs actually forbid.`,
  },
  {
    id: 'tpl-pr',
    name: 'PR review pass',
    description: 'Reviews every PR you open before a human sees it.',
    category: 'Quality',
    trigger: { kind: 'event', event: 'pr-opened' },
    permission: 'read-only',
    scopeKind: 'all-projects',
    prompt: `Review the PR diff for correctness bugs only — not style, not naming.

For each finding, give me the concrete inputs that produce the wrong output. If you can't describe a failure, don't file it.`,
  },
  {
    id: 'tpl-links',
    name: 'Broken links & images',
    description: 'Crawls the running preview and reports anything that 404s.',
    category: 'Quality',
    trigger: { kind: 'daily', atHour: 18, atMinute: 0 },
    permission: 'read-only',
    scopeKind: 'project',
    prompt: `Crawl every page of the running dev server. Report links that 404, images that fail to load, and any page that throws in the console on first paint.

Use the Ship Studio preview bridge rather than starting your own browser.`,
  },
  {
    id: 'tpl-blank',
    name: 'Blank routine',
    description: 'Start from an empty prompt.',
    category: 'Quality',
    trigger: { kind: 'manual' },
    permission: 'read-only',
    scopeKind: 'project',
    prompt: '',
  },
];
