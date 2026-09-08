/**
 * The screen where the agent does the work.
 *
 * Deliberately not a terminal. A terminal is the honest view for someone who
 * reads shell and an anxiety machine for everyone else — scrolling text they
 * can't parse, warnings that mean nothing, and no way to tell progress from a
 * hang. So the default is a short list of plain-English steps with one moving
 * at a time, and the terminal stays available for anyone who wants it.
 *
 * When a step needs the person, the list steps aside for
 * {@link UserActionPrompt}: there is exactly one thing to do on screen at any
 * moment, and it is never ambiguous whether we're waiting on the machine or on
 * them.
 */

import { CheckIcon } from '@/components/icons';
import { Spinner } from '../../primitives/Spinner';
import { UserActionPrompt } from './UserActionPrompt';
import { INSTALL_STEPS, InstallStepId } from '../../../lib/installAgent';
import type { InstallAgentSession, StepState } from '../../../hooks/useInstallAgentSession';

/** Marker glyph for a step's current state. */
function StepMarker({ state }: { state: StepState | undefined }) {
  if (state === 'working') return <Spinner size="sm" />;
  if (state === 'done' || state === 'skipped') {
    return (
      <span className="flow-step-check">
        <CheckIcon size={13} />
      </span>
    );
  }
  if (state === 'failed') return <span className="flow-step-dot failed" />;
  return <span className="flow-step-dot" />;
}

/** Trailing note. Only says something when it has something to say. */
function stepNote(state: StepState | undefined): string | null {
  if (state === 'skipped') return 'Already installed';
  if (state === 'failed') return "Couldn't install";
  return null;
}

interface FlowInstallingProps {
  steps: InstallStepId[];
  session: InstallAgentSession;
}

export function FlowInstalling({ steps, session }: FlowInstallingProps) {
  if (session.pendingUserAction) {
    return (
      <UserActionPrompt
        request={session.pendingUserAction}
        onRespond={session.respond}
        waiting={session.respondingToUser}
      />
    );
  }

  return (
    <div className="flow-installing">
      <ul className="flow-step-list">
        {steps.map((step) => {
          const state = session.steps[step];
          const note = stepNote(state);
          return (
            <li
              key={step}
              className={`flow-step ${state ?? 'pending'}`}
              aria-current={state === 'working' ? 'step' : undefined}
            >
              <span className="flow-step-marker">
                <StepMarker state={state} />
              </span>
              <span className="flow-step-label">{INSTALL_STEPS[step].label}</span>
              {note && <span className="flow-step-note">{note}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
