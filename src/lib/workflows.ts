/**
 * Workflows & Inbox — types and formatting.
 *
 * Every type here mirrors a Rust type in `src-tauri/src/commands/workflows/`,
 * field for field, so backend payloads deserialize without a translation
 * layer. The store that talks to those commands is `./workflowsStore`.
 *
 * @module lib/workflows
 */

import { CLAUDE_CODE, CODEX, OPENCODE, type AgentConfig } from './agent';

/* ------------------------------------------------------------------ types */

/** How severe a finding is. Drives colour, sort order, and delivery floor. */
export type Severity = 'critical' | 'warning' | 'info';

/** Outcome of a single workflow run. */
export type RunStatus = 'ok' | 'findings' | 'failed' | 'running';

/** What a workflow's agent is allowed to do while it runs. */
export type WorkflowPermission = 'read-only' | 'can-edit';

/**
 * Non-time triggers, all of which Ship Studio already observes. These are the
 * best fit for the model: they fire during work, which is exactly when the app
 * is open.
 */
export type WorkflowEvent = 'push' | 'pr-opened';

/**
 * What sets a workflow off.
 *
 * Pressing Run is the default and always works. Everything else is an opt-in on
 * top of it, and everything else fires **only while Ship Studio is running** —
 * a workflow is the user's own agent CLI on the user's own machine, so there is
 * no server to keep a clock. {@link describeTriggerReality} is the single place
 * that sentence is written, and every trigger control shows it.
 */
export type WorkflowTrigger =
  | { kind: 'manual' }
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'daily'; atHour: number; atMinute: number }
  | { kind: 'weekly'; weekday: number; atHour: number; atMinute: number }
  | { kind: 'event'; event: WorkflowEvent };

/** One recorded execution of a workflow. */
export interface WorkflowRun {
  id: string;
  workflowId: string;
  startedAt: number;
  durationMs: number;
  status: RunStatus;
  /** Findings filed to the inbox by this run. */
  findings: number;
  /**
   * Tokens billed to the user's own agent subscription, or null when the CLI
   * doesn't report them (Codex `exec` doesn't). Null renders as "—"; a guessed
   * number would defeat the point of showing it at all.
   *
   * Excludes cached-context reads — see `parse_claude_stream` in
   * `runs.rs` for why counting them made this read ten times too high.
   */
  tokens: number | null;
  /** Why it failed. Null for a run that completed. */
  error: string | null;
  /** Trimmed tail of the agent's reply. */
  transcript: string;
}

/**
 * A standing instruction. On disk this is one markdown file with frontmatter
 * under `<project>/.shipstudio/workflows/`.
 */
export interface Workflow {
  /** `<projectPath>::<slug>`. */
  id: string;
  /** Filename stem, and the workflow's identity within its project. */
  slug: string;
  name: string;
  /** A single emoji standing in for the workflow. Null falls back to a dot. */
  icon: string | null;
  description: string;
  /** Null means "whatever the user's default agent is". */
  agentId: string | null;
  projectPath: string;
  projectName: string;
  trigger: WorkflowTrigger;
  permission: WorkflowPermission;
  /** The user-authored body of the workflow file. */
  prompt: string;
  /** Findings below this level are dropped rather than filed. */
  severityFloor: Severity;
  /**
   * Whether the trigger is armed. Irrelevant for a manual workflow, which is
   * always runnable from its Run button — pressing Run is the whole trigger.
   */
  autoRun: boolean;
  /** Absolute path of the markdown file this workflow lives in. */
  filePath: string;
  /**
   * When the file was last written, in epoch ms. The scheduler treats this as
   * the arming moment, so a schedule saved this afternoon doesn't count this
   * morning's slot as one it missed.
   */
  updatedAt: number | null;
  /** When the trigger next comes due. Null for manual, event, and disarmed. */
  nextRunAt: number | null;
  isRunning: boolean;
  /** When the in-flight run started, for elapsed time. Null when idle. */
  runningSince: number | null;
  runs: WorkflowRun[];
}

/** Everything a save may change. Identity fields are not editable. */
export interface WorkflowDraft {
  name: string;
  icon: string | null;
  description: string;
  agentId: string | null;
  trigger: WorkflowTrigger;
  permission: WorkflowPermission;
  prompt: string;
  severityFloor: Severity;
  autoRun: boolean;
}

/** One line of live activity from a running workflow. */
export interface ProgressLine {
  workflowId: string;
  at: number;
  text: string;
}

