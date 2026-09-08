/**
 * A step didn't install. What now?
 *
 * This is the screen that decides whether onboarding is bulletproof, because
 * it is the one that runs when everything else has gone wrong. Four rules:
 *
 * 1. **Never a dead end.** There is always a way forward. "Skip it" is a real
 *    button, not a link in small print, and it names what the user gives up so
 *    the choice is informed rather than resigned.
 * 2. **Never blame the user.** A package mirror being down is not something
 *    they did or can fix. The reason is stated as a fact about the world.
 * 3. **Stop offering "try again" forever.** After a couple of attempts the
 *    same button is no longer a suggestion, it is a loop — so the emphasis
 *    flips to moving on.
 * 4. **No stack traces.** Someone who has never opened a terminal cannot act
 *    on stderr, and being shown it reads as "this app is broken" rather than
 *    "this download failed".
 */

import { Button } from '../../primitives/Button';
import { WarningIcon } from '@/components/icons';
import { stepLabel, stepSkipConsequence, type StepFailure } from '../../../lib/installAgent';
import type { RecoveryChoice } from '../../../lib/installAgent';

/** After this many tries, stop leading with "try again". */
const RETRY_FATIGUE_AT = 2;

interface StepFailurePromptProps {
  failure: StepFailure;
  onChoose: (choice: RecoveryChoice) => void;
}

export function StepFailurePrompt({ failure, onChoose }: StepFailurePromptProps) {
  const label = stepLabel(failure.step);
  const tired = failure.attempts >= RETRY_FATIGUE_AT;
  const blocked = failure.blocks.map(stepLabel);

  return (
    <div className="flow-action flow-action--failure">
      <p className="flow-action-reason">
        <span className="flow-action-icon" aria-hidden="true">
          <WarningIcon size={15} />
        </span>
        {failure.reason}
      </p>

      <div className="flow-action-buttons">
        {/* After repeated attempts the retry stops being the primary action —
            pressing the same button a fourth time is not a plan. */}
        <Button
          variant={tired ? 'secondary' : 'primary'}
          size="large"
          onClick={() => onChoose('retry')}
        >
          {tired ? 'Try once more' : 'Try again'}
        </Button>
        <Button
          variant={tired ? 'primary' : 'secondary'}
          size="large"
          onClick={() => onChoose('skip')}
        >
          Skip {label}
        </Button>
      </div>

      <p className="flow-action-footnote">
        {stepSkipConsequence(failure.step)}
        {blocked.length > 0 && ` I'll also have to leave out ${listOut(blocked)}.`}
      </p>
    </div>
  );
}

/** "A", "A and B", "A, B and C" — the way a person would say it. */
function listOut(items: string[]): string {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
