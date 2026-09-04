/**
 * Routines & Inbox — types and formatting.
 *
 * Every type here mirrors a Rust type in `src-tauri/src/commands/routines/`,
 * field for field, so backend payloads deserialize without a translation
 * layer. The store that talks to those commands is `./routinesStore`.
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
 * Non-time triggers, all of which Ship Studio already observes. These are the
 * best fit for the model: they fire during work, which is exactly when the app
 * is open.
 */
export type RoutineEvent = 'push' | 'pr-opened';

/**
 * What sets a routine off.
 *
 * Pressing Run is the default and always works. Everything else is an opt-in on
 * top of it, and everything else fires **only while Ship Studio is running** —
 * a routine is the user's own agent CLI on the user's own machine, so there is
 * no server to keep a clock. {@link describeTriggerReality} is the single place
 * that sentence is written, and every trigger control shows it.
 */
export type RoutineTrigger =
  | { kind: 'manual' }
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'daily'; atHour: number; atMinute: number }
  | { kind: 'weekly'; weekday: number; atHour: number; atMinute: number }
  | { kind: 'event'; event: RoutineEvent };

/** One recorded execution of a routine. */
export interface RoutineRun {
  id: string;
  routineId: string;
  startedAt: number;
  durationMs: number;
  status: RunStatus;
  /** Findings filed to the inbox by this run. */
  findings: number;
  /**
   * Tokens billed to the user's own agent subscription, or null when the CLI
   * doesn't report them (Codex `exec` doesn't). Null renders as "—"; a guessed
   * number would defeat the point of showing it at all.
   */
  tokens: number | null;
  /** Why it failed. Null for a run that completed. */
  error: string | null;
  /** Trimmed tail of the agent's reply. */
  transcript: string;
}

/**
 * A standing instruction. On disk this is one markdown file with frontmatter
 * under `<project>/.shipstudio/routines/`.
 */
export interface Routine {
  /** `<projectPath>::<slug>`. */
  id: string;
  /** Filename stem, and the routine's identity within its project. */
  slug: string;
  name: string;
  description: string;
  /** Null means "whatever the user's default agent is". */
  agentId: string | null;
  projectPath: string;
  projectName: string;
  trigger: RoutineTrigger;
  permission: RoutinePermission;
  /** The user-authored body of the routine file. */
  prompt: string;
  /** Findings below this level are dropped rather than filed. */
  severityFloor: Severity;
  /**
   * Whether the trigger is armed. Irrelevant for a manual routine, which is
   * always runnable from its Run button — pressing Run is the whole trigger.
   */
  autoRun: boolean;
  /** Absolute path of the markdown file this routine lives in. */
  filePath: string;
  /** When the trigger next comes due. Null for manual, event, and disarmed. */
  nextRunAt: number | null;
  isRunning: boolean;
  /** When the in-flight run started, for elapsed time. Null when idle. */
  runningSince: number | null;
  runs: RoutineRun[];
}

/** Everything a save may change. Identity fields are not editable. */
export interface RoutineDraft {
  name: string;
  description: string;
  agentId: string | null;
  trigger: RoutineTrigger;
  permission: RoutinePermission;
  prompt: string;
  severityFloor: Severity;
  autoRun: boolean;
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
  /** Stable identity across runs — a repeat bumps `occurrences`. */
  fingerprint: string;
  occurrences: number;
  firstSeenAt: number;
  locations: FindingLocation[];
  /** What "Fix with agent" types into a terminal tab. */
  suggestedPrompt: string;
  runId: string;
}

/** A starter routine offered when creating a new one. */
export interface RoutineTemplate {
  id: string;
  name: string;
  description: string;
  category: 'Quality' | 'Security' | 'Maintenance' | 'Research';
  trigger: RoutineTrigger;
  permission: RoutinePermission;
  prompt: string;
}

/* -------------------------------------------------------------- formatting */