/** A file/line the finding points at. */
export interface FindingLocation {
  path: string;
  line?: number;
  note?: string;
}

/** One report filed by a workflow run. */
export interface InboxItem {
  id: string;
  workflowId: string;
  workflowName: string;
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

/* -------------------------------------------------------------- formatting */

const EVENT_LABELS: Record<WorkflowEvent, string> = {
  push: 'After every push',
  'pr-opened': 'When a PR opens',
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

/** Human label for a trigger, e.g. "Every 30 min" or "Daily at 10:00". */
export function formatTrigger(trigger: WorkflowTrigger): string {
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
 * workflow file, and the one documented in the agent skill.
 *
 * Mirrors `WorkflowTrigger::to_phrase` in Rust. Shown in the editor so what you
 * configured and what an agent would write are visibly the same thing.
 */
export function triggerPhrase(trigger: WorkflowTrigger): string {
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
export function isTimeTrigger(trigger: WorkflowTrigger): boolean {
  return trigger.kind === 'interval' || trigger.kind === 'daily' || trigger.kind === 'weekly';
}

/**
 * The list-row schedule line: what fires it, and — the part that actually
 * matters — the fact that it only fires while the app is open.
 *
 * A disarmed workflow must not advertise a cadence it is not keeping.
 */
export function describeSchedule(workflow: Pick<Workflow, 'trigger' | 'autoRun'>): string {
  const { trigger } = workflow;
  if (trigger.kind === 'manual') return 'Manual — runs when you press Run';
  if (!workflow.autoRun) return `${formatTrigger(trigger)} — auto-run off`;
  return `${formatTrigger(trigger)}, while Ship Studio is open`;
}

/**
 * The honest sentence about when a trigger can actually fire.
 *
 * Workflows are the user's own agent CLI on the user's own machine. There is no
 * Ship Studio server, so nothing fires while the app is closed, and every one
 * of these sentences says so plainly rather than implying a clock we don't
 * keep.
 */
export function describeTriggerReality(trigger: WorkflowTrigger): string {
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
 * How long until the workflow is eligible to run again, e.g. "in 12 min".
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

/** Rolling seven-day rollup for the Workflows summary strip. */
export function summarizeWeek(workflows: Workflow[]): {
  runs: number;
  findings: number;
  tokens: number | null;
} {
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const runs = workflows.flatMap((workflow) =>
    workflow.runs.filter((run) => run.startedAt >= since)
  );
  const counted = runs.filter((run) => run.tokens !== null);
  return {
    runs: runs.length,
    findings: runs.reduce((total, run) => total + run.findings, 0),
    // All-null (e.g. every workflow is on Codex) means we genuinely don't know,
    // which must not render as a confident "0".
    tokens:
      counted.length === 0 ? null : counted.reduce((total, run) => total + (run.tokens ?? 0), 0),
  };
}

const AGENTS: AgentConfig[] = [CLAUDE_CODE, CODEX, OPENCODE];

/** Agent config for a workflow, falling back to Claude Code. */
export function agentForWorkflow(agentId: string | null): AgentConfig {
  return AGENTS.find((agent) => agent.id === agentId) ?? CLAUDE_CODE;
}

/**
 * The literal command a run executes.
 *
 * Shown verbatim in the workflow editor. The point of the feature is that
 * there's no hidden orchestration, so the user should be able to read the
 * command, paste it into their own terminal, and get the same thing. It must
 * therefore stay in lockstep with `invoke_agent` in
 * `src-tauri/src/commands/workflows/runs.rs` — a preview that drifts from what
 * actually runs is worse than no preview at all.
 */
export function buildCommandPreview(workflow: Pick<Workflow, 'agentId' | 'permission'>): string {
  const agent = agentForWorkflow(workflow.agentId);
  if (agent.id === 'codex') {
    const sandbox = workflow.permission === 'read-only' ? 'read-only' : 'workspace-write';
    return [
      `${agent.binaryName} exec --skip-git-repo-check --color never \\`,
      `  --sandbox ${sandbox} \\`,
      `  --output-last-message <tmp> -  < <prompt>`,
    ].join('\n');
  }
  const mode = workflow.permission === 'read-only' ? 'plan' : 'acceptEdits';
  return [
    `${agent.binaryName} --print --output-format json \\`,
    `  --permission-mode ${mode}  < <prompt>`,
  ].join('\n');
}

/** Starter workflows offered in the "New workflow" flow. */
