/**
 * Tests for the agent-terminal startup watchdog policy (issue #158).
 *
 * The behaviour that matters: a spawned-but-silent PTY gets exactly one
 * automatic respawn; a second silent run surfaces the error; output or
 * unmount disarms the watchdog entirely.
 */

import { describe, it, expect } from 'vitest';
import { decideStartupTimeoutAction, shouldArmStartupWatchdog } from './startupWatchdog';

describe('decideStartupTimeoutAction', () => {
  it('does nothing once output has been received', () => {
    expect(
      decideStartupTimeoutAction({ receivedOutput: true, mounted: true, autoRespawnUsed: false })
    ).toBe('none');
    // Output wins even if the respawn budget is already spent.
    expect(
      decideStartupTimeoutAction({ receivedOutput: true, mounted: true, autoRespawnUsed: true })
    ).toBe('none');
  });

  it('does nothing after unmount', () => {
    expect(
      decideStartupTimeoutAction({ receivedOutput: false, mounted: false, autoRespawnUsed: false })
    ).toBe('none');
    expect(
      decideStartupTimeoutAction({ receivedOutput: false, mounted: false, autoRespawnUsed: true })
    ).toBe('none');
  });

  it('respawns once when the first spawn is silent', () => {
    expect(
      decideStartupTimeoutAction({ receivedOutput: false, mounted: true, autoRespawnUsed: false })
    ).toBe('respawn');
  });

  it('shows the error when the respawn is also silent (no retry loop)', () => {
    expect(
      decideStartupTimeoutAction({ receivedOutput: false, mounted: true, autoRespawnUsed: true })
    ).toBe('error');
  });
});

describe('shouldArmStartupWatchdog', () => {
  it('arms for a genuine spawn with no output yet', () => {
    expect(shouldArmStartupWatchdog({ spawned: true, alive: true, snapshotLength: 0 })).toBe(true);
  });

  it('never arms on a re-attach to a live background session', () => {
    // The core "chat died and restarted after switching projects" bug: an
    // idle agent emits nothing on re-attach, and that silence must not be
    // read as a wedged spawn.
    expect(shouldArmStartupWatchdog({ spawned: false, alive: true, snapshotLength: 0 })).toBe(
      false
    );
    expect(shouldArmStartupWatchdog({ spawned: false, alive: true, snapshotLength: 4096 })).toBe(
      false
    );
  });

  it('does not arm when the spawn already produced output into the snapshot', () => {
    // Bytes landed in the ring between open and attach — the process is
    // demonstrably alive and talking.
    expect(shouldArmStartupWatchdog({ spawned: true, alive: true, snapshotLength: 12 })).toBe(
      false
    );
  });

  it('does not arm for a session that is already dead (exit path owns it)', () => {
    expect(shouldArmStartupWatchdog({ spawned: true, alive: false, snapshotLength: 0 })).toBe(
      false
    );
    expect(shouldArmStartupWatchdog({ spawned: false, alive: false, snapshotLength: 100 })).toBe(
      false
    );
  });
});
