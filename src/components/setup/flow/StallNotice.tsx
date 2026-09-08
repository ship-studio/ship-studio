/**
 * Shown when a step has gone quiet for minutes.
 *
 * The honest thing to say here is very little. We do not know that it failed —
 * a Homebrew install on hotel wifi genuinely takes this long — only that we
 * have not heard anything. So this claims nothing, offers the way out, and
 * stays out of the way if it turns out to be fine.
 *
 * It appears *beside* the progress list rather than replacing it, because
 * replacing it would assert that the install is over when it might not be.
 */

import { TextButton } from '../../primitives/TextButton';
import { stepLabel, type InstallStepId } from '../../../lib/installAgent';

interface StallNoticeProps {
  /** The step that has gone quiet, when we know which one. */
  step: InstallStepId | null;
  /** Stop waiting and let the rest of setup continue. */
  onSkip: () => void;
}

export function StallNotice({ step, onSkip }: StallNoticeProps) {
  return (
    <div className="flow-stall" role="status">
      <p className="flow-stall-text">
        {step ? `${stepLabel(step)} is taking longer than usual.` : 'This is taking a while.'} A big
        download on a slow connection looks exactly like this, so it may still finish on its own.
      </p>
      {/* Deliberately not "skip this step": a wedged step can't be stepped
          over, only left. The label says what actually happens. */}
      <TextButton onClick={onSkip}>Stop waiting and carry on</TextButton>
    </div>
  );
}
