/**
 * What keeps agents running: this Mac, awake, with Ship Studio open. Said
 * once, quietly — under the Chief of Staff's first-run starters, and as a
 * link in the schedule popover's footnote — with the one thing the app can
 * do about it: hold the Mac awake (the same assertion remote access uses).
 *
 * Shows nothing until the backend has answered, and nothing off macOS.
 *
 * @module components/agents/AgentsStayOn
 */

import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { useKeepAwake } from '../../hooks/useKeepAwake';

/** The first-run note: where agents run, and the keep-awake action. */
export function AgentsStayOnNote() {
  const { state, turnOn } = useKeepAwake();
  if (!state?.supported) return null;
  return (
    <div className="agents-stay-on">
      {state.active ? (
        <p className="agents-stay-on__line">This Mac stays awake while Ship Studio is open.</p>
      ) : (
        <>
          <p className="agents-stay-on__line">
            Agents run on this Mac. They pause when it sleeps or Ship Studio quits.
          </p>
          <Button tabIndex={0} variant="ghost" size="compact" onClick={() => void turnOn()}>
            Keep this Mac awake
          </Button>
        </>
      )}
      <p className="agents-stay-on__line agents-stay-on__line--quiet">
        Always on? Run Ship Studio on an always-on Mac (a Mac mini, or a cloud Mac) to keep agents
        going around the clock.
      </p>
    </div>
  );
}

/** The schedule footnote's trailing link; nothing once the Mac is held awake. */
export function KeepAwakeLink() {
  const { state, turnOn } = useKeepAwake();
  if (!state?.supported || state.active) return null;
  return (
    <>
      {' '}
      <TextButton tabIndex={0} onClick={() => void turnOn()}>
        Keep this Mac awake
      </TextButton>
    </>
  );
}
