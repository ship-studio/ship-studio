/**
 * Who is on what.
 *
 * The closest thing to presence that can be true without a server. Nobody is
 * "online" here and there is no green dot: what a git remote actually knows is
 * that a person has a branch, that it last moved at a time, and that it is N
 * commits ahead. That is real, it is free, and it answers the question people
 * open a team screen to ask.
 *
 * The line that makes it useful is `doing` — the headline off their most
 * recent update. A branch name tells you where someone is; that sentence tells
 * you what they are actually doing, which is the difference between this and
 * `git branch -r`.
 *
 * @module components/team/TeamPeoplePanel
 */

import { BranchIcon, CollaboratorsIcon, PullRequestIcon } from '@/components/icons';
import { EmptyState } from '../primitives/EmptyState';
import { TeamAvatar } from './TeamAvatar';
import { TeamCoverageComplete, TeamGitHubOnlyBadge } from './TeamCoverageNote';
import { formatAgo } from '../../lib/workflows';
import { actorKey, type TeamMember } from '../../lib/team';

const ROLE_LABEL: Record<TeamMember['role'], string> = {
  admin: 'Admin',
  maintainer: 'Maintainer',
  write: 'Write',
  read: 'Read',
};

interface TeamPeoplePanelProps {
  members: TeamMember[];
  now: number;
  /** Tighter rows for the in-workspace panel, which is 420px wide. */
  compact?: boolean;
  /**
   * Whether this project is on GitHub at all.
   *
   * An empty list means two completely different things, and the old copy said
   * the wrong one to the person it mattered most to: "this repository has no
   * other collaborators" reads as a fact about their repo when the truth is
   * that there is no repo to have any.
   */
  hasRepo?: boolean;
}

export function TeamPeoplePanel({
  members,
  now,
  compact = false,
  hasRepo = true,
}: TeamPeoplePanelProps) {
  if (members.length === 0) {
    return hasRepo ? (
      <EmptyState
        icon={<CollaboratorsIcon size={24} />}
        title="No collaborators"
        description="This repository has no other collaborators on GitHub."
      />
    ) : (
      <EmptyState
        icon={<CollaboratorsIcon size={24} />}
        title="Just you, for now"
        description="Anyone who pushes to this project on GitHub shows up here, with the branch they're on and what they're working on."
      />
    );
  }

  // Most recently active first; never-pushed last rather than interleaved by a
  // null timestamp, which would sort them as if they were ancient.
  const sorted = [...members].sort((a, b) => (b.lastPushedAt ?? -1) - (a.lastPushedAt ?? -1));

  return (
    <div className={`team-people${compact ? ' is-compact' : ''}`}>
      {!compact && (
        <p className="team-people-note">
          Everyone with access to this repository on GitHub. Roles come from GitHub. Harbr has no
          accounts of its own, so there is nothing here to invite anyone to.
        </p>
      )}

      <ul className="team-people-list">
        {sorted.map((member) => (
          <li
            className={`team-person${member.isSelf ? ' is-self' : ''}`}
            key={actorKey(member.actor)}
          >
            <TeamAvatar actor={member.actor} size={compact ? 'md' : 'lg'} isSelf={member.isSelf} />

            <div className="team-person-body">
              <div className="team-person-line">
                <span className="team-person-name">
                  {member.actor.name}
                  {member.isSelf && <span className="team-person-you">you</span>}
                </span>
                {!member.explainsWork && !member.isSelf && <TeamGitHubOnlyBadge />}
                {!compact && <span className="team-person-role">{ROLE_LABEL[member.role]}</span>}
                <span className="team-person-when">
                  {member.lastPushedAt !== null ? formatAgo(member.lastPushedAt, now) : '—'}
                </span>
              </div>

              {member.doing ? (
                <span className="team-person-doing">{member.doing}</span>
              ) : member.isSelf ? null : (
                <span className="team-person-idle">Nothing new since you last looked</span>
              )}

              {member.branch ? (
                <div className="team-person-work">
                  <span className="team-person-branch">
                    <BranchIcon size={10} />
                    {member.branch}
                  </span>
                  {member.commitsAhead > 0 && (
                    <span className="team-person-ahead">{member.commitsAhead} ahead</span>
                  )}
                  {member.prNumber !== null && (
                    <span className="team-person-pr">
                      <PullRequestIcon size={10} />#{member.prNumber}
                    </span>
                  )}
                </div>
              ) : (
                <div className="team-person-work">
                  <span className="team-person-idle">Has not pushed to this repository</span>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>

      <TeamCoverageComplete members={members} />

      {/* The honest caveat, said once, where the misreading would happen. */}
      <p className="team-people-footnote">
        “Last pushed” is the only activity a git remote can report. Uncommitted work, and work that
        has not been pushed, is invisible to everyone, including to this panel.
      </p>
    </div>
  );
}
