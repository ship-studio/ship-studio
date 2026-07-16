/**
 * Shared failure-message helpers for setup terminal flows.
 *
 * Extracted from OnboardingScreen so the classic wizard and the agent-led
 * onboarding produce identical, honest error messages for the same failure
 * signatures (issues #159, #164 established the wording; don't soften it).
 */

import { detectAlreadyLoggedIn, extractTerminalError } from '../../lib/terminalDiagnostics';
import { SETUP_FRIENDLY_NAMES } from '../../lib/setup';

/** Friendly tool names for auth items, used in already-signed-in messages. */
const AUTH_TOOL_LABELS: Record<string, string> = {
  claude_auth: 'Claude',
  codex_auth: 'Codex',
  opencode_auth: 'Opencode',
  cursor_auth: 'Cursor',
  gh_auth: 'GitHub',
};

/**
 * Message for the "CLI insists it's already signed in, but our status check
 * disagrees" case — e.g. a partial sign-out desynced `claude auth status`
 * from the checklist (issue #159). A generic "authentication not completed"
 * would be dishonest here; name the identity the CLI reported and point at
 * the real fix instead.
 */
export function alreadySignedInMessage(itemId: string, identity: string | null): string {
  const tool = AUTH_TOOL_LABELS[itemId] ?? 'The CLI';
  const who = identity ? ` as ${identity}` : '';
  const fix =
    itemId === 'gh_auth'
      ? 'sign out by running `gh auth logout` in a terminal first'
      : 'sign out from the Agents panel first';
  return `${tool} reports you're already signed in${who} — if this looks wrong, ${fix}.`;
}

/**
 * Honest error for an auth item whose post-terminal verification failed:
 * prefer the already-signed-in special case, then whatever the terminal
 * actually said, over the generic message.
 */
export function authFailureMessage(itemId: string, outputTail: string): string {
  const already = detectAlreadyLoggedIn(outputTail);
  if (already) return alreadySignedInMessage(itemId, already.identity);
  return extractTerminalError(outputTail) ?? 'Authentication not completed. Click to try again.';
}

/** Guidance shown when the output tail matches a network-failure signature. */
export const NETWORK_FAILURE_MESSAGE =
  'This looks like a network problem — check your internet connection and try again.';

/**
 * Message for the "command exited cleanly but the tool never appeared" case —
 * e.g. the Homebrew installer's curl substitution coming back empty offline,
 * or the Windows winget informational echo (both exit 0 without installing
 * anything). A clean exit is a claim, not proof; this is what we say when
 * verification disproves it.
 */
export function notDetectedMessage(itemId: string): string {
  const name = SETUP_FRIENDLY_NAMES[itemId] ?? itemId;
  return `The command finished but ${name} still isn't detected. If you're on a spotty connection, check your internet and try again.`;
}
