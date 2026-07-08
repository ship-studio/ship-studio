/**
 * One rule in the cascade, as a card (Stacki anatomy):
 *   ┌ @  (wrap rule in an at-rule — top-level editable cards)
 *   │ [selector chip]                                   🗑 (delete)
 *   └ @  (add a nested at-rule inside the rule)
 *     property : value   rows…
 *     nested rule cards (recursive)
 *     + Add property                              styles.css (source chip)
 *
 * Read-only rules (inline / UA-or-framework / multi-file) render as a locked card.
 * Editing is driven by the structured `RuleBody` model (`lib/cssBody`); the card is
 * controlled — it emits a new body via `onChange`.
 */

import { useId, useMemo, useRef, useState } from 'react';
import { predictNextDeclaration } from '../../lib/cssPredict';
import { ChevronIcon, CloseIcon } from '../icons/common';
import { LayersIcon } from '../icons/utility';
import { TrashIcon, FileIcon } from '../icons/editor';
import { DeclarationRow } from './DeclarationRow';
import { AddMenu } from './AddMenu';
import { suggestMediaConditions } from '../../lib/cssProperties';
import {
  NEST_ITEMS,
  WRAP_ITEMS,
  KEYFRAME_STEP_ITEMS,
  searchStructures,
  isKeyframesSelector,
} from '../../lib/cssStructures';
import { SuggestionPopover, suggestionOptionId, type Suggestion } from './SuggestionPopover';
import {
  declarations,
  nestedRules,
  addDeclaration,
  addNestedRule,
  removeItem,
  replaceItem,
  moveDeclIntoNested,
  type Decl,
  type RuleBody,
} from '../../lib/cssBody';

