/**
 * CSS-Mode editor panel — the properties panel for the CSS visual editor
 * (`useCssEditor`). A SEPARATE feature from `VisualEditorPanel` (the Tailwind
 * one); it shares the `ss-edit-panel` chrome (draggable header, pin, close) for
 * an identical look, but its body edits a CSS rule directly.
 *
 * A resolved rule offers two views:
 * - **Visual** — structured controls grouped by category (Layout, Spacing,
 *   Type, …), each reading/writing one CSS property off the rule.
 * - **Code** — the rule's declarations as raw, editable CSS, for a direct
 *   connection to the source.
 *
 * Other states mirror the resolver: `not_found` (create the rule), and the
 * read-only `needs_class` / `inline` / `multiple` cases, each offering the
 * agent-prep prompt.
 */

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { ToggleButton } from '../primitives/ToggleButton';
import { Tabs, TabsList, TabsTab } from '../primitives/Tabs';
import { EnumDropdown } from './EnumDropdown';
import { PinIcon } from '@/components/icons';
import { SaveIcon } from '@/components/icons';
import { ChevronIcon, CloseIcon } from '@/components/icons';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { trackEvent } from '../../lib/analytics';
import { buildCssPrepPrompt } from '../../lib/edit-css';
import { CssControls, AddProp } from './CssControls';
import { CssClassBar, CssStateSwitcher, CssBreakpointBar } from './CssClassBar';
import { CodeOverlayEditor } from './CodeOverlayEditor';
import { CSS_CATEGORIES, PROP_TO_CATEGORY, CSS_BREAKPOINTS } from '../../lib/cssControls';

/** Common sections start open; the long-tail ones collapse to keep it scannable. */
function defaultSectionOpen(id: string): boolean {
  return !['position', 'transform', 'effects'].includes(id);
}
import type { CssSelection } from '../../hooks/useCssEditor';
import type { CssDeclaration } from '../../lib/edit-css';

const PANEL_WIDTH = 340;
const VIEW_KEY = 'ss:cssEditor:view';

type DeclChange = { property: string; value: string | null };

/** Serialize a rule's declarations to CSS text for the Code view. */
function serializeDeclarations(declarations: CssDeclaration[]): string {
  return declarations
    .map((d) => `${d.property}: ${d.value}${d.important ? ' !important' : ''};`)
    .join('\n');
}

/** Parse the Code view's text back into `property: value` pairs. */
function parseCssText(text: string): { property: string; value: string }[] {
  const out: { property: string; value: string }[] = [];
  for (const chunk of text.split(';')) {
    const i = chunk.indexOf(':');
    if (i < 0) continue;
    const property = chunk.slice(0, i).trim().toLowerCase();
    const value = chunk.slice(i + 1).trim();
    if (property && value) out.push({ property, value });
  }
  return out;
}

/** Diff edited declarations against the current rule into a change set. */
function diffDeclarations(
  current: CssDeclaration[],
  edited: { property: string; value: string }[]
): DeclChange[] {
  const changes: DeclChange[] = [];
  const editedMap = new Map(edited.map((d) => [d.property.toLowerCase(), d.value]));
  const currentMap = new Map(current.map((d) => [d.property.toLowerCase(), d]));
  // Added / changed.
  for (const [prop, value] of editedMap) {
    const cur = currentMap.get(prop);
    const curVal = cur ? `${cur.value}${cur.important ? ' !important' : ''}` : null;
    if (curVal !== value) changes.push({ property: prop, value });
  }
  // Removed.
  for (const prop of currentMap.keys()) {
    if (!editedMap.has(prop)) changes.push({ property: prop, value: null });
  }
  return changes;
}

