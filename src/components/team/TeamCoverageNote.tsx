/**
 * How complete this feed actually is, and what would make it more so.
 *
 * The honest framing of a feature that degrades rather than breaks. Everyone
 * with repo access shows up here whether or not they use Harbr — their
 * pushes arrive as GitHub facts, openable in GitHub, missing only the *why*.
 * That is a working product for a team of one adopter, which is the only way
 * adoption ever starts.
 *
 * So this block is not a nag and must not become one. It states what is
 * missing and from whom, offers the one action that fixes it, and then stops.
 * It hides itself entirely once everyone is covered, because a permanent
 * "invite your team" banner on a fully-covered team is just noise with a
 * button on it.
 *
 * @module components/team/TeamCoverageNote
 */

import { CheckIcon, CopyIcon, GitHubIcon } from '@/components/icons';
import { TeamAvatar } from './TeamAvatar';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useOptionalToast } from '../../contexts/ToastContext';
import { actorKey, teamCoverage, type TeamMember } from '../../lib/team';

interface TeamCoverageNoteProps {
  members: TeamMember[];
  /** `owner/repo`, used in the invite text so it names the actual project. */
  repo: string | null;
}

export function TeamCoverageNote({ members, repo }: TeamCoverageNoteProps) {
  const { showToast } = useOptionalToast();
  const { copy } = useCopyToClipboard({
    onCopy: () => showToast('Invite copied', 'success'),
  });

  const coverage = teamCoverage(members);
  if (coverage.missing.length === 0) return null;

  const names = coverage.missing.map((member) => member.actor.name);
  const nameList =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

  // A nudge about commit messages, not a pitch for this app. What the feed
  // needs from someone is a sentence in their commit body — which costs them
  // nothing, works in whatever editor they already use, and helps everyone
  // reading `git log` whether or not they ever open Harbr.
  const nudge = [
    `Could we start putting a line or two in commit bodies on ${repo ?? 'this repo'}? Just why the change was needed — the subject already says what changed.`,
    '',
    'It shows up in `git log`, on GitHub, and in code review, so it helps whether or not you use any particular tool.',
  ].join('\n');

  return (
    <section className="team-coverage" aria-label="Team coverage">
      <div className="team-coverage-heads">
        {coverage.missing.map((member) => (
          <TeamAvatar key={actorKey(member.actor)} actor={member.actor} size="sm" />
        ))}
      </div>

      <p className="team-coverage-text">
        <strong>
          {coverage.explaining} of {coverage.total} write commit bodies.
        </strong>{' '}
        {nameList}
        {names.length === 1 ? "'s commits say" : "'s commits say"} what changed but not why, so
        their rows have a headline and nothing under it.
      </p>

      <button
        type="button"
        className="team-coverage-invite"
        onClick={() => void copy(nudge)}
        title="Copies a short message you can paste anywhere"
      >
        <CopyIcon size={11} />
        Copy a nudge
      </button>
    </section>
  );
}

/** The all-covered counterpart, shown in the People tab rather than the feed. */
export function TeamCoverageComplete({ members }: { members: TeamMember[] }) {
  const coverage = teamCoverage(members);
  if (coverage.missing.length > 0) return null;

  return (
    <p className="team-coverage-complete">
      <CheckIcon size={11} />
      Everyone on this repository is sending summaries. This feed is as complete as it gets.
    </p>
  );
}

/**
 * Marks a person whose commits arrive with no body.
 *
 * Deliberately not "GitHub only", which is what this said when the feed read a
 * Harbr record instead of the commit. That badge was about which tool
 * somebody used; this one is about whether their work is legible, which is the
 * only part that affects anyone else.
 */
export function TeamGitHubOnlyBadge() {
  return (
    <span
      className="team-github-only"
      title="Their commits have a subject but no body, so their rows show what changed and not why"
    >
      <GitHubIcon size={9} />
      no context
    </span>
  );
}
