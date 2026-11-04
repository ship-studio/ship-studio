/**
 * "Remember this" on a message: the message as one line worth keeping,
 * summarised by Claude Code on Haiku (or its opening, if that can't run),
 * which you can edit before it goes into the agent's memory.
 *
 * @module components/agents/AgentRemember
 */

import { useEffect, useRef, useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { TextArea } from '../primitives/TextField';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useAsyncState } from '../../hooks/useAsyncState';
import { changeAgentMemory, suggestMemory, type Agent, type AgentMessage } from '../../lib/agents';

interface RememberModalProps {
  agent: Agent;
  /** The message to remember; the modal is open while there is one. */
  message: AgentMessage | null;
  onClose: () => void;
}

export function RememberModal({ agent, message, onClose }: RememberModalProps) {
  const { showToast } = useOptionalToast();
  const [text, setText] = useState('');
  const [summarising, setSummarising] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Once you've typed, a late summary doesn't overwrite you.
  const typed = useRef(false);

  useEffect(() => {
    if (!message) return;
    let live = true;
    suggestMemory(message.text)
      .then((line) => {
        if (live && !typed.current) setText(line);
      })
      .catch(() => undefined)
      .finally(() => live && setSummarising(false));
    return () => {
      live = false;
    };
  }, [message]);

  const save = useAsyncState(async () => {
    const fact = text.trim();
    if (!fact) return;
    setError(null);
    try {
      const view = await changeAgentMemory(agent.id, { op: 'add', text: fact });
      onClose();
      showToast(`${agent.name} will remember that`, 'success', {
        label: 'Undo',
        onClick: () => {
          const index = view.entries.map((e) => e.text).lastIndexOf(fact);
          if (index < 0) return;
          void changeAgentMemory(agent.id, { op: 'delete', index, original: fact }).catch(
            (err: unknown) => showToast(formatCommandError(asCommandError(err)), 'error')
          );
        },
      });
    } catch (err) {
      setError(formatCommandError(asCommandError(err)));
    }
  });

  const canSave = text.trim().length > 0 && !save.isLoading;
  return (
    <ModalFrame
      isOpen={Boolean(message)}
      onClose={onClose}
      title="Remember this"
      className="agent-remember"
    >
      <form
        className="agent-remember__body"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) void save.execute();
        }}
      >
        <TextArea
          autoFocus
          rows={3}
          value={text}
          placeholder={summarising ? 'Summarising…' : `What should ${agent.name} remember?`}
          onChange={(e) => {
            typed.current = true;
            setText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }}
          aria-label={`What ${agent.name} should remember`}
          aria-busy={summarising || undefined}
        />
        <p className="agent-editor__hint">
          Added to {agent.name}’s memory, which it reads at the start of every conversation. Edit or
          forget it any time under Edit agent → Memory.
        </p>
        {error && (
          <p className="agent-editor__error" role="alert">
            {error}
          </p>
        )}
        <div className="agent-editor__actions">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!canSave}>
            Remember
          </Button>
        </div>
      </form>
    </ModalFrame>
  );
}
