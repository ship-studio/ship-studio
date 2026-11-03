import { Fragment, useCallback, useId, useState, type KeyboardEvent } from 'react';
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
  const globalWrapper = /^(:global\s*\()([\s\S]*)(\))$/i.exec(selector);
  const displaySelector = globalWrapper?.[2] ?? selector;
  const parts = splitCompoundClassSelector(displaySelector);
  if (!parts) {
    return <span className="ss-cascade-chip__content">{selector}</span>;
  }

  return (
    <>
      {globalWrapper && (
        <span className="ss-cascade-selector-display__wrapper">{globalWrapper[1]}</span>
      )}
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
      {globalWrapper && (
        <span className="ss-cascade-selector-display__wrapper">{globalWrapper[3]}</span>
      )}
    </>
  );
}

function escapeEnd(value: string, index: number): number {
  let next = index + 1;
  if (next >= value.length) return next;
  if (/[\da-f]/i.test(value[next])) {
    let digits = 0;
    while (next < value.length && digits < 6 && /[\da-f]/i.test(value[next])) {
      next += 1;
      digits += 1;
    }
    if (/\s/.test(value[next] ?? '')) {
      if (value[next] === '\r' && value[next + 1] === '\n') return next + 2;
      return next + 1;
    }
    return next;
  }
  if (value[next] === '\r' && value[next + 1] === '\n') return next + 2;
  return next + (value.codePointAt(next)! > 0xffff ? 2 : 1);
}

/** Split at selector-list commas only. Escapes, strings, comments, attributes and
 * functional pseudo arguments keep their commas inside the current selector. */
function splitTopLevelSelectorList(value: string): string[] {
  const parts: string[] = [];
  const stack: string[] = [];
  let start = 0;
  let quote = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === '\\') {
        index = escapeEnd(value, index) - 1;
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === '\\') {
      index = escapeEnd(value, index) - 1;
      continue;
    }
    if (char === '/' && value[index + 1] === '*') {
      const end = value.indexOf('*/', index + 2);
      index = end < 0 ? value.length : end + 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(') {
      stack.push(')');
    } else if (char === '[') {
      stack.push(']');
    } else if ((char === ')' || char === ']') && stack[stack.length - 1] === char) {
      stack.pop();
    } else if (char === ',' && stack.length === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function matchingCloseParen(value: string, open: number): number | null {
  let depth = 1;
  let quote = '';
  for (let index = open + 1; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === '\\') index = escapeEnd(value, index) - 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '\\') {
      index = escapeEnd(value, index) - 1;
      continue;
    }
    if (char === '/' && value[index + 1] === '*') {
      const end = value.indexOf('*/', index + 2);
      if (end < 0) return null;
      index = end + 1;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')' && --depth === 0) return index;
  }
  return null;
}

function displaySelectorGroups(selectorList: string): string[] {
  return splitTopLevelSelectorList(selectorList).flatMap((member) => {
    const wrapper = /^(:global\s*\()/i.exec(member);
    if (!wrapper) return [member];
    const open = wrapper[0].length - 1;
    const close = matchingCloseParen(member, open);
    if (close == null || member.slice(close + 1).trim()) return [member];
    const inner = member.slice(open + 1, close);
    const innerMembers = splitTopLevelSelectorList(inner);
    if (innerMembers.length <= 1) return [member];
    const prefix = member.slice(0, open + 1);
    const suffix = member.slice(close);
    return innerMembers.map((part) => `${prefix}${part}${suffix}`);
  });
}

function selectorListTail(value: string): { prefix: string; tail: string } {
  const lastComma = (() => {
    const depth: string[] = [];
    let quote = '';
    let result = -1;
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      if (quote) {
        if (char === '\\') index = escapeEnd(value, index) - 1;
        else if (char === quote) quote = '';
      } else if (char === '\\') {
        index = escapeEnd(value, index) - 1;
      } else if (char === '/' && value[index + 1] === '*') {
        const end = value.indexOf('*/', index + 2);
        index = end < 0 ? value.length : end + 1;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '(') {
        depth.push(')');
      } else if (char === '[') {
        depth.push(']');
      } else if ((char === ')' || char === ']') && depth[depth.length - 1] === char) {
        depth.pop();
      } else if (char === ',' && depth.length === 0) {
        result = index;
      }
    }
    return result;
  })();
  return lastComma < 0
    ? { prefix: '', tail: value.trim() }
    : { prefix: value.slice(0, lastComma + 1), tail: value.slice(lastComma + 1).trim() };
}

