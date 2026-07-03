/**
 * "Request a change" section of the unified visual-editor panel — a
 * self-contained requests manager. It is rendered for the whole edit mode (not
 * gated on a selection): the direct style/text/image controls handle what the
 * editor can write itself, and this section captures everything else as
 * free-form notes for the coding agent.
 *
 * Three stacked parts:
 *   1. Add-box — a draft textarea + an "Add request" button gated on `canAdd`
 *      (a selection exists). Pressing it hands the label up via `onAddRequest`;
 *      the host mints the numbered badge through `useRedline.addRequestForSelection`.
 *   2. List — the pending requests, each with its number badge, an inline-editable
 *      label (or before/after text for a text edit), the resolved source line, and
 *      a delete. Clicking a row focuses its badge in the preview.
 *   3. Send — one primary button that ships every pending request to the agent
 *      (screenshot + markdown), then self-clears the queue on success.
 *
 * The request-row + label-editor markup is migrated from the commit tray and
 * reuses its `ss-redline-panel__*` classes (still shipped via index.css). The
 * only local state is which row is being edited inline.
 */

import { useCallback, useState, type CSSProperties } from 'react';
import { Button } from '../primitives/Button';
import { PropSection } from './PropSection';
import type { RedlineAnnotation } from '../../lib/redline';

interface Props {
  /** Record a change request for the current selection. The host attaches the
   *  selection's signature/locator/source location and draws the badge. */
  onAddRequest: (label: string) => void;
  /** Whether a request can be added right now — true when an element is
   *  selected in the preview. Gates the "Add request" button. */
  canAdd: boolean;
  /** Every change request captured so far, awaiting the batched send. */
  pendingRequests: RedlineAnnotation[];
  /** Commit a new label for a request row. */
  onEditRequestLabel: (id: string, text: string) => void;
  /** Drop one change request (removes its badge in the host). */
  onDiscardRequest: (id: string) => void;
  /** Scroll/flash the request's badge in the preview. */
  onFocusRequest?: (id: string) => void;
  /** Ship every pending request to the agent (screenshot + markdown). The host
   *  self-clears the queue on success. */
  onSendRequests: () => void;
  /** True while the send is in flight — disables the action. */
  sending: boolean;
}

const TEXTAREA_BASE: CSSProperties = {
  width: '100%',
  minHeight: '54px',
  maxHeight: '160px',
  resize: 'vertical',
  padding: 'var(--spacing-sm)',
  fontFamily: 'inherit',
  fontSize: 'var(--font-size-base)',
  lineHeight: 1.5,
  color: 'var(--text-primary)',
  background: 'var(--bg-tertiary)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  outline: 'none',
};

/** Resolved source as `file:line`, or the dynamic fallback. */
function requestSource(annotation: RedlineAnnotation): string {
  const loc = annotation.resolvedLocation;
  return loc ? `${loc.file}:${loc.line}` : 'dynamic — agent will locate';
}

interface LabelEditorProps {
  initialLabel: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
}

/** Inline label editor for a request row — mounted only while a row is editing
 *  (keyed on the row id by the parent), so its `useState` initializer seeds the
 *  draft from the current label. Focus + select happen in a ref callback.
 *  Migrated from the commit tray. */
