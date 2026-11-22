/**
 * Who else is in this repo, in the workspace header.
 *
 * The smallest thing that makes a project stop feeling like a room you are
 * alone in. Faces, ordered by who moved most recently, with a count of what
 * has landed since you last looked.
 *
 * It is not presence and does not pretend to be: no green dots, no "active
 * now". Every avatar here is someone with a branch that has actually moved,
 * which is the only thing a git remote can tell us and — usefully — the thing
 * people are really asking when they ask who is around.
 *
 * Built on `ToggleButton` with `className="workspace-panel-toggle"`, exactly
 * like Agent, Elements, Variables and Comments beside it. It was briefly a
 * hand-rolled `<button>` with its own borders and hover rules, which is the
 * per-domain button class CLAUDE.md rules out — and it showed, because it sat
 * in a row of five controls and was the only one whose pressed and hover
 * states did not match.
 *
 * @module components/team/TeamPresence
 */

import { CollaboratorsIcon } from '@/components/icons';
import { ToggleButton } from '../primitives/ToggleButton';
import { TeamAvatar } from './TeamAvatar';
import { formatAgo } from '../../lib/workflows';
import { activeTeammates, actorKey, type TeamMember } from '../../lib/team';

/** Beyond this the rest collapse into a "+N". Four is what the header fits. */
const MAX_FACES = 4;

/** What the button says when there is nobody else on the repo. */
function describeOpen(openComments: number): string {
  if (openComments === 0) return 'no open comments';
  return openComments === 1 ? '1 open comment' : `${openComments} open comments`;
}

function aloneTitle(openComments: number): string {
  return openComments === 0
    ? 'Team — comments, and who else is on this repository'
    : `Team — ${describeOpen(openComments)}`;
}

interface TeamPresenceProps {
  members: TeamMember[];
  /** Updates that have arrived since the user last looked. */
  unseenCount: number;
  /**
   * Unresolved comment threads. What the button counts when you are the only
   * person here, which is the whole state this feature used to hide in.
   */
  openComments: number;
  panelOpen: boolean;
  panelSelected?: boolean;
  onTogglePanel: () => void;
  now: number;
}

export function TeamPresence({
  members,
  unseenCount,
  openComments,
  panelOpen,
  panelSelected,
  onTogglePanel,
  now,
}: TeamPresenceProps) {
  const teammates = activeTeammates(members);
  const panelActive = panelOpen && (panelSelected ?? true);
  const shown = teammates.slice(0, MAX_FACES);
  const overflow = teammates.length - shown.length;

  // Alone is a state this button has, not a reason for it to disappear.
  //
  // It used to return null with no teammates, which quietly made the whole
  // panel unreachable for the person working solo — and comments, which need
  // no teammates and no repository, went with it. A count of open comments is
  // what that person actually wants on the button anyway.
  const alone = teammates.length === 0;

  const summary = teammates
    .map(
      (member) =>
        `${member.actor.name}: ${member.branch ?? 'no branch'}, ${
          member.lastPushedAt ? formatAgo(member.lastPushedAt, now) : 'never pushed'
        }`
    )
    .join('\n');

  return (
    <span className="team-presence-wrap">
      <ToggleButton
        variant={panelActive ? 'secondary' : 'default'}
        className="workspace-panel-toggle team-presence"
        pressed={panelActive}
        onClick={onTogglePanel}
        title={alone ? aloneTitle(openComments) : summary}
        leftIcon={<CollaboratorsIcon size={16} />}
        aria-label={
          alone
            ? `Team: ${describeOpen(openComments)}`
            : unseenCount > 0
              ? `Team: ${teammates.length} others, ${unseenCount} new`
              : `Team: ${teammates.length} others`
        }
        data-workspace-panel="team"
      >
        {alone ? (
          // No faces rather than your own: a stack of one is a picture of
          // being alone, which the empty state already says in words.
          openComments > 0 && <span className="team-presence-count">{openComments}</span>
        ) : (
          <span className="team-presence-faces">
            {shown.map((member) => (
              <TeamAvatar key={actorKey(member.actor)} actor={member.actor} size="sm" />
            ))}
            {overflow > 0 && (
              <span className="team-avatar team-avatar--sm team-avatar--overflow">
                <span className="team-avatar-initials" aria-hidden>
                  +{overflow}
                </span>
              </span>
            )}
          </span>
        )}
      </ToggleButton>

      {/* Outside the button so it can sit on the corner without the button's
          own padding pushing it inward — the same arrangement the Comments
          toggle uses for its pending badge. */}
      {unseenCount > 0 && (
        <span className="team-presence-badge" aria-hidden>
          {unseenCount > 9 ? '9+' : unseenCount}
        </span>
      )}
    </span>
  );
}
