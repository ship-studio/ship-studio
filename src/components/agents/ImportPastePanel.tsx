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
import { TextButton } from '../primitives/TextButton';
import { TextArea } from '../primitives/TextField';
import { useAsyncState } from '../../hooks/useAsyncState';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  getPasteImportPrompt,
  importPaste,
  previewPasteImport,
  type ImportSummary,
  type PasteImportAgent,
  type PasteImportPreview,
} from '../../lib/agents';
import { ImportPreview, ImportStep, MessageCard, plural } from './ImportParts';

/** Long enough that a paste lands in one check, short enough to feel live. */
const PREVIEW_DELAY_MS = 200;

export interface ImportResult {
  summary: ImportSummary;
  agents: PasteImportAgent[];
}

interface ImportPastePanelProps {
  onCancel: () => void;
  onDone: (result: ImportResult) => void;
}

export function ImportPastePanel({ onCancel, onDone }: ImportPastePanelProps) {
  const [prompt, setPrompt] = useState('');
  const [copied, setCopied] = useState(false);
  const [showMessage, setShowMessage] = useState(false);
  const [text, setText] = useState('');
  const [checked, setChecked] = useState<{ text: string; preview: PasteImportPreview } | null>(
    null
  );
  const importer = useAsyncState(async (pasted: string, agents: PasteImportAgent[]) => {
    try {
      const summary = await importPaste(pasted);
      onDone({ summary, agents });
      return summary;
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

  const pasted = !!text.trim();
  const preview = pasted ? checked?.preview : null;
  const current = checked?.text === text;
  const ready = current && !!preview && preview.problems.length === 0 && preview.agents.length > 0;

  return (
    <>
      <div className="agents-import__body">
        <p className="agents-import__lede">
          Bring your agents over with their instructions, memory and routines. It takes about two
          minutes, and they run on Claude Code on this Mac.
        </p>
        <ol className="agents-import-steps">
          <ImportStep
            n={1}
            state={copied || pasted ? 'done' : 'current'}
            title="Ask your assistant for its agents"
            // Once a reply is in, this step has done its job and folds away.
            folded={pasted && !showMessage}
            aside={
              pasted && (
                <TextButton onClick={() => setShowMessage((s) => !s)}>
                  {showMessage ? 'Hide message' : 'Show message'}
                </TextButton>
              )
            }
          >
            <MessageCard
              message={prompt}
              lead={!pasted}
              autoFocus
              onCopied={() => setCopied(true)}
            />
          </ImportStep>
          <ImportStep n={2} state={copied || pasted ? 'current' : 'todo'} title="Paste its reply">
            <TextArea
              id="agents-import-paste"
              aria-label="The assistant's reply"
              className="agents-import__paste"
              rows={pasted ? 4 : 7}
              spellCheck={false}
              placeholder={
                'Paste the whole reply here.\n\nIf it came in several parts, paste them all. The text around the code is fine.'
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            {preview && <ImportPreview preview={preview} />}
            {importer.error && (
              <p className="agents-import__error" role="alert">
                {importer.error.message}
              </p>
            )}
          </ImportStep>
        </ol>
      </div>
      <footer className="agents-import__footer">
        <p className="agents-import__note">
          Running it again updates the same agents. Apps your assistant is connected to, like email
          and calendar, stay behind.
        </p>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!ready || importer.isLoading}
          onClick={() => preview && void importer.execute(text, preview.agents)}
        >
          {ready && preview ? `Import ${plural(preview.agents.length, 'agent')}` : 'Import'}
        </Button>
      </footer>
    </>
  );
}