const EVENT_LABELS: Record<RoutineEvent, string> = {
  push: 'After every push',
  'pr-opened': 'When a PR opens',
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

/**
 * The frontmatter phrase for a trigger — the exact string written to the
 * routine file, and the one documented in the agent skill.
 *
 * Mirrors `RoutineTrigger::to_phrase` in Rust. Shown in the editor so what you
 * configured and what an agent would write are visibly the same thing.
 */
export function triggerPhrase(trigger: RoutineTrigger): string {
  switch (trigger.kind) {
    case 'manual':
      return 'manual';
    case 'interval':
      return trigger.everyMinutes % 60 === 0 && trigger.everyMinutes >= 60
        ? `every ${trigger.everyMinutes / 60}h`
        : `every ${trigger.everyMinutes}m`;
    case 'daily':
      return `daily at ${pad(trigger.atHour)}:${pad(trigger.atMinute)}`;
    case 'weekly':
      return `weekly on ${WEEKDAYS[trigger.weekday].toLowerCase()} at ${pad(trigger.atHour)}:${pad(trigger.atMinute)}`;
    case 'event':
      return trigger.event === 'pr-opened' ? 'on pr' : `on ${trigger.event}`;
  }
}

/** Whether a trigger is a clock/interval one at all (vs manual or an event). */
export function isTimeTrigger(trigger: RoutineTrigger): boolean {
  return trigger.kind === 'interval' || trigger.kind === 'daily' || trigger.kind === 'weekly';
}

/**
 * The list-row schedule line: what fires it, and — the part that actually
 * matters — the fact that it only fires while the app is open.
 *
 * A disarmed routine must not advertise a cadence it is not keeping.
 */
export function describeSchedule(routine: Pick<Routine, 'trigger' | 'autoRun'>): string {
  const { trigger } = routine;
  if (trigger.kind === 'manual') return 'Manual — runs when you press Run';
  if (!routine.autoRun) return `${formatTrigger(trigger)} — auto-run off`;
  return `${formatTrigger(trigger)}, while Ship Studio is open`;
}

/**
 * The honest sentence about when a trigger can actually fire.
 *
 * Routines are the user's own agent CLI on the user's own machine. There is no
 * Ship Studio server, so nothing fires while the app is closed, and every one
 * of these sentences says so plainly rather than implying a clock we don't
 * keep.
 */
export function describeTriggerReality(trigger: RoutineTrigger): string {
  switch (trigger.kind) {
    case 'manual':
      return 'Runs only when you press Run. Nothing happens on its own.';
    case 'event':
      return 'Fires when Ship Studio sees the event, which is while you are working in it. Events that happen elsewhere are not replayed.';
    case 'interval':
      return 'Not a clock — a minimum gap. While Ship Studio is open it checks whether that long has passed since the last run, and runs if it has. Close the app for a day and it runs once when you reopen, never a backlog.';
    case 'daily':
    case 'weekly':
      return 'Ship Studio checks this while it is open. If the app is closed at that time the run is simply late — it happens at the next check after you reopen, once, not once per day missed.';
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

/**
 * How long an in-flight run has been going, e.g. "1m 12s".
 *
 * `now` defaults inside the function rather than being read in a component's
 * render — the purity lint (rightly) rejects `Date.now()` in render.
 */
export function formatElapsed(since: number, now = Date.now()): string {
  return formatDuration(Math.max(0, now - since));
}

/** Run duration as "1.4s" / "48s" / "2m 10s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * Token counts read better rounded: 18400 → "18.4k".
 *
 * Null means the agent CLI didn't report usage, and renders as an em dash —
 * never as zero, which would read as a free run.
 */
export function formatTokens(tokens: number | null): string {
  if (tokens === null) return '—';
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(1)}k`;
}

/** Rolling seven-day rollup for the Routines summary strip. */
export function summarizeWeek(routines: Routine[]): {
  runs: number;
  findings: number;
  tokens: number | null;
} {
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const runs = routines.flatMap((routine) => routine.runs.filter((run) => run.startedAt >= since));
  const counted = runs.filter((run) => run.tokens !== null);
  return {
    runs: runs.length,
    findings: runs.reduce((total, run) => total + run.findings, 0),
    // All-null (e.g. every routine is on Codex) means we genuinely don't know,
    // which must not render as a confident "0".
    tokens:
      counted.length === 0 ? null : counted.reduce((total, run) => total + (run.tokens ?? 0), 0),
  };
}

const AGENTS: AgentConfig[] = [CLAUDE_CODE, CODEX, OPENCODE];

/** Agent config for a routine, falling back to Claude Code. */
export function agentForRoutine(agentId: string | null): AgentConfig {
  return AGENTS.find((agent) => agent.id === agentId) ?? CLAUDE_CODE;
}

/**
 * The literal command a run executes.
 *
 * Shown verbatim in the routine editor. The point of the feature is that
 * there's no hidden orchestration, so the user should be able to read the
 * command, paste it into their own terminal, and get the same thing. It must
 * therefore stay in lockstep with `invoke_agent` in
 * `src-tauri/src/commands/routines/runs.rs` — a preview that drifts from what
 * actually runs is worse than no preview at all.
 */
export function buildCommandPreview(routine: Pick<Routine, 'agentId' | 'permission'>): string {
  const agent = agentForRoutine(routine.agentId);
  if (agent.id === 'codex') {
    const sandbox = routine.permission === 'read-only' ? 'read-only' : 'workspace-write';
    return [
      `${agent.binaryName} exec --skip-git-repo-check --color never \\`,
      `  --sandbox ${sandbox} \\`,
      `  --output-last-message <tmp> -  < <prompt>`,
    ].join('\n');
  }
  const mode = routine.permission === 'read-only' ? 'plan' : 'acceptEdits';
  return [
    `${agent.binaryName} --print --output-format json \\`,
    `  --permission-mode ${mode}  < <prompt>`,
  ].join('\n');
}

/** Starter routines offered in the "New routine" flow. */
export const ROUTINE_TEMPLATES: RoutineTemplate[] = [
  {
    id: 'tpl-security',
    name: 'Security sweep',
    description: 'Reviews each new diff for secrets, auth gaps, and unsafe input.',
    category: 'Security',
    trigger: { kind: 'interval', everyMinutes: 30 },
    permission: 'read-only',
    prompt: `Review everything that changed since your last run for security regressions: secrets committed to source, unvalidated user input reaching the filesystem or a shell, auth checks removed from a route, dependencies from an unfamiliar registry.

Include the exact file and line for each finding. Ignore test fixtures.`,
  },
  {
    id: 'tpl-deps',
    name: 'Dependency drift',
    description: 'Daily advisory check plus a read on which majors are worth taking.',
    category: 'Maintenance',
    trigger: { kind: 'daily', atHour: 9, atMinute: 0 },
    permission: 'read-only',
    prompt: `Run the project's audit and outdated commands. For each advisory above "low", tell me whether the vulnerable path is actually reachable from this codebase. For majors we're behind on, give me a one-line read on whether the migration is worth doing now, later, or never.

Ignore dev-only packages unless the advisory is remotely exploitable.`,
  },
  {
    id: 'tpl-competitors',
    name: 'Competitor watch',
    description: 'Reads competitor blogs and changelogs, reports what changed.',
    category: 'Research',
    trigger: { kind: 'manual' },
    permission: 'read-only',
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
    prompt: `Review the PR diff for correctness bugs only — not style, not naming.

For each finding, give me the concrete inputs that produce the wrong output. If you can't describe a failure, don't file it.`,
  },
  {
    id: 'tpl-links',
    name: 'Broken links & images',
    description: 'Crawls the running preview. Needs the project open with its dev server up.',
    category: 'Quality',
    trigger: { kind: 'manual' },
    permission: 'read-only',
    prompt: `Crawl the pages of this project's running dev-server preview. Report links that 404, images that fail to load, and any page that throws in the console on first paint.

If no preview is running, report nothing and stop. Do not start a server yourself.`,
  },
  {
    id: 'tpl-blank',
    name: 'Blank routine',
    description: 'Start from an empty prompt.',
    category: 'Quality',
    trigger: { kind: 'manual' },
    permission: 'read-only',
    prompt: '',
  },
];
