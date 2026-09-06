/**
 * The batch bar for pinned comments.
 *
 * The notes themselves live on the page — each one pinned to its element (see
 * `CommentPins`), which is where they are read, edited and deleted. What is
 * left here is only what is about the batch rather than any one note: how many
 * are selected, how much context to send, which terminal to send to, and the
 * handoff itself.
 */
import { useState } from 'react';
import { DockablePanel } from '../primitives/DockablePanel';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { EmptyState } from '../primitives/EmptyState';
import { CloseIcon, CommentIcon } from '@/components/icons';
import {
  commentElementName,
  COMMENT_DETAILS,
  type CanvasComment,
  type CommentAgent,
  type CommentDetail,
} from '../../lib/canvasComments';

interface Props {
  comments: CanvasComment[];
  agents: CommentAgent[];
  agentId: number | null;
  setAgentId: (id: number) => void;
  excluded: Set<string>;
  selectAll: () => void;
  clearSelection: () => void;
  selectedCount: number;
  onClose: () => void;
  onLocate: (comment: CanvasComment) => void;
  onSend: () => void;
  onCopy: () => void;
  detail: CommentDetail;
  setDetail: (detail: CommentDetail) => void;
  sending: boolean;
  disabled: boolean;
  message: string;
  error?: string | null;
  hidden?: boolean;
  prompt: string;
}
export function CommentsPanel(props: Props) {
  const [review, setReview] = useState(false);
  const pending = props.comments.filter((c) => c.status === 'pending');
  const allSelected = props.selectedCount === pending.length;
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
        width: 300,
        height: Math.min(pending.length ? 330 : 190, window.innerHeight - 128),
      }}
      initialPosition={() => ({ left: window.innerWidth - 324, top: 110 })}
      surfaceClassName="canvas-comments-panel"
    >
      <header className="canvas-comments-header" data-dockable-drag-handle>
        <span className="canvas-comments-title">
          Comments
          {pending.length > 0 && (
            <span className="canvas-comments-count">{pending.length} pending</span>
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
        {props.comments.length === 0 && !props.error && (
          <EmptyState
            className="canvas-comments-empty"
            icon={<CommentIcon size={20} />}
            title="No comments yet"
            description="Click any element in the preview to leave a note. It stays pinned there. Nothing reaches an agent until you send the batch."
          />
        )}
        {pending.length > 0 && (
          <>
            <div className="canvas-comments-selection">
              <span className="canvas-comments-hint">
                {props.selectedCount} of {pending.length} selected
              </span>
              <Button
                variant="ghost"
                size="compact"
                onClick={allSelected ? props.clearSelection : props.selectAll}
              >
                {allSelected ? 'Clear selection' : 'Select all'}
              </Button>
            </div>
            {/* Jumping to a note is a batch-level need: a pin you cannot see
                because it is on another route or below the fold. */}
            <ul className="canvas-comments-jump">
              {pending.map((c) => (
                <li key={c.id}>
                  <Button
                    variant="ghost"
                    size="compact"
                    width="fill"
                    className="canvas-comments-jump__item"
                    title={`Show comment ${c.number} in the preview`}
                    onClick={() => props.onLocate(c)}
                  >
                    <span className="canvas-comment-pin" aria-hidden>
                      {c.number}
                    </span>
                    <span className="canvas-comments-jump__label">
                      {commentElementName(c.target)}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {pending.length > 0 && (
        <footer className="canvas-comments-footer">
          {review && (
            <pre className="canvas-comments-prompt">
              {props.prompt || 'Select pending comments to preview the prompt.'}
            </pre>
          )}
          <label className="canvas-comments-agent">
            <span className="canvas-comments-hint">Context sent</span>
            <SegmentedControl<CommentDetail>
              aria-label="Context sent"
              value={props.detail}
              onValueChange={props.setDetail}
              options={COMMENT_DETAILS.map((d) => ({
                value: d,
                label: d[0].toUpperCase() + d.slice(1),
              }))}
            />
          </label>
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
