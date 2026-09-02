import { useId, useState } from 'react';
import { suggestMediaConditions } from '../../lib/cssProperties';
import { LayersIcon } from '@/components/icons';
import { CascadeChip } from './CascadeChip';
import { SuggestionPopover, suggestionOptionId, type Suggestion } from './SuggestionPopover';

/** A click-to-edit `@media` condition chip (shows the compact label, edits the raw
 *  condition with a styled SuggestionPopover of common conditions). */
function MediaChip({
  condition,
  onCommit,
}: {
  condition: string;
  onCommit: (newMedia: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(condition);
  const [active, setActive] = useState(0);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const listId = useId();
  if (!editing) {
    return (
      <CascadeChip
        tone="media"
        interactive
        title="Click to edit the condition"
        role="button"
        tabIndex={0}
        onClick={() => {
          setText(condition);
          setActive(0);
          setEditing(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setText(condition);
            setActive(0);
            setEditing(true);
          }
        }}
      >
        <span className="ss-cascade-chip__content">
          <span className="ss-cascade-card__media-at">@media</span> {condition}
        </span>
      </CascadeChip>
    );
  }
  const commit = (value: string) => {
    const v = value.trim();
    if (v && v !== condition) onCommit(v);
    setEditing(false);
  };
  const matches: Suggestion[] = suggestMediaConditions(text).map((m) => ({ value: m, label: m }));
  return (
    <CascadeChip tone="media" editing>
      <input
        className="ss-cascade-chip__input"
        autoFocus
        value={text}
        size={Math.max(text.length, 1)}
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-expanded={matches.length > 0}
        aria-controls={listId}
        aria-activedescendant={matches.length > 0 ? suggestionOptionId(listId, active) : undefined}
        aria-autocomplete="list"
        aria-label="Media condition"
        onFocus={(e) => setAnchorEl(e.currentTarget)}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(matches[active]?.value ?? text);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, matches.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setText(condition);
            setEditing(false);
          }
        }}
        onBlur={() => setEditing(false)}
      />
      <SuggestionPopover
        anchor={anchorEl}
        items={matches}
        active={active}
        onPick={commit}
        width={220}
        listId={listId}
      />
    </CascadeChip>
  );
}

/** Renders the selector, at-rule, and inheritance context for a CSS declaration. */
export function RuleContextChips({
  mediaText,
  layer,
  container,
  supports,
  onRenameAtRule,
}: {
  mediaText?: string | null;
  layer?: string | null;
  container?: string | null;
  supports?: string | null;
  onRenameAtRule?: (newMedia: string) => void;
}) {
  return (
    <>
      {layer && (
        <span className="ss-cascade-card__chip ss-cascade-card__chip--layer">
          <LayersIcon size={10} />
          {layer}
        </span>
      )}
      {/* `@container` / `@supports` are read-only context (we don't yet edit their
          condition in place), shown in full so the card states its real scope. */}
      {container && (
        <span className="ss-cascade-card__chip ss-cascade-card__chip--at">
          <span className="ss-cascade-card__media-at">@container</span> {container}
        </span>
      )}
      {supports && (
        <span className="ss-cascade-card__chip ss-cascade-card__chip--at">
          <span className="ss-cascade-card__media-at">@supports</span> {supports}
        </span>
      )}
      {mediaText &&
        (onRenameAtRule ? (
          <MediaChip condition={mediaText} onCommit={onRenameAtRule} />
        ) : (
          // Read-only rule: still show the full condition, just not editable.
          <CascadeChip tone="media">
            <span className="ss-cascade-chip__content">
              <span className="ss-cascade-card__media-at">@media</span> {mediaText}
            </span>
          </CascadeChip>
        ))}
    </>
  );
}
