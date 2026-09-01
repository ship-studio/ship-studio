/**
 * Tests for the PTY startup watchdog policy (issue #158).
 *
 * The behaviour that matters: a spawned-but-silent PTY gets exactly one
 * automatic respawn; a second silent run surfaces the error; output or
 * unmount disarms the watchdog entirely. Both the workspace terminal
 * (#384) and the onboarding terminal (#245) run on this one policy.
 */

import { describe, it, expect } from 'vitest';
import {
  decideStartupTimeoutAction,
  RESPAWN_GRACE_MS,
  STARTUP_TIMEOUT_MS,
} from './startupWatchdog';

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

describe('watchdog timings', () => {
  it('keeps the historical windows both terminals were built around', () => {
    // Deliberately pinned: the setup commands are written to print
    // immediately so 10s only trips a wedged spawn, and the user-facing
    // messages in both terminals still say "10 seconds".
    expect(STARTUP_TIMEOUT_MS).toBe(10_000);
    expect(RESPAWN_GRACE_MS).toBe(500);
  });
});
