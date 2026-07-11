/**
 * Decision logic for the agent-terminal startup watchdog.
 *
 * When a PTY spawns but never produces output within the startup window,
 * the agent process is wedged (issue #158: seen on first app launch with
 * Claude Code on macOS and Codex on Windows). The manual workaround users
 * found — create a new agent tab, delete the old one — amounts to "kill
 * the silent PTY and spawn a fresh one". `decideStartupTimeoutAction`
 * drives the automatic version of that, capped at one respawn per
 * terminal mount so a genuinely-broken binary can't respawn in a loop.
 *
 * Kept as a pure function so the retry policy is unit-testable without
 * mounting the xterm-heavy Terminal component.
 */

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