interface CommonHeader {
  selector: string;
  file?: string;
  line?: number;
  /** The raw `@media` condition (e.g. `(max-width: 768px)`) — for editing the chip. */
  mediaText?: string | null;
  layer?: string | null;
  /** The enclosing `@container` condition (e.g. `(min-width: 400px)`), for the chip. */
  container?: string | null;
  /** The enclosing `@supports` condition (e.g. `(display: grid)`), for the chip. */
  supports?: string | null;
  /** Nesting depth (0 = top-level rule), for indentation. */
  depth?: number;
  /** This card is a keyframe step (a child of a `@keyframes` rule) — its selector is
   *  a step (`0%`, `from`) and its body holds only declarations. */
  isStep?: boolean;
  /** The rule's @media/@container condition doesn't match the current preview
   *  viewport — the whole card is dimmed and its declarations don't apply now. */
  inactive?: boolean;
  /** Controlled collapse. When `onToggleCollapse` is provided the card is controlled
   *  (the panel persists the state by selector so a minimized rule stays minimized
   *  across element switches); otherwise it manages collapse locally. */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

interface EditableCard extends CommonHeader {
  editable: true;
  body: RuleBody;
  /** Lowercased property names the cascade reports overridden (struck-through). */
  overridden: Map<string, string>;
  onChange: (body: RuleBody) => void;
  /** Present for nested rules — makes the selector chip an editable input. */
  onSelectorChange?: (selector: string) => void;
  /** Present for top-level editable rules — wrap the rule in an at-rule (`@` above). */
  onWrap?: (atPrelude: string) => void;
  /** Present for top-level editable rules — delete the whole rule (🗑). */
  onDelete?: () => void;
  /** Present for top-level editable rules — click-to-edit the selector (any selector). */
  onRename?: (newSelector: string) => void;
  /** Present for a `@keyframes` rule — click-to-rename the animation name. */
  onRenameKeyframes?: (newName: string) => void;
  /** Class-name suggestions (e.g. `.btn`) for the selector autocomplete. */
  selectorSuggestions?: string[];
  /** Present for top-level editable rules inside an `@media` — edit its condition. */
  onRenameAtRule?: (newMedia: string) => void;
  /** Project CSS variables (`--foo`) for `var(--…)` value autocomplete. */
  variables?: string[];
  /** Project `@keyframes` names, suggested as `animation` values. */
  animations?: string[];
  /** A not-yet-created rule (one of the element's own selectors) — shown dashed with a
   *  "new" chip; the rule is written to source on the first property. */
  draft?: boolean;
  /** Editing-flow: open the "+ Add" menu on mount (right after this rule was created via
   *  "Add selector"), so the user jumps straight to its first property. */
  autoOpenAdd?: boolean;
  /** This created rule's selector doesn't match the selected element — show a note so it
   *  doesn't look like it applies (e.g. `cool` typed for an `<h1>`, or a class the
   *  element doesn't have). */
  unmatched?: boolean;
}

interface ReadonlyCard extends CommonHeader {
  editable: false;
  decls: Decl[];
  overridden: Map<string, string>;
  readonlyReason?: string;
}

type Props = EditableCard | ReadonlyCard;

const basename = (path: string) => path.split('/').pop() ?? path;
/** A readable file-chip label. Embedded `<style>` blocks are addressed as
 *  `Foo.astro?style=0`; show them as `Foo.astro › style` rather than the raw query. */
const fileLabel = (path: string) => {
  const [file, query] = path.split('?style=');
  const name = basename(file);
  return query ? `${name} › style` : name;
};

/** A top-level rule's selector as ONE intelligent field — just like writing real
 *  CSS. Type a selector (class names autocomplete from the project) to rename the
 *  rule; type `@…` and it suggests conditions (`@media`, `@container`, `@supports`)
 *  and wraps the rule to scope it. No separate "when" box — one field does both. */
function SelectorChip({
  selector,
  suggestions,
  onCommit,
  onWrap,
}: {
  selector: string;
  suggestions: string[];
  onCommit: (newSelector: string) => void;
  /** Wrap the rule in a condition when the user types an `@`-rule. */
  onWrap?: (prelude: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(selector);
  const [active, setActive] = useState(0);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const listId = useId();

  if (!editing) {
    return (
      <code
        className="ss-card__selector-chip ss-card__selector-chip--editable"
        title="Click to edit — type a selector, or @media (…) to scope this rule"
        role="button"
        tabIndex={0}
        onClick={() => {
          setText(selector);
          setActive(0);
          setEditing(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            setText(selector);
            setActive(0);
            setEditing(true);
          }
        }}
      >
        {selector}
      </code>
    );
  }

  const typed = text.trim();
  const isCondition = typed.startsWith('@');
  // Typing `@…` switches the field into condition mode (wrap the rule); otherwise
  // it autocompletes the project's class names (rename the rule).
  const matches: Suggestion[] = isCondition
    ? [
        ...(typed.length > 1 && !WRAP_ITEMS.some((w) => w.insert === typed)
          ? [{ label: typed, value: typed, hint: 'new condition' }]
          : []),
        ...searchStructures(WRAP_ITEMS, typed).map((w) => ({
          label: w.label,
          value: w.insert,
          hint: w.hint,
        })),
      ]
    : (typed
        ? suggestions.filter((s) => s.toLowerCase().includes(typed.toLowerCase()))
        : suggestions
      )
        .slice(0, 8)
        .map((s) => ({ label: s, value: s }));

  const commit = (value: string) => {
    const v = value.trim();
    if (!v) {
      setEditing(false);
      return;
    }
    if (v.startsWith('@'))
      onWrap?.(v); // scope the rule in a condition
    else if (v !== selector) onCommit(v); // rename the selector
    setEditing(false);
  };

  return (
    <div className="ss-card__chip-edit ss-card__selector-edit">
      <input
        className="ss-card__selector-chip ss-card__selector-chip--input"
        autoFocus
        value={text}
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-expanded={matches.length > 0}
        aria-controls={listId}
        aria-activedescendant={matches.length > 0 ? suggestionOptionId(listId, active) : undefined}
        aria-autocomplete="list"
        aria-label="Rule selector"
        placeholder="selector, or @media (…) to scope it"
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
            setText(selector);
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
        listId={listId}
      />
    </div>
  );
}

/** A nested rule's selector — a live input with autocomplete over the modern nesting
 *  vocabulary (`&:hover`, `&:nth-child(2n)`, `&::before`, `&:has(…)`, `& .child`) plus
 *  the project's classes. Controlled: edits the body on every keystroke. */
function NestedSelectorInput({
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
    <div className="ss-card__chip-edit ss-card__selector-edit">
      <input
        className="ss-card__selector-chip ss-card__selector-chip--input"
        value={value}
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
    </div>
  );
}

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
      <span
        className="ss-card__chip ss-card__chip--media ss-card__chip--editable"
        title="Click to edit the condition"
        role="button"
        tabIndex={0}
        onClick={() => {
          setText(condition);
          setActive(0);
          setEditing(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            setText(condition);
            setActive(0);
            setEditing(true);
          }
        }}
      >
        {/* The full condition, in CSS form — never abbreviated/truncated. */}
        <span className="ss-card__media-at">@media</span> {condition}
      </span>
    );
  }
  const commit = (value: string) => {
    const v = value.trim();
    if (v && v !== condition) onCommit(v);
    setEditing(false);
  };
  const matches: Suggestion[] = suggestMediaConditions(text).map((m) => ({ value: m, label: m }));
  return (
    <div className="ss-card__chip-edit">
      <input
        className="ss-card__chip ss-card__chip--media-input"
        autoFocus
        value={text}
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
    </div>
  );
}

