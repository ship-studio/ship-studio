/**
 * Tests for the agent-terminal startup watchdog policy (issue #158).
 *
 * The behaviour that matters: a spawned-but-silent PTY gets exactly one
 * automatic respawn; a second silent run surfaces the error; output or
 * unmount disarms the watchdog entirely.
 */

import { describe, it, expect } from 'vitest';
import { decideStartupTimeoutAction } from './startupWatchdog';

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
