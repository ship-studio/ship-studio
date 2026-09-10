/**
 * One thing a teammate did.
 *
 * The row leads with the sentence, because that is what someone came here to
 * read. "Rebuilt the pricing tiers as a CSS grid" is a thing you can hold in
 * your head; "pushed 3 commits" is not, and a column of those is a git log
 * with faces on it.
 *
 * Under the headline: why it happened, what specifically changed, and what it
 * wants from you. The commits and files are real and they matter, but they are
 * *evidence* — collapsed behind one line, there for when you doubt the claim
 * or want to go look. Leading with them buries the only part most people need.
 *
 * An `app`-written row is drawn deliberately thinner. Harbr saw a push
 * and no agent left a summary, so all it can honestly say is that a push
 * happened — and the visible difference between that and the rich rows is the
 * argument for the skill, made in the UI instead of in a doc.
 *
 * @module components/team/TeamUpdateCard
 */

import { openUrl } from '@tauri-apps/plugin-opener';
import {
  ChevronIcon,
  ClaudeIcon,
  CodexIcon,
  ErrorIcon,
  ExternalLinkIcon,
  EyeIcon,
  GenericAgentIcon,
  GitHubIcon,
  PullRequestIcon,
} from '@/components/icons';
import { TeamAvatar } from './TeamAvatar';
import { formatAgo } from '../../lib/workflows';
import { fileTotals, TEAM_STATUS_LABEL, type TeamUpdate } from '../../lib/team';

function AgentMark({ name }: { name: string }) {
  if (name.toLowerCase().includes('claude')) return <ClaudeIcon size={10} />;
  if (name.toLowerCase().includes('codex')) return <CodexIcon size={10} />;
  return <GenericAgentIcon size={10} />;
}

interface TeamUpdateCardProps {
  update: TeamUpdate;
  expanded: boolean;
  onToggleExpanded: (id: string) => void;
  /** Marks the row as arrived since the user last looked. */
  isNew: boolean;
  now: number;
}

export function TeamUpdateCard({
  update,
  expanded,
  onToggleExpanded,
  isNew,
  now,
}: TeamUpdateCardProps) {
  const thin = update.writtenBy === 'app';
  const totals = fileTotals(update.files);
  const githubUrl = update.githubUrl;

  return (
    <article
      className={`team-update${thin ? ' is-thin' : ''}${isNew ? ' is-new' : ''}`}
      data-status={update.status}
    >
      <header className="team-update-head">
        {/* The unread mark rides the avatar rather than sitting in a gutter of
            its own. As a column it was blank on every row but the new ones,
            which left one lonely dot floating in empty space and made two
            neighbouring cards look misaligned when they were not. */}
        <span className="team-update-figure">
          <TeamAvatar actor={update.actor} size="md" />
          {isNew && (
            <span
              className="team-update-new-dot"
              role="img"
              aria-label="New since you last looked"
            />
          )}
        </span>
        <div className="team-update-who">
          <span className="team-update-name">{update.actor.name}</span>
          <span className="team-update-when">{formatAgo(update.at, now)}</span>
          {update.writtenBy === 'agent' && update.agentName && (
            <span
              className="team-update-agent"
              title={`Summarised by ${update.agentName}, which did the work`}
            >
              <AgentMark name={update.agentName} />
              {update.agentName}
            </span>
          )}
        </div>
        <span className="team-status" data-status={update.status}>
          {TEAM_STATUS_LABEL[update.status]}
        </span>
      </header>

      <h4 className="team-update-headline">{update.headline}</h4>

      {/* The commit body, as written. Paragraph breaks are preserved because
          the author put them there — a body is prose, and collapsing it into
          one block is a different document from the one they wrote. */}
      {update.why && <p className="team-update-why">{update.why}</p>}

      {update.changes.length > 0 && (
        <ul className="team-update-changes">
          {update.changes.map((change) => (
            <li key={change}>{change}</li>
          ))}
        </ul>
      )}

      {/* A row with no written summary behind it. One line saying where to go
          for the rest, and nothing else: it was briefly a sentence naming the
          person and explaining what their push was missing, which read as a
          complaint about a teammate for using a different tool. Half the team
          will always be on a different tool.

          It also used to say "not pushed from Harbr", which is a claim
          about *how* someone pushed — and it was wrong for the common case of
          pushing from an agent terminal inside Harbr. What this row
          actually knows is narrower: no summary was written, so the commit
          subject is all there is. */}
      {thin && (
        <p className="team-update-source-note">
          <GitHubIcon size={11} />
          <span>No summary was written for this one. The full diff is on GitHub.</span>
        </p>
      )}

      {update.buildError && (
        <p className="team-update-error">
          <ErrorIcon size={11} />
          <code>{update.buildError}</code>
        </p>
      )}

      {/* The one thing on the card addressed to the reader — a request, not a
          status. Drawn as a quoted aside so it reads like a colleague asking
          rather than like something that has gone wrong. */}
      {update.asks && (
        <div className="team-update-ask">
          <span className="team-update-ask-icon" aria-hidden>
            <EyeIcon size={12} />
          </span>
          <span className="team-update-ask-label">
            {update.actor.name.split(' ')[0]} wants a second pair of eyes
          </span>
          <p className="team-update-ask-text">{update.asks}</p>
        </div>
      )}

      {/* Two groups, not seven loose items. Where it lives (left) and what you
          can do with it (right) — so a narrow panel wraps one whole group
          under the other instead of stranding "Open in GitHub" on its own. */}
      <footer className="team-update-foot">
        <span className="team-update-foot-where">
          <span className="team-branch-chip">{update.branch}</span>
          {update.prNumber !== null && (
            <span className="team-pr-chip">
              <PullRequestIcon size={10} />#{update.prNumber}
            </span>
          )}
        </span>

        <span className="team-update-foot-actions">
          {(update.commits.length > 0 || update.files.length > 0) && (
            <button
              type="button"
              className="team-evidence-toggle"
              onClick={() => onToggleExpanded(update.id)}
              aria-expanded={expanded}
            >
              <ChevronIcon size={9} className={expanded ? 'chevron-flipped' : undefined} />
              {update.commits.length} {update.commits.length === 1 ? 'commit' : 'commits'} ·{' '}
              {update.files.length} {update.files.length === 1 ? 'file' : 'files'}
              {totals.added > 0 && <span className="team-diff-add">+{totals.added}</span>}
              {totals.removed > 0 && <span className="team-diff-del">−{totals.removed}</span>}
            </button>
          )}

          {/* On every row, not only the thin ones. GitHub is the one place the
              whole team can already see, whether or not they use this app. */}
          {githubUrl && (
            <button
              type="button"
              className="team-github-link"
              onClick={() => void openUrl(githubUrl)}
              title={githubUrl}
            >
              <GitHubIcon size={11} />
              Open in GitHub
              <ExternalLinkIcon size={9} />
            </button>
          )}
        </span>
      </footer>

      {expanded && (
        <div className="team-evidence">
          <ul className="team-evidence-list">
            {update.commits.map((commit) => (
              <li key={commit.sha} className="team-evidence-row">
                <code className="team-sha">{commit.sha}</code>
                <span className="team-evidence-text">{commit.message}</span>
              </li>
            ))}
          </ul>
          <ul className="team-evidence-list">
            {update.files.map((file) => (
              <li key={file.path} className="team-evidence-row">
                <code className="team-evidence-path">{file.path}</code>
                <span className="team-diff-add">+{file.added}</span>
                <span className="team-diff-del">−{file.removed}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}