/** Display every list member in its own group while keeping compound class chips joined. */
export function SelectorListDisplay({
  selectorList,
  interactive = false,
  onActivate,
}: {
  selectorList: string;
  interactive?: boolean;
  onActivate?: () => void;
}) {
  const groups = displaySelectorGroups(selectorList);
  if (groups.length <= 1) {
    return (
      <SelectorDisplay
        selector={groups[0] ?? selectorList}
        interactive={interactive}
        onActivate={onActivate}
      />
    );
  }
  return (
    <span
      className="ss-cascade-selector-list"
      title={interactive ? 'Click to edit the full selector list' : selectorList}
      aria-label={selectorList}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? onActivate : undefined}
      onKeyDown={
        interactive
          ? (event: KeyboardEvent<HTMLSpanElement>) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onActivate?.();
              }
            }
          : undefined
      }
    >
      {groups.map((group, index) => (
        <Fragment key={`${index}-${group}`}>
          {index > 0 && (
            <span className="ss-cascade-selector-list__separator" aria-hidden="true">
              ,
            </span>
          )}
          <span className="ss-cascade-selector-list__member">
            <SelectorDisplay selector={group} />
          </span>
        </Fragment>
      ))}
    </span>
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
  const globalWrapper = /^:global\s*\(([\s\S]*)\)$/i.exec(selector);
  const parts = splitCompoundClassSelector(globalWrapper?.[1] ?? selector);
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
  selectorList = selector,
  suggestions,
  onCommit,
  onWrap,
  editRequestId,
  onEditRequestHandled,
}: {
  selector: string;
  /** Full authored prelude; the field edits the entire selector list at once. */
  selectorList?: string;
  suggestions: string[];
  onCommit: (newSelector: string) => void;
  /** Wrap the rule in a condition when the user types an `@`-rule. */
  onWrap?: (prelude: string) => void;
  editRequestId?: number;
  onEditRequestHandled?: (requestId: number) => void;
}) {
  const [editing, setEditing] = useState(editRequestId != null);
  const [text, setText] = useState(selectorList);
  const [active, setActive] = useState(0);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  // `dirty` = the user typed since opening the field; `navigated` = they moved the
  // highlight with the arrow keys. Without them, Enter straight after clicking the
  // chip would commit the first browse suggestion and silently rename the rule.
  const [dirty, setDirty] = useState(false);
  const [navigated, setNavigated] = useState(false);
  const listId = useId();
  const openEditor = useCallback(() => {
    setText(selectorList);
    setActive(0);
    setDirty(false);
    setNavigated(false);
    setEditing(true);
  }, [selectorList]);

  const finishEditing = () => {
    setEditing(false);
    if (editRequestId != null) onEditRequestHandled?.(editRequestId);
  };

  if (!editing) {
    return <SelectorListDisplay selectorList={selectorList} interactive onActivate={openEditor} />;
  }

  const typed = text.trim();
  const isCondition = typed.startsWith('@');
  const tail = selectorListTail(text);
  const typedTail = tail.tail.trim();
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
    : (typedTail
        ? suggestions.filter((s) => s.toLowerCase().includes(typedTail.toLowerCase()))
        : suggestions
      )
        .slice(0, 8)
        .map((s) => ({
          label: s,
          value: tail.prefix ? `${tail.prefix}${/\s$/.test(tail.prefix) ? '' : ' '}${s}` : s,
        }));

  const commit = (value: string) => {
    const v = value.trim();
    if (!v) {
      finishEditing();
      return;
    }
    if (v.startsWith('@'))
      onWrap?.(v); // scope the rule in a condition
    else if (v !== selectorList) onCommit(v); // replace the full selector list
    finishEditing();
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
            setText(selectorList);
            finishEditing();
          }
        }}
        onBlur={finishEditing}
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