/** `@keyframes apply` → `apply`. */
function keyframesName(selector: string): string {
  return selector
    .trim()
    .replace(/^@(-[a-z]+-)?keyframes\s+/i, '')
    .trim();
}

/** A `@keyframes` rule's name as a click-to-rename chip — the `@keyframes` keyword is
 *  fixed; only the animation name is edited (idents only, no spaces). */
function KeyframesNameChip({
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
      <code
        className="ss-card__selector-chip ss-card__selector-chip--editable"
        title="Click to rename the animation"
        role="button"
        tabIndex={0}
        onClick={() => {
          setText(name);
          setEditing(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            setText(name);
            setEditing(true);
          }
        }}
      >
        <span className="ss-card__kf-at">@keyframes</span> {name}
      </code>
    );
  }

  const commit = () => {
    const v = text.trim();
    if (v && v !== name) onCommit(v);
    setEditing(false);
  };

  return (
    <span className="ss-card__chip-edit ss-card__kf-edit">
      <span className="ss-card__kf-at">@keyframes</span>
      <input
        className="ss-card__selector-chip ss-card__selector-chip--input"
        autoFocus
        value={text}
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
    </span>
  );
}

function Chips({
  mediaText,
  layer,
  container,
  supports,
  onRenameAtRule,
}: Pick<CommonHeader, 'mediaText' | 'layer' | 'container' | 'supports'> & {
  onRenameAtRule?: (newMedia: string) => void;
}) {
  return (
    <>
      {layer && (
        <span className="ss-card__chip ss-card__chip--layer">
          <LayersIcon size={10} />
          {layer}
        </span>
      )}
      {/* `@container` / `@supports` are read-only context (we don't yet edit their
          condition in place), shown in full so the card states its real scope. */}
      {container && (
        <span className="ss-card__chip ss-card__chip--at">
          <span className="ss-card__media-at">@container</span> {container}
        </span>
      )}
      {supports && (
        <span className="ss-card__chip ss-card__chip--at">
          <span className="ss-card__media-at">@supports</span> {supports}
        </span>
      )}
      {mediaText &&
        (onRenameAtRule ? (
          <MediaChip condition={mediaText} onCommit={onRenameAtRule} />
        ) : (
          // Read-only rule: still show the full condition, just not editable.
          <span className="ss-card__chip ss-card__chip--media">
            <span className="ss-card__media-at">@media</span> {mediaText}
          </span>
        ))}
    </>
  );
}

