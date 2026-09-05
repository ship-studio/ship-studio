/**
 * Code-first CSS editor panel (vanilla-CSS projects) — the structured cascade card
 * GUI. Click an element → its whole cascade renders as a stack of cards (one per
 * rule, in cascade order), each rule's properties as editable GUI rows, nested
 * rules as nested cards. A GUI layer on real CSS, not abstracted controls.
 *
 * Shares the `ss-edit-panel` chrome (draggable header, pin, close) with the other
 * editor panels.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { PinIcon } from '@/components/icons';
import { CloseIcon, CheckIcon } from '@/components/icons';
import { PlusIcon } from '@/components/icons';
import { CopyIcon } from '@/components/icons';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useOptionalToast } from '../../contexts/ToastContext';
import { Spinner } from '../primitives/Spinner';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { IconButton } from '../primitives/IconButton';
import { ToggleButton } from '../primitives/ToggleButton';
import { Tabs, TabsList, TabsTab } from '../primitives/Tabs';
import { CascadeRuleCard } from './CascadeRuleCard';
import { ElementSettingsPanel } from './ElementSettingsPanel';
import { CssAnimationsPanel } from './CssAnimationsPanel';
import { MediaQueryGroupCard } from './MediaQueryGroupCard';
import { CascadeChip } from './CascadeChip';
import { SuggestionPopover, suggestionOptionId, type Suggestion } from './SuggestionPopover';
import { WRAP_ITEMS, searchStructures, parseRulePrelude } from '../../lib/cssStructures';
import { isMediaQueryComplete } from '../../lib/mediaQueries';
import { groupCascadeRows, rowKey, type CascadeRow } from '../../lib/cssCascade';
import { parseRuleBody, type RuleBody } from '../../lib/cssBody';
import type { CascadeSelection } from '../../hooks/useCssCascadeEditor';
import type { ElementSettings } from '../../hooks/useElementSettings';
import type { useCssAnimations } from '../../hooks/useCssAnimations';

/** The panel's top-level view: element style/settings, or project-global animation CSS. */
type Scope = 'style' | 'settings' | 'animations';

function mediaConditionKey(condition: string): string {
  return condition.replace(/\s+/g, '').toLowerCase();
}

interface DraftMediaQuery {
  id: number;
  condition: string;
  selectors: string[];
}

