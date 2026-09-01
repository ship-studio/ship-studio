/**
 * Decision logic and timings for the PTY startup watchdog.
 *
 * When a PTY spawns but never produces output within the startup window,
 * the process is wedged (issue #158: seen on first app launch with
 * Claude Code on macOS and Codex on Windows). The manual workaround users
 * found — create a new agent tab, delete the old one — amounts to "kill
 * the silent PTY and spawn a fresh one". `decideStartupTimeoutAction`
 * drives the automatic version of that, capped at one respawn per
 * terminal mount so a genuinely-broken binary can't respawn in a loop.
 *
 * This module is the single source of that policy for BOTH terminals that
 * spawn a PTY — the workspace agent terminal (`Terminal.tsx`, issue #384)
 * and the onboarding terminal (`setup/OnboardingTerminal.tsx`, issue #245).
 * They previously carried separate copies of the same rule and the same
 * magic numbers, which is how the two drifted into looking like unrelated
 * bugs. Only the user-facing wording differs per terminal; the timings and
 * the respawn cap live here.
 *
 * Kept as pure values/functions so the retry policy is unit-testable without
 * mounting the xterm-heavy terminal components.
 */

/**
 * How long a freshly spawned PTY may stay silent before the watchdog acts.
 * Every setup command is deliberately written to print something
 * immediately (see the echoes in `getTerminalCommands`, lib/setup.ts) so
 * this only fires on a genuinely wedged spawn.
 */
export const STARTUP_TIMEOUT_MS = 10_000;

/**
 * Pause between killing a silent PTY and respawning, so the dead PTY's exit
 * event is delivered before the replacement subscribes — otherwise it looks
 * like the new process exiting immediately.
 */
export const RESPAWN_GRACE_MS = 500;

export interface StartupTimeoutState {
  /** True once any PTY output arrived for the current spawn. */
  receivedOutput: boolean;
  /** True while the owning effect instance is still mounted. */
  mounted: boolean;
  /** True once the single allowed automatic respawn has been used. */
  autoRespawnUsed: boolean;
}

export type StartupTimeoutAction = 'none' | 'respawn' | 'error';

/**
 * What to do when the no-output startup timeout fires.
 *
 * - `'none'`    — output arrived or the component unmounted; do nothing.
 * - `'respawn'` — silent first spawn: kill the PTY and respawn once.
 * - `'error'`   — the respawn was also silent: surface the error text.
 */
export function decideStartupTimeoutAction(state: StartupTimeoutState): StartupTimeoutAction {
  if (state.receivedOutput || !state.mounted) return 'none';
  return state.autoRespawnUsed ? 'error' : 'respawn';
}
