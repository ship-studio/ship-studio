import { describe, expect, it } from 'vitest';
import {
  buildCommandPreview,
  describeSchedule,
  describeTriggerReality,
  formatAge,
  formatAgo,
  formatCountdown,
  formatDuration,
  formatTokens,
  formatTrigger,
  isTimeTrigger,
  summarizeWeek,
  triggerPhrase,
  type Workflow,
  type WorkflowRun,
  type WorkflowTrigger,
} from './workflows';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    workflowId: 'r1',
    startedAt: Date.now(),
    durationMs: 1000,
    status: 'ok',
    findings: 0,
    tokens: null,
    error: null,
    transcript: '',
    ...overrides,
  };
}

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: '/p::r',
    slug: 'r',
    name: 'R',
    icon: null,
    description: '',
    agentId: null,
    projectPath: '/p',
    projectName: 'p',
    trigger: { kind: 'manual' },
    permission: 'read-only',
    prompt: 'do a thing',
    severityFloor: 'info',
    autoRun: true,
    filePath: '/p/.shipstudio/workflows/r.md',
    updatedAt: null,
    nextRunAt: null,
    isRunning: false,
    runningSince: null,
    runs: [],
    ...overrides,
  };
}

describe('formatTrigger', () => {
  it('renders each trigger kind', () => {
    expect(formatTrigger({ kind: 'manual' })).toBe('Manual');
    expect(formatTrigger({ kind: 'interval', everyMinutes: 30 })).toBe('Every 30 min');
    expect(formatTrigger({ kind: 'interval', everyMinutes: 60 })).toBe('Every hour');
    expect(formatTrigger({ kind: 'interval', everyMinutes: 120 })).toBe('Every 2 hours');
    expect(formatTrigger({ kind: 'daily', atHour: 9, atMinute: 0 })).toBe('Daily at 09:00');
    expect(formatTrigger({ kind: 'weekly', weekday: 1, atHour: 18, atMinute: 30 })).toBe(
      'Mondays at 18:30'
    );
    expect(formatTrigger({ kind: 'event', event: 'push' })).toBe('After every push');
  });
});

describe('triggerPhrase', () => {
  // These strings are written into the workflow file and documented in the
  // bundled agent skill, so they are a contract with the Rust parser.
  it('produces the frontmatter grammar', () => {
    expect(triggerPhrase({ kind: 'manual' })).toBe('manual');
    expect(triggerPhrase({ kind: 'interval', everyMinutes: 30 })).toBe('every 30m');
    expect(triggerPhrase({ kind: 'interval', everyMinutes: 120 })).toBe('every 2h');
    expect(triggerPhrase({ kind: 'daily', atHour: 9, atMinute: 5 })).toBe('daily at 09:05');
    expect(triggerPhrase({ kind: 'weekly', weekday: 1, atHour: 10, atMinute: 0 })).toBe(
      'weekly on monday at 10:00'
    );
    expect(triggerPhrase({ kind: 'event', event: 'push' })).toBe('on push');
    expect(triggerPhrase({ kind: 'event', event: 'pr-opened' })).toBe('on pr');
  });
});

describe('describeSchedule', () => {
  it('never advertises a cadence a disarmed workflow is not keeping', () => {
    const trigger: WorkflowTrigger = { kind: 'interval', everyMinutes: 30 };
    expect(describeSchedule({ trigger, autoRun: false })).toBe('Every 30 min — auto-run off');
    expect(describeSchedule({ trigger, autoRun: true })).toBe(
      'Every 30 min, while Ship Studio is open'
    );
  });

  it('describes a manual workflow by its button, not a schedule', () => {
    expect(describeSchedule({ trigger: { kind: 'manual' }, autoRun: true })).toBe(
      'Manual — runs when you press Run'
    );
  });
});

describe('describeTriggerReality', () => {
  it('never promises a run while the app is closed', () => {
    const triggers: WorkflowTrigger[] = [
      { kind: 'manual' },
      { kind: 'interval', everyMinutes: 30 },
      { kind: 'daily', atHour: 9, atMinute: 0 },
      { kind: 'weekly', weekday: 1, atHour: 9, atMinute: 0 },
      { kind: 'event', event: 'push' },
    ];
    for (const trigger of triggers) {
      const sentence = describeTriggerReality(trigger);
      expect(sentence.length).toBeGreaterThan(0);
      expect(sentence).not.toMatch(/even when .*closed|whether or not Ship Studio/i);
    }
  });
});

