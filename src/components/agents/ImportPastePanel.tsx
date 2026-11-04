/**
 * Import by copy and paste: the path that needs no remote access.
 *
 * The user sends their other assistant a message asking for its agents as
 * JSON, then pastes the whole reply here. Rust finds and checks the JSON
 * (`agents/paste.rs`), this shows what would be imported or exactly what's
 * wrong, and the import goes through the same merge as the `import_agents`
 * tool.
 *
 * @module components/agents/ImportPastePanel
 */

import { useEffect, useState } from 'react';
import { Button } from '../primitives/Button';
import { TextArea } from '../primitives/TextField';
import { useAsyncState } from '../../hooks/useAsyncState';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  getPasteImportPrompt,
  importPaste,
  previewPasteImport,
  type ImportSummary,
  type PasteImportAgent,
  type PasteImportPreview,
} from '../../lib/agents';

/** Long enough that a paste lands in one check, short enough to feel live. */
const PREVIEW_DELAY_MS = 200;

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function tagFor(agent: PasteImportAgent) {
  if (agent.isMain) return 'Merges into Chief of Staff';
  return agent.existing ? 'Updates existing' : 'New';
}

function detailFor(agent: PasteImportAgent) {
  const instructions = agent.instructionsChars
    ? `${plural(agent.instructionsChars, 'character')} of instructions`
    : 'No instructions';
  const parts = [instructions, plural(agent.memoryLines, 'memory line')];
  if (agent.routines.length) parts.push(plural(agent.routines.length, 'routine'));
  return parts.join(' · ');
}

/** Each routine: what it becomes, or the phrase that won't be set and why. */
function RoutineList({ agent }: { agent: PasteImportAgent }) {
  if (!agent.routines.length) return null;
  return (
    <ul className="agents-import__routines">
      {agent.routines.map((r, i) =>
        r.refused ? (
          <li key={i} className="agents-import__routine" data-refused="">
            Won&apos;t be set: &ldquo;{r.when}&rdquo;. {r.refused}
          </li>
        ) : (
          <li key={i} className="agents-import__routine">
            {r.schedule}: {r.what}
          </li>
        )
      )}
    </ul>
  );
}

function doneText(done: ImportSummary) {
  return [
    done.created.length ? `Created ${done.created.join(', ')}.` : '',
    done.updated.length ? `Updated ${done.updated.join(', ')}.` : '',
    ...done.skipped.map(([name, why]) => `Skipped ${name}: ${why}`),
    done.routinesSet.length ? `Set ${plural(done.routinesSet.length, 'routine')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function PreviewList({ preview }: { preview: PasteImportPreview }) {
  const { agents, problems, source, blocks } = preview;
  const refused = agents.reduce((n, a) => n + a.routines.filter((r) => r.refused).length, 0);
  return (
    <div className="agents-import__preview" aria-live="polite">
      {problems.length > 0 && (
        <div className="agents-import__problems" role="alert">
          <span>Can&apos;t import this yet:</span>
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {agents.length > 0 && (
        <>
          <span className="agents-import__found">
            {plural(agents.length, 'agent')}
            {source ? ` from ${source}` : ''}
            {blocks > 1 ? `, in ${blocks} parts` : ''}
            {refused > 0 &&
              `. ${plural(refused, 'routine')} can't be set as written; the rest import fine.`}
          </span>
          <ul className="agents-import__list">
            {agents.map((a) => (
              <li key={a.name} className="agents-import__agent">
                <div className="agents-import__agent-text">
                  <span className="agents-import__agent-name">{a.name}</span>
                  {a.role && <span className="agents-import__agent-role">{a.role}</span>}
                  <span className="agents-import__agent-detail">{detailFor(a)}</span>
                  <RoutineList agent={a} />
                </div>
                <span className="agents-import__tag" data-main={a.isMain || undefined}>
                  {tagFor(a)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function ImportPastePanel({ onClose }: { onClose: () => void }) {
  const [prompt, setPrompt] = useState('');
  const [text, setText] = useState('');
  const [checked, setChecked] = useState<{ text: string; preview: PasteImportPreview } | null>(
    null
  );
  const { copy, isCopied } = useCopyToClipboard();
  const importer = useAsyncState(async (pasted: string) => {
    try {
      return { text: pasted, summary: await importPaste(pasted) };
    } catch (e) {
      // A paste that changed after its preview: show the problems, not the wrapper.
      const err = asCommandError(e);
      throw new Error(err.type === 'Validation' ? err.reason : formatCommandError(err));
    }
  });

  useEffect(() => {
    void getPasteImportPrompt()
      .then(setPrompt)
      .catch(() => setPrompt(''));
  }, []);

  useEffect(() => {
    if (!text.trim()) return;
    let live = true;
    const timer = setTimeout(() => {
      previewPasteImport(text)
        .then((preview) => live && setChecked({ text, preview }))
        .catch(
          (e: unknown) =>
            live &&
            setChecked({
              text,
              preview: {
                source: '',
                blocks: 0,
                agents: [],
                problems: [formatCommandError(asCommandError(e))],
              },
            })
        );
    }, PREVIEW_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text]);

  const preview = text.trim() ? checked?.preview : null;
  const current = checked?.text === text;
  const ready = current && !!preview && preview.problems.length === 0 && preview.agents.length > 0;
  const done = importer.data?.text === text ? importer.data.summary : null;

  return (
    <div className="agents-import__body">
      <p>
        Works with Grok Bot or any other assistant. It writes out its agents, with their
        instructions and memory, and you paste that here. They then run on Claude Code on this Mac.
      </p>
      <ol className="agents-import__steps">
        <li>
          <div className="agents-import__step">
            <span>Send it this message.</span>
            <Button
              variant="secondary"
              size="compact"
              onClick={() => void copy(prompt)}
              disabled={!prompt}
            >
              {isCopied ? 'Copied' : 'Copy message'}
            </Button>
          </div>
          {/* Once a reply is in, step 1 is done: its text gives the room to the preview. */}
          {!text && (
            <blockquote className="agents-import__prompt agents-import__prompt--long" tabIndex={0}>
              {prompt}
            </blockquote>
          )}
        </li>
        <li>
          <label className="agents-import__step-label" htmlFor="agents-import-paste">
            Paste its whole reply. If it came in parts, paste them all.
          </label>
          <TextArea
            id="agents-import-paste"
            className="agents-import__paste"
            rows={4}
            spellCheck={false}
            placeholder="Paste here. The text around the code is fine."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </li>
      </ol>
      {done ? (
        <div className="agents-import__done" role="status">
          <p>
            {doneText(done)} They don&apos;t start working until you message them, apart from their
            routines, which run while Ship Studio is open.
          </p>
          {done.routinesRefused.length > 0 && (
            <div className="agents-import__problems">
              <span>These routines weren&apos;t set. Ask the agent to schedule them:</span>
              <ul>
                {done.routinesRefused.map((r, i) => (
                  <li key={i}>
                    {r.agent}: &ldquo;{r.when}&rdquo; ({r.what}). {r.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        preview && <PreviewList preview={preview} />
      )}
      {importer.error && (
        <p className="agents-import__error" role="alert">
          {importer.error.message}
        </p>
      )}
      <p className="agents-import__note">
        Pasting again later updates the same agents rather than making copies. Connections that
        assistant has (its email, calendar and so on) don&apos;t come across.
      </p>
      <div className="agents-import__actions">
        {done ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!ready || importer.isLoading}
              onClick={() => void importer.execute(text)}
            >
              {ready && preview ? `Import ${plural(preview.agents.length, 'agent')}` : 'Import'}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
