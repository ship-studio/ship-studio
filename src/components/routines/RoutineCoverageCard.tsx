/**
 * The standing explanation of when routines can actually run.
 *
 * Routines execute the agent CLI on this machine, so nothing fires while Ship
 * Studio is closed or the Mac is asleep. That is a real limit of the
 * piggyback-on-your-own-tools approach, not an implementation gap, so the page
 * states it permanently instead of hiding it in a footnote — and shows which
 * routines missed a window while the app was closed.
 *
 * PROTOTYPE. Reads fixture state; nothing is scheduled.
 *
 * @module components/routines/RoutineCoverageCard
 */

import { InfoIcon, WarningIcon } from '@/components/icons';
import { formatAge, type Routine } from '../../lib/routines';

interface RoutineCoverageCardProps {
  /** Routines whose window elapsed while Ship Studio was closed. */
  missed: Routine[];
}

export function RoutineCoverageCard({ missed }: RoutineCoverageCardProps) {
  const hasMissed = missed.length > 0;
  const catchingUp = missed.filter((routine) => routine.catchUpOnLaunch);

  return (
    <section
      className="routine-coverage"
      data-state={hasMissed ? 'attention' : 'ok'}
      aria-label="When routines run"
    >
      <span className="routine-coverage-icon" aria-hidden>
        {hasMissed ? <WarningIcon size={14} /> : <InfoIcon size={14} />}
      </span>

      <div className="routine-coverage-body">
        <p className="routine-coverage-title text-style-control-semibold">
          {hasMissed
            ? `${missed.length} ${missed.length === 1 ? 'routine' : 'routines'} missed a window while Ship Studio was closed`
            : 'Routines are running — Ship Studio is open'}
        </p>
        <p className="routine-coverage-copy">
          A routine runs the agent CLI installed on this Mac, in your project folder. There is no
          Ship Studio server and no copy of your code anywhere else, which also means nothing fires
          while the app is closed or the machine is asleep.
          {hasMissed && catchingUp.length > 0 && (
            <>
              {' '}
              {catchingUp.length === missed.length ? 'They' : `${catchingUp.length} of them`} will
              catch up as soon as this session finishes loading.
            </>
          )}
        </p>

        {hasMissed && (
          <ul className="routine-coverage-list">
            {missed.map((routine) => (
              <li key={routine.id} className="routine-coverage-item">
                <span className="routine-coverage-item-name">{routine.name}</span>
                <span className="routine-coverage-item-meta">
                  {routine.missedSince === null
                    ? 'window passed'
                    : `window passed ${formatAge(routine.missedSince)} ago`}{' '}
                  · {routine.catchUpOnLaunch ? 'will catch up' : 'window skipped'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