describe('formatCountdown', () => {
  it('reads as eligibility, not a promise', () => {
    const now = 1_000_000;
    expect(formatCountdown(null, now)).toBeNull();
    expect(formatCountdown(now - 1, now)).toBe('due now');
    expect(formatCountdown(now + 12 * MINUTE, now)).toBe('in 12 min');
    expect(formatCountdown(now + 1 * HOUR, now)).toBe('in 1 hour');
    expect(formatCountdown(now + 5 * HOUR, now)).toBe('in 5 hours');
    expect(formatCountdown(now + 25 * HOUR, now)).toBe('tomorrow');
    expect(formatCountdown(now + 3 * DAY, now)).toBe('in 3 days');
  });
});

describe('formatAge / formatAgo', () => {
  it('never produces "now ago"', () => {
    const now = 1_000_000_000;
    expect(formatAge(now, now)).toBe('now');
    expect(formatAgo(now, now)).toBe('just now');
    expect(formatAgo(now - 18 * MINUTE, now)).toBe('18m ago');
    expect(formatAgo(now - 3 * HOUR, now)).toBe('3h ago');
    expect(formatAgo(now - 2 * DAY, now)).toBe('2d ago');
    expect(formatAgo(now - 14 * DAY, now)).toBe('2w ago');
  });

  it('clamps a clock-skewed future timestamp to "now"', () => {
    const now = 1_000_000_000;
    expect(formatAge(now + 5 * MINUTE, now)).toBe('now');
  });
});

describe('formatDuration', () => {
  it('scales from milliseconds to minutes', () => {
    expect(formatDuration(400)).toBe('400ms');
    expect(formatDuration(1400)).toBe('1s');
    expect(formatDuration(48_000)).toBe('48s');
    expect(formatDuration(130_000)).toBe('2m 10s');
  });
});

describe('formatTokens', () => {
  it('shows an em dash when the CLI reported nothing, never a zero', () => {
    // Codex reports no usage. Rendering that as "0" would read as a free run.
    expect(formatTokens(null)).toBe('—');
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(940)).toBe('940');
    expect(formatTokens(18_400)).toBe('18.4k');
  });
});

describe('summarizeWeek', () => {
  it('counts only the last seven days', () => {
    const now = Date.now();
    const summary = summarizeWeek([
      workflow({
        runs: [
          run({ startedAt: now - 2 * DAY, findings: 2, tokens: 1000 }),
          run({ startedAt: now - 10 * DAY, findings: 5, tokens: 9999 }),
        ],
      }),
    ]);
    expect(summary.runs).toBe(1);
    expect(summary.findings).toBe(2);
    expect(summary.tokens).toBe(1000);
  });

  it('reports unknown token usage as null rather than zero', () => {
    const now = Date.now();
    const summary = summarizeWeek([
      workflow({ runs: [run({ startedAt: now - HOUR, tokens: null })] }),
    ]);
    expect(summary.runs).toBe(1);
    expect(summary.tokens).toBeNull();
  });

  it('sums only the runs that reported usage', () => {
    const now = Date.now();
    const summary = summarizeWeek([
      workflow({
        runs: [
          run({ id: 'a', startedAt: now - HOUR, tokens: 500 }),
          run({ id: 'b', startedAt: now - HOUR, tokens: null }),
        ],
      }),
    ]);
    expect(summary.tokens).toBe(500);
  });
});

describe('isTimeTrigger', () => {
  it('separates clock triggers from manual and events', () => {
    expect(isTimeTrigger({ kind: 'interval', everyMinutes: 30 })).toBe(true);
    expect(isTimeTrigger({ kind: 'daily', atHour: 9, atMinute: 0 })).toBe(true);
    expect(isTimeTrigger({ kind: 'weekly', weekday: 0, atHour: 9, atMinute: 0 })).toBe(true);
    expect(isTimeTrigger({ kind: 'manual' })).toBe(false);
    expect(isTimeTrigger({ kind: 'event', event: 'push' })).toBe(false);
  });
});

describe('buildCommandPreview', () => {
  // The preview is shown as "what actually runs". If it drifts from
  // invoke_agent in runs.rs it is worse than showing nothing.
  it('shows the enforcing flag for each agent and permission', () => {
    expect(buildCommandPreview({ agentId: null, permission: 'read-only' })).toContain(
      '--permission-mode plan'
    );
    expect(buildCommandPreview({ agentId: 'claude-code', permission: 'can-edit' })).toContain(
      '--permission-mode acceptEdits'
    );
    expect(buildCommandPreview({ agentId: 'codex', permission: 'read-only' })).toContain(
      '--sandbox read-only'
    );
    expect(buildCommandPreview({ agentId: 'codex', permission: 'can-edit' })).toContain(
      '--sandbox workspace-write'
    );
  });

  it('falls back to Claude Code for an unknown agent', () => {
    expect(buildCommandPreview({ agentId: 'nonsense', permission: 'read-only' })).toContain(
      'claude'
    );
  });
});
