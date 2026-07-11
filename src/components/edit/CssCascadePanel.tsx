/**
 * Code-first CSS editor panel (vanilla-CSS projects) — the structured cascade card
 * GUI. Click an element → its whole cascade renders as a stack of cards (one per
 * rule, in cascade order), each rule's properties as editable GUI rows, nested
 * rules as nested cards. A GUI layer on real CSS, not abstracted controls.
 *
 * Shares the `ss-edit-panel` chrome (draggable header, pin, close) with the other
 * editor panels.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { PinIcon } from '../icons/layout';
import { CloseIcon, CheckIcon } from '../icons/common';
import { PlusIcon } from '../icons/utility';
import { CopyIcon } from '../icons/editor';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useOptionalToast } from '../../contexts/ToastContext';
import { Spinner } from '../primitives/Spinner';
import { CascadeRuleCard } from './CascadeRuleCard';
import { ElementSettingsPanel } from './ElementSettingsPanel';
import { CssVariablesPanel } from './CssVariablesPanel';
import { CssAnimationsPanel } from './CssAnimationsPanel';
import { SuggestionPopover, suggestionOptionId, type Suggestion } from './SuggestionPopover';
import { WRAP_ITEMS, searchStructures, parseRulePrelude } from '../../lib/cssStructures';
import { rowKey, type CascadeRow } from '../../lib/cssCascade';
import type { RuleBody } from '../../lib/cssBody';
import type { CascadeSelection } from '../../hooks/useCssCascadeEditor';
import type { ElementSettings } from '../../hooks/useElementSettings';
import type { useCssVariables } from '../../hooks/useCssVariables';
import type { useCssAnimations } from '../../hooks/useCssAnimations';

/** The panel's scope: the selected element, or the project-global tokens/animations. */
type Scope = 'element' | 'variables' | 'animations';

const PANEL_WIDTH = 360;

interface Props {
  selection: CascadeSelection | null;
  rows: CascadeRow[];
  loading: boolean;
  bodies: Record<string, RuleBody>;
  overridden: Record<string, Map<string, string>>;
  onChangeBody: (key: string, body: RuleBody) => void;
  onDeleteRule: (key: string) => void;
  onWrapRule: (key: string, atPrelude: string) => void;
  onRenameRule: (key: string, newSelector: string) => void;
  onRenameAtRule: (key: string, newMedia: string) => void;
  onAddSelector: (selector: string) => void;
  /** `.class` suggestions for the selector autocomplete. */
  selectorSuggestions: string[];
  /** Full text of every existing rule selector (`.card`, `@keyframes reveal`) — shown
   *  in "Add selector" so existing rules are discoverable and re-surfaced on a match. */
  existingSelectors: string[];
  /** Project CSS variables (`--foo`) for `var(--…)` value autocomplete. */
  variables: string[];
  /** Project `@keyframes` names for `animation` value autocomplete. */
  animations: string[];
  /** rowKey of a just-created rule — its card auto-opens its "+ Add" menu (editing flow). */
  justCreatedKey?: string | null;
  settings: ElementSettings;
  /** Project-global Variables editor state (custom properties / design tokens). */
  variablesState: ReturnType<typeof useCssVariables>;
  /** Project-global Animations editor state (`@keyframes`). */
  animationsState: ReturnType<typeof useCssAnimations>;
  onClose: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  /** Controlled scope (Element / Variables / Animations) — lets the Cmd+K palette open
   *  the panel straight to a scope. Uncontrolled (local state) when omitted. */
  scope?: Scope;
  onScopeChange?: (scope: Scope) => void;
}