interface Props {
  selection: CascadeSelection | null;
  rows: CascadeRow[];
  loading: boolean;
  bodies: Record<string, RuleBody>;
  overridden: Record<string, Map<string, string>>;
  onChangeBody: (key: string, body: RuleBody) => void;
  onDeleteRule: (key: string) => void | Promise<void>;
  onWrapRule: (key: string, atPrelude: string) => void;
  onRenameRule: (key: string, newSelector: string) => void;
  onRenameAtRule: (key: string, newMedia: string) => void;
  onAddSelector: (selector: string, atPrelude?: string) => void;
  /** `.class` suggestions for the selector autocomplete. */
  selectorSuggestions: string[];
  /** Full text of every existing rule selector (`.card`, `@keyframes reveal`) — shown
   *  in "Add selector" so existing rules are discoverable and re-surfaced on a match. */
  existingSelectors: string[];
  /** Project CSS variables (`--foo`) for `var(--…)` value autocomplete. */
  variables: string[];
  /** Project `@keyframes` names for `animation` value autocomplete. */
  animations: string[];
  settings: ElementSettings;
  /** Project-global Animations editor state (`@keyframes`). */
  animationsState: ReturnType<typeof useCssAnimations>;
  onClose: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  /** Controlled view — lets the Cmd+K palette open the panel directly to Style,
   *  Variables, or Animate. Uncontrolled (local state) when omitted. */
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
  settings,
  animationsState,
  onClose,
  pinned = false,
  onTogglePin,
  scope: controlledScope,
  onScopeChange,
}: Props) {
  const [localScope, setLocalScope] = useState<Scope>('style');
  const scope = controlledScope ?? localScope;
  const setScope = onScopeChange ?? setLocalScope;
  // Refresh the project-global data when its scope becomes visible.
  const reloadAnimations = animationsState.reload;
  useEffect(() => {
    if (scope === 'animations') void reloadAnimations();
  }, [scope, reloadAnimations]);
  // "Copy id": the element's selector (tag + classes), so you can paste it to your agent
  // and describe the change you want ("make a .button--secondary hover state pop").
  const { showToast } = useOptionalToast();
  const { copy: copyElementId, isCopied: idCopied } = useCopyToClipboard({
    onCopy: () => showToast('Element id copied — paste it to your agent', 'success'),
  });
  // Collapse state keyed by rule identity (selector + media), not the per-element row
  // key — so minimizing a shared rule like `*` keeps it minimized across element
  // switches. Lives on the panel (which stays mounted), so it survives reselection.
  const [collapsedRules, setCollapsedRules] = useState<Set<string>>(() => new Set());
  // A newly-composed media query has no selector (and therefore no cascade row) yet.
  // Keep it as an empty normal group until the user adds its first selector.
  const [draftMediaQueries, setDraftMediaQueries] = useState<DraftMediaQuery[]>([]);
  const draftMediaIndex = useRef(0);
  const toggleCollapsed = useCallback((ruleKey: string) => {
    setCollapsedRules((prev) => {
      const next = new Set(prev);
      if (next.has(ruleKey)) next.delete(ruleKey);
      else next.add(ruleKey);
      return next;
    });
  }, []);
  const classes = (selection?.signature.className ?? '').split(/\s+/).filter(Boolean);
  // The element's own classes lead the "Add selector" suggestions (so a class you
  // just added in Settings is one click away from getting a rule), then the rest of
  // the project's classes, then every existing rule selector (incl. `@keyframes …`)
  // so what's already defined is discoverable and re-openable rather than duplicated.
  const addSelectorOptions = [
    ...new Set([...classes.map((c) => `.${c}`), ...selectorSuggestions, ...existingSelectors]),
  ];

  const addDraftMediaQuery = (condition: string) => {
    const next = condition.trim();
    setDraftMediaQueries((current) => {
      const duplicate = current.some(({ condition: item }) =>
        next ? mediaConditionKey(item) === mediaConditionKey(next) : item === ''
      );
      return duplicate
        ? current
        : [{ id: ++draftMediaIndex.current, condition: next, selectors: [] }, ...current];
    });
  };
  const renameDraftMediaQuery = (id: number, next: string) => {
    const value = next.trim();
    const draft = draftMediaQueries.find((query) => query.id === id);
    if (draft && isMediaQueryComplete(value) && draft.selectors.length > 0) {
      setDraftMediaQueries((queries) => queries.filter((query) => query.id !== id));
      for (const selector of draft.selectors) onAddSelector(selector, `@media ${value}`);
      return;
    }
    setDraftMediaQueries((queries) =>
      queries.map((query) => (query.id === id ? { ...query, condition: value } : query))
    );
  };
  const deleteDraftMediaQuery = (id: number) => {
    setDraftMediaQueries((queries) => queries.filter((query) => query.id !== id));
  };
  const addDraftMediaSelector = (id: number, selector: string) => {
    const value = selector.trim();
    if (!value) return;
    setDraftMediaQueries((queries) =>
      queries.map((query) =>
        query.id !== id || query.selectors.includes(value)
          ? query
          : { ...query, selectors: [...query.selectors, value] }
      )
    );
  };
  const deleteDraftMediaSelector = (id: number, selector: string) => {
    setDraftMediaQueries((queries) =>
      queries.map((query) =>
        query.id === id
          ? { ...query, selectors: query.selectors.filter((item) => item !== selector) }
          : query
      )
    );
  };

  const renderRuleCard = (row: CascadeRow, insideMedia = false) => {
    const key = rowKey(row);
    const collapseKey = `${row.selector ?? ''}|${row.mediaText ?? ''}`;
    const collapsed = collapsedRules.has(collapseKey);
    const onToggleCollapse = () => toggleCollapsed(collapseKey);
    const mediaText = insideMedia ? null : row.mediaText;
    if (row.editable && bodies[key]) {
      return (
        <CascadeRuleCard
          key={key}
          editable
          selector={row.selector ?? ''}
          file={insideMedia ? undefined : row.file}
          line={insideMedia ? undefined : row.line}
          mediaText={mediaText}
          layer={row.layer}
          container={row.container}
          supports={row.supports}
          inactive={insideMedia ? false : row.inactiveMedia}
          overridden={row.inactiveMedia ? new Map() : (overridden[key] ?? new Map())}
          body={bodies[key]}
          draft={row.draft}
          unmatched={row.unmatched}
          onChange={(b) => onChangeBody(key, b)}
          onDelete={() => {
            void onDeleteRule(key);
          }}
          // A draft rule doesn't exist in source yet — no rename/wrap until it is
          // created by adding the first property.
          onWrap={row.draft || insideMedia ? undefined : (at) => onWrapRule(key, at)}
          onRename={row.draft ? undefined : (s) => onRenameRule(key, s)}
          onRenameAtRule={row.draft || insideMedia ? undefined : (m) => onRenameAtRule(key, m)}
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
        file={insideMedia ? undefined : row.file}
        line={insideMedia ? undefined : row.line}
        sourceFiles={insideMedia ? undefined : row.sourceFiles}
        mediaText={mediaText}
        layer={row.layer}
        container={row.container}
        supports={row.supports}
        inactive={insideMedia ? false : row.inactiveMedia}
        overridden={row.inactiveMedia ? new Map() : (overridden[key] ?? new Map())}
        readonlyReason={row.readonlyReason}
        decls={row.declarations.map((d) => ({
          prop: d.prop,
          value: d.value,
          important: d.important,
        }))}
      />
    );
  };

  return (
    <div
      className={`ss-edit-panel ss-cascade-panel ss-cascade-panel--dockable${
        pinned ? ' ss-edit-panel--pinned' : ''
      }`}
      data-testid="css-cascade-panel"
    >
      <div className="ss-edit-panel__header" data-dockable-drag-handle>
        <span className="ss-edit-panel__title">CSS</span>
        <span className="ss-edit-panel__header-actions">
          {onTogglePin && (
            <ToggleButton
              variant="ghost"
              size="compact"
              className="button--icon-only panel-pin-toggle"
              onClick={onTogglePin}
              title={pinned ? 'Unpin — float over the preview' : 'Pin to the window'}
              aria-label={pinned ? 'Unpin CSS panel' : 'Pin CSS panel to the window'}
              pressed={pinned}
              leftIcon={<PinIcon size={13} />}
            />
          )}
          <IconButton
            variant="ghost"
            size="compact"
            onClick={onClose}
            title="Close CSS panel"
            aria-label="Close CSS panel"
            icon={<CloseIcon size={14} />}
          />
        </span>
      </div>

      <div className="ss-edit-panel__body">
        <Tabs value={scope} mode="navigation" onValueChange={(next) => setScope(next as Scope)}>
          <TabsList className="ss-cascade-scope" aria-label="CSS panel view">
            <TabsTab value="style">Style</TabsTab>
            <TabsTab value="settings">Settings</TabsTab>
            <TabsTab value="animations">Animate</TabsTab>
          </TabsList>
        </Tabs>

        <div className="ss-cascade-content">
          {scope === 'animations' ? (
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
                <code className="ss-cascade-chip" data-tone="tag">
                  {selection.signature.tagName}
                </code>
                <span className="ss-cascade-target__selector">
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
                </span>
                <Button
                  className="ss-cascade-target__copy"
                  variant="ghost"
                  size="compact"
                  leftIcon={idCopied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
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
                  {idCopied ? 'Copied' : 'Copy id'}
                </Button>
              </div>

              {scope === 'settings' ? (
                <ElementSettingsPanel settings={settings} />
              ) : (
                <>
                  <AddSelectorBar
                    onAddSelector={onAddSelector}
                    onAddMediaQuery={addDraftMediaQuery}
                    suggestions={addSelectorOptions}
                    existing={existingSelectors}
                  />

                  {loading ? (
                    <div className="ss-cascade-loading">
                      <Spinner size="sm" />
                    </div>
                  ) : (
                    <div className="ss-cascade-cards">
                      {draftMediaQueries.map(({ id, condition, selectors }) => (
                        <MediaQueryGroupCard
                          key={`draft-media:${id}`}
                          condition={condition}
                          autoFocusQuery
                          commitQueryOnAppend
                          onRename={(next) => renameDraftMediaQuery(id, next)}
                          onDelete={() => deleteDraftMediaQuery(id)}
                          addSelector={
                            <AddSelectorBar
                              onAddSelector={(selector, atPrelude) => {
                                if (isMediaQueryComplete(condition)) {
                                  deleteDraftMediaQuery(id);
                                  onAddSelector(selector, atPrelude);
                                } else {
                                  addDraftMediaSelector(id, selector);
                                }
                              }}
                              suggestions={addSelectorOptions}
                              existing={existingSelectors}
                              fixedCondition={`@media ${condition}`}
                            />
                          }
                        >
                          {selectors.map((selector) => (
                            <CascadeRuleCard
                              key={selector}
                              editable
                              draft
                              selector={selector}
                              body={parseRuleBody('')}
                              overridden={new Map()}
                              onChange={() => undefined}
                              onDelete={() => deleteDraftMediaSelector(id, selector)}
                              selectorSuggestions={selectorSuggestions}
                              variables={variables}
                              animations={animations}
                              pendingReason="Complete the media query before editing properties."
                            />
                          ))}
                        </MediaQueryGroupCard>
                      ))}
                      {groupCascadeRows(rows).map((item) => {
                        if (item.kind === 'rule') return renderRuleCard(item.row);

                        const groupCollapseKey = `media:${item.key}`;
                        const groupEditableRow = item.rows.find(
                          (row) => row.editable && !row.draft && bodies[rowKey(row)]
                        );
                        const groupDeletableRows = item.rows.filter(
                          (row) => row.editable && !row.draft && bodies[rowKey(row)]
                        );
                        const sourceFiles = [
                          ...new Set(
                            item.rows.flatMap((row) =>
                              row.file ? [row.file] : (row.sourceFiles ?? [])
                            )
                          ),
                        ];
                        return (
                          <MediaQueryGroupCard
                            key={item.key}
                            condition={item.condition}
                            file={sourceFiles.length === 1 ? sourceFiles[0] : undefined}
                            sourceFiles={sourceFiles}
                            inactive={item.rows.some((row) => row.inactiveMedia)}
                            collapsed={collapsedRules.has(groupCollapseKey)}
                            onToggleCollapse={() => toggleCollapsed(groupCollapseKey)}
                            onRename={
                              groupEditableRow
                                ? (condition) => onRenameAtRule(rowKey(groupEditableRow), condition)
                                : undefined
                            }
                            onDelete={
                              groupDeletableRows.length === item.rows.length
                                ? () => {
                                    void (async () => {
                                      for (const row of groupDeletableRows) {
                                        await onDeleteRule(rowKey(row));
                                      }
                                    })();
                                  }
                                : undefined
                            }
                            addSelector={
                              groupEditableRow ? (
                                <AddSelectorBar
                                  onAddSelector={onAddSelector}
                                  suggestions={addSelectorOptions}
                                  existing={existingSelectors}
                                  fixedCondition={`@media ${item.condition}`}
                                />
                              ) : undefined
                            }
                          >
                            {item.rows.map((row) => renderRuleCard(row, true))}
                          </MediaQueryGroupCard>
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
    </div>
  );
}

/** "Add selector" affordance: a button that expands to a selector input with a
 *  live autocomplete of the project's class names (and a "new rule" row for free
 *  text), creating a new rule for the element. */
export function AddSelectorBar({
  onAddSelector,
  onAddMediaQuery,
  suggestions,
  existing,
  fixedCondition,
}: {
  onAddSelector: (selector: string, atPrelude?: string) => void;
  /** Creates an empty media group before any selector is added to it. */
  onAddMediaQuery?: (condition: string) => void;
  suggestions: string[];
  /** Selectors that already have a rule — tagged "existing" and re-opened on pick. */
  existing: string[];
  /** When present, the selector is added inside this existing `@media` wrapper. */
  fixedCondition?: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const listId = useId();

  const submit = (value: string) => {
    const v = value.trim();
    if (v) onAddSelector(v, fixedCondition);
    setText('');
    setActive(0);
    setOpen(false);
  };

  const beginMediaQuery = (value: string): boolean => {
    const trimmed = value.trim();
    const [keyword = '', ...conditionParts] = trimmed.split(/\s+/);
    // Accept the useful partials too (`@m`, `@med`, …), while leaving other
    // at-rules on the existing condition autocomplete path.
    if (keyword.length < 2 || !'@media'.startsWith(keyword.toLowerCase())) return false;
    onAddMediaQuery?.(keyword.toLowerCase() === '@media' ? conditionParts.join(' ') : '');
    setText('');
    setActive(0);
    setOpen(false);
    return true;
  };

  const existingSet = new Set(existing);
  // Smart staged autofill: compose one rule prelude `[@condition] [selector]`. While you
  // type the `@…` it suggests CONDITIONS (any kind — width, dark mode, print, container
  // / style query, supports); once the condition is set it suggests your project's
  // CLASSES for the selector. Picking a condition keeps you typing; picking a class (or
  // Enter) creates `@condition { selector { } }`.
  const parsed = fixedCondition
    ? { condition: fixedCondition, selector: text, stage: 'selector' as const }
    : parseRulePrelude(text);
  let items: Suggestion[];
  if (parsed.stage === 'condition' && !fixedCondition) {
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
    if (parsed.stage === 'condition' && !fixedCondition) {
      setText(`${value} `);
      setActive(0);
      anchorEl?.focus();
    } else {
      submit(fixedCondition ? value : parsed.condition ? `${parsed.condition} ${value}` : value);
    }
  };

  const action = (
    <div className={`ss-cascade-action${fixedCondition ? ' ss-cascade-action--nested' : ''}`}>
      {fixedCondition ? (
        <TextButton
          leftIcon={<PlusIcon size={11} />}
          data-cascade-add-selector
          onClick={() => setOpen(true)}
        >
          Add selector
        </TextButton>
      ) : (
        <Button
          variant="default"
          width="fill"
          leftIcon={<PlusIcon size={11} />}
          data-cascade-add-selector
          onClick={() => setOpen(true)}
        >
          Add selector
        </Button>
      )}
    </div>
  );

  const selectorComposer = (
    <section className="ss-cascade-card ss-cascade-selector-composer" aria-label="New selector">
      <header className="ss-cascade-card__head">
        <div className="ss-cascade-card__selector-row">
          <span className="ss-cascade-card__collapse" aria-hidden="true" />
          <CascadeChip
            tone={text.trimStart().startsWith('@') ? 'media' : 'selector'}
            editing
            className="ss-cascade-card__selector-edit"
          >
            <input
              className="ss-cascade-chip__input"
              autoFocus
              value={text}
              size={Math.max(text.length, 1)}
              spellCheck={false}
              autoComplete="off"
              role="combobox"
              aria-expanded={items.length > 0}
              aria-controls={listId}
              aria-activedescendant={
                items.length > 0 ? suggestionOptionId(listId, active) : undefined
              }
              aria-autocomplete="list"
              aria-label="Add selector"
              placeholder=".class-name"
              onFocus={(e) => setAnchorEl(e.currentTarget)}
              onChange={(e) => {
                setText(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (!fixedCondition && beginMediaQuery(text)) return;
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
          </CascadeChip>
          <SuggestionPopover
            anchor={anchorEl}
            items={items}
            active={active}
            onPick={pick}
            width={280}
            flip={false}
            listId={listId}
          />
        </div>
      </header>
    </section>
  );

  const composer = open ? selectorComposer : null;

  return fixedCondition ? (
    <>
      {composer}
      {action}
    </>
  ) : (
    <>
      {action}
      {composer}
    </>
  );
}
