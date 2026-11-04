/**
 * What an agent remembers, as items you can add to, edit and delete: the
 * `## Memory` section of its CLAUDE.md (`agents/memory.rs`), which the agent
 * also maintains itself. Imported memory sits under its own heading.
 *
 * Changes apply at once, like revoking a permission: memory isn't a draft.
 * Deleting or editing offers Undo in a toast. An entry the agent rewrote
 * since this list was read is refused by the backend, and the list reloads
 * to show it as it is now.
 *
 * @module components/agents/AgentMemory
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { EditFieldIcon, TrashIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { TextArea } from '../primitives/TextField';
import { Spinner } from '../primitives/Spinner';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  changeAgentMemory,
  getAgentMemory,
  groupMemory,
  undoDelete,
  type Agent,
  type MemoryChange,
  type MemoryEntry,
} from '../../lib/agents';

/** "Return saves, Shift-Return for a new line", Esc leaves. */
function editKeys(onSave: () => void, onCancel?: () => void) {
  return (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSave();
    } else if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };
}

const clip = (text: string, max = 48) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

export function AgentMemory({ agent }: { agent: Agent }) {
  const { showToast } = useOptionalToast();
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  // Set on mount too: StrictMode mounts twice, and the first cleanup ran.
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    try {
      const view = await getAgentMemory(agent.id);
      if (live.current) setEntries(view.entries);
    } catch (err) {
      if (live.current) setError(formatCommandError(asCommandError(err)));
    }
  }, [agent.id]);
  useEffect(() => void reload(), [reload]);

  /** Apply a change; on a refusal, say why and show the memory as it is now. */
  const apply = async (change: MemoryChange) => {
    setBusy(true);
    setError(null);
    try {
      const view = await changeAgentMemory(agent.id, change);
      if (live.current) setEntries(view.entries);
      return view;
    } catch (err) {
      if (live.current) setError(formatCommandError(asCommandError(err)));
      await reload();
      return null;
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const remove = async (index: number) => {
    if (!entries) return;
    const before = entries;
    const entry = before[index];
    const view = await apply({ op: 'delete', index, original: entry.text });
    if (!view) return;
    showToast(`Forgot “${clip(entry.text)}”`, 'info', {
      label: 'Undo',
      onClick: () => void apply(undoDelete(before, index, view.removed)),
    });
  };

  const saveEdit = async (index: number) => {
    if (!entries) return;
    const original = entries[index].text;
    const text = draft.trim();
    if (!text || text === original) {
      setEditing(null);
      return;
    }
    const view = await apply({ op: 'edit', index, original, text });
    if (!view) return;
    setEditing(null);
    const now = view.entries[index]?.text ?? text;
    showToast('Memory updated', 'info', {
      label: 'Undo',
      onClick: () => void apply({ op: 'edit', index, original: now, text: original }),
    });
  };

  const add = async () => {
    const text = adding.trim();
    if (!text) return;
    const view = await apply({ op: 'add', text });
    if (view) setAdding('');
  };

  if (entries === null) {
    return (
      <div className="agent-memory agent-memory--loading">
        {error ? <p className="agent-editor__error">{error}</p> : <Spinner size="sm" />}
      </div>
    );
  }

  const groups = groupMemory(entries);
  return (
    <div className="agent-memory">
      <p className="agent-editor__hint">
        What {agent.name} remembers between conversations. It reads this at the start of every one,
        and keeps it up to date itself.
      </p>
      {groups.map((group) => (
        <section
          key={group.title ?? ''}
          className="agent-memory__group"
          aria-label={group.title ?? `${agent.name}'s memory`}
        >
          {group.title && <h3 className="agent-memory__heading">{group.title}</h3>}
          {group.items.length === 0 ? (
            <p className="agent-memory__empty">
              Nothing yet. Add something below, or use “Remember this” on a message.
            </p>
          ) : (
            <ul className="agent-memory__list">
              {group.items.map(({ entry, index }) =>
                editing === index ? (
                  <li key={index} className="agent-memory__item" data-editing>
                    <TextArea
                      autoFocus
                      rows={Math.min(6, Math.max(2, draft.split('\n').length))}
                      value={draft}
                      disabled={busy}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={editKeys(
                        () => void saveEdit(index),
                        () => setEditing(null)
                      )}
                      aria-label="Edit memory"
                    />
                    <div className="agent-memory__edit-actions">
                      <Button size="compact" variant="ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                      <Button
                        size="compact"
                        variant="secondary"
                        disabled={busy || !draft.trim()}
                        onClick={() => void saveEdit(index)}
                      >
                        Save
                      </Button>
                    </div>
                  </li>
                ) : (
                  <li key={index} className="agent-memory__item">
                    <span className="agent-memory__text">{entry.text}</span>
                    <span className="agent-memory__actions">
                      <IconButton
                        tabIndex={0}
                        variant="ghost"
                        size="compact"
                        icon={<EditFieldIcon size={12} />}
                        disabled={busy}
                        onClick={() => {
                          setDraft(entry.text);
                          setEditing(index);
                        }}
                        title="Edit"
                        aria-label={`Edit “${clip(entry.text)}”`}
                      />
                      <IconButton
                        tabIndex={0}
                        variant="ghost"
                        size="compact"
                        icon={<TrashIcon size={12} />}
                        disabled={busy}
                        onClick={() => void remove(index)}
                        title="Forget"
                        aria-label={`Forget “${clip(entry.text)}”`}
                      />
                    </span>
                  </li>
                )
              )}
            </ul>
          )}
        </section>
      ))}
      <div className="agent-memory__add">
        <TextArea
          rows={1}
          value={adding}
          disabled={busy}
          placeholder={`Something ${agent.name} should remember`}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={editKeys(() => void add())}
          aria-label={`Add to ${agent.name}'s memory`}
        />
        <Button variant="secondary" disabled={busy || !adding.trim()} onClick={() => void add()}>
          Add
        </Button>
      </div>
      {error && (
        <p className="agent-editor__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
