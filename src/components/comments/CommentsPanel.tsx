import { commentTargetLabel, commentScopeLabel } from '../../lib/canvasComments';
/** Moveable backlog panel; its overlay leaves the preview viewport unchanged. */
import { useState, type ReactNode } from 'react';
import { DockablePanel } from '../primitives/DockablePanel';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { TrashIcon } from '@/components/icons';
import { type CanvasComment, type CommentAgent } from '../../lib/canvasComments';

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
          props.composing ? 350 : props.comments.length ? 460 : 130,
          window.innerHeight - 128
        ),
      }}
      initialPosition={() => ({ left: window.innerWidth - 344, top: 110 })}
      surfaceClassName="canvas-comments-panel"
    >
      <header className="canvas-comments-header" data-dockable-drag-handle>
        <strong>Comments</strong>
        <Button variant="ghost" size="compact" onClick={props.onClose}>
          Close
        </Button>
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
        {!props.composing && props.comments.length > 0 && (
          <>
            {visible.some((c) => c.status === 'pending') && (
              <Button variant="ghost" size="compact" onClick={props.selectAll}>
                Select all
              </Button>
            )}
            {pages.map((page) => (
              <section key={page} className="canvas-comments-group">
                <h3>{page}</h3>
                {visible
                  .filter((c) => c.target.page === page)
                  .map((c) => (
                    <article className="canvas-comment-card" key={c.id}>
                      <div className="canvas-comments-row">
                        {c.status === 'pending' && (
                          <input
                            type="checkbox"
                            aria-label={`Include comment: ${c.body}`}
                            checked={!props.excluded.has(c.id)}
                            onChange={() => props.toggle(c.id)}
                          />
                        )}
                        <Button variant="ghost" size="compact" onClick={() => props.onLocate(c)}>
                          {commentTargetLabel(c.target)}
                        </Button>
                      </div>
                      <p className="canvas-comment-body">{c.body}</p>
                      <span className="canvas-comments-hint">
                        {c.target.viewport.width}px · Applies to {commentScopeLabel(c.scope)}
                      </span>
                      {c.status === 'sent' && (
                        <span className="canvas-comments-hint">Sent to {c.sentTo}.</span>
                      )}
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
        {review && !props.composing && (
          <pre className="canvas-comments-prompt">
            {props.prompt || 'Select pending comments to preview the prompt.'}
          </pre>
        )}
      </div>
      {!props.composing && props.comments.some((c) => c.status === 'pending') && (
        <footer className="canvas-comments-footer">
          <label>
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
          <p className="canvas-comments-hint">Press Enter in the terminal to start.</p>
        </footer>
      )}
    </DockablePanel>
  );
}
