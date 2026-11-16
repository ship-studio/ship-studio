/**
 * Claude Code reports what it is doing through the first glyph of the
 * terminal title. Ship Studio reads that glyph to drive the sidebar's
 * thinking dot, tab attention and the "agent finished" sound, and strips it
 * before showing the title as a tab label.
 *
 * Glyphs observed from the CLI:
 * - Working: Braille spinner frames (⠂ ⠐ …, older releases) and the
 *   half-circle frames ◐ ◑ (2.1.x). Match the whole Braille block and the
 *   whole quarter-circle run (◐ ◑ ◒ ◓) so a new frame in either family does
 *   not silently stop the working state from being seen.
 * - Waiting for input: ✳ (and the asterisk-like fallbacks).
 * - Older releases also used a middle dot / bullet while working.
 */
const WORKING_GLYPHS = '\\u2800-\\u28ff\\u25d0-\\u25d3·•';
const WAITING_GLYPHS = '✳✱✲*';

const AGENT_STATUS_PREFIX = new RegExp(`^[${WORKING_GLYPHS}${WAITING_GLYPHS}]+\\s*`, 'u');
const WORKING_PREFIX = new RegExp(`^[${WORKING_GLYPHS}]`, 'u');
const WAITING_PREFIX = new RegExp(`^[${WAITING_GLYPHS}]`, 'u');

export type TitleAgentStatus = 'thinking' | 'waiting' | 'idle';

/** Remove the agent's leading status glyph(s) before showing the title. */
export function sanitizeTerminalTitle(title: string): string {
  return title.replace(AGENT_STATUS_PREFIX, '').trim();
}

/** The agent status encoded in a terminal title's leading glyph. */
export function agentStatusFromTitle(title: string): TitleAgentStatus {
  if (WORKING_PREFIX.test(title)) return 'thinking';
  if (WAITING_PREFIX.test(title)) return 'waiting';
  return 'idle';
}

/**
 * xterm's focus reports (DECSET 1004): `CSI I` on focus, `CSI O` on blur.
 *
 * Claude Code only animates its title while it believes its terminal is
 * focused; told it has lost focus, it shows the static ✳ — the "waiting"
 * glyph — for the rest of the turn, even while it is still working. Ship
 * Studio's terminal loses focus whenever the user clicks the preview or
 * another tab, so forwarding these reports made a turn look finished the
 * moment the user looked away, and the real finish was never seen. Agents
 * whose status is read from the title must not receive them.
 */
export function isFocusReport(data: string): boolean {
  return data === '\x1b[I' || data === '\x1b[O';
}
