import { useId, useState, type KeyboardEvent } from 'react';
import { WRAP_ITEMS, searchStructures } from '../../lib/cssStructures';
import { CascadeChip, type CascadeChipTone } from './CascadeChip';
import { SuggestionPopover, suggestionOptionId, type Suggestion } from './SuggestionPopover';
import SelectorConnectorGraphic from '@/assets/graphics/selector-connector.svg?react';

const TAG_SELECTOR_PATTERN = /^[a-z][a-z\d-]*(?:(?::|::)[a-z-]+(?:\([^)]*\))?)*$/i;
const CLASS_SELECTOR_SEQUENCE_PATTERN = /^(?:\.[-_a-zA-Z][-_a-zA-Z\d]*\s*){2,}$/;

/** Split a selector made only from class names, whether classes are compound
 * (`.one.two`) or descendants (`.one .two`), into separate visual chips. Keep
 * other CSS selectors intact: combinators, pseudo-classes, and escaped names
 * have semantics that should remain visible as one literal selector. */
export function splitCompoundClassSelector(selector: string): string[] | null {
  const value = selector.trim();
  if (!CLASS_SELECTOR_SEQUENCE_PATTERN.test(value)) return null;
  return value.match(/\.[-_a-zA-Z][-_a-zA-Z\d]*/g);
}

/** Keep plain HTML/custom-element selectors in the media pink family. */
export function selectorTone(selector: string): CascadeChipTone {
  const value = selector.trim();
  return value === '*' || TAG_SELECTOR_PATTERN.test(value) ? 'tag' : 'selector';
}

function SelectorParts({ selector }: { selector: string }) {
  const parts = splitCompoundClassSelector(selector);
  if (!parts) {
    return <span className="ss-cascade-chip__content">{selector}</span>;
  }

  return (
    <>
      {parts.map((part, index) => (
        <span className="ss-cascade-selector-display__part" key={part}>
          {index > 0 && (
            <span className="ss-cascade-selector-display__connector" aria-hidden="true">
              <SelectorConnectorGraphic aria-hidden="true" />
            </span>
          )}
          <CascadeChip tone="selector">
            <span className="ss-cascade-chip__content">{part}</span>
          </CascadeChip>
        </span>
      ))}
    </>
  );
}

/** Shared display for ordinary and compound selectors. */
export function SelectorDisplay({
  selector,
  interactive = false,
  onActivate,
}: {
  selector: string;
  interactive?: boolean;
  onActivate?: () => void;
}) {
  const parts = splitCompoundClassSelector(selector);
  const isUniversal = selector.trim() === '*';
  const title = interactive
    ? 'Click to edit — type a selector, or @media (…) to scope this rule'
    : selector;
  const activate = interactive
    ? {
        role: 'button' as const,
        tabIndex: 0,
        onClick: onActivate,
        onKeyDown: (e: KeyboardEvent<HTMLSpanElement>) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onActivate?.();
          }
        },
      }
    : {};

  if (isUniversal) {
    return (
      <span
        className="ss-cascade-selector-display ss-cascade-selector-display--universal"
        title={title}
        aria-label={`${selector} — Universal`}
        {...activate}
      >
        <CascadeChip tone={selectorTone(selector)} interactive={interactive} aria-hidden="true">
          <span className="ss-cascade-chip__content">{selector}</span>
        </CascadeChip>
        <span className="ss-cascade-selector-display__label">Universal</span>
      </span>
    );
  }

  if (!parts) {
    return (
      <CascadeChip
        tone={selectorTone(selector)}
        interactive={interactive}
        title={title}
        {...activate}
      >
        <span className="ss-cascade-chip__content">{selector}</span>
      </CascadeChip>
    );
  }

  return (
    <span className="ss-cascade-selector-display" title={title} aria-label={selector} {...activate}>
      <SelectorParts selector={selector} />
    </span>
  );
}

/** A top-level rule's selector as ONE intelligent field — just like writing real
 *  CSS. Type a selector (class names autocomplete from the project) to rename the
 *  rule; type `@…` and it suggests conditions (`@media`, `@container`, `@supports`)
 *  and wraps the rule to scope it. No separate "when" box — one field does both. */
export function SelectorChip({
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
  // `dirty` = the user typed since opening the field; `navigated` = they moved the
  // highlight with the arrow keys. Without them, Enter straight after clicking the
  // chip would commit the first browse suggestion and silently rename the rule.
  const [dirty, setDirty] = useState(false);
  const [navigated, setNavigated] = useState(false);
  const listId = useId();

  if (!editing) {
    return (
      <SelectorDisplay
        selector={selector}
        interactive
        onActivate={() => {
          setText(selector);
          setActive(0);
          setDirty(false);
          setNavigated(false);
          setEditing(true);
        }}
      />
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
    <CascadeChip tone={selectorTone(selector)} editing className="ss-cascade-card__selector-edit">
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
        aria-label="Rule selector"
        placeholder="selector, or @media (…) to scope it"
        onFocus={(e) => setAnchorEl(e.currentTarget)}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          setDirty(true);
          setNavigated(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            // Apply the highlighted suggestion only if the user typed (so the menu
            // reflects their text) or explicitly navigated it — never when merely
            // browsing, which would clobber the rule's existing selector.
            commit(dirty || navigated ? (matches[active]?.value ?? text) : text);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setNavigated(true);
            setActive((a) => Math.min(a + 1, matches.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setNavigated(true);
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
    </CascadeChip>
  );
}
