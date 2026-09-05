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
import { SelectorChip, SelectorDisplay } from './SelectorChip';
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

const basename = (path: string) => path.split('/').pop() ?? path;
/** A readable file-chip label. Embedded `<style>` blocks are addressed as
 *  `Foo.astro?style=0`; show them as `Foo.astro › style` rather than the raw query. */
const fileLabel = (path: string) => {
  const [file, query] = path.split('?style=');
  const name = basename(file);
  return query ? `${name} › style` : name;
};

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
  const sourcePaths = props.file ? [props.file] : Array.from(new Set(props.sourceFiles ?? []));
  const sourceTitle = props.file ? `${props.file}:${props.line}` : sourcePaths.join('\n');
  const sourceLabel = sourcePaths.map(fileLabel).join(', ');
  const propertyCount = props.editable ? declarations(props.body).length : props.decls.length;

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
          <SelectorDisplay selector={props.selector} />
        )}
        <span className="ss-cascade-card__head-spacer" />
        {!editable && (
          <span className="ss-cascade-card__src ss-cascade-card__src--ro">read-only</span>
        )}
        {editable && props.onDelete && (!props.draft || props.pendingReason) && (
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
        )}
        {sourcePaths.length > 0 && (
          <span className="ss-cascade-card__src-chip" title={sourceTitle}>
            <FileTextIcon size={11} />
            {sourceLabel}
          </span>
        )}
      </div>
      {collapsed && (
        <span className="ss-cascade-card__collapsed-summary">
          {propertyCount} {propertyCount === 1 ? 'property' : 'properties'}
        </span>
      )}
    </>
  );

  if (!editable) {
    return (
      <section
        className={`ss-cascade-card is-readonly${depth ? ' is-nested' : ''}${collapsed ? ' is-collapsed' : ''}${inactive ? ' is-inactive' : ''}`}
        data-testid="cascade-card"
      >
        <header className="ss-cascade-card__head">{headerContent}</header>
        {!collapsed && (
          <div className="ss-cascade-card__body">
            {props.decls.map((d, i) => (
              <DeclarationRow
                key={`${d.prop}-${i}`}
                editable={false}
                decl={d}
                overridden={props.overridden.has(d.prop.toLowerCase())}
                overriddenBy={props.overridden.get(d.prop.toLowerCase())}
              />
            ))}
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
      className={`ss-cascade-card${depth ? ' is-nested' : ''}${isStep ? ' is-keyframe-step' : ''}${collapsed ? ' is-collapsed' : ''}${inactive ? ' is-inactive' : ''}${props.draft ? ' is-draft' : ''}${props.unmatched ? ' is-unmatched' : ''}`}
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

      {!collapsed && (
        <div className="ss-cascade-card__body">
          {props.draft && (
            <div className="ss-cascade-card__draft-row">
              <span
                className="ss-cascade-card__chip ss-cascade-card__chip--new"
                title={
                  props.pendingReason ??
                  'No rules applied — add a property to create this selector in your stylesheet'
                }
              >
                {props.pendingReason ? 'Pending selector' : 'No rules applied'}
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

          {!props.pendingReason && (
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
                <span className="ss-decl__prop">{prediction.prop}</span>
                <span className="ss-decl__colon">:</span>
                <span className="ss-decl__value">
                  <CssValueText value={prediction.value} />
                  {prediction.hint && (
                    <span className="ss-decl__ghost-hint">{prediction.hint}</span>
                  )}
                </span>
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
              onSelectorChange={
                isKeyframes
                  ? undefined
                  : (sel) =>
                      onChange(
                        replaceItem(body, r.index, { kind: 'rule', selector: sel, body: r.body })
                      )
              }
              onDelete={() => onChange(removeItem(body, r.index))}
            />
          ))}
        </div>
      )}
    </section>
  );
}
