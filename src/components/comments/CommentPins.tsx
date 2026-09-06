/**
 * The comments layer that sits over the preview frame.
 *
 * A note belongs on the thing it is about, so this is where a comment is read
 * and written — a numbered pin on its element, which opens into the note itself
 * anchored beside it. Host-side rather than drawn inside the iframe (the same
 * arrangement as `ElementToolbar`), so a card is real React with house
 * primitives instead of imperative DOM in the injected script.
 *
 * The frame reports every note's rect in its OWN pixels on each scroll, resize
 * and mutation; on a breakpoint canvas those pixels are then scaled to the
 * screen, exactly as the structural toolbar scales its selection box.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { TrashIcon, CloseIcon } from '@/components/icons';
import {
  commentElementName,
  commentScopeLabel,
  type CanvasComment,
  type CommentPlacement,
} from '../../lib/canvasComments';

/** Half the pin, so a pin on an element's corner sits centred on it. */
const PIN_RADIUS = 11;
const CARD_WIDTH = 260;
const GAP = 10;

interface Props {
  comments: CanvasComment[];
  placements: CommentPlacement[];
  missing: string[];
  /** Canvas scale; 1 for the ordinary single-frame preview. */
  scale: number;
  /** The frame's on-screen box, used to keep pins and cards inside it. */
  bounds: { w: number; h: number } | null;
  openId: string | null;
  onOpen: (id: string | null) => void;
  excluded: Set<string>;
  toggle: (id: string) => void;
  onEdit: (comment: CanvasComment) => void;
  onDelete: (comment: CanvasComment) => void;
  onHover: (comment: CanvasComment | null) => void;
  /** The composer, rendered anchored to the element being commented on. */
  composer?: ReactNode;
  composerAt?: { x: number; y: number } | null;
}

/** Keep a card fully inside the frame, and flip it left when it would overflow. */
function place(
  x: number,
  y: number,
  bounds: { w: number; h: number } | null,
  height: number
): { left: number; top: number } {
  const w = bounds?.w ?? Infinity;
  const h = bounds?.h ?? Infinity;
  const flip = x + GAP + CARD_WIDTH > w;
  const left = flip ? Math.max(GAP, x - GAP - CARD_WIDTH) : x + GAP;
  const top = Math.min(Math.max(GAP, y - PIN_RADIUS), Math.max(GAP, h - height - GAP));
  return { left, top };
}

export function CommentPins(props: Props) {
  const { comments, placements, scale, bounds, openId } = props;
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardHeight, setCardHeight] = useState(160);
  useLayoutEffect(() => {
    if (cardRef.current) setCardHeight(cardRef.current.offsetHeight);
  }, [openId, comments]);

  const byId = new Map(comments.map((c) => [c.id, c]));
  const open = openId ? comments.find((c) => c.id === openId) : undefined;
  const openAt = openId ? placements.find((p) => p.id === openId) : undefined;

  return (
    <div className="canvas-comment-layer">
      {placements.map((p) => {
        const note = byId.get(p.id);
        if (!note) return null;
        const x = p.x * scale;
        const y = p.y * scale;
        const isOpen = note.id === openId;
        return (
          <button
            key={note.id}
            type="button"
            className="canvas-comment-pin-marker"
            data-status={note.status}
            data-open={isOpen || undefined}
            style={{ left: x, top: y }}
            title={`Comment ${note.number} — ${commentElementName(note.target)}`}
            aria-label={`Comment ${note.number}: ${note.body}`}
            aria-expanded={isOpen}
            onClick={() => props.onOpen(isOpen ? null : note.id)}
            onPointerEnter={() => props.onHover(note)}
            onPointerLeave={() => props.onHover(null)}
          >
            {note.number}
          </button>
        );
      })}

      {open && openAt && (
        <div
          ref={cardRef}
          className="canvas-comment-bubble"
          data-status={open.status}
          style={{
            width: CARD_WIDTH,
            ...place(openAt.x * scale, openAt.y * scale, bounds, cardHeight),
          }}
        >
          <div className="canvas-comment-bubble__head">
            {open.status === 'pending' && (
              <input
                type="checkbox"
                aria-label={`Include comment: ${open.body}`}
                checked={!props.excluded.has(open.id)}
                onChange={() => props.toggle(open.id)}
              />
            )}
            <span className="canvas-comment-bubble__target">{commentElementName(open.target)}</span>
            <IconButton
              variant="ghost"
              size="compact"
              icon={<CloseIcon size={12} />}
              title="Close comment"
              aria-label="Close comment"
              onClick={() => props.onOpen(null)}
            />
          </div>
          <p className="canvas-comment-body">{open.body}</p>
          <span className="canvas-comments-hint">Applies to {commentScopeLabel(open.scope)}</span>
          {open.status === 'sent' && (
            <span className="canvas-comments-sent">Sent to {open.sentTo}</span>
          )}
          {props.missing.includes(open.id) && (
            <span className="canvas-comments-error">
              Element not found. Choose Edit, then click a new element.
            </span>
          )}
          <div className="canvas-comments-actions">
            <Button size="compact" variant="ghost" onClick={() => props.onEdit(open)}>
              Edit
            </Button>
            <IconButton
              size="compact"
              variant="ghost"
              icon={<TrashIcon />}
              aria-label={`Delete comment: ${open.body}`}
              title="Delete comment"
              onClick={() => props.onDelete(open)}
            />
          </div>
        </div>
      )}

      {props.composer && props.composerAt && (
        <div
          className="canvas-comment-bubble canvas-comment-bubble--composing"
          style={{
            width: CARD_WIDTH,
            ...place(props.composerAt.x * scale, props.composerAt.y * scale, bounds, 320),
          }}
        >
          {props.composer}
        </div>
      )}
    </div>
  );
}
