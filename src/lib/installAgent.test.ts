/**
 * The install agent's protocol, tested without a UI.
 *
 * These are the guarantees the flow is built on, and every one of them was
 * previously only checkable by finding a fresh machine and breaking something
 * on it: a declined password doesn't end the session, a failure is always a
 * question, skipping a dependency doesn't leave its dependents to fail with an
 * error nobody can act on, and a finished run reports what it left out.
 *
 * The driver is an async iterable of events, so a test is: script the human,
 * collect the events, assert the sequence. No DOM, no timers to fake beyond
 * the pace, no machine.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  scriptedDriver,
  stepDependents,
  stepRequires,
  baseSteps,
  INSTALL_STEPS,
  type InstallAgentEvent,
  type InstallAgentHost,
  type InstallStepId,
  type RecoveryChoice,
  type UserActionResult,
} from './installAgent';

vi.mock('./agentOnboarding', () => ({
  mockMarkSetupItemReady: vi.fn(() => Promise.resolve()),
}));

vi.mock('./setup', () => ({ isWindows: () => false }));

/**
 * A host that answers on a script.
 *
 * `admin` and `recovery` are queues: each request takes the next answer, and
 * running out is an error rather than a default, so a test can never silently
 * pass because the driver asked something it wasn't supposed to.
 */
function scriptedHost(answers: {
  admin?: UserActionResult[];
  recovery?: RecoveryChoice[];
}): InstallAgentHost & { asked: string[] } {
  const admin = [...(answers.admin ?? [])];
  const recovery = [...(answers.recovery ?? [])];
  const asked: string[] = [];
  return {
    asked,
    requestUser(request) {
      asked.push(`user:${request.kind}`);
      const next = admin.shift();
      if (!next) throw new Error(`unscripted requestUser (${request.kind})`);
      return Promise.resolve(next);
    },
    requestRecovery(failure) {
      asked.push(`recovery:${failure.step}`);
      const next = recovery.shift();
      if (!next) throw new Error(`unscripted requestRecovery (${failure.step})`);
      return Promise.resolve(next);
    },
  };
}

async function collect(
  host: InstallAgentHost,
  steps: InstallStepId[],
  alreadyPresent: InstallStepId[] = []
): Promise<InstallAgentEvent[]> {
  const events: InstallAgentEvent[] = [];
  for await (const event of scriptedDriver.run({ steps, alreadyPresent }, host)) {
    events.push(event);
  }
  return events;
}

const done = (events: InstallAgentEvent[]) =>
  events.find((e): e is Extract<InstallAgentEvent, { type: 'done' }> => e.type === 'done');

const endedOk = (events: InstallAgentEvent[], step: InstallStepId) =>
  events.some((e) => e.type === 'step_end' && e.step === step && e.ok);

beforeEach(() => {
  // Collapse the scripted pauses; these tests are about order, not pacing.
  localStorage.setItem('shipstudio.installAgentPace', '0.001');
  localStorage.removeItem('shipstudio.installAgentFailStep');
});

describe('the step graph', () => {
  it('gives every step a consequence for skipping it', () => {
    // The failure UI promises to say what skipping costs. A step without that
    // sentence would render an empty reassurance.
    for (const meta of Object.values(INSTALL_STEPS)) {
      expect(meta.whenSkipped.length).toBeGreaterThan(0);
    }
  });

  it('knows what a step blocks', () => {
    expect(stepDependents('homebrew')).toEqual(expect.arrayContaining(['node', 'git', 'gh']));
    expect(stepDependents('git')).toEqual([]);
    expect(stepRequires('node')).toBe('homebrew');
    expect(stepRequires('homebrew')).toBeNull();
  });
});

describe('the happy path', () => {
  it('installs everything and reports nothing skipped', async () => {
    const host = scriptedHost({ admin: [{ ok: true }] });
    const events = await collect(host, baseSteps());

    for (const step of baseSteps()) expect(endedOk(events, step)).toBe(true);
    expect(done(events)?.status).toBe('complete');
    expect(done(events)?.skipped).toEqual([]);
  });

  it('skips what is already on the machine without installing it', async () => {
    const host = scriptedHost({ admin: [{ ok: true }] });
    const events = await collect(host, baseSteps(), ['git']);

    expect(events).toContainEqual({ type: 'step_skipped', step: 'git' });
    expect(events.some((e) => e.type === 'step_start' && e.step === 'git')).toBe(false);
  });

  it('does nothing at all when the machine is already set up', async () => {
    const host = scriptedHost({});
    const events = await collect(host, baseSteps(), [...baseSteps()]);

    expect(done(events)?.status).toBe('complete');
    expect(events.some((e) => e.type === 'step_start')).toBe(false);
    // Never asked for a password it had no use for.
    expect(host.asked).toEqual([]);
  });
});

