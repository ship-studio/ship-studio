/**
 * "How this works" — the disclosure panel that replaces an onboarding step.
 *
 * This feature writes into the user's repository and other people read it.
 * There is no setup wizard gating that, because there is nothing to configure:
 * the repo already decides who can see it. But a feature that commits on your
 * behalf owes you a plain account of what it writes and who can read it, and
 * this is that account, one click away instead of in front of the door.
 *
 * It also states the two limits out loud. Both are consequences of having no
 * server, both are permanent, and both are the kind of thing a team discovers
 * at the worst possible moment if nobody wrote them down:
 *
 *   - nothing is live; the app fetches, so news travels at fetch speed
 *   - nothing is tamper-proof; anyone who can push can edit the log
 *
 * @module components/team/TeamHowItWorks
 */

import { CloseIcon } from '@/components/icons';
import { IconButton } from '../primitives/IconButton';

interface TeamHowItWorksProps {
  onClose: () => void;
}

/** The three writers, in the order they are trusted. */
const WRITERS = [
  {
    who: 'Harbr',
    what: 'Pushes, branches, PRs, deploys, workflow runs, comments',
    how: 'Written by the app itself, in Rust. Deterministic: it happens whether or not an agent is running.',
    tone: 'certain',
  },
  {
    who: 'Your agent, in Harbr',
    what: 'What it changed and why, at the end of a session',
    how: 'Through a Harbr tool the agent is given when it starts. Schema-checked, so it cannot write a malformed entry.',
    tone: 'likely',
  },
  {
    who: 'Any agent, anywhere',
    what: 'The same session notes, outside the app',
    how: 'Through a skill committed to the repo, so a teammate who clones it has the protocol whether or not they use Harbr.',
    tone: 'best-effort',
  },
] as const;

export function TeamHowItWorks({ onClose }: TeamHowItWorksProps) {
  return (
    <section className="team-how" aria-label="How team activity works">
      <header className="team-how-header">
        <h3 className="team-how-title">Your repository is the database</h3>
        <IconButton
          variant="ghost"
          size="compact"
          icon={<CloseIcon size={12} />}
          onClick={onClose}
          title="Close"
          aria-label="Close"
        />
      </header>

      <p className="team-how-lead">
        There is no Harbr server, no account and no database. What people did is read out of your
        git history, comments are small files in your own repo, and the network is{' '}
        <code>git fetch</code>. Everyone who can see the repository on GitHub can see this; everyone
        who cannot, cannot.
      </p>

      <div className="team-how-grid">
        <div className="team-how-block">
          <h4 className="team-how-block-title">What gets written</h4>
          <pre className="team-how-path">
            <code>{'.shipstudio-team/threads/2026-09-07/\n  01K4J8Q2-mayareed.json'}</code>
          </pre>
          <p className="team-how-note">
            Only comments need a file — a note pinned to an element, on a page, at a viewport has no
            equivalent in git. What people <em>did</em> is your commit messages, read straight out
            of the history. One file per event, named by its own id, never edited afterwards, so two
            people acting at once never produce a merge conflict.
          </p>
        </div>

        <div className="team-how-block">
          <h4 className="team-how-block-title">Who writes it</h4>
          <ul className="team-how-writers">
            {WRITERS.map((writer) => (
              <li className="team-how-writer" key={writer.who} data-tone={writer.tone}>
                <span className="team-how-writer-who">{writer.who}</span>
                <span className="team-how-writer-what">{writer.what}</span>
                <span className="team-how-writer-how">{writer.how}</span>
              </li>
            ))}
          </ul>
          <p className="team-how-note">
            The app never depends on an agent remembering. If an agent writes nothing, Harbr still
            records the session from what changed on disk. You lose the explanation, not the entry.
          </p>
        </div>
      </div>

      <div className="team-how-limits">
        <h4 className="team-how-block-title">What this is not</h4>
        <ul className="team-how-limit-list">
          <li>
            <strong>Not live.</strong> Nothing can notify you without a server, so news arrives when
            Harbr next fetches, about once a minute while the app is open, and never while it is
            closed.
          </li>
          <li>
            <strong>Not an audit log.</strong> Anyone who can push to this repository can edit or
            delete these files. Rows marked <em>from git</em> are reconstructed from commit history
            and can be checked; the rest are reported by someone&rsquo;s app and are taken at their
            word.
          </li>
          <li>
            <strong>Not private.</strong> Anything written here is committed history that other
            people fetch. Harbr never records IP addresses, locations, or anything about your
            machine. Only what happened to the code.
          </li>
        </ul>
      </div>
    </section>
  );
}