interface Props {
  selection: CssSelection | null;
  authoredSheets: string[];
  saving: boolean;
  /** Live-preview a property on the resolved rule (no write). */
  onPreview: (property: string, value: string | null) => void;
  /** Persist a property (remove when value is null). */
  onSave: (property: string, value: string | null) => void;
  /** Persist several declaration changes at once (the Code view's Save). */
  onSaveMany: (changes: DeclChange[]) => void;
  /** Create a rule for `selector` in `file` (the not-found case). */
  onCreateRule: (file: string, selector: string, declarations?: CssDeclaration[]) => void;
  /** Paste the prep prompt into the agent terminal (user presses Enter). */
  onSendToClaude?: (prompt: string) => void;
  // Class bar + state switcher + breakpoints.
  targetClass: string | null;
  pseudo: string | null;
  allClasses: string[];
  breakpointMinPx: number | null;
  onSelectClass: (name: string) => void;
  onAddClass: (name: string) => void;
  onRemoveClass: (name: string) => void;
  onSetPseudo: (pseudo: string | null) => void;
  onSetBreakpoint: (minPx: number | null) => void;
  onClose: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
}

/** The raw-CSS view of the rule: edit declarations as text, save the diff. */
function CodeView({
  declarations,
  onSaveMany,
}: {
  declarations: CssDeclaration[];
  onSaveMany: (changes: DeclChange[]) => void;
}) {
  const serialized = serializeDeclarations(declarations);
  const [text, setText] = useState(serialized);
  const dirty = text !== serialized;
  // Same DOM + classes as the (working) HTML editor tab: the editor absolutely
  // fills a relative, overflow-clipped box, so the textarea always spans the
  // area and click-to-caret works everywhere.
  return (
    <div className="ss-css-code">
      <div className="ss-htmltab">
        <div className="ss-htmltab__main">
          <CodeOverlayEditor
            value={text}
            onChange={setText}
            lang="css"
            placeholder="property: value;"
          />
        </div>
        <div className="ss-htmltab__foot">
          <Button
            variant="ghost"
            size="compact"
            disabled={!dirty}
            onClick={() => setText(serialized)}
          >
            Revert
          </Button>
          <Button
            variant="primary"
            size="compact"
            disabled={!dirty}
            leftIcon={<SaveIcon size={12} />}
            onClick={() => {
              const changes = diffDeclarations(declarations, parseCssText(text));
              if (changes.length) onSaveMany(changes);
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

export function CssEditorPanel({
  selection,
  authoredSheets,
  saving,
  onPreview,
  onSave,
  onSaveMany,
  onCreateRule,
  onSendToClaude,
  targetClass,
  pseudo,
  allClasses,
  breakpointMinPx,
  onSelectClass,
  onAddClass,
  onRemoveClass,
  onSetPseudo,
  onSetBreakpoint,
  onClose,
  pinned = false,
  onTogglePin,
}: Props) {
  const [pos, setPos] = useState(() => ({
    top: 76,
    left: Math.max(
      8,
      (typeof window !== 'undefined' ? window.innerWidth : 1280) - PANEL_WIDTH - 24
    ),
  }));
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  // The create-rule target; defaults (derived, no effect) to the first sheet.
  const [sheet, setSheet] = useState('');
  const effectiveSheet = sheet || authoredSheets[0] || '';

  // Visual (structured controls) vs Code (raw CSS), remembered across sessions.
  const [view, setView] = useState<'visual' | 'code'>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'code' ? 'code' : 'visual';
    } catch {
      return 'visual';
    }
  });
  const setViewMode = useCallback((next: 'visual' | 'code') => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);
  // Accordion section open-state (per category) + a transient highlight used when
  // "add property" jumps to an existing control.
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const [highlightProp, setHighlightProp] = useState<string | null>(null);
  const hlTimer = useRef<number | null>(null);
  const jumpToProp = useCallback((prop: string) => {
    const cat = PROP_TO_CATEGORY[prop];
    if (!cat) return; // arbitrary property with no structured control — just added
    setOpenSections((o) => ({ ...o, [cat]: true }));
    setHighlightProp(prop);
    requestAnimationFrame(() => {
      const root = rootRef.current;
      const el =
        root?.querySelector(`[data-prop="${prop}"]`) ?? root?.querySelector(`[data-cat="${cat}"]`);
      try {
        (el as HTMLElement | null)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch {
        /* scrollIntoView is unavailable in some environments (tests) */
      }
    });
    if (hlTimer.current) window.clearTimeout(hlTimer.current);
    hlTimer.current = window.setTimeout(() => setHighlightProp(null), 1800);
  }, []);

  // Agent-prep flow: a reviewable prompt that refactors an off-spec project
  // toward the editor's conventions.
  const [prep, setPrep] = useState(false);
  const { copy, isCopied } = useCopyToClipboard();
  const prepPrompt = buildCssPrepPrompt(authoredSheets);
  const openPrep = useCallback(() => {
    setPrep(true);
    void trackEvent('visual_prep_started', { mode: 'css' });
  }, []);
  const prepLink = (
    <button type="button" className="ss-css-prep-link" onClick={openPrep}>
      Prepare this project for visual editing →
    </button>
  );

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

  const res = selection?.resolution;
  const classes = (selection?.signature.className ?? '').split(/\s+/).filter(Boolean);
  const activeClass = targetClass ?? (classes.length ? classes[classes.length - 1] : null);

  // How many of the rule's declarations fall in each category (the per-section
  // "N properties set" badge).
  const categoryCounts: Record<string, number> = {};
  if (res?.status === 'resolved') {
    for (const d of res.declarations) {
      const cat = PROP_TO_CATEGORY[d.property.toLowerCase()];
      if (cat) categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
    }
  }

  return (
    <div
      ref={rootRef}
      className={`ss-edit-panel${pinned ? ' ss-edit-panel--pinned' : ''}`}
      data-testid="css-editor-panel"
      style={
        pinned
          ? undefined
          : {
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              right: 'auto',
              zIndex: 1000,
              maxHeight: `min(560px, calc(100vh - ${pos.top + 16}px))`,
            }
      }
    >
      <div
        className="ss-edit-panel__header"
        onPointerDown={pinned ? undefined : onHeaderPointerDown}
        onPointerMove={pinned ? undefined : onHeaderPointerMove}
        onPointerUp={pinned ? undefined : onHeaderPointerUp}
      >
        <span className="ss-edit-panel__title">Edit CSS</span>
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
        {prep && (
          <div className="ss-css-prep">
            <p className="ss-css-prep__lead">
              Hand this to your coding agent to refactor the project's styling into clean,
              class-based CSS the editor can edit. It keeps the site looking the same.
            </p>
            <div className="ss-css-prep__box">{prepPrompt}</div>
            <div className="ss-css-prep__actions">
              <Button variant="ghost" onClick={() => setPrep(false)}>
                Back
              </Button>
              <div className="ss-css-prep__right">
                <Button variant="secondary" onClick={() => void copy(prepPrompt)}>
                  {isCopied ? 'Copied!' : 'Copy'}
                </Button>
                {onSendToClaude && (
                  <Button variant="primary" onClick={() => onSendToClaude(prepPrompt)}>
                    Paste
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}

        {!prep && !selection && (
          <div className="ss-css-empty">
            <p className="ss-css-empty__lead">Click an element to edit its styles.</p>
            <p className="ss-css-empty__hint">
              Edits change the element's CSS class rule — any property, any value — and apply
              everywhere that class is used.
            </p>
            {prepLink}
          </div>
        )}

        {!prep && selection && (
          <>
            <CssBreakpointBar minPx={breakpointMinPx} onChange={onSetBreakpoint} />
            <CssClassBar
              classes={classes}
              active={activeClass}
              allClasses={allClasses}
              onSelect={onSelectClass}
              onRemove={onRemoveClass}
              onAdd={onAddClass}
            />
            {classes.length > 0 && <CssStateSwitcher pseudo={pseudo} onChange={onSetPseudo} />}
          </>
        )}

        {!prep && selection && !res && <p className="ss-css-status">Resolving…</p>}

        {!prep && selection && res?.status === 'resolved' && (
          <>
            <div className="ss-css-context">
              <span className="ss-css-target">
                <code className="ss-css-selector">{res.selector}</code>
                <span className="ss-css-bp">
                  {CSS_BREAKPOINTS.find((b) => b.minPx === breakpointMinPx)?.label ?? 'Base'}
                </span>
              </span>
              <span className="ss-css-file" title={res.file}>
                {res.file}
              </span>
            </div>
            {selection.instanceCount > 1 && (
              <p className="ss-css-instances">
                {selection.instanceCount} elements share this class — a save updates all of them.
              </p>
            )}

            <Tabs
              value={view}
              mode="navigation"
              onValueChange={(next) => setViewMode(next as 'visual' | 'code')}
            >
              <TabsList className="ss-css-modes" aria-label="Editor view">
                <TabsTab value="visual">Visual</TabsTab>
                <TabsTab value="code">Code</TabsTab>
              </TabsList>
            </Tabs>

            {view === 'visual' ? (
              <>
                <div className="ss-css-sections">
                  {CSS_CATEGORIES.filter((c) => c.id !== 'custom').map((cat) => (
                    <details
                      key={cat.id}
                      className="ss-edit-panel__section"
                      data-cat={cat.id}
                      open={openSections[cat.id] ?? defaultSectionOpen(cat.id)}
                      onToggle={(e) => {
                        // Read synchronously — the synthetic event's currentTarget is
                        // nulled by the time the deferred setState updater runs.
                        const isOpen = (e.currentTarget as HTMLDetailsElement).open;
                        setOpenSections((o) => ({ ...o, [cat.id]: isOpen }));
                      }}
                    >
                      <summary className="ss-edit-panel__section-head">
                        <span className="ss-edit-panel__section-row">
                          <span className="ss-edit-panel__section-title">{cat.label}</span>
                          {categoryCounts[cat.id] ? (
                            <span className="ss-css-section-count">{categoryCounts[cat.id]}</span>
                          ) : null}
                          <ChevronIcon className="ss-edit-panel__section-chevron" />
                        </span>
                      </summary>
                      <div className="ss-edit-panel__section-body">
                        <CssControls
                          category={cat.id}
                          declarations={res.declarations}
                          onPreview={onPreview}
                          onSave={onSave}
                          highlightProp={highlightProp}
                        />
                      </div>
                    </details>
                  ))}
                </div>
                <AddProp onSave={onSave} onAdded={jumpToProp} />
              </>
            ) : (
              <CodeView
                key={res.selector}
                declarations={res.declarations}
                onSaveMany={onSaveMany}
              />
            )}
          </>
        )}

        {!prep && res?.status === 'not_found' && (
          <div className="ss-css-create">
            <p className="ss-css-status">
              No CSS rule defines <code>{res.selector}</code> yet.
            </p>
            {authoredSheets.length > 0 ? (
              <>
                <label className="ss-css-create__label">
                  Stylesheet
                  <EnumDropdown
                    label="Stylesheet"
                    value={effectiveSheet}
                    options={authoredSheets.map((sheet) => ({ label: sheet, token: sheet }))}
                    onChange={setSheet}
                  />
                </label>
                <Button
                  variant="primary"
                  block
                  disabled={!effectiveSheet}
                  onClick={() => onCreateRule(effectiveSheet, res.selector, [])}
                >
                  Create {res.selector}
                </Button>
              </>
            ) : (
              <p className="ss-css-readonly">
                No stylesheet found to add the rule to. Add a `.css` file linked in the page, then
                reselect.
              </p>
            )}
          </div>
        )}

        {!prep && res?.status === 'needs_class' && (
          <div className="ss-css-readonly">
            <p>
              This element has no class yet. Use <strong>Add class</strong> above to give it one,
              then style its rule.
            </p>
            {prepLink}
          </div>
        )}

        {!prep && res?.status === 'inline' && (
          <div className="ss-css-readonly">
            <p>
              This element is styled with an inline <code>style</code> attribute. Move those styles
              into a class to edit them here.
            </p>
            {prepLink}
          </div>
        )}

        {!prep && res?.status === 'multiple' && (
          <div className="ss-css-readonly">
            <p>
              <code>{res.selector}</code> is defined by {res.locations.length} rules, so it isn't
              safe to edit automatically. Consolidate it into one rule, then reselect.
            </p>
            <ul className="ss-css-locations">
              {res.locations.map((l) => (
                <li key={`${l.file}:${l.line}`}>
                  {l.file}:{l.line}
                </li>
              ))}
            </ul>
            {prepLink}
          </div>
        )}

        {!prep && res?.status === 'error' && (
          <div className="ss-css-readonly">
            <p>Couldn’t read this element’s styles: {res.reason}. Try selecting it again.</p>
          </div>
        )}
      </div>

      <div className="ss-edit-panel__footer">
        <div className="ss-edit-panel__saved" aria-live="polite">
          {saving ? 'Saving…' : 'Edits save automatically'}
        </div>
      </div>
    </div>
  );
}
