/**
 * When your *own* pushes are coming back without a summary.
 *
 * `TeamCoverageNote` covers the other half of the team — people pushing straight
 * to GitHub from somewhere else. This covers the case that actually confuses
 * people, because it looks like the feature is broken rather than unconfigured:
 * you are using Harbr, you told your agent to push, and your row says "no
 * summary was written" with no indication of what to do about it.
 *
 * The reason is always the same. Harbr can observe that a push happened;
 * only the agent that did the work knows *why* it did it, and it has to write
 * that down at the time. If it did not, the sentence does not exist anywhere any
 * more — so this says so, once, with the one thing that fixes it.
 *
 * ## Why the fix is a file and not a prompt
 *
 * This used to offer a prompt to paste at your agent. A prompt fixes one
 * session: the next one starts with no memory of it, and so does every other
 * agent anyone on the team runs. Writing the guidance into `CLAUDE.md` /
 * `AGENTS.md` fixes it for every session in the project, including sessions
 * started from a terminal that never touches this app.
 *
 * Shown only for your own rows, only when several are thin, and never once the
 * guidance is in place — at that point the app has done the only thing it can,
 * and a note that repeats itself with no action left is a nag.
 *
 * @module components/team/TeamSelfCoverageNote
 */

import { useState } from 'react';
import { InfoIcon, PlusIcon } from '@/components/icons';
import { Spinner } from '../primitives/Spinner';
import { useOptionalToast } from '../../contexts/ToastContext';
import { installCommitGuidance } from '../../lib/teamApi';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { actorKey, type TeamActor, type TeamUpdate } from '../../lib/team';

/**
 * How many of your own rows must be thin before this appears.
 *
 * One is a push you made before the agent had anything to say about, or work
 * you committed by hand. Three in a row is a setup that is not writing them at
 * all, which is worth one line.
 */
const THIN_ROWS_BEFORE_NOTE = 3;

interface TeamSelfCoverageNoteProps {
  updates: TeamUpdate[];
  me: TeamActor | null;
  projectPath: string;
  /** Whether the block is already in this project's agent instructions. */
  installed: boolean;
  /** Re-read the snapshot, so the note disappears once the file is written. */
  onInstalled: () => void;
}

export function TeamSelfCoverageNote({
  updates,
  me,
  projectPath,
  installed,
  onInstalled,
}: TeamSelfCoverageNoteProps) {
  const { showToast } = useOptionalToast();
  const [isWriting, setIsWriting] = useState(false);

  if (!me) return null;
  // The advice is already taken. Whatever is still thin is history, and there
  // is nothing further to offer about it.
  if (installed) return null;

  const mine = updates.filter((update) => actorKey(update.actor) === actorKey(me));
  const thin = mine.filter((update) => update.writtenBy === 'app');

  // Nothing to say when it is working, or when there is barely any history to
  // judge from.
  if (thin.length < THIN_ROWS_BEFORE_NOTE) return null;
  // Already working most of the time: one stray hand-made commit is not a
  // configuration problem and does not need advice attached.
  if (mine.length - thin.length > thin.length) return null;

  const install = async () => {
    setIsWriting(true);
    try {
      const file = await installCommitGuidance(projectPath);
      // Names the file, because this edited something tracked in their repo.
      const name = file.split('/').pop() ?? file;
      showToast(`Added a commit-message section to ${name}`, 'success');
      onInstalled();
    } catch (error) {
      showToast(formatCommandError(asCommandError(error)), 'error');
    } finally {
      setIsWriting(false);
    }
  };

  return (
    <section className="team-coverage" aria-label="Your rows have no summary">
      <span className="team-coverage-icon" aria-hidden>
        <InfoIcon size={12} />
      </span>

      <p className="team-coverage-text">
        <strong>Your pushes are not writing summaries.</strong> Harbr can see that you pushed; only
        the agent that did the work knows why it did it. Add a commit-message section to this
        project&rsquo;s agent instructions and every session reads it — the rows above stay as they
        are.
      </p>

      <button
        type="button"
        className="team-coverage-invite"
        onClick={() => void install()}
        disabled={isWriting}
        title="Appends a short, clearly-marked section to this project's CLAUDE.md or AGENTS.md"
      >
        {isWriting ? <Spinner size="sm" /> : <PlusIcon size={11} />}
        Add it to the instructions
      </button>
    </section>
  );
}
