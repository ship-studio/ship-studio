/**
 * The screen where the agent does the work.
 *
 * Deliberately not a terminal. A terminal is the honest view for someone who
 * reads shell and an anxiety machine for everyone else — scrolling text they
 * can't parse, warnings that mean nothing, and no way to tell progress from a
 * hang. So the default is a short list of plain-English steps with one moving
 * at a time.
 *
 * The screen has exactly one job at any moment, in strict priority: a failure
 * to decide about, a person to ask, or progress to watch. Two of those on
 * screen together would be two things to do, and the whole design of this flow
 * is that there is never more than one.
 *
 * Progress is announced as well as drawn: the list is decorative to a screen
 * reader (each row is a spinner and a word), so a live region carries the same
 * information as a sentence.
 */

import { CheckIcon } from '@/components/icons';
import { Spinner } from '../../primitives/Spinner';
import { UserActionPrompt } from './UserActionPrompt';
import { StepFailurePrompt } from './StepFailurePrompt';
import { StallNotice } from './StallNotice';
import { INSTALL_STEPS, InstallStepId, stepLabel } from '../../../lib/installAgent';
import type { InstallAgentSession, StepState } from '../../../hooks/useInstallAgentSession';

/** Marker glyph for a step's current state. */
function StepMarker({ state }: { state: StepState | undefined }) {
  if (state === 'working') return <Spinner size="sm" />;
  if (state === 'done' || state === 'skipped') {
    return (
      <span className={`flow-step-check ${state === 'skipped' ? 'muted' : ''}`}>
        <CheckIcon size={13} />
      </span>
    );
  }
  if (state === 'failed') return <span className="flow-step-dot failed" />;
  return <span className="flow-step-dot" />;
}

/** Trailing note. Only says something when it has something to say. */
function stepNote(state: StepState | undefined): string | null {
  if (state === 'skipped') return 'Skipped';
  if (state === 'failed') return "Didn't install";
  return null;
}

/** One sentence a screen reader can act on, in place of five spinner rows. */
function progressSentence(steps: InstallStepId[], session: InstallAgentSession): string {
  const working = steps.find((s) => session.steps[s] === 'working');
  const settled = steps.filter((s) => {
    const state = session.steps[s];
    return state === 'done' || state === 'skipped';
  }).length;
  if (!working) return `${settled} of ${steps.length} steps finished.`;
  return `Installing ${stepLabel(working)}. ${settled} of ${steps.length} finished.`;
}

interface FlowInstallingProps {
  steps: InstallStepId[];
  session: InstallAgentSession;
}

export function FlowInstalling({ steps, session }: FlowInstallingProps) {
  // A failure outranks everything: it is the only state where the flow cannot
  // proceed on its own, so it must not sit behind anything else.
  if (session.pendingRecovery) {
    return <StepFailurePrompt failure={session.pendingRecovery} onChoose={session.recover} />;
  }

  if (session.pendingUserAction) {
    return (
      <UserActionPrompt
        request={session.pendingUserAction}
        onRespond={session.respond}
        waiting={session.respondingToUser}
      />
    );
  }

  const working = steps.find((s) => session.steps[s] === 'working') ?? null;

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

      {/* The list is a picture; this is the same information as a sentence.
          `polite` so it waits for a gap rather than cutting the user off. */}
      <p className="flow-sr-only" role="status" aria-live="polite">
        {progressSentence(steps, session)}
      </p>

      {session.stalled && <StallNotice step={working} onSkip={session.abandon} />}
    </div>
  );
}
