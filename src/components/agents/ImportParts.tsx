/**
 * The pieces both import paths are built from: the numbered steps (the same
 * rail as Remote access setup), the message to send with its Copy button, the
 * preview of what a pasted reply brings, and the moment it's done.
 *
 * @module components/agents/ImportParts
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckIcon, ChevronRightIcon, CopyIcon, WarningIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useAgents } from '../../lib/agentsStore';
import type { ImportSummary, PasteImportAgent, PasteImportPreview } from '../../lib/agents';
import { AgentAvatar } from './AgentAvatar';

export const plural = (n: number, word: string) =>
  `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** "and"-joined, the way a person lists names: "A", "A and B", "A, B and C". */
const listOf = (names: string[]) =>
  names.length < 2
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

export type StepState = 'todo' | 'current' | 'done';

interface ImportStepProps {
  n: number;
  state: StepState;
  title: string;
  /** Beside the title once the step is done and folded away. */
  aside?: ReactNode;
  /** Shown while the step isn't folded. */
  children?: ReactNode;
  folded?: boolean;
}

export function ImportStep({ n, state, title, aside, children, folded }: ImportStepProps) {
  return (
    <li className="agents-import-step" data-state={state}>
      <div className="agents-import-step__head">
        <span className="agents-import-step__marker" aria-hidden>
          {state === 'done' ? <CheckIcon size={12} /> : n}
        </span>
        <span className="agents-import-step__title">{title}</span>
        {aside && <span className="agents-import-step__aside">{aside}</span>}
      </div>
      {!folded && children && <div className="agents-import-step__body">{children}</div>}
    </li>
  );
}

/**
 * The message to send the other assistant, and the one action that matters
 * on this step. `onCopied` lets the caller tick the step.
 */