export function CssCascadePanel({
  selection,
  rows,
  loading,
  bodies,
  overridden,
  onChangeBody,
  onDeleteRule,
  onWrapRule,
  onRenameRule,
  onRenameAtRule,
  onAddSelector,
  selectorSuggestions,
  existingSelectors,
  variables,
  animations,
  justCreatedKey,
  settings,
  variablesState,
  animationsState,
  onClose,
  pinned,
  onTogglePin,
  scope: controlledScope,
  onScopeChange,
}: Props) {
  const [tab, setTab] = useState<'style' | 'settings'>('style');
  const [localScope, setLocalScope] = useState<Scope>('element');
  const scope = controlledScope ?? localScope;
  const setScope = onScopeChange ?? setLocalScope;
  // Refresh the project-global data when its scope becomes visible — works whether the
  // scope was entered via the tabs or opened directly from the Cmd+K palette.
  const reloadVariables = variablesState.reload;
  const reloadAnimations = animationsState.reload;
  useEffect(() => {
    if (scope === 'variables') void reloadVariables();
    else if (scope === 'animations') void reloadAnimations();
  }, [scope, reloadVariables, reloadAnimations]);
  // "Copy id": the element's selector (tag + classes), so you can paste it to your agent
  // and describe the change you want ("make a.btn-secondary's hover state pop").
  const { showToast } = useOptionalToast();
  const { copy: copyElementId, isCopied: idCopied } = useCopyToClipboard({
    onCopy: () => showToast('Element id copied — paste it to your agent', 'success'),
  });
  // Collapse state keyed by rule identity (selector + media), not the per-element row
  // key — so minimizing a shared rule like `*` keeps it minimized across element
  // switches. Lives on the panel (which stays mounted), so it survives reselection.
  const [collapsedRules, setCollapsedRules] = useState<Set<string>>(() => new Set());
  const toggleCollapsed = useCallback((ruleKey: string) => {
    setCollapsedRules((prev) => {
      const next = new Set(prev);
      if (next.has(ruleKey)) next.delete(ruleKey);
      else next.add(ruleKey);
      return next;
    });
  }, []);
  const [pos, setPos] = useState(() => ({
    top: 76,
    left: Math.max(
      8,
      (typeof window !== 'undefined' ? window.innerWidth : 1280) - PANEL_WIDTH - 24
    ),
  }));
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const onHeaderPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.ss-edit-panel__header-actions')) return;
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    dragRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);
  const onHeaderPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const w = rootRef.current?.offsetWidth ?? PANEL_WIDTH;
    const left = Math.max(8, Math.min(e.clientX - d.dx, window.innerWidth - w - 8));
    const top = Math.max(8, Math.min(e.clientY - d.dy, window.innerHeight - 40));
    setPos({ top, left });
  }, []);
  const onHeaderPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, []);

  const classes = (selection?.signature.className ?? '').split(/\s+/).filter(Boolean);
  // The element's own classes lead the "Add selector" suggestions (so a class you
  // just added in Settings is one click away from getting a rule), then the rest of
  // the project's classes, then every existing rule selector (incl. `@keyframes …`)
  // so what's already defined is discoverable and re-openable rather than duplicated.
  const addSelectorOptions = [
    ...new Set([...classes.map((c) => `.${c}`), ...selectorSuggestions, ...existingSelectors]),
  ];

  return (
    <div
      ref={rootRef}
      className={`ss-edit-panel ss-cascade-panel${pinned ? ' ss-edit-panel--pinned' : ''}`}
      data-testid="css-cascade-panel"
      style={
        pinned
          ? undefined
          : {
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              right: 'auto',
              zIndex: 1000,
              maxHeight: `min(680px, calc(100vh - ${pos.top + 16}px))`,
            }
      }
    >
      <div
        className="ss-edit-panel__header"
        onPointerDown={pinned ? undefined : onHeaderPointerDown}
        onPointerMove={pinned ? undefined : onHeaderPointerMove}
        onPointerUp={pinned ? undefined : onHeaderPointerUp}
      >
        <span className="ss-edit-panel__title">CSS</span>
        <span className="ss-edit-panel__header-actions">
          {onTogglePin && (
            <button
              className={`ss-edit-panel__pin${pinned ? ' is-pinned' : ''}`}
              onClick={onTogglePin}
              title={pinned ? 'Unpin — float over the preview' : 'Pin as sidebar'}
              aria-pressed={pinned}
            >
              <PinIcon size={13} />
            </button>
          )}
          <button className="ss-edit-panel__close" onClick={onClose} aria-label="Exit edit mode">
            <CloseIcon size={14} />
          </button>
        </span>
      </div>

      <div className="ss-edit-panel__body">
        <div className="ss-cascade-scope" role="tablist" aria-label="CSS scope">
          {(['element', 'variables', 'animations'] as Scope[]).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={scope === s}
              className={`ss-cascade-scope__tab${scope === s ? ' is-active' : ''}`}
              onClick={() => setScope(s)}
            >
              {s === 'element' ? 'Element' : s === 'variables' ? 'Variables' : 'Animations'}
            </button>
          ))}
        </div>

        {scope === 'variables' ? (
          <CssVariablesPanel
            variables={variablesState.variables}
            loading={variablesState.loading}
            variableNames={variables}
            onSetValue={variablesState.setValue}
            onAddVariable={(n, v) => void variablesState.addVariable(n, v)}
          />
        ) : scope === 'animations' ? (
          <CssAnimationsPanel
            animations={animationsState.animations}
            loading={animationsState.loading}
            selectorSuggestions={selectorSuggestions}
            variables={variables}
            onChangeBody={animationsState.setBody}
            onDelete={(s) => void animationsState.remove(s)}
            onCreate={(n) => void animationsState.create(n)}
            onRename={(s, n) => void animationsState.rename(s, n)}
          />
        ) : !selection ? (
          <p className="ss-cascade-empty">Click an element to see the CSS that styles it.</p>
        ) : (
          <>
            <div className="ss-cascade-target">
              <code className="ss-cascade-target__tag">{selection.signature.tagName}</code>
              {classes.length > 0 && (
                <span className="ss-cascade-target__classes">
                  {classes.map((c) => (
                    <code key={c} className="ss-cascade-target__class">
                      .{c}
                    </code>
                  ))}
                </span>
              )}
              {selection.instanceCount > 1 && (
                <span className="ss-cascade-target__count">×{selection.instanceCount}</span>
              )}
              <button
                type="button"
                className="ss-cascade-target__copy"
                title={
                  settings.location
                    ? `Copy this element's source location (${settings.location.file}:${settings.location.line}) to paste into your agent`
                    : "Copy this element's selector to paste into your agent"
                }
                aria-label="Copy element location"
                onClick={() => {
                  const sel = `${selection.signature.tagName}${classes.map((c) => `.${c}`).join('')}`;
                  // Prefer the element's REAL source location (file:line) so the agent can
                  // jump straight to it; fall back to the selector when it can't be resolved.
                  const id = settings.location
                    ? `${settings.location.file}:${settings.location.line} (${sel})`
                    : sel;
                  void copyElementId(id);
                }}
              >
                {idCopied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
                {idCopied ? 'Copied' : 'Copy id'}
              </button>
            </div>

            <div className="ss-cascade-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'style'}
                className={`ss-cascade-tab${tab === 'style' ? ' is-active' : ''}`}
                onClick={() => setTab('style')}
              >
                Style
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'settings'}
                className={`ss-cascade-tab${tab === 'settings' ? ' is-active' : ''}`}
                onClick={() => setTab('settings')}
              >
                Settings
              </button>
            </div>

            {tab === 'settings' ? (
              <ElementSettingsPanel settings={settings} />
            ) : (
              <>
                <AddSelectorBar
                  onAddSelector={onAddSelector}
                  suggestions={addSelectorOptions}
                  existing={existingSelectors}
                />

                {loading ? (
                  <div className="ss-cascade-loading">
                    <Spinner size="sm" />
                  </div>
                ) : (
                  <div className="ss-cascade-cards">
                    {rows.map((row) => {
                      const key = rowKey(row);
                      // Stable across element switches (unlike `key`, which embeds the row index).
                      const collapseKey = `${row.selector ?? ''}|${row.mediaText ?? ''}`;
                      const collapsed = collapsedRules.has(collapseKey);
                      const onToggleCollapse = () => toggleCollapsed(collapseKey);
                      if (row.editable && bodies[key]) {
                        return (
                          <CascadeRuleCard
                            key={key}
                            editable
                            selector={row.selector ?? ''}
                            file={row.file}
                            line={row.line}
                            mediaText={row.mediaText}
                            layer={row.layer}
                            container={row.container}
                            supports={row.supports}
                            inactive={row.inactiveMedia}
                            overridden={
                              row.inactiveMedia ? new Map() : (overridden[key] ?? new Map())
                            }
                            body={bodies[key]}
                            draft={row.draft}
                            unmatched={row.unmatched}
                            autoOpenAdd={key === justCreatedKey}
                            onChange={(b) => onChangeBody(key, b)}
                            onDelete={() => onDeleteRule(key)}
                            // A draft rule doesn't exist in source yet — no rename/wrap
                            // until it's created (by adding the first property).
                            onWrap={row.draft ? undefined : (at) => onWrapRule(key, at)}
                            onRename={row.draft ? undefined : (s) => onRenameRule(key, s)}
                            onRenameAtRule={row.draft ? undefined : (m) => onRenameAtRule(key, m)}
                            selectorSuggestions={selectorSuggestions}
                            variables={variables}
                            animations={animations}
                            collapsed={collapsed}
                            onToggleCollapse={onToggleCollapse}
                          />
                        );
                      }
                      return (
                        <CascadeRuleCard
                          key={key}
                          editable={false}
                          collapsed={collapsed}
                          onToggleCollapse={onToggleCollapse}
                          selector={row.selector ?? 'element.style'}
                          file={row.file}
                          line={row.line}
                          mediaText={row.mediaText}
                          layer={row.layer}
                          container={row.container}
                          supports={row.supports}
                          inactive={row.inactiveMedia}
                          overridden={
                            row.inactiveMedia ? new Map() : (overridden[key] ?? new Map())
                          }
                          readonlyReason={row.readonlyReason}
                          decls={row.declarations.map((d) => ({
                            prop: d.prop,
                            value: d.value,
                            important: d.important,
                          }))}
                        />
                      );
                    })}

                    {rows.length === 0 && (
                      <p className="ss-cascade-empty">No CSS rules match this element.</p>
                    )}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** "Add selector" affordance: a button that expands to a selector input with a
 *  live autocomplete of the project's class names (and a "new rule" row for free
 *  text), creating a new rule for the element. */
function AddSelectorBar({
  onAddSelector,
  suggestions,
  existing,
}: {
  onAddSelector: (selector: string) => void;
  suggestions: string[];
  /** Selectors that already have a rule — tagged "existing" and re-opened on pick. */
  existing: string[];
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const listId = useId();

  const submit = (value: string) => {
    const v = value.trim();
    if (v) onAddSelector(v);
    setText('');
    setActive(0);
    setOpen(false);
  };

  if (!open) {
    return (
      <button type="button" className="ss-cascade-add-selector" onClick={() => setOpen(true)}>
        <PlusIcon size={11} /> Add selector
      </button>
    );
  }

  const existingSet = new Set(existing);
  // Smart staged autofill: compose one rule prelude `[@condition] [selector]`. While you
  // type the `@…` it suggests CONDITIONS (any kind — width, dark mode, print, container
  // / style query, supports); once the condition is set it suggests your project's
  // CLASSES for the selector. Picking a condition keeps you typing; picking a class (or
  // Enter) creates `@condition { selector { } }`.
  const parsed = parseRulePrelude(text);
  let items: Suggestion[];
  if (parsed.stage === 'condition') {
    // `@media` covers the full media-query space the catalog offers — widths AND dark
    // mode, print, hover, reduced motion, orientation. `@container`/`@supports` aren't
    // suggested yet (the cascade walker doesn't report their condition, so a rule inside
    // them wouldn't stay locatable on save); they'll join once that lands.
    const conds = searchStructures(WRAP_ITEMS, text.trim()).filter((w) =>
      w.insert.startsWith('@media')
    );
    const showFree = text.trim().length > 1 && !conds.some((w) => w.insert === text.trim());
    items = [
      ...(showFree ? [{ value: text.trim(), label: text.trim(), hint: 'new condition' }] : []),
      ...conds.map((w) => ({ value: w.insert, label: w.label, hint: w.hint })),
    ];
  } else {
    const q = parsed.selector;
    const selectorMatches = (
      q ? suggestions.filter((s) => s.toLowerCase().includes(q.toLowerCase())) : suggestions
    )
      .filter((s) => !s.trim().startsWith('@'))
      .slice(0, 10);
    const showCreate = q.length > 0 && !selectorMatches.includes(q);
    items = [
      ...(showCreate ? [{ value: q, label: q, hint: 'new rule' }] : []),
      ...selectorMatches.map((s) => ({
        value: s,
        label: s,
        hint: existingSet.has(s) ? 'existing' : undefined,
      })),
    ];
  }

  // Picking a CONDITION fills it and leaves you typing the selector; picking a SELECTOR
  // (or pressing Enter on one) composes `condition selector` and creates the rule.
  const pick = (value: string) => {
    if (parsed.stage === 'condition') {
      setText(`${value} `);
      setActive(0);
      anchorEl?.focus();
    } else {
      submit(parsed.condition ? `${parsed.condition} ${value}` : value);
    }
  };

  return (
    <div className="ss-cascade-add-selector__wrap">
      <input
        className="ss-cascade-add-selector__input"
        autoFocus
        value={text}
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-expanded={items.length > 0}
        aria-controls={listId}
        aria-activedescendant={items.length > 0 ? suggestionOptionId(listId, active) : undefined}
        aria-autocomplete="list"
        aria-label="Add selector"
        placeholder="Selector (.card) — or @media (…), @container (…) then a selector"
        onFocus={(e) => setAnchorEl(e.currentTarget)}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (items[active]) pick(items[active].value);
            else submit(text);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, items.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setText('');
            setOpen(false);
          }
        }}
        onBlur={() => setOpen(false)}
      />
      <SuggestionPopover
        anchor={anchorEl}
        items={items}
        active={active}
        onPick={pick}
        width={280}
        listId={listId}
      />
    </div>
  );
}
