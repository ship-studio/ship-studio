/** Backlog composer: adding a note never invokes an agent. */
import { useState } from 'react';
import { Button } from '../primitives/Button';
import { TextArea } from '../primitives/TextField';
import {
  commentTargetLabel,
  type CommentTarget,
  type CanvasComment,
} from '../../lib/canvasComments';

interface Props {
  target: CommentTarget;
  existing?: CanvasComment;
  onSave: (body: string) => boolean;
  onCancel: () => void;
}
export function CommentComposer({ target, existing, onSave, onCancel }: Props) {
  const [body, setBody] = useState(existing?.body ?? '');
  return (
    <form
      className="canvas-comment-composer"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(body);
      }}
    >
      <div className="canvas-comments-context" aria-label="Selected element">
        <div className="canvas-comments-row">
          <code className="canvas-comments-tag">{`<${target.tag}>`}</code>
          <span>
            {target.viewport.width} × {target.viewport.height}
          </span>
        </div>
        <code title={target.selector}>{target.selector}</code>
        <span className="canvas-comments-target-text" title={commentTargetLabel(target)}>
          {target.heading || target.text || target.page}
        </span>
      </div>
      <p className="canvas-comments-hint">Click another element to change the target.</p>
      <TextArea
        aria-label="What should change?"
        autoFocus
        value={body}
        maxLength={8000}
        rows={3}
        placeholder="Please make this 80vh instead of 100vh."
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            if (body.trim()) onSave(body);
          }
        }}
      />
      {existing?.status === 'sent' && (
        <p className="canvas-comments-hint">Changes will be ready to send again.</p>
      )}
      <div className="canvas-comments-row">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!body.trim()}>
          Save comment
        </Button>
      </div>
    </form>
  );
}
