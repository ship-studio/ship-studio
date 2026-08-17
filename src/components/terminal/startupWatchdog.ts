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

export interface StartupWatchdogArmState {
  /** True when `pty_session_open` actually spawned a new process this call
   *  (false = re-attached to an already-live backend session). */
  spawned: boolean;
  /** Liveness reported by the attach snapshot. */
  alive: boolean;
  /** Byte length of the attach snapshot replayed into xterm. */
  snapshotLength: number;
}

/**
 * Should the no-output startup watchdog be armed at all for this mount?
 *
 * Only for a genuine spawn that hasn't produced a byte yet and is still
 * alive. The watchdog exists for issue #158's spawned-but-silent PTY; it
 * must NEVER arm on a re-attach to a live background session — an idle
 * agent sitting at its prompt emits nothing for 10s as a matter of course,
 * and killing it for that silence destroyed healthy chats on every
 * project switch / remount ("my chat died and restarted for no reason").
 * A dead session is the exit path's job, not the watchdog's.
 */
export function shouldArmStartupWatchdog(state: StartupWatchdogArmState): boolean {
  return state.spawned && state.alive && state.snapshotLength === 0;
}
