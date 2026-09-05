import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { CascadeChip } from './CascadeChip';
import { SuggestionPopover, suggestionOptionId, type Suggestion } from './SuggestionPopover';
import {
  normalizeMediaQueryChunk,
  parseMediaQuery,
  serializeMediaQuery,
  suggestMediaQueryChunks,
  type MediaQueryChunk,
  type MediaQueryChunkKind,
} from '../../lib/mediaQueries';

function chipClass(kind: MediaQueryChunkKind): string {
  return `ss-media-query__chunk--${kind}`;
}

function queryChunks(condition: string): MediaQueryChunk[] {
  return [{ kind: 'at-rule', value: '@media' }, ...parseMediaQuery(condition)];
}

interface TailSuggestion extends Suggestion {
  kind: MediaQueryChunkKind;
}

function suggestionTone(kind: MediaQueryChunkKind): Suggestion['tone'] {
  if (kind === 'at-rule' || kind === 'value') return 'media';
  if (kind === 'type' || kind === 'feature') return 'property';
  return 'text';
}

function tailSuggestion(value: string, kind: MediaQueryChunkKind): TailSuggestion {
  return { value, label: value, kind, tone: suggestionTone(kind) };
}

interface ComposerPopoverTarget {
  anchor: HTMLElement;
  width: number;
}

function tailSuggestions(chunks: MediaQueryChunk[], query: string): TailSuggestion[] {
  const last = chunks[chunks.length - 1];
  if (last?.kind === 'feature') {
    return suggestMediaQueryChunks('value', query, last.value)
      .map((value) => tailSuggestion(value, 'value'))
      .slice(0, 12);
  }
  if (!last || last.kind === 'at-rule' || last.kind === 'operator') {
    return [
      ...suggestMediaQueryChunks('type', query).map((value) => tailSuggestion(value, 'type')),
      ...suggestMediaQueryChunks('feature', query).map((value) => tailSuggestion(value, 'feature')),
    ].slice(0, 12);
  }
  return suggestMediaQueryChunks('operator', query)
    .map((value) => tailSuggestion(value, 'operator'))
    .slice(0, 12);
}

function MediaQueryChunkChip({
  chunk,
  onCommit,
  onRemove,
  editable,
  getPopoverTarget,
}: {
  chunk: MediaQueryChunk;
  onCommit: (value: string) => void;
  onRemove: () => void;
  editable: boolean;
  getPopoverTarget: () => ComposerPopoverTarget | null;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(chunk.value);
  const [filtering, setFiltering] = useState(false);
  const [active, setActive] = useState(0);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [popoverWidth, setPopoverWidth] = useState(220);
  const listId = useId();
  const matches: Suggestion[] = suggestMediaQueryChunks(
    chunk.kind,
    filtering ? text : '',
    chunk.feature
  ).map((value) => ({ value, label: value, tone: suggestionTone(chunk.kind) }));
  const className = chipClass(chunk.kind);

  const beginEditing = () => {
    setText(chunk.value);
    setFiltering(false);
    setActive(0);
    setEditing(true);
  };

  const commit = (raw: string) => {
    const value = normalizeMediaQueryChunk(chunk.kind, raw);
    if (!value) onRemove();
    else if (value !== chunk.value) onCommit(value);
    setEditing(false);
  };

  if (!editable) {
    return (
      <CascadeChip tone="media" className={className} data-query-chunk-kind={chunk.kind}>
        <span className="ss-cascade-chip__content">{chunk.value}</span>
      </CascadeChip>
    );
  }

  if (!editing) {
    return (
      <CascadeChip
        tone="media"
        interactive
        className={className}
        role="button"
        tabIndex={0}
        title="Click to edit this media-query chunk"
        data-query-chunk-kind={chunk.kind}
        onClick={(event) => {
          event.stopPropagation();
          beginEditing();
        }}
        onKeyDown={(event: KeyboardEvent<HTMLSpanElement>) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            beginEditing();
          }
        }}
      >
        <span className="ss-cascade-chip__content">{chunk.value}</span>
      </CascadeChip>
    );
  }

  return (
    <CascadeChip tone="media" editing className={className} data-query-chunk-kind={chunk.kind}>
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
        aria-label={`Edit media query ${chunk.kind}`}
        onFocus={(event) => {
          const target = getPopoverTarget();
          setAnchorEl(target?.anchor ?? event.currentTarget);
          setPopoverWidth(target?.width ?? 220);
        }}
        onChange={(event) => {
          setText(event.target.value);
          setFiltering(true);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit(matches[active]?.value ?? text);
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive((current) => Math.min(current + 1, matches.length - 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((current) => Math.max(current - 1, 0));
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setText(chunk.value);
            setEditing(false);
          }
        }}
        onBlur={() => commit(text)}
      />
      <SuggestionPopover
        anchor={anchorEl}
        items={matches}
        active={active}
        onPick={commit}
        width={popoverWidth}
        listId={listId}
      />
    </CascadeChip>
  );
}

