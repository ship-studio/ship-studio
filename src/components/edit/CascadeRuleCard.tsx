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

import { useMemo, useRef, useState } from 'react';
import { predictNextDeclaration } from '../../lib/cssPredict';
import { ChevronIcon, CloseIcon } from '@/components/icons';
import { FileTextIcon, TrashIcon } from '@/components/icons';
import { DeclarationRow } from './DeclarationRow';
import { CssValueText } from './CssValueText';
import { AddMenu } from './AddMenu';
import { isKeyframesSelector } from '../../lib/cssStructures';
import { KeyframesNameChip, keyframesName } from './KeyframesNameChip';
import { NestedSelectorInput } from './NestedSelectorInput';
import { RuleContextChips } from './RuleContextChips';
import { SelectorChip, SelectorListDisplay } from './SelectorChip';
import { TextButton } from '../primitives/TextButton';
import { Button } from '../primitives/Button';
import { Dropdown, DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';
import { ModalFrame } from '../primitives/ModalFrame';
import { cascadeSourceFileLabel, nestedRuleCollapseKey } from '../../lib/cascadePresentation';
import { searchRuleBody } from '../../lib/cascadeSearch';
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
import type { ColorContrastContexts, ColorVariableDefinition } from '../../lib/colorContrast';

interface CommonHeader {
  selector: string;
  /** Full source/CSSOM selector-list prelude when available. */
  selectorList?: string;
  file?: string;
  line?: number;
  /** Candidate source files when the selector is defined by multiple rules. */
  sourceFiles?: string[];
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
  /** Resolved project token values for color display and variable authoring. */
  colorVariables?: readonly ColorVariableDefinition[];
  /** Stable identity used by the panel-wide collapse control for nested rules. */
  collapseKey?: string;
  collapseControl?: {
    collapsedKeys: ReadonlySet<string>;
    searchCollapsedOverrides: ReadonlyMap<string, boolean>;
    toggle: (key: string) => void;
    toggleSearch: (key: string, collapsed: boolean) => void;
  };
  /** Search terms are presentation-only: edits still target the original body indices. */
  searchTerm?: string;
  /** A matching root selector or enclosing condition reveals the whole card body. */
  searchMatchesAll?: boolean;
  /** A query-scoped collapse toggle. Undefined means matching cards start expanded. */
  searchCollapseOverride?: boolean;
  /** This whole card is an unmatched item exposed by its parent's Show all action. */
  searchDimmed?: boolean;
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
  /** Present when the source rule is a selector list and this member is shared. */
  sharedSelectors?: string[];
  /** Whether the backend proved every member can be split without changing specificity. */
  selectorListSplitSafe?: boolean;
  /** Request the card's selector field to open from the command palette. */
  selectorEditRequestId?: number;
  onSelectorEditRequestHandled?: (requestId: number) => void;
  /** Remove only this card's matched selector-list member. */
  onRemoveSelector?: () => void;
  /** Split every member into its own adjacent source rule with the same body/context. */
  onSplitSelectorList?: () => void;
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
  projectPath?: string;
  colorContrast?: ColorContrastContexts;
  /** A not-yet-created rule (one of the element's own selectors) — shown dashed with a
   *  "new" chip; the rule is written to source on the first property. */
  draft?: boolean;
  /** Whether this draft has a verified destination stylesheet for its first write. */
  draftTargetKnown?: boolean;
  /** A local selector waiting for its enclosing construct to become writable. */
  pendingReason?: string;
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

export function CascadeRuleCard(props: Props) {
  // Controlled by the panel (persists across element switches) when `onToggleCollapse`
  // is supplied; otherwise local (nested cards, where per-instance state is fine).
  const [localCollapsed, setLocalCollapsed] = useState(false);
  const controlled = props.onToggleCollapse != null;
  const storedCollapsed = controlled ? (props.collapsed ?? false) : localCollapsed;
  const searchTerm = props.searchTerm?.trim() ?? '';
  const normalizedSearch = searchTerm.toLocaleLowerCase();
  const searchActive = normalizedSearch.length > 0;
  const selectorMatches = Boolean(
    searchActive &&
    (props.searchMatchesAll || props.selector.toLocaleLowerCase().includes(normalizedSearch))
  );
  const editableBody = props.editable ? props.body : null;
  const bodySearch = useMemo(
    () => (editableBody && searchActive ? searchRuleBody(editableBody, normalizedSearch) : null),
    [editableBody, normalizedSearch, searchActive]
  );
  const readonlyHasMatch =
    !props.editable &&
    searchActive &&
    props.decls.some(
      (decl) =>
        decl.prop.toLocaleLowerCase().includes(normalizedSearch) ||
        decl.value.toLocaleLowerCase().includes(normalizedSearch) ||
        (decl.important && '!important'.includes(normalizedSearch))
    );
  const cardHasSearchMatch = selectorMatches || Boolean(bodySearch?.hasMatch) || readonlyHasMatch;
  const [showAllState, setShowAllState] = useState<{ query: string; visible: boolean } | null>(
    null
  );
  const showAll = Boolean(
    searchActive && showAllState?.query === normalizedSearch && showAllState.visible
  );
  const [localSearchCollapse, setLocalSearchCollapse] = useState<{
    query: string;
    collapsed: boolean;
  } | null>(null);
  const searchCollapseOverride =
    props.searchCollapseOverride ??
    (localSearchCollapse?.query === normalizedSearch ? localSearchCollapse.collapsed : undefined);
  const collapsed =
    searchActive && cardHasSearchMatch ? (searchCollapseOverride ?? false) : storedCollapsed;
  const toggleCollapse = () => {
    if (controlled) {
      props.onToggleCollapse?.();
    } else if (searchActive && cardHasSearchMatch) {
      setLocalSearchCollapse({ query: normalizedSearch, collapsed: !collapsed });
    } else {
      setLocalCollapsed((value) => !value);
    }
  };
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
  const sourcePaths = props.file ? [props.file] : Array.from(new Set(props.sourceFiles ?? []));
  const sourceTitle = props.file ? `${props.file}:${props.line}` : sourcePaths.join('\n');
  const sourceLabel = sourcePaths.map(cascadeSourceFileLabel).join(', ');
  const propertyCount = props.editable ? declarations(props.body).length : props.decls.length;
  const sharedSelectors = props.editable ? (props.sharedSelectors ?? []) : [];
  const selectorList = props.selectorList ?? props.selector;
  const [confirmSharedDelete, setConfirmSharedDelete] = useState(false);

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
      const add = card.querySelector<HTMLElement>('.ss-cascade-card__add');
      const collapse = card.querySelector<HTMLElement>('.ss-cascade-card__collapse');
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
      el && el.classList.contains('ss-cascade-card')
        ? el.querySelector<HTMLElement>('.ss-cascade-card__collapse')
        : null;
    const panel = card.closest('.ss-cascade-panel');
    requestAnimationFrame(() => {
      const target =
        cardCollapse(next) ??
        cardCollapse(prev) ??
        panel?.querySelector<HTMLElement>('[data-cascade-add-selector]');
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
        <div className={`ss-cascade-card__context${inactive ? ' is-inactive' : ''}`}>
          <RuleContextChips
            mediaText={props.mediaText}
            layer={props.layer}
            container={props.container}
            supports={props.supports}
            onRenameAtRule={onRenameAtRule}
          />
          {inactive && (
            <span
              className="ss-cascade-card__context-note"
              title="This condition doesn't match the current preview size — these styles aren't applying right now"
            >
              not active now
            </span>
          )}
        </div>
      )}
      <div className="ss-cascade-card__selector-row">
        <button
          type="button"
          className={`ss-cascade-card__collapse${collapsed ? ' is-collapsed' : ''}`}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand rule' : 'Collapse rule'}
          onClick={toggleCollapse}
        >
          <ChevronIcon size={12} />
        </button>
        <div className="ss-cascade-card__selector-main">
          <div className="ss-cascade-card__selector-field">
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
                key={props.selectorEditRequestId ?? 'manual'}
                selector={props.selector}
                selectorList={selectorList}
                suggestions={props.selectorSuggestions ?? []}
                onCommit={props.onRename}
                onWrap={props.onWrap}
                editRequestId={props.selectorEditRequestId}
                onEditRequestHandled={props.onSelectorEditRequestHandled}
              />
            ) : (
              <SelectorListDisplay selectorList={selectorList} />
            )}
          </div>
          {editable &&
            sharedSelectors.length > 0 &&
            props.selectorListSplitSafe &&
            props.onSplitSelectorList && (
              <TextButton
                className="ss-cascade-card__split"
                title={`Split all ${sharedSelectors.length + 1} selectors into adjacent rules with the same declarations`}
                aria-label={`Split all ${sharedSelectors.length + 1} selectors into individual rules`}
                onClick={props.onSplitSelectorList}
              >
                Split
              </TextButton>
            )}
          {props.editable && props.draft && !props.pendingReason && (
            <span
              className="ss-cascade-card__draft-status"
              title={
                props.draftTargetKnown === false
                  ? 'No verified stylesheet destination is known for this selector yet'
                  : 'No rules applied — add a property to create this selector in your stylesheet'
              }
            >
              No rules applied
            </span>
          )}
          {!editable && (
            <span className="ss-cascade-card__src ss-cascade-card__src--ro">read-only</span>
          )}
          {sourcePaths.length > 0 && (
            <span className="ss-cascade-card__src-chip" title={sourceTitle}>
              <FileTextIcon size={11} />
              <span className="ss-cascade-card__src-label">{sourceLabel}</span>
            </span>
          )}
        </div>
        {editable &&
          props.onDelete &&
          (!props.draft || props.pendingReason) &&
          (sharedSelectors.length > 0 && props.onRemoveSelector ? (
            <Dropdown
              align="right"
              className="ss-cascade-card__trash-menu"
              trigger={(triggerProps) => (
                <MenuButton
                  {...triggerProps}
                  variant="ghost"
                  size="compact"
                  className="ss-cascade-card__trash"
                  title="Rule actions"
                  aria-label="Rule actions"
                  expanded={triggerProps['aria-expanded']}
                >
                  <TrashIcon size={12} />
                </MenuButton>
              )}
            >
              <DropdownItem
                icon={<TrashIcon size={13} />}
                onSelect={() => {
                  focusAfterCardDelete();
                  props.onRemoveSelector?.();
                }}
              >
                Remove {props.selector} from this rule
              </DropdownItem>
              <DropdownDivider />
              <DropdownItem variant="danger" onSelect={() => setConfirmSharedDelete(true)}>
                Delete entire shared rule…
              </DropdownItem>
            </Dropdown>
          ) : (
            <div className="ss-cascade-card__trash-menu">
              <button
                type="button"
                className="ss-cascade-card__trash"
                title="Delete rule"
                aria-label="Delete rule"
                onClick={() => {
                  focusAfterCardDelete();
                  props.onDelete?.();
                }}
              >
                <TrashIcon size={12} />
              </button>
            </div>
          ))}
      </div>
      {collapsed && (
        <span className="ss-cascade-card__collapsed-summary">
          {propertyCount} {propertyCount === 1 ? 'property' : 'properties'}
        </span>
      )}
    </>
  );

  if (!editable) {
    const indexedDecls = props.decls.map((decl, index) => ({ decl, index }));
    const matchesDeclaration = (decl: Decl) =>
      decl.prop.toLocaleLowerCase().includes(normalizedSearch) ||
      decl.value.toLocaleLowerCase().includes(normalizedSearch) ||
      (decl.important && '!important'.includes(normalizedSearch));
    const hasHiddenDeclarations =
      searchActive &&
      !selectorMatches &&
      indexedDecls.some(({ decl }) => !matchesDeclaration(decl));
    const visibleDecls = indexedDecls.filter(
      ({ decl }) => !searchActive || selectorMatches || showAll || matchesDeclaration(decl)
    );
    return (
      <section
        className={`ss-cascade-card is-readonly${depth ? ' is-nested' : ''}${collapsed ? ' is-collapsed' : ''}${inactive ? ' is-inactive' : ''}${props.searchDimmed ? ' is-search-dimmed' : ''}`}
        data-testid="cascade-card"
      >
        <header className="ss-cascade-card__head">{headerContent}</header>
        {!collapsed && (
          <div className="ss-cascade-card__body">
            {visibleDecls.map(({ decl, index }) => {
              const dimmed = showAll && !selectorMatches && !matchesDeclaration(decl);
              return (
                <div
                  key={`${decl.prop}-${index}`}
                  className={`ss-cascade-filtered${dimmed ? ' is-dimmed' : ''}`}
                >
                  <DeclarationRow
                    editable={false}
                    decl={decl}
                    overridden={props.overridden.has(decl.prop.toLowerCase())}
                    overriddenBy={props.overridden.get(decl.prop.toLowerCase())}
                    colorVariables={props.colorVariables}
                    variableSelector={
                      (props.depth ?? 0) === 0 && !props.isStep ? props.selector : undefined
                    }
                  />
                </div>
              );
            })}
            {hasHiddenDeclarations && (
              <div className="ss-cascade-card__search-actions ss-cascade-card__search-actions--readonly">
                <TextButton
                  onClick={() => setShowAllState({ query: normalizedSearch, visible: !showAll })}
                >
                  {showAll ? 'Show matching properties' : 'Show all properties'}
                </TextButton>
              </div>
            )}
            {props.readonlyReason && (
              <p className="ss-cascade-card__note">{props.readonlyReason}</p>
            )}
          </div>
        )}
      </section>
    );
  }

  const { body, onChange, overridden } = props;
  const decls = declarations(body);
  const nested = nestedRules(body);
  const directMatches = (index: number) =>
    selectorMatches || Boolean(bodySearch?.declarationIndexes.has(index));
  const nestedMatches = (index: number, selector: string) =>
    selectorMatches ||
    selector.toLocaleLowerCase().includes(normalizedSearch) ||
    Boolean(bodySearch?.nestedRuleIndexes.has(index));
  const hasHiddenContent =
    searchActive &&
    !selectorMatches &&
    (decls.some((decl) => !directMatches(decl.index)) ||
      nested.some((rule) => !nestedMatches(rule.index, rule.selector)));
  const visibleDecls = decls.filter(
    (decl) => !searchActive || selectorMatches || showAll || directMatches(decl.index)
  );
  const visibleNested = nested.filter(
    (rule) =>
      !searchActive || selectorMatches || showAll || nestedMatches(rule.index, rule.selector)
  );
  const nestedCollapseKeys = new Map<number, string>();
  if (props.collapseKey) {
    const occurrences = new Map<string, number>();
    for (const rule of nested) {
      const occurrence = occurrences.get(rule.selector) ?? 0;
      occurrences.set(rule.selector, occurrence + 1);
      nestedCollapseKeys.set(
        rule.index,
        nestedRuleCollapseKey(props.collapseKey, rule.selector, occurrence)
      );
    }
  }

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
      className={`ss-cascade-card${depth ? ' is-nested' : ''}${isStep ? ' is-keyframe-step' : ''}${collapsed ? ' is-collapsed' : ''}${inactive ? ' is-inactive' : ''}${props.draft ? ' is-draft' : ''}${props.unmatched ? ' is-unmatched' : ''}${props.searchDimmed ? ' is-search-dimmed' : ''}`}
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
      <header className="ss-cascade-card__head">{headerContent}</header>

      {sharedSelectors.length > 0 && (
        <ModalFrame
          isOpen={confirmSharedDelete}
          onClose={() => setConfirmSharedDelete(false)}
          title="Delete entire shared rule?"
          showCloseButton
          className="ss-cascade-shared-delete-modal"
        >
          <div className="ss-cascade-shared-delete-modal__body">
            <p>
              This removes the rule and its properties for <code>{props.selector}</code> and every
              selector listed here:
            </p>
            <p className="ss-cascade-shared-delete-modal__selectors">
              {sharedSelectors.map((selector, index) => (
                <code key={`${selector}-${index}`}>{selector}</code>
              ))}
            </p>
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setConfirmSharedDelete(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmSharedDelete(false);
                  focusAfterCardDelete();
                  props.onDelete?.();
                }}
              >
                Delete entire rule
              </Button>
            </div>
          </div>
        </ModalFrame>
      )}

      {!collapsed && (
        <div className="ss-cascade-card__body">
          {props.draft && props.pendingReason && (
            <div className="ss-cascade-card__draft-row">
              <span
                className="ss-cascade-card__chip ss-cascade-card__chip--new"
                title={props.pendingReason}
              >
                Pending selector
              </span>
            </div>
          )}
          {props.pendingReason && (
            <p className="ss-cascade-card__note ss-cascade-card__note--pending">
              {props.pendingReason}
            </p>
          )}
          {props.unmatched && (
            <p className="ss-cascade-card__note ss-cascade-card__note--unmatched">
              This selector doesn&apos;t match the selected element, so it isn&apos;t applying here
              — add the class in Settings, or rename it to one of the element&apos;s selectors.
            </p>
          )}
          {visibleDecls.map((d) => {
            const dimmed = showAll && !directMatches(d.index);
            return (
              <div key={d.index} className={`ss-cascade-filtered${dimmed ? ' is-dimmed' : ''}`}>
                <DeclarationRow
                  editable
                  decl={{ prop: d.prop, value: d.value, important: d.important }}
                  overridden={overridden.has(d.prop.toLowerCase())}
                  overriddenBy={overridden.get(d.prop.toLowerCase())}
                  nestTargets={nested.map((r) => r.selector)}
                  variables={props.variables}
                  colorVariables={props.colorVariables}
                  variableSelector={
                    (props.depth ?? 0) === 0 && !props.isStep ? props.selector : undefined
                  }
                  projectPath={props.projectPath}
                  colorContrast={props.colorContrast}
                  animations={props.animations}
                  autoEditValue={autoEditProp === d.prop}
                  onChange={(next) =>
                    onChange(replaceItem(body, d.index, { kind: 'decl', ...next }))
                  }
                  onRemove={(rowEl) => {
                    focusWithinCard(rowEl);
                    onChange(removeItem(body, d.index));
                  }}
                  onNest={(sel) => onChange(moveDeclIntoNested(body, d.index, sel))}
                />
              </div>
            );
          })}

          {hasHiddenContent && (
            <div className="ss-cascade-card__search-actions">
              <TextButton
                onClick={() => setShowAllState({ query: normalizedSearch, visible: !showAll })}
              >
                {showAll ? 'Show matching properties' : 'Show all properties'}
              </TextButton>
            </div>
          )}

          {prediction && !props.pendingReason && (
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
                <span className="ss-decl__ghost-property">
                  <kbd className="ss-decl__ghost-kbd">Tab</kbd>
                  <span className="ss-decl__prop">{prediction.prop}</span>
                </span>
                <span className="ss-decl__colon">:</span>
                <span className="ss-decl__value">
                  <CssValueText value={prediction.value} />
                  {prediction.hint && (
                    <span className="ss-decl__ghost-hint">{prediction.hint}</span>
                  )}
                </span>
              </button>
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

          {!props.pendingReason && !isKeyframes && (
            <div className="ss-cascade-card__add-row">
              <AddMenu
                mode={isKeyframes ? 'keyframes' : isStep ? 'props' : 'full'}
                onAddProperty={(prop) => {
                  onChange(addDeclaration(body, { prop, value: '', important: false }));
                  setAutoEditProp(prop); // → the new row opens its value input
                }}
                onNest={(sel) => onChange(addNestedRule(body, sel))}
              />
            </div>
          )}

          {visibleNested.map((r) => {
            const collapseKey = nestedCollapseKeys.get(r.index);
            const nestedSearchMatch = nestedMatches(r.index, r.selector);
            const nestedSearchAll = Boolean(props.searchMatchesAll || selectorMatches || showAll);
            const nestedCollapsed =
              searchActive && (nestedSearchMatch || nestedSearchAll)
                ? (props.collapseControl?.searchCollapsedOverrides.get(collapseKey ?? '') ?? false)
                : (props.collapseControl?.collapsedKeys.has(collapseKey ?? '') ?? false);
            return (
              <div
                key={r.index}
                className={`ss-cascade-filtered${showAll && !nestedSearchMatch ? ' is-dimmed' : ''}`}
              >
                <CascadeRuleCard
                  editable
                  depth={depth + 1}
                  isStep={isKeyframes}
                  selector={r.selector}
                  overridden={new Map()}
                  body={r.body}
                  variables={props.variables}
                  colorVariables={props.colorVariables}
                  projectPath={props.projectPath}
                  animations={props.animations}
                  selectorSuggestions={props.selectorSuggestions}
                  collapseKey={collapseKey}
                  collapseControl={props.collapseControl}
                  collapsed={nestedCollapsed}
                  searchCollapseOverride={nestedCollapsed}
                  onToggleCollapse={
                    collapseKey && props.collapseControl
                      ? () => {
                          if (searchActive && (nestedSearchMatch || nestedSearchAll)) {
                            props.collapseControl?.toggleSearch(collapseKey, !nestedCollapsed);
                          } else {
                            props.collapseControl?.toggle(collapseKey);
                          }
                        }
                      : undefined
                  }
                  searchTerm={searchTerm}
                  searchMatchesAll={nestedSearchAll}
                  onChange={(nextBody) =>
                    onChange(
                      replaceItem(body, r.index, {
                        kind: 'rule',
                        selector: r.selector,
                        body: nextBody,
                      })
                    )
                  }
                  onSelectorChange={
                    isKeyframes
                      ? undefined
                      : (sel) =>
                          onChange(
                            replaceItem(body, r.index, {
                              kind: 'rule',
                              selector: sel,
                              body: r.body,
                            })
                          )
                  }
                  onDelete={() => onChange(removeItem(body, r.index))}
                />
              </div>
            );
          })}

          {!props.pendingReason && isKeyframes && (
            <div className="ss-cascade-card__add-row ss-cascade-card__add-row--keyframes">
              <AddMenu
                mode="keyframes"
                onAddProperty={(prop) => {
                  onChange(addDeclaration(body, { prop, value: '', important: false }));
                  setAutoEditProp(prop);
                }}
                onNest={(sel) => onChange(addNestedRule(body, sel))}
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