function RequestLabelEditor({ initialLabel, onCommit, onCancel }: LabelEditorProps) {
  const [draft, setDraft] = useState(initialLabel);

  const commit = useCallback(() => onCommit(draft.trim()), [onCommit, draft]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    },
    [commit, onCancel]
  );

  return (
    <input
      ref={(el) => {
        if (el) {
          el.focus();
          el.select();
        }
      }}
      className="ss-redline-panel__label-input"
      value={draft}
      placeholder="Describe the change…"
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

interface RequestRowProps {
  annotation: RedlineAnnotation;
  isEditing: boolean;
  onStartEdit: (id: string) => void;
  onCommitEdit: (id: string, text: string) => void;
  onCancelEdit: () => void;
  onDiscard: (id: string) => void;
  onFocus?: (id: string) => void;
}

/** One pending request row: number badge + (inline-editable) label or text-edit
 *  pair + source line + discard. Click the body to focus the badge in the
 *  preview. Migrated from the commit tray. */
function RequestRow({
  annotation,
  isEditing,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onDiscard,
  onFocus,
}: RequestRowProps) {
  const isText = annotation.kind === 'textedit';
  const labelText = annotation.label.trim();

  return (
    <li className="ss-redline-panel__row">
      <span className={`ss-redline-panel__badge${isText ? ' ss-redline-panel__badge--text' : ''}`}>
        {annotation.number}
      </span>

      <div
        className="ss-redline-panel__main"
        role="button"
        tabIndex={0}
        onClick={() => onFocus?.(annotation.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onFocus?.(annotation.id);
          }
        }}
      >
        {isText ? (
          <div className="ss-redline-panel__textedit">
            <span className="ss-redline-panel__text-old" title={annotation.oldText}>
              {annotation.oldText || '(empty)'}
            </span>
            <span className="ss-redline-panel__text-arrow" aria-hidden>
              →
            </span>
            <span className="ss-redline-panel__text-new" title={annotation.newText}>
              {annotation.newText || '(empty)'}
            </span>
          </div>
        ) : isEditing ? (
          <RequestLabelEditor
            initialLabel={annotation.label}
            onCommit={(text) => onCommitEdit(annotation.id, text)}
            onCancel={onCancelEdit}
          />
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className={`ss-redline-panel__label${labelText ? '' : ' ss-redline-panel__label--empty'}`}
            title="Click to edit"
            onClick={(e) => {
              e.stopPropagation();
              onStartEdit(annotation.id);
            }}
          >
            {labelText || 'Describe the change…'}
          </Button>
        )}

        <div className="ss-redline-panel__meta">
          <code className="ss-redline-panel__source">{requestSource(annotation)}</code>
        </div>
      </div>

      <div className="ss-redline-panel__actions ss-commit-tray__row-actions">
        <button
          type="button"
          className="ss-redline-panel__action ss-redline-panel__action--delete"
          title="Discard this request"
          aria-label="Discard change request"
          onClick={() => onDiscard(annotation.id)}
        >
          <DiscardIcon />
        </button>
      </div>
    </li>
  );
}

function DiscardIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M18 6 6 18M6 6l12 12"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function RequestChangeSection({
  onAddRequest,
  canAdd,
  pendingRequests,
  onEditRequestLabel,
  onDiscardRequest,
  onFocusRequest,
  onSendRequests,
  sending,
}: Props) {
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  // The only persistent local state: which request row's label is editing inline.
  const [editingId, setEditingId] = useState<string | null>(null);

  const trimmed = draft.trim();
  const canSubmitDraft = canAdd && trimmed.length > 0;

  const add = () => {
    if (!canSubmitDraft) return;
    onAddRequest(trimmed);
    setDraft('');
  };

  const handleCommitEdit = useCallback(
    (id: string, text: string) => {
      onEditRequestLabel(id, text);
      setEditingId(null);
    },
    [onEditRequestLabel]
  );

  const count = pendingRequests.length;

  return (
    <PropSection title="Request a change" defaultOpen>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
        <label className="ss-edit-panel__label">
          Describe a change for your agent. Add as many as you need, then send them all at once.
        </label>
        <textarea
          value={draft}
          spellCheck={false}
          placeholder="Describe the change for your agent…"
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter adds without leaving the field (Enter alone is a newline).
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          style={focused ? { ...TEXTAREA_BASE, borderColor: 'var(--action)' } : TEXTAREA_BASE}
        />
        <Button variant="primary" size="sm" block disabled={!canSubmitDraft} onClick={add}>
          Add request
        </Button>
        {!canAdd && (
          <span className="ss-edit-panel__hint">
            Select an element in the preview to request a change.
          </span>
        )}

        {count > 0 && (
          <>
            <label className="ss-edit-panel__label">
              {count} pending {count === 1 ? 'request' : 'requests'}
            </label>
            <ul className="ss-redline-panel__list">
              {pendingRequests.map((annotation) => (
                <RequestRow
                  key={annotation.id}
                  annotation={annotation}
                  isEditing={editingId === annotation.id}
                  onStartEdit={setEditingId}
                  onCommitEdit={handleCommitEdit}
                  onCancelEdit={() => setEditingId(null)}
                  onDiscard={onDiscardRequest}
                  onFocus={onFocusRequest}
                />
              ))}
            </ul>
          </>
        )}

        <Button variant="primary" block disabled={sending || count === 0} onClick={onSendRequests}>
          {sending ? 'Sending…' : `Send ${count} request${count === 1 ? '' : 's'} to agent`}
        </Button>
      </div>
    </PropSection>
  );
}
