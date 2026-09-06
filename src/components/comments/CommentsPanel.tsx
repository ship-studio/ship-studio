/** Moveable backlog panel; its overlay leaves the preview viewport unchanged. */
import { useState, type ReactNode } from 'react';
import { DockablePanel } from '../primitives/DockablePanel';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { EmptyState } from '../primitives/EmptyState';
import { TrashIcon, CloseIcon, CommentIcon } from '@/components/icons';
import {
  commentTargetLabel,
  commentScopeLabel,
  type CanvasComment,
  type CommentAgent,
} from '../../lib/canvasComments';

interface Props {
  composing: boolean;
  comments: CanvasComment[];
  children?: ReactNode;
  missing: string[];
  agents: CommentAgent[];
  agentId: number | null;
  setAgentId: (id: number) => void;
  excluded: Set<string>;
  toggle: (id: string) => void;
  selectAll: () => void;
  clearSelection: () => void;
  selectedCount: number;
  onClose: () => void;
  onLocate: (comment: CanvasComment) => void;
  onEdit: (comment: CanvasComment) => void;
  onDelete: (comment: CanvasComment) => void;
  onSend: () => void;
  onCopy: () => void;
  sending: boolean;
  disabled: boolean;
  message: string;
  error?: string | null;
  hidden?: boolean;
  prompt: string;
}
export function CommentsPanel(props: Props) {
  const [review, setReview] = useState(false);
  const visible = props.comments;
  const pages = [...new Set(visible.map((c) => c.target.page))];
  const pendingCount = visible.filter((c) => c.status === 'pending').length;
  const allSelected = props.selectedCount === pendingCount;
  return (
    <DockablePanel
      docked={false}
      visible={!props.hidden}
      ariaLabel="Canvas comments"
      positionKey="canvasComments.position"
      sizeKey="canvasComments.size"
      resizable={false}
      keepWithinViewport
      floatingSize={{
        width: 320,
        height: Math.min(
          props.composing ? 380 : props.comments.length ? 460 : 200,
          window.innerHeight - 128
        ),
      }}
      initialPosition={() => ({ left: window.innerWidth - 344, top: 110 })}
      surfaceClassName="canvas-comments-panel"
    >
      <header className="canvas-comments-header" data-dockable-drag-handle>
        <span className="canvas-comments-title">
          Comments
          {pendingCount > 0 && (
            <span className="canvas-comments-count">{pendingCount} pending</span>
          )}
        </span>
        <IconButton
          variant="ghost"
          size="compact"
          onClick={props.onClose}
          title="Close Comments panel"
          aria-label="Close Comments panel"
          icon={<CloseIcon size={14} />}
        />
      </header>
      <div className="canvas-comments-scroll">
        {props.message && (
          <p className="canvas-comments-hint" role="status">
            {props.message}
          </p>
        )}
        {props.error && (
          <p role="alert" className="canvas-comments-error">
            {props.error}
          </p>
        )}
        {props.children}
        {!props.composing && props.comments.length === 0 && !props.error && (
          <EmptyState
            className="canvas-comments-empty"
            icon={<CommentIcon size={20} />}
            title="No comments yet"
            description="Click any element in the preview to leave a note. Nothing is sent to an agent until you review the batch and choose Send."
          />
        )}
        {!props.composing && props.comments.length > 0 && (
          <>
            {pendingCount > 0 && (
              <div className="canvas-comments-selection">
                <span className="canvas-comments-hint">
                  {props.selectedCount} of {pendingCount} selected
                </span>
                <Button
                  variant="ghost"
                  size="compact"
                  onClick={allSelected ? props.clearSelection : props.selectAll}
                >
                  {allSelected ? 'Clear selection' : 'Select all'}
                </Button>
              </div>
            )}
            {pages.map((page) => (
              <section key={page} className="canvas-comments-group">
                <h3 title={page}>{page}</h3>
                {visible
                  .filter((c) => c.target.page === page)
                  .map((c) => (
                    <article className="canvas-comment-card" data-status={c.status} key={c.id}>
                      <div className="canvas-comment-card__head">
                        {c.status === 'pending' && (
                          <input
                            type="checkbox"
                            aria-label={`Include comment: ${c.body}`}
                            checked={!props.excluded.has(c.id)}
                            onChange={() => props.toggle(c.id)}
                          />
                        )}
                        <Button
                          variant="ghost"
                          size="compact"
                          className="canvas-comment-card__target"
                          title={`Find ${commentTargetLabel(c.target)} in the preview`}
                          onClick={() => props.onLocate(c)}
                        >
                          {commentTargetLabel(c.target)}
                        </Button>
                      </div>
                      <p className="canvas-comment-body">{c.body}</p>
                      <div className="canvas-comment-card__meta">
                        <span className="canvas-comments-hint">
                          Applies to {commentScopeLabel(c.scope)} · captured at{' '}
                          {c.target.viewport.width}px
                        </span>
                        {c.status === 'sent' && (
                          <span className="canvas-comments-sent">Sent to {c.sentTo}</span>
                        )}
                      </div>
                      {props.missing.includes(c.id) && (
                        <span className="canvas-comments-error">
                          Element not found. Choose Edit, then click a new element.
                        </span>
                      )}
                      <div className="canvas-comments-actions">
                        <Button size="compact" variant="ghost" onClick={() => props.onEdit(c)}>
                          Edit
                        </Button>
                        <IconButton
                          size="compact"
                          variant="ghost"
                          icon={<TrashIcon />}
                          aria-label={`Delete comment: ${c.body}`}
                          title="Delete comment"
                          disabled={props.sending}
                          onClick={() => props.onDelete(c)}
                        />
                      </div>
                    </article>
                  ))}
              </section>
            ))}
          </>
        )}
      </div>
      {!props.composing && pendingCount > 0 && (
        <footer className="canvas-comments-footer">
          {review && (
            <pre className="canvas-comments-prompt">
              {props.prompt || 'Select pending comments to preview the prompt.'}
            </pre>
          )}
          <label className="canvas-comments-agent">
            <span className="canvas-comments-hint">Send to</span>
            <select
              aria-label="Send to"
              value={props.agentId ?? ''}
              onChange={(e) => props.setAgentId(Number(e.target.value))}
            >
              <option value="" disabled>
                Choose an agent terminal
              </option>
              {props.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="primary"
            width="fill"
            disabled={
              props.disabled || props.sending || !props.selectedCount || props.agentId === null
            }
            onClick={props.onSend}
          >
            {props.sending ? 'Sending…' : 'Send comments to agent'}
          </Button>
          <div className="canvas-comments-row">
            <Button variant="ghost" size="compact" onClick={() => setReview(!review)}>
              {review ? 'Hide prompt' : 'Review prompt'}
            </Button>
            <Button
              variant="ghost"
              size="compact"
              disabled={!props.selectedCount}
              onClick={props.onCopy}
            >
              Copy prompt
            </Button>
          </div>
          <p className="canvas-comments-hint">
            Pastes into the terminal without running. Press Enter there to start.
          </p>
        </footer>
      )}
    </DockablePanel>
  );
}