export function CascadeRuleCard(props: Props) {
  // Controlled by the panel (persists across element switches) when `onToggleCollapse`
  // is supplied; otherwise local (nested cards, where per-instance state is fine).
  const [localCollapsed, setLocalCollapsed] = useState(false);
  const controlled = props.onToggleCollapse != null;
  const collapsed = controlled ? (props.collapsed ?? false) : localCollapsed;
  const toggleCollapse = controlled ? props.onToggleCollapse! : () => setLocalCollapsed((c) => !c);
  // Editing-flow: the property just added via "+ Add" — its row auto-opens the value
  // input so the user types the value immediately (no second click).
  const [autoEditProp, setAutoEditProp] = useState<string | null>(null);
  // Predictive autofill (v1, heuristic): the most likely next declaration, shown as a
  // ghost row you accept with Tab. Dismissed props (Esc) aren't re-suggested.
  const [dismissedPreds, setDismissedPreds] = useState<ReadonlySet<string>>(() => new Set());
  const depth = props.depth ?? 0;
  const editable = props.editable;
  const inactive = props.inactive ?? false;
  const isStep = props.isStep ?? false;
  // A `@keyframes <name>` container: its body is steps, not declarations. (A step
  // itself is never a keyframes container, even if oddly named.)
  const isKeyframes = !isStep && isKeyframesSelector(props.selector);
  const onRenameAtRule = props.editable ? props.onRenameAtRule : undefined;

  // Focus management after a destructive action (#14): the focused button unmounts, so
  // without intervention focus falls to <body>. Capture a stable target *before* mutating,
  // then restore focus once React has re-rendered.
  const sectionRef = useRef<HTMLElement>(null);

  /** Focus a stable element inside this card after a delete/remove (its row unmounted).
   *  Prefers the next/previous declaration row of the removed one, else the card's
   *  "+ Add" button, else the collapse toggle. */
  const focusWithinCard = (removed: HTMLElement | null) => {
    const card = sectionRef.current;
    if (!card) return;
    const fallback = () => {
      const add = card.querySelector<HTMLElement>('.ss-card__add');
      const collapse = card.querySelector<HTMLElement>('.ss-card__collapse');
      (add ?? collapse)?.focus();
    };
    // The DOM still holds the removed node at click time; resolve its surviving sibling.
    const next = removed?.nextElementSibling as HTMLElement | null;
    const prev = removed?.previousElementSibling as HTMLElement | null;
    const sibling = (el: HTMLElement | null) =>
      el && el.matches('.ss-decl') ? el.querySelector<HTMLElement>('button, [tabindex]') : null;
    requestAnimationFrame(() => {
      const target = sibling(next) ?? sibling(prev);
      if (target && card.contains(target)) target.focus();
      else fallback();
    });
  };

  /** Focus a sibling card (or the panel's Add-selector control) after this whole card is
   *  deleted — the card itself unmounts, so the target lives in the parent list. */
  const focusAfterCardDelete = () => {
    const card = sectionRef.current;
    if (!card) return;
    const next = card.nextElementSibling as HTMLElement | null;
    const prev = card.previousElementSibling as HTMLElement | null;
    const cardCollapse = (el: HTMLElement | null) =>
      el && el.classList.contains('ss-card')
        ? el.querySelector<HTMLElement>('.ss-card__collapse')
        : null;
    const panel = card.closest('.ss-cascade-panel');
    requestAnimationFrame(() => {
      const target =
        cardCollapse(next) ??
        cardCollapse(prev) ??
        panel?.querySelector<HTMLElement>('.ss-cascade-add-selector');
      target?.focus();
    });
  };

  // The next-declaration prediction for this rule (ordinary editable rules only — not
  // keyframe steps / @keyframes containers). Computed unconditionally to keep hooks stable.
  const editBody = props.editable ? props.body : null;
  const predictVars = props.editable ? props.variables : undefined;
  const prediction = useMemo(
    () =>
      editBody && !isStep && !isKeyframes
        ? predictNextDeclaration(
            declarations(editBody).map((d) => ({ prop: d.prop, value: d.value })),
            dismissedPreds,
            { selector: props.selector, variables: predictVars }
          )
        : null,
    [editBody, isStep, isKeyframes, dismissedPreds, props.selector, predictVars]
  );

  const headerContent = (
    <>
      {/* Devtools-style context line: the rule's enclosing `@media (…)` / `@layer` /
          `@container` / `@supports`, shown in full above the selector — the literal CSS,
          never abbreviated or pushed off. */}
      {(props.mediaText || props.layer || props.container || props.supports) && (
        <div className={`ss-card__context${inactive ? ' is-inactive' : ''}`}>
          <Chips
            mediaText={props.mediaText}
            layer={props.layer}
            container={props.container}
            supports={props.supports}
            onRenameAtRule={onRenameAtRule}
          />
          {inactive && (
            <span
              className="ss-card__context-note"
              title="This condition doesn't match the current preview size — these styles aren't applying right now"
            >
              not active now
            </span>
          )}
        </div>
      )}
      <div className="ss-card__selector-row">
        <button
          type="button"
          className={`ss-card__collapse${collapsed ? ' is-collapsed' : ''}`}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand rule' : 'Collapse rule'}
          onClick={toggleCollapse}
        >
          <ChevronIcon size={12} />
        </button>
        {props.editable && isKeyframes && props.onRenameKeyframes ? (
          <KeyframesNameChip
            name={keyframesName(props.selector)}
            onCommit={props.onRenameKeyframes}
          />
        ) : editable && props.onSelectorChange ? (
          <NestedSelectorInput
            value={props.selector}
            suggestions={props.selectorSuggestions ?? []}
            vocab={isStep ? 'keyframe' : 'nesting'}
            onChange={(sel) => props.onSelectorChange?.(sel)}
          />
        ) : props.editable && props.onRename ? (
          <SelectorChip
            selector={props.selector}
            suggestions={props.selectorSuggestions ?? []}
            onCommit={props.onRename}
            onWrap={props.onWrap}
          />
        ) : (
          <code className="ss-card__selector-chip" title={props.selector}>
            {props.selector}
          </code>
        )}
        <span className="ss-card__head-spacer" />
        {props.editable && props.draft && (
          <span
            className="ss-card__chip ss-card__chip--new"
            title="No rule yet — it's created in your stylesheet when you add the first property"
          >
            new
          </span>
        )}
        {!editable && <span className="ss-card__src ss-card__src--ro">read-only</span>}
        {editable && props.onDelete && !props.draft && (
          <button
            type="button"
            className="ss-card__trash"
            title="Delete rule"
            aria-label="Delete rule"
            onClick={() => {
              focusAfterCardDelete();
              props.onDelete?.();
            }}
          >
            <TrashIcon size={12} />
          </button>
        )}
      </div>
    </>
  );

  if (!editable) {
    return (
      <section
        className={`ss-card is-readonly${depth ? ' is-nested' : ''}${collapsed ? ' is-collapsed' : ''}${inactive ? ' is-inactive' : ''}`}
        data-testid="cascade-card"
      >
        <header className="ss-card__head">{headerContent}</header>
        {!collapsed && (
          <div className="ss-card__body">
            {props.decls.map((d, i) => (
              <DeclarationRow
                key={`${d.prop}-${i}`}
                editable={false}
                decl={d}
                overridden={props.overridden.has(d.prop.toLowerCase())}
                overriddenBy={props.overridden.get(d.prop.toLowerCase())}
              />
            ))}
            {props.readonlyReason && <p className="ss-card__note">{props.readonlyReason}</p>}
          </div>
        )}
      </section>
    );
  }

  const { body, onChange, overridden } = props;
  const decls = declarations(body);
  const nested = nestedRules(body);

  // Accept the ghost prediction: add it (with its suggested value) — the next prediction
  // then appears, so Tab-Tab-Tab fills in companions. Dismiss just hides this one.
  const acceptPrediction = () => {
    if (!prediction) return;
    onChange(
      addDeclaration(body, { prop: prediction.prop, value: prediction.value, important: false })
    );
  };
  const dismissPrediction = () => {
    if (prediction) setDismissedPreds((s) => new Set(s).add(prediction.prop.toLowerCase()));
  };

  return (
    <section
      ref={sectionRef}
      className={`ss-card${depth ? ' is-nested' : ''}${collapsed ? ' is-collapsed' : ''}${inactive ? ' is-inactive' : ''}${props.draft ? ' is-draft' : ''}${props.unmatched ? ' is-unmatched' : ''}`}
      data-testid="cascade-card"
      onKeyDown={(e) => {
        // Tab accepts the ghost; Esc dismisses it. Portaled popovers (add-menu, value
        // editor) don't bubble here, so this only fires for focus within the card.
        if (!prediction) return;
        const t = e.target as HTMLElement;
        if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
        if (e.key === 'Tab' && !e.shiftKey) {
          e.preventDefault();
          acceptPrediction();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          dismissPrediction();
        }
      }}
    >
      <header className="ss-card__head">{headerContent}</header>

      {!collapsed && (
        <div className="ss-card__body">
          {props.unmatched && (
            <p className="ss-card__note ss-card__note--unmatched">
              This selector doesn&apos;t match the selected element, so it isn&apos;t applying here
              — add the class in Settings, or rename it to one of the element&apos;s selectors.
            </p>
          )}
          {decls.map((d) => (
            <DeclarationRow
              key={d.index}
              editable
              decl={{ prop: d.prop, value: d.value, important: d.important }}
              overridden={overridden.has(d.prop.toLowerCase())}
              overriddenBy={overridden.get(d.prop.toLowerCase())}
              nestTargets={nested.map((r) => r.selector)}
              variables={props.variables}
              animations={props.animations}
              autoEditValue={autoEditProp === d.prop}
              onChange={(next) => onChange(replaceItem(body, d.index, { kind: 'decl', ...next }))}
              onRemove={(rowEl) => {
                focusWithinCard(rowEl);
                onChange(removeItem(body, d.index));
              }}
              onNest={(sel) => onChange(moveDeclIntoNested(body, d.index, sel))}
            />
          ))}

          {prediction && (
            <div
              className="ss-decl ss-decl--ghost"
              title="Predicted next — Tab to accept, Esc to dismiss"
            >
              <button
                type="button"
                className="ss-decl__ghost-accept"
                onClick={acceptPrediction}
                aria-label={`Add ${prediction.prop}: ${prediction.value}`}
              >
                <span className="ss-decl__prop">{prediction.prop}</span>
                <span className="ss-decl__colon">:</span>
                <span className="ss-decl__value">{prediction.value}</span>
                {prediction.hint && <span className="ss-decl__ghost-hint">{prediction.hint}</span>}
              </button>
              <kbd className="ss-decl__ghost-kbd">Tab</kbd>
              <button
                type="button"
                className="ss-decl__ghost-dismiss"
                onClick={(e) => {
                  // The ghost row unmounts on dismiss — move focus to a stable sibling
                  // (the "+ Add" button) so it doesn't fall to <body> (#14).
                  focusWithinCard(e.currentTarget.closest('.ss-decl'));
                  dismissPrediction();
                }}
                title="Dismiss"
                aria-label="Dismiss prediction"
              >
                <CloseIcon size={11} />
              </button>
            </div>
          )}

          {nested.map((r) => (
            <CascadeRuleCard
              key={r.index}
              editable
              depth={depth + 1}
              isStep={isKeyframes}
              selector={r.selector}
              overridden={new Map()}
              body={r.body}
              variables={props.variables}
              animations={props.animations}
              selectorSuggestions={props.selectorSuggestions}
              onChange={(nextBody) =>
                onChange(
                  replaceItem(body, r.index, { kind: 'rule', selector: r.selector, body: nextBody })
                )
              }
              onSelectorChange={(sel) =>
                onChange(replaceItem(body, r.index, { kind: 'rule', selector: sel, body: r.body }))
              }
              onDelete={() => onChange(removeItem(body, r.index))}
            />
          ))}

          <footer className="ss-card__foot">
            <AddMenu
              mode={isKeyframes ? 'keyframes' : isStep ? 'props' : 'full'}
              autoOpen={props.editable && props.autoOpenAdd}
              onAddProperty={(prop) => {
                onChange(addDeclaration(body, { prop, value: '', important: false }));
                setAutoEditProp(prop); // → the new row opens its value input
              }}
              onNest={(sel) => onChange(addNestedRule(body, sel))}
            />
            {props.file && (
              <span className="ss-card__src-chip" title={`${props.file}:${props.line}`}>
                <FileIcon size={11} />
                {fileLabel(props.file)}
              </span>
            )}
          </footer>
        </div>
      )}
    </section>
  );
}
