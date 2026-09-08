/**
 * The moment the agent hands back to the person.
 *
 * On a fresh machine this is guaranteed, not exceptional: an admin password
 * for Homebrew, a browser sign-in for GitHub. Those moments are where a
 * non-technical user decides whether this app is trustworthy, so they get a
 * whole screen and a straight explanation rather than a dialog and a shrug.
 *
 * Three rules the copy follows:
 *
 * 1. Say who is asking. A password sheet that appears with no warning reads as
 *    the app asking for your password. It isn't, and saying so is the
 *    difference between "fine" and "cancel".
 * 2. Say what happens if they say no — nothing breaks, they can do it later.
 * 3. Never show a command. If the user has to read shell to proceed, the flow
 *    has already failed the person it was built for.
 */

import { useCopyToClipboard } from '../../../hooks/useCopyToClipboard';
import { Button } from '../../primitives/Button';
import { Spinner } from '../../primitives/Spinner';
import { isWindows } from '../../../lib/setup';
import type { UserActionRequest, UserActionResult } from '../../../lib/installAgent';

interface UserActionPromptProps {
  request: UserActionRequest;
  /** Resolves the driver's pending `requestUser` call. */
  onRespond: (result: UserActionResult) => void;
  /** True once they've acted and we're waiting on the machine to agree. */
  waiting?: boolean;
}

export function UserActionPrompt({ request, onRespond, waiting }: UserActionPromptProps) {
  const { copy, isCopied } = useCopyToClipboard();

  if (request.kind === 'browser_auth') {
    return (
      <div className="flow-action">
        <p className="flow-action-reason">{request.reason}</p>

        {request.code && (
          <button
            type="button"
            className="flow-action-code"
            onClick={() => void copy(request.code as string)}
            title="Copy code"
          >
            <span className="flow-action-code-value">{request.code}</span>
            <span className="flow-action-code-hint">{isCopied ? 'Copied' : 'Click to copy'}</span>
          </button>
        )}

        {request.url && <p className="flow-action-destination">We'll open {request.url}</p>}

        <div className="flow-action-buttons">
          <Button variant="primary" size="large" onClick={() => onRespond({ ok: true })}>
            {waiting ? <Spinner size="sm" /> : `Sign in to ${request.service}`}
          </Button>
          <Button variant="ghost" onClick={() => onRespond({ ok: false, reason: 'declined' })}>
            Skip for now
          </Button>
        </div>

        <p className="flow-action-footnote">
          You can connect {request.service} later — nothing else depends on it right now.
        </p>
      </div>
    );
  }

  if (request.kind === 'admin') {
    return (
      <div className="flow-action">
        <p className="flow-action-reason">{request.reason}</p>

        <div className="flow-action-buttons">
          <Button variant="primary" size="large" onClick={() => onRespond({ ok: true })}>
            {waiting ? <Spinner size="sm" /> : 'Continue'}
          </Button>
          <Button variant="ghost" onClick={() => onRespond({ ok: false, reason: 'declined' })}>
            Not now
          </Button>
        </div>

        <p className="flow-action-footnote">
          {/* Named for the OS the user is actually on. This sentence is the
              app asking to be trusted; getting the platform wrong in it is
              the cheapest possible way to not be. */}
          {isWindows()
            ? 'Windows handles the prompt. Ship Studio never receives your details.'
            : 'Your password goes straight to macOS. Ship Studio never receives it.'}
        </p>
      </div>
    );
  }

  return (
    <div className="flow-action">
      <p className="flow-action-reason">{request.reason}</p>
      <div className="flow-action-buttons">
        <Button variant="primary" size="large" onClick={() => onRespond({ ok: true })}>
          {waiting ? <Spinner size="sm" /> : request.confirmLabel}
        </Button>
        <Button variant="ghost" onClick={() => onRespond({ ok: false, reason: 'declined' })}>
          Skip
        </Button>
      </div>
    </div>
  );
}
