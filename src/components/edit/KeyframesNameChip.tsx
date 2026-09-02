import { useState } from 'react';
import { CascadeChip } from './CascadeChip';

/** `@keyframes apply` → `apply`. */
export function keyframesName(selector: string): string {
  return selector
    .trim()
    .replace(/^@(-[a-z]+-)?keyframes\s+/i, '')
    .trim();
}

/** A `@keyframes` rule's name as a click-to-rename chip — the `@keyframes` keyword is
 *  fixed; only the animation name is edited (idents only, no spaces). */
export function KeyframesNameChip({
  name,
  onCommit,
}: {
  name: string;
  onCommit: (newName: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(name);

  if (!editing) {
    return (
      <CascadeChip
        tone="media"
        interactive
        title="Click to rename the animation"
        role="button"
        tabIndex={0}
        onClick={() => {
          setText(name);
          setEditing(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setText(name);
            setEditing(true);
          }
        }}
      >
        <span className="ss-cascade-chip__content">
          <span className="ss-cascade-card__media-at">@keyframes</span> {name}
        </span>
      </CascadeChip>
    );
  }

  const commit = () => {
    const v = text.trim();
    if (v && v !== name) onCommit(v);
    setEditing(false);
  };

  return (
    <CascadeChip tone="media" editing>
      <span className="ss-cascade-card__media-at">@keyframes</span>
      <input
        className="ss-cascade-chip__input"
        autoFocus
        value={text}
        size={Math.max(text.length, 1)}
        spellCheck={false}
        autoComplete="off"
        aria-label="Animation name"
        onChange={(e) => setText(e.target.value.replace(/\s+/g, ''))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setText(name);
            setEditing(false);
          }
        }}
        onBlur={commit}
      />
    </CascadeChip>
  );
}