export function MessageCard({
  message,
  onCopied,
  lead = true,
  autoFocus = false,
}: {
  message: string;
  onCopied?: () => void;
  /** Primary until the user has moved past this step. */
  lead?: boolean;
  /** Take focus on open, so Enter copies: this is the first thing to do. */
  autoFocus?: boolean;
}) {
  const { copy, isCopied } = useCopyToClipboard({ onCopy: onCopied });
  const button = useRef<HTMLButtonElement>(null);
  // The message loads after the dialog opens, so the button is still disabled
  // when the dialog places focus. Take it once there's something to copy.
  const ready = !!message;
  useEffect(() => {
    if (autoFocus && lead && ready) button.current?.focus();
    // Only on arrival: never pull focus back once the user has moved on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  return (
    <div className="agents-import-message">
      <div className="agents-import-message__box">
        <blockquote className="agents-import-message__text" tabIndex={0}>
          {message}
        </blockquote>
      </div>
      <div className="agents-import-message__actions">
        <Button
          variant={lead ? 'primary' : 'secondary'}
          leftIcon={isCopied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          onClick={() => void copy(message)}
          disabled={!message}
          data-copied={isCopied || undefined}
          ref={button}
          className="agents-import-message__copy"
        >
          {isCopied ? 'Copied' : 'Copy message'}
        </Button>
        <span className="agents-import-message__hint" aria-live="polite">
          {isCopied
            ? 'Now paste it into a chat with your assistant.'
            : 'Grok Bot, Muse or any other assistant.'}
        </span>
      </div>
    </div>
  );
}

/** 2140 → "2.1k": the size of what came across, not a number to read. */
const compact = (n: number) =>
  new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);

function counts(agent: PasteImportAgent) {
  return [
    agent.instructionsChars
      ? `${compact(agent.instructionsChars)} chars of instructions`
      : 'No instructions',
    agent.memoryLines
      ? `${agent.memoryLines.toLocaleString()} ${agent.memoryLines === 1 ? 'memory' : 'memories'}`
      : 'no memory',
    agent.routines.length ? plural(agent.routines.length, 'routine') : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function Chip({ agent }: { agent: PasteImportAgent }) {
  const [kind, label] = agent.isMain
    ? ['main', 'Merges into Chief of Staff']
    : agent.existing
      ? ['update', 'Updates']
      : ['new', 'New'];
  return (
    <span className="agents-import-chip" data-kind={kind}>
      {label}
    </span>
  );
}

function AgentDetail({ agent }: { agent: PasteImportAgent }) {
  return (
    <div className="agents-import-agent__detail">
      <section>
        <h4>Instructions</h4>
        {agent.instructions ? (
          <p className="agents-import-agent__instructions">{agent.instructions}</p>
        ) : (
          <p className="agents-import-agent__none">None came across.</p>
        )}
      </section>
      <section>
        <h4>Memory</h4>
        {agent.memory.length ? (
          <ul className="agents-import-agent__memory">
            {agent.memory.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        ) : (
          <p className="agents-import-agent__none">Nothing remembered yet.</p>
        )}
      </section>
      {agent.routines.length > 0 && (
        <section>
          <h4>Routines</h4>
          <ul className="agents-import-agent__routines">
            {agent.routines.map((r, i) => (
              <li key={i} data-refused={r.refused ? '' : undefined}>
                {r.refused ? <WarningIcon size={12} /> : <CheckIcon size={12} />}
                <span>
                  {r.refused ? (
                    <>
                      Won’t be set: &ldquo;{r.when}&rdquo;. {r.refused}
                    </>
                  ) : (
                    <>
                      <strong>{r.schedule}</strong> {r.what}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function AgentRow({ agent, mainName }: { agent: PasteImportAgent; mainName: string }) {
  const [open, setOpen] = useState(false);
  const refused = agent.routines.filter((r) => r.refused).length;
  return (
    <li className="agents-import-agent" data-open={open || undefined}>
      {/* A large disclosure surface, not an action: a raw button by design. */}
      <button
        type="button"
        className="agents-import-agent__row"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <AgentAvatar
          // The main one becomes the Chief of Staff, so it wears that badge.
          name={agent.isMain ? mainName : agent.name}
          color={agent.color ?? 'gray'}
        />
        <span className="agents-import-agent__text">
          <span className="agents-import-agent__name">
            <span className="agents-import-agent__name-text">{agent.name}</span>
            <Chip agent={agent} />
          </span>
          {agent.role && <span className="agents-import-agent__role">{agent.role}</span>}
          <span className="agents-import-agent__counts">
            {counts(agent)}
            {refused > 0 && (
              <span className="agents-import-agent__warn">
                {' · '}
                {refused === 1 ? '1 won’t be set' : `${refused} won’t be set`}
              </span>
            )}
          </span>
        </span>
        <ChevronRightIcon size={12} className="agents-import-agent__chevron" />
      </button>
      <div className="agents-import-agent__reveal">
        <div>{open && <AgentDetail agent={agent} />}</div>
      </div>
    </li>
  );
}

/** Calm and specific: what's wrong, where, and the easiest way out. */
export function ImportProblems({ title, items }: { title: string; items: ReactNode[] }) {
  return (
    <div className="agents-import-problems" role="alert">
      <WarningIcon size={14} className="agents-import-problems__icon" />
      <div>
        <p className="agents-import-problems__title">{title}</p>
        <ul>
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function ImportPreview({ preview }: { preview: PasteImportPreview }) {
  const { agents, problems, source, blocks } = preview;
  const mainName = useAgents().agents.find((a) => a.isMain)?.name ?? 'Chief of Staff';
  const refused = agents.reduce((n, a) => n + a.routines.filter((r) => r.refused).length, 0);
  return (
    <div className="agents-import-preview" aria-live="polite">
      {problems.length > 0 && (
        <ImportProblems
          title={
            problems.length === 1
              ? 'One thing to fix before this can come across'
              : `${problems.length} things to fix before this can come across`
          }
          items={[
            ...problems,
            <span key="hint" className="agents-import-problems__hint">
              Easiest fix: send these lines to your assistant and paste its new reply.
            </span>,
          ]}
        />
      )}
      {agents.length > 0 && (
        <>
          <p className="agents-import-preview__found">
            <strong>{plural(agents.length, 'agent')}</strong>
            {source ? ` from ${source}` : ''}
            {blocks > 1 ? `, in ${blocks} parts` : ''}
            {refused > 0 && (
              <span className="agents-import-agent__warn">
                {' · '}
                {plural(refused, 'routine')} can’t be set as written
              </span>
            )}
          </p>
          <ul className="agents-import-preview__list">
            {agents.map((a) => (
              <AgentRow key={`${a.isMain}-${a.name}`} agent={a} mainName={mainName} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

interface ImportDoneProps {
  summary: ImportSummary;
  agents: PasteImportAgent[];
}

/** A short celebration, what happened in one line, and what to do next. */
export function ImportDone({ summary, agents }: ImportDoneProps) {
  const team = useAgents().agents;
  const mainName = team.find((a) => a.isMain)?.name ?? 'Chief of Staff';
  const skipped = new Set(summary.skipped.map(([name]) => name));
  const arrived = agents.filter((a) => !skipped.has(a.name));
  const line = [
    summary.created.length ? `${plural(summary.created.length, 'new agent')}` : '',
    summary.updated.length ? `${summary.updated.length} updated` : '',
    summary.routinesSet.length ? `${plural(summary.routinesSet.length, 'routine')} set` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="agents-import-done" role="status">
      <span className="agents-import-done__mark" aria-hidden>
        <CheckIcon size={22} />
      </span>
      <h3 className="agents-import-done__title">
        {arrived.length ? 'Your team is here' : 'Nothing came across'}
      </h3>
      {line && <p className="agents-import-done__line">{line}</p>}
      {arrived.length > 0 && (
        <ul className="agents-import-done__team" aria-label="Imported agents">
          {arrived.map((a) => {
            const name = a.isMain ? mainName : a.name;
            return (
              <li key={`${a.isMain}-${a.name}`}>
                <AgentAvatar name={name} color={a.color ?? 'gray'} size="mini" />
                {name}
              </li>
            );
          })}
        </ul>
      )}
      {(summary.skipped.length > 0 || summary.routinesRefused.length > 0) && (
        <ImportProblems
          title="A few things didn’t come across"
          items={[
            ...summary.skipped.map(([name, why]) => (
              <>
                <strong>{name}</strong> wasn’t imported. {why}
              </>
            )),
            ...summary.routinesRefused.map((r) => (
              <>
                <strong>{r.agent}</strong>: &ldquo;{r.when}&rdquo; wasn’t scheduled. {r.detail}
              </>
            )),
            ...(summary.routinesRefused.length
              ? [
                  <span key="hint" className="agents-import-problems__hint">
                    Ask {listOf([...new Set(summary.routinesRefused.map((r) => r.agent))])} to
                    schedule {summary.routinesRefused.length === 1 ? 'it' : 'them'} in plain words.
                  </span>,
                ]
              : []),
          ]}
        />
      )}
      <p className="agents-import-done__next">
        <strong>Say hi to your team.</strong> They start when you message them; routines run while
        Ship Studio is open.
      </p>
    </div>
  );
}
