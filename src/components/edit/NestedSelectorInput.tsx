import { useId, useState } from 'react';
import { KEYFRAME_STEP_ITEMS, NEST_ITEMS, searchStructures } from '../../lib/cssStructures';
import { CascadeChip } from './CascadeChip';
import { SuggestionPopover, suggestionOptionId, type Suggestion } from './SuggestionPopover';

/** A nested rule's selector — a live input with autocomplete over the modern nesting
 *  vocabulary (`&:hover`, `&:nth-child(2n)`, `&::before`, `&:has(…)`, `& .child`) plus
 *  the project's classes. Controlled: edits the body on every keystroke. */
export function NestedSelectorInput({
  value,
  suggestions,
  onChange,
  vocab = 'nesting',
}: {
  value: string;
  suggestions: string[];
  onChange: (selector: string) => void;
  /** Which suggestion vocabulary to offer: CSS nesting (`&:hover`, `& .child`) or
   *  `@keyframes` steps (`from`, `to`, `50%`). */
  vocab?: 'nesting' | 'keyframe';
}) {
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  // `dirty` = the user has typed since focusing (vs. just clicked in to browse).
  // `navigated` = the user moved the highlight with the arrow keys. Together they keep the
  // browse-menu from hijacking Enter and overwriting a typed custom selector.
  const [dirty, setDirty] = useState(false);
  const [navigated, setNavigated] = useState(false);
  const listId = useId();

  const typed = value.trim();
  const q = typed.toLowerCase();
  let matches: Suggestion[];
  if (vocab === 'keyframe') {
    // Keyframe steps only — no class suggestions (a step isn't a selector).
    matches = searchStructures(KEYFRAME_STEP_ITEMS, typed)
      .map((i) => ({ value: i.insert, label: i.label, hint: i.hint }))
      .slice(0, 10);
  } else {
    // Curated nesting vocab matched on label/hint/keywords (so "even" finds
    // &:nth-child), plus the project's classes as `& .class`.
    const curated: Suggestion[] = searchStructures(NEST_ITEMS, typed).map((i) => ({
      value: i.insert,
      label: i.insert,
      hint: i.hint,
    }));
    const classItems: Suggestion[] = suggestions
      .map((s) => `& ${s}`)
      .filter((p) => !q || p.toLowerCase().includes(q))
      .map((p) => ({ value: p, label: p }));
    matches = [...curated, ...classItems].slice(0, 10);
  }
  // Browsing (clicked in, not yet typed): always open a useful menu — like the top-level
  // selector chip. When the current value matches nothing (a custom selector like `& > b`)
  // or only itself (a complete vocab item like `&:focus-visible`), fall back to the full
  // vocabulary so the user can browse/switch. Once they type, this turns off and the menu
  // filters on what's typed (so it never gets in the way of authoring a custom selector).
  const onlySelfMatch = matches.length === 1 && matches[0].value === value;
  if (focused && !dirty && (matches.length === 0 || onlySelfMatch)) {
    const allVocab: Suggestion[] = (vocab === 'keyframe' ? KEYFRAME_STEP_ITEMS : NEST_ITEMS).map(
      (i) => ({ value: i.insert, label: i.insert, hint: i.hint })
    );
    const allClasses: Suggestion[] =
      vocab === 'keyframe' ? [] : suggestions.map((s) => ({ value: `& ${s}`, label: `& ${s}` }));
    matches = [...allVocab, ...allClasses].slice(0, 10);
  }
  const showMenu = focused && matches.length > 0;

  return (
    <CascadeChip tone="selector" editing className="ss-cascade-card__selector-edit">
      <input
        className="ss-cascade-chip__input"
        value={value}
        size={Math.max(value.length, 1)}
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-expanded={showMenu}
        aria-controls={listId}
        aria-activedescendant={showMenu ? suggestionOptionId(listId, active) : undefined}
        aria-autocomplete="list"
        aria-label={vocab === 'keyframe' ? 'Keyframe step' : 'Nested selector'}
        placeholder={
          vocab === 'keyframe' ? 'from, to, 50%…' : '&:hover, &:nth-child(2n), & .child…'
        }
        onFocus={(e) => {
          setAnchorEl(e.currentTarget);
          setFocused(true);
          setActive(0);
          setDirty(false);
          setNavigated(false);
        }}
        onChange={(e) => {
          onChange(e.target.value);
          setActive(0);
          setDirty(true);
          setNavigated(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setFocused(false);
            return;
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            // Apply the highlighted suggestion only if the user typed (so the menu reflects
            // their text) or explicitly navigated it — never when merely browsing on a
            // click, which would clobber the existing selector. Otherwise just commit.
            if (showMenu && (dirty || navigated) && matches[active])
              onChange(matches[active].value);
            setFocused(false);
            return;
          }
          if (!showMenu) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setNavigated(true);
            setActive((a) => Math.min(a + 1, matches.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setNavigated(true);
            setActive((a) => Math.max(a - 1, 0));
          }
        }}
        onBlur={() => setFocused(false)}
      />
      {showMenu && (
        <SuggestionPopover
          anchor={anchorEl}
          items={matches}
          active={active}
          listId={listId}
          onPick={(v) => {
            onChange(v);
            setFocused(false);
          }}
        />
      )}
    </CascadeChip>
  );
}