describe('when the user declines the admin prompt', () => {
  it('carries on with the rest of the session instead of stopping', async () => {
    const host = scriptedHost({ admin: [{ ok: false, reason: 'declined' }] });
    const events = await collect(host, baseSteps());

    // The old behaviour ended the run here, stranding the user.
    expect(done(events)?.status).toBe('complete');
    expect(done(events)?.skipped).toContain('homebrew');
  });

  it('does not pretend it can install what Homebrew was needed for', async () => {
    const host = scriptedHost({ admin: [{ ok: false, reason: 'declined' }] });
    const events = await collect(host, baseSteps());

    for (const dependent of ['node', 'git', 'gh'] as InstallStepId[]) {
      expect(events.some((e) => e.type === 'step_start' && e.step === dependent)).toBe(false);
      expect(done(events)?.skipped).toContain(dependent);
    }
  });
});

describe('when a step fails', () => {
  beforeEach(() => {
    localStorage.setItem('shipstudio.installAgentFailStep', 'git');
  });

  it('asks what to do rather than deciding for the user', async () => {
    const host = scriptedHost({ admin: [{ ok: true }], recovery: ['skip'] });
    const events = await collect(host, baseSteps());

    expect(host.asked).toContain('recovery:git');
    expect(events.some((e) => e.type === 'awaiting_recovery')).toBe(true);
  });

  it('retrying actually retries, and a second attempt succeeds', async () => {
    const host = scriptedHost({ admin: [{ ok: true }], recovery: ['retry'] });
    const events = await collect(host, baseSteps());

    const starts = events.filter((e) => e.type === 'step_start' && e.step === 'git');
    expect(starts).toHaveLength(2);
    expect(endedOk(events, 'git')).toBe(true);
    expect(done(events)?.skipped).toEqual([]);
  });

  it('skipping records it and still finishes the run', async () => {
    const host = scriptedHost({ admin: [{ ok: true }], recovery: ['skip'] });
    const events = await collect(host, baseSteps());

    expect(done(events)?.status).toBe('complete');
    expect(done(events)?.skipped).toEqual(['git']);
    // Everything after the failure still ran.
    expect(endedOk(events, 'gh')).toBe(true);
  });

  it('stopping ends the session as blocked, not as success', async () => {
    const host = scriptedHost({ admin: [{ ok: true }], recovery: ['stop'] });
    const events = await collect(host, baseSteps());

    expect(done(events)?.status).toBe('blocked');
    expect(events.some((e) => e.type === 'step_start' && e.step === 'gh')).toBe(false);
  });

  it('counts attempts, so the UI can stop saying "try again" forever', async () => {
    const host = scriptedHost({ admin: [{ ok: true }], recovery: ['skip'] });
    const events = await collect(host, baseSteps());

    const failure = events.find((e) => e.type === 'awaiting_recovery');
    expect(failure?.type === 'awaiting_recovery' && failure.failure.attempts).toBe(1);
  });

  it('tells the user what else the failure takes down with it', async () => {
    localStorage.setItem('shipstudio.installAgentFailStep', 'homebrew');
    const host = scriptedHost({ admin: [{ ok: true }], recovery: ['skip'] });
    const events = await collect(host, baseSteps());

    const failure = events.find((e) => e.type === 'awaiting_recovery');
    expect(failure?.type === 'awaiting_recovery' && failure.failure.blocks).toEqual(
      expect.arrayContaining(['node', 'git', 'gh'])
    );
  });
});

describe('the reason text', () => {
  it('never leaks a raw command or stack trace to the user', async () => {
    localStorage.setItem('shipstudio.installAgentFailStep', 'git');
    const host = scriptedHost({ admin: [{ ok: true }], recovery: ['skip'] });
    const events = await collect(host, baseSteps());

    const failure = events.find((e) => e.type === 'awaiting_recovery');
    const reason = failure?.type === 'awaiting_recovery' ? failure.failure.reason : '';
    expect(reason).not.toMatch(/brew |npm |curl |\bError\b|at .*:\d+/);
    expect(reason.length).toBeGreaterThan(0);
  });
});