/**
 * Render an `@media` condition as editable, semantic chunks. The callback receives
 * the condition without the `@media` keyword, matching the cascade source API.
 */
interface MediaQueryChipsProps {
  condition: string;
  onCommit?: (condition: string) => void;
  /** Focus the continuation field when a new composer is first mounted. */
  autoFocusTail?: boolean;
  /** Commit as soon as a continuation chip is accepted (used when creating a group). */
  commitOnAppend?: boolean;
}

function MediaQueryComposer({
  condition,
  onCommit,
  autoFocusTail = false,
  commitOnAppend = false,
}: MediaQueryChipsProps) {
  const [chunks, setChunks] = useState<MediaQueryChunk[]>(() => queryChunks(condition));
  const chunksRef = useRef(chunks);
  const composerRef = useRef<HTMLDivElement>(null);
  const tailRef = useRef<HTMLInputElement>(null);
  const [tailText, setTailText] = useState('');
  const [tailActive, setTailActive] = useState(0);
  const [tailAnchor, setTailAnchor] = useState<HTMLElement | null>(null);
  const [tailPopoverWidth, setTailPopoverWidth] = useState(220);
  const [active, setActive] = useState(false);
  const tailListId = useId();
  const tailItems = tailSuggestions(chunks, tailText);

  useEffect(() => {
    if (!active) return;
    const deselectOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || composerRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('.ss-suggest')) return;
      composerRef.current?.querySelector<HTMLElement>(':focus')?.blur();
      setTailAnchor(null);
      setActive(false);
    };
    document.addEventListener('pointerdown', deselectOutside, true);
    return () => document.removeEventListener('pointerdown', deselectOutside, true);
  }, [active]);

  const getPopoverTarget = (): ComposerPopoverTarget | null => {
    const anchor = composerRef.current?.parentElement;
    if (!anchor) return null;
    const width = anchor.getBoundingClientRect().width;
    return { anchor, width: width > 0 ? width : 220 };
  };

  const setDraftChunks = (next: MediaQueryChunk[]) => {
    chunksRef.current = next;
    setChunks(next);
  };

  const commitComposer = () => {
    const serialized = serializeMediaQuery(chunksRef.current);
    if (serialized && serialized !== condition) onCommit?.(serialized);
  };

  const updateChunk = (index: number, value: string) => {
    const next = chunks.map((chunk, chunkIndex) =>
      chunkIndex === index ? { ...chunk, value } : { ...chunk }
    );
    // A feature chip owns the value chip immediately after it. Keep that context
    // fresh so value suggestions follow the feature while the user composes.
    if (next[index]?.kind === 'feature' && next[index + 1]?.kind === 'value') {
      next[index + 1] = { ...next[index + 1], feature: value };
    }
    setDraftChunks(next);
    const serialized = serializeMediaQuery(next);
    if (serialized && serialized !== condition) onCommit?.(serialized);
  };

  const removeChunk = (index: number) => {
    if (index === 0) return;
    setDraftChunks(chunks.filter((_, chunkIndex) => chunkIndex !== index));
    queueMicrotask(() => tailRef.current?.focus());
  };

  const appendTail = () => {
    const value = tailText.trim();
    const last = chunksRef.current[chunksRef.current.length - 1];
    const additions: MediaQueryChunk[] =
      last?.kind === 'feature'
        ? [{ kind: 'value', value: normalizeMediaQueryChunk('value', value), feature: last.value }]
        : parseMediaQuery(value);
    if (additions.length === 0) return false;
    const next = [...chunksRef.current, ...additions];
    setDraftChunks(next);
    setTailText('');
    if (commitOnAppend) {
      const serialized = serializeMediaQuery(next);
      if (serialized) onCommit?.(serialized);
    }
    return true;
  };

  const pickTail = (value: string) => {
    const suggestion = tailItems.find((item) => item.value === value);
    if (!suggestion) return;
    const last = chunksRef.current[chunksRef.current.length - 1];
    const nextChunk: MediaQueryChunk = {
      kind: suggestion.kind,
      value: normalizeMediaQueryChunk(suggestion.kind, value),
      ...(suggestion.kind === 'value' && last?.kind === 'feature' ? { feature: last.value } : {}),
    };
    const next = [...chunksRef.current, nextChunk];
    setDraftChunks(next);
    setTailText('');
    setTailActive(0);
    if (commitOnAppend) {
      const serialized = serializeMediaQuery(next);
      if (serialized) onCommit?.(serialized);
    }
    tailRef.current?.focus();
  };

  return (
    <div
      ref={composerRef}
      className={`ss-media-query__chunks${active ? ' is-active' : ''}`}
      aria-label={`Media query: ${condition}`}
      onFocusCapture={() => setActive(true)}
      onClick={(event) => {
        if (onCommit && event.target === event.currentTarget) tailRef.current?.focus();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          window.setTimeout(() => {
            if (!composerRef.current?.contains(document.activeElement)) {
              setActive(false);
              commitComposer();
            }
          }, 0);
        }
      }}
    >
      {chunks.map((chunk, index) => (
        <span key={`${chunk.kind}-${index}`} className="ss-media-query__chunk-slot">
          <MediaQueryChunkChip
            chunk={chunk}
            editable={onCommit != null}
            getPopoverTarget={getPopoverTarget}
            onCommit={(value) => updateChunk(index, value)}
            onRemove={() => removeChunk(index)}
          />
        </span>
      ))}
      {onCommit && (
        <input
          ref={tailRef}
          autoFocus={autoFocusTail}
          className="ss-media-query__tail-input"
          value={tailText}
          size={Math.max(tailText.length, 1)}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded={tailAnchor != null && tailItems.length > 0}
          aria-controls={tailListId}
          aria-activedescendant={
            tailItems.length > 0 ? suggestionOptionId(tailListId, tailActive) : undefined
          }
          aria-autocomplete="list"
          aria-label="Continue media query"
          onFocus={(event) => {
            const target = getPopoverTarget();
            setTailAnchor(target?.anchor ?? event.currentTarget);
            setTailPopoverWidth(target?.width ?? 220);
          }}
          onChange={(event) => {
            setTailText(event.target.value);
            setTailActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (tailItems[tailActive]) pickTail(tailItems[tailActive].value);
              else if (appendTail()) window.setTimeout(commitComposer, 0);
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              setTailActive((current) => Math.min(current + 1, tailItems.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setTailActive((current) => Math.max(current - 1, 0));
            } else if (event.key === 'Backspace' && tailText.length === 0 && chunks.length > 1) {
              event.preventDefault();
              removeChunk(chunks.length - 1);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setTailText('');
              event.currentTarget.blur();
            }
          }}
          onBlur={() => {
            setTailAnchor(null);
            if (tailText.trim()) appendTail();
          }}
        />
      )}
      <SuggestionPopover
        anchor={tailAnchor}
        items={tailItems}
        active={tailActive}
        onPick={pickTail}
        width={tailPopoverWidth}
        listId={tailListId}
      />
    </div>
  );
}

export function MediaQueryChips(props: MediaQueryChipsProps) {
  return <MediaQueryComposer key={props.condition} {...props} />;
}
