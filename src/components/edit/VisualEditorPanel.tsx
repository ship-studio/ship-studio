/**
 * Visual editor properties panel.
 *
 * Renders for the element selected in the preview and exposes the spacing
 * controls (padding / margin / gap) as live steppers: each step mutates the DOM
 * instantly and persists to source on "Save". Ambiguous/dynamic elements are
 * shown read-only with the reason, matching the resolver's safe fallback.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Button, buttonClassNames } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { ToggleButton } from '../primitives/ToggleButton';
import { EnumDropdown } from './EnumDropdown';
import { MultiSourceControl } from './MultiSourceControl';
import { UsageScope } from './UsageScope';
import { CodeIcon } from './CodeIcon';
import { SlackIcon } from '@/components/icons';
import {
  CheckIcon,
  CloseIcon,
  DesktopIcon,
  FullBreakpointIcon,
  InfoIcon,
  LaptopIcon,
  MobileIcon,
  TabletIcon,
} from '@/components/icons';
import { SaveIcon } from '@/components/icons';
import { HelpIcon } from '@/components/icons';
import { PinIcon } from '@/components/icons';
import { Tooltip } from '../primitives/Tooltip';
import { PropSection } from './PropSection';
import { ImageSection } from './ImageSection';
import { PropControlRenderer, type ControlRenderCtx } from './PropControlRenderer';
import type { ValueFieldVariable } from '../primitives/ValueField';
import { ClassBar } from './ClassBar';
import type { CustomClass, TailwindVersion } from '../../lib/customClasses';
import type { EditTarget } from '../../hooks/useVisualEditor';
import { CONTROL_SECTIONS } from '../../lib/editControls';
import {
  activeEnumToken,
  breakpointPrefixes,
  ENUM_CONTROLS,
  readLayer,
  type UsageReport,
} from '../../lib/edit';
import type {
  BoxType,
  Side,
  Breakpoint,
  LayerContext,
  SpacingValue,
  ResetSpec,
  ElementSignature,
  Resolution,
  TextResolution,
  ImageResolution,
} from '../../lib/edit';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import type { Selection } from '../../hooks/useVisualEditor';
import { SLACK_INVITE_URL } from '../../lib/links';

/** Build a ready-to-paste request for the coding agent to change text that's rendered
 *  from code/data (so it can't be edited inline). The user pastes it into the terminal
 *  and fills in the new wording. */
function buildAgentRequest(sig: ElementSignature, resolution: Resolution | null): string {
  const cls = sig.className ? ` (classes: "${sig.className}")` : '';
  const loc =
    resolution?.status === 'resolved' ? `\nNear: ${resolution.file}:${resolution.line}` : '';
  const text = (sig.text || '').trim();
  return (
    `The text below is rendered from code or data in my project (not a static string in the markup), ` +
    `so I can't edit it directly. Find where it's produced in the source and change it.\n\n` +
    `Element: <${sig.tagName}>${cls}${loc}\n\n` +
    `Current text:\n"${text}"`
  );
}

/** Save-status badge — the SAME box whether saving or saved, so the footer never
 *  shifts height between the two (auto-save) states. */
function StatusBadge({ saving }: { saving: boolean }) {
  return (
    <div
      className={buttonClassNames({
        variant: 'default',
        className: 'ss-edit-panel__saved',
      })}
      aria-live="polite"
    >
      {saving ? (
        'Saving…'
      ) : (
        <>
          <CheckIcon size={13} />
          Saved
        </>
      )}
    </div>
  );
}

/** Small "?" glyph that reveals the shared tooltip on hover/focus. */
function HelpHint({ text }: { text: string }) {
  return (
    <Tooltip content={text}>
      <span className="ss-edit-panel__help" tabIndex={0} role="img" aria-label={text}>
        <HelpIcon size={12} />
      </span>
    </Tooltip>
  );
}

/** Empty-state intro shown before any element is selected — explains what the
 *  visual editor is and how it works, instead of a bare one-line hint. */
function IntroCheck() {
  return <CheckIcon size={13} />;
}

function EditorIntro() {
  return (
    <div className="ss-edit-intro">
      <p className="ss-edit-intro__lead">
        Click any element to fine-tune its Tailwind styles — spacing, size, type, color, layout, and
        more — without using any tokens. Double-click text to edit the copy right on the page.
      </p>
      <ul className="ss-edit-intro__list">
        <li>
          <IntroCheck />
          <span>
            Works with any <strong>Next.js</strong>, <strong>Astro</strong>, or{' '}
            <strong>Vite (React)</strong> project that uses Tailwind
          </span>
        </li>
        <li>
          <IntroCheck />
          <span>
            Edit styles and text — <strong>double-click</strong> to rewrite text, bold, italic, or
            link it
          </span>
        </li>
        <li>
          <IntroCheck />
          <span>
            Free — uses <strong>0 tokens</strong>
          </span>
        </li>
        <li>
          <IntroCheck />
          <span>Updates live and saves to your source instantly</span>
        </li>
      </ul>
    </div>
  );
}

/** Shown when a clicked text element is rendered from code/data and can't be edited
 *  inline: hands the change off to the coding agent via a one-click copy-able request. */
function DynamicTextHelp({
  signature,
  resolution,
  pulseKey,
}: {
  signature: ElementSignature;
  resolution: Resolution | null;
  /** Bumps when the user double-clicks this dynamic text again — restarts the pulse. */
  pulseKey?: number;
}) {
  const { copy, isCopied } = useCopyToClipboard();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pulseKey) return;
    const el = ref.current;
    if (!el) return;
    const cls = 'ss-edit-panel__dynhelp--pulse';
    el.classList.remove(cls);
    void el.offsetWidth; // restart the animation even if it's already mid-pulse
    el.classList.add(cls);
  }, [pulseKey]);
  return (
    <div ref={ref} className="ss-edit-panel__dynhelp">
      <p>
        This text comes from code or data — it can’t be edited here. Copy the request below, paste
        it into your agent, and tell it the new wording.
      </p>
      <Button
        variant="secondary"
        block
        onClick={() => void copy(buildAgentRequest(signature, resolution))}
      >
        {isCopied ? 'Copied — paste it to your agent' : 'Copy request for your agent'}
      </Button>
    </div>
  );
}

/** Shown when the selected element has NO class at all (`no_class` resolution):
 *  instead of a dead-end read-only banner, offer inserting its first class — the
 *  backend writes a fresh class attribute into the element's source tag, after
 *  which the selection re-resolves and the full controls appear. */
function NoClassState({
  tag,
  onAddClass,
}: {
  tag: string;
  onAddClass: (name: string) => void | Promise<void>;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim().replace(/^\./, '');
  const submit = async () => {
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onAddClass(trimmed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ss-edit-panel__noclass">
      <p>
        This <code>&lt;{tag}&gt;</code> has no classes yet. Add one to start styling it — it&apos;s
        written straight into your source.
      </p>
      <input
        type="text"
        value={name}
        placeholder="e.g. hero-title or flex gap-4"
        aria-label="First class name"
        spellCheck={false}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
        }}
      />
      <Button variant="primary" block disabled={!trimmed || busy} onClick={() => void submit()}>
        {busy ? 'Adding…' : 'Add class'}
      </Button>
    </div>
  );
}

/** Subtle info dot shown by the source line when the element is styled by a custom
 *  CSS class — its tooltip explains that edits use `!important` to win the cascade. */
function CustomCssHint() {
  return (
    <Tooltip content="Styled by a custom CSS class — edits use !important so they take effect.">
      <span
        className="ss-edit-panel__csshint"
        tabIndex={0}
        role="img"
        aria-label="Styled by a custom CSS class — edits use !important so they take effect"
      >
        <InfoIcon size={13} />
      </span>
    </Tooltip>
  );
}

function breakpointIcon(bp: Breakpoint): ReactNode {
  if (bp.minPx === 0) return <FullBreakpointIcon />;
  if (bp.minPx < 768) return <MobileIcon />;
  if (bp.minPx < 1024) return <TabletIcon />;
  if (bp.minPx < 1280) return <LaptopIcon />;
  return <DesktopIcon />;
}

interface Props {
  selection: Selection | null;
  /** Project root — the Image section's asset picker lists assets from it. */
  projectPath: string;
  /** The class string currently applied live (what "Save" will persist). */
  currentClass: string;
  /** Project CSS custom properties available to value fields. */
  variables?: ValueFieldVariable[];
  /** Detected Tailwind token context (prefix/version/custom scale). */
  tailwindVersion?: TailwindVersion;
  utilityPrefix?: string;
  spacingScale?: Record<string, string>;
  /** Text-editability of the selection. When read-only (dynamic text), the panel
   *  offers a copy-able request to hand the edit to the coding agent. */
  textResolution?: TextResolution | null;
  /** Image-src editability of the selection — drives the Image section. */
  imageResolution?: ImageResolution | null;
  /** Write a new src to source and swap the preview (immediate save). */
  onReplaceImage: (webPath: string) => Promise<void>;
  /** Bumps each time a double-click hits dynamic text — pulses the hand-off block
   *  so the user's eye is drawn to the panel after their click did nothing. */
  textBlockedNonce?: number;
  /** All breakpoints (Base + detected), supplied in cascade order. */
  breakpoints: Breakpoint[];
  /** The breakpoint layer currently being edited (derived from the canvas width). */
  activeBreakpoint: Breakpoint;
  /** True when the active breakpoint is wider than the preview can show — edits
   *  apply but aren't visible at the current canvas size. */
  breakpointTooWide: boolean;
  /** Switch the edited breakpoint — resizes the preview canvas to match. */
  onSelectBreakpoint: (bp: Breakpoint) => void;
  /** Whether edits auto-save to source (debounced). */
  autoSave: boolean;
  /** Toggle auto-save on/off. */
  onToggleAutoSave: () => void;
  /** Step the gap utility up (1) or down (-1), by `step` notches (default 1). */
  onStepGap: (dir: 1 | -1, step?: number) => void;
  /** Set one side of padding/margin to a scale step or arbitrary value. */
  onSetSide: (type: BoxType, side: Side, value: SpacingValue) => void;
  /** Set one position offset (top/right/bottom/left) to a scale step or arbitrary value. */
  onSetPositionSide?: (side: Side, value: SpacingValue) => void;
  /** Apply an enum option's token + inline-style preview. */
  onApplyEnum: (token: string, style: Record<string, string>) => void;
  /** Reset a control's value at the active breakpoint. */
  onReset: (spec: ResetSpec) => void;
  /** For a multi-location element: which spot(s) to write — 'all' or one index. */
  multiTarget: 'all' | number;
  onMultiTargetChange: (t: 'all' | number) => void;
  /** Custom-class state + actions (Webflow-style class bar). Optional so the
   *  panel can be rendered standalone (e.g. in tests) without the class wiring. */
  editTarget?: EditTarget;
  customClasses?: CustomClass[];
  /** False when the project has no writable Tailwind entry stylesheet — disables
   *  "create class". */
  canCreateClass?: boolean;
  onEditElement?: () => void;
  onEditClass?: (name: string, tokens: string[]) => void;
  onApplyClass?: (name: string) => void | Promise<void>;
  onUnapplyClass?: (name: string) => void | Promise<void>;
  onCreateClass?: (name: string) => void;
  /** Insert the FIRST class on a class-less element (`no_class` resolution) — the
   *  backend writes a fresh class attribute into source, then the caller
   *  re-resolves so the panel gains full controls. */
  onAddFirstClass?: (name: string) => void | Promise<void>;
  /** Where the selected element's component is used project-wide (scope hint). */
  usage: UsageReport | null;
  /** Jump to a source file:line in the Code tab. */
  onOpenInCode?: (file: string, line: number) => void;
  onCommit: () => void;
  onClose: () => void;
  /** Docked as a sidebar column inside the preview container instead of
   *  floating over the canvas. Positioning comes from the container's grid. */
  pinned?: boolean;
  onTogglePin?: () => void;
}

const PANEL_WIDTH = 240;
const EMPTY_VALUE_FIELD_VARIABLES: ValueFieldVariable[] = [];
const NOOP_POSITION_SIDE = (_side: Side, _value: SpacingValue) => undefined;

/** Initial top-right resting spot (clears the toolbar). Lazy so it reads the
 *  window once on mount; drag takes over from there. */
function initialPos() {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1200;
  return { top: 96, left: Math.max(16, w - PANEL_WIDTH - 16) };
}

export function VisualEditorPanel({
  selection,
  projectPath,
  currentClass,
  variables = EMPTY_VALUE_FIELD_VARIABLES,
  tailwindVersion = 'v4',
  utilityPrefix,
  spacingScale,
  textResolution,
  imageResolution,
  onReplaceImage,
  textBlockedNonce,
  breakpoints,
  activeBreakpoint,
  breakpointTooWide,
  onSelectBreakpoint,
  autoSave,
  onToggleAutoSave,
  onStepGap,
  onSetSide,
  onSetPositionSide = NOOP_POSITION_SIDE,
  onApplyEnum,
  onReset,
  multiTarget,
  onMultiTargetChange,
  editTarget = { kind: 'element' },
  customClasses = [],
  canCreateClass = true,
  onEditElement = () => {},
  onEditClass = () => {},
  onApplyClass = () => {},
  onUnapplyClass = () => {},
  onCreateClass = () => {},
  onAddFirstClass,
  usage,
  onOpenInCode,
  onCommit,
  onClose,
  pinned = false,
  onTogglePin,
}: Props) {
  const resolution = selection?.resolution ?? null;
  // Images get an Image section (current asset + Replace) on top of style controls.
  const isImage = selection?.signature.tagName === 'img';
  // Both 'resolved' (one spot) and 'multi' (several identical spots) are editable.
  const editable = resolution?.status === 'resolved' || resolution?.status === 'multi';
  // Dirty baseline differs by edit target: a class edit compares the live @apply
  // bag to the class's saved tokens (the element's className is irrelevant and
  // never matches, which used to pin "Saving…" on forever); an element edit
  // compares to the element's source className. Normalize whitespace so a stray
  // double-space can't wedge it permanently dirty.
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ');
  const dirty =
    editTarget.kind === 'class'
      ? norm(currentClass) !== norm(editTarget.baseline)
      : editable && currentClass !== resolution.class_name;
  // Show the controls as soon as an element is selected — they only need the class
  // string (available instantly). The source badge + Save fill in once resolved, so
  // the panel doesn't flicker through a "Resolving…" collapse on every click.
  // `no_class` (element has no class at all) shows the add-a-class state instead:
  // there's nothing for the style controls to write to yet.
  const controlsVisible =
    !!selection && resolution?.status !== 'read_only' && resolution?.status !== 'no_class';

  // Cascade-resolution context for the active breakpoint, threaded to each control
  // so they show the effective value at this layer and which breakpoint set it.
  const layer = useMemo<LayerContext>(
    () => ({
      bp: activeBreakpoint,
      ordered: breakpoints,
      known: breakpointPrefixes(breakpoints),
      tailwindVersion,
      utilityPrefix,
      spacingScale,
      direction: selection?.signature.direction,
      writingMode: selection?.signature.writingMode,
      spacingUnit: selection?.signature.spacingUnit,
    }),
    [activeBreakpoint, breakpoints, selection, spacingScale, tailwindVersion, utilityPrefix]
  );
  const breakpointIcons = useMemo(
    () => Object.fromEntries(breakpoints.map((bp) => [bp.name, breakpointIcon(bp)])),
    [breakpoints]
  );
  const breakpointOptions = useMemo(
    () => [...breakpoints].sort((a, b) => b.minPx - a.minPx),
    [breakpoints]
  );

  // Shared render context for every control row (the registry renders generically).
  const controlCtx = useMemo<ControlRenderCtx>(
    () => ({
      currentClass,
      layer,
      onApplyEnum,
      onReset,
      onSetSide,
      onSetPositionSide,
      onStepGap,
      variables,
      computed: {
        color: selection?.signature.computedColor,
        'background-color': selection?.signature.computedBackgroundColor,
      },
      inherited: selection?.signature.inheritedProps,
      projectPath,
      onOpenInCode,
    }),
    [
      currentClass,
      layer,
      onApplyEnum,
      onReset,
      onSetSide,
      onSetPositionSide,
      onStepGap,
      selection,
      variables,
      projectPath,
      onOpenInCode,
    ]
  );
  const displayControl = ENUM_CONTROLS.find((control) => control.label === 'Display')!;
  const display = readLayer(currentClass, layer, (tokens) =>
    activeEnumToken(tokens, displayControl, layer.utilityPrefix)
  ).value;
  const flexLayout = display === 'flex' || display === 'inline-flex';
  const flexOrGridLayout = flexLayout || display === 'grid';
  const positionControl = ENUM_CONTROLS.find((control) => control.label === 'Position')!;
  const position = readLayer(currentClass, layer, (tokens) =>
    activeEnumToken(tokens, positionControl, layer.utilityPrefix)
  ).value;
  const positioned = position !== null && position !== 'static';

  // Contextual mobile-first explainer (shown in the "?" tooltip by the label).
  const breakpointHelp =
    activeBreakpoint.minPx > 0
      ? `Changes here apply from ${activeBreakpoint.minPx}px wide and up, overriding the smaller sizes.`
      : 'Changes here apply to every screen size. Pick a breakpoint to override it from that width up.';

  // Self-owned fixed position so the panel is draggable by its header. Fully
  // inline (no CSS-var/measurement dependency) so it can't drift out of view.
  const [pos, setPos] = useState(initialPos);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const onHeaderPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    // Don't start a drag from the header buttons (pin/close) — pointer capture
    // would swallow their click events.
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

  return (
    <div
      ref={rootRef}
      className={`ss-edit-panel${pinned ? ' ss-edit-panel--pinned' : ''}`}
      data-testid="visual-editor-panel"
      style={
        // Pinned positioning is entirely CSS (the container's grid column).
        pinned
          ? undefined
          : {
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              right: 'auto',
              zIndex: 1000,
              // Cap shorter than the viewport; the body scrolls, the footer stays put.
              maxHeight: `min(520px, calc(100vh - ${pos.top + 16}px))`,
            }
      }
    >
      <div
        className="ss-edit-panel__header"
        onPointerDown={pinned ? undefined : onHeaderPointerDown}
        onPointerMove={pinned ? undefined : onHeaderPointerMove}
        onPointerUp={pinned ? undefined : onHeaderPointerUp}
      >
        <span className="ss-edit-panel__title">Edit</span>
        <span className="ss-edit-panel__header-actions">
          {onTogglePin && (
            <ToggleButton
              variant="ghost"
              size="compact"
              className="button--icon-only panel-pin-toggle"
              onClick={onTogglePin}
              title={pinned ? 'Unpin — float over the preview' : 'Pin to the window'}
              aria-label={pinned ? 'Unpin Edit panel' : 'Pin Edit panel to the window'}
              pressed={pinned}
              leftIcon={<PinIcon size={13} />}
            />
          )}
          <IconButton
            variant="ghost"
            size="compact"
            onClick={onClose}
            title="Close Edit panel"
            aria-label="Close Edit panel"
            icon={<CloseIcon size={14} />}
          />
        </span>
      </div>

      {/* Sticky context bar: always shows WHICH breakpoint and WHICH target you're
          editing, while the controls below scroll. */}
      {controlsVisible && (
        <div className="ss-edit-panel__context">
          {/* Breakpoint dropdown — picking one resizes the canvas; the active value
              tracks the live preview width. Tailwind is mobile-first: edits cascade
              up, so a value set on a breakpoint applies at that width and larger. */}
          <div className="ss-edit-panel__control">
            {/* The "?" reveals the mobile-first explainer — styles set on a breakpoint
                apply at that width AND LARGER, which surprises desktop-first users. */}
            <label className="ss-edit-panel__label">
              Breakpoint
              <HelpHint text={breakpointHelp} />
            </label>
            <EnumDropdown
              label="Breakpoint"
              value={activeBreakpoint.name}
              options={breakpointOptions.map((bp) => ({
                // Plain "Base" rather than "Base · all widths": the trigger is
                // a single-line control and this was the one option long
                // enough to need two.
                label: bp.minPx > 0 ? `${bp.name} · ≥${bp.minPx}px` : 'Base',
                token: bp.name,
              }))}
              optionIcons={breakpointIcons}
              onChange={(name) => {
                const bp = breakpoints.find((b) => b.name === name);
                if (bp) onSelectBreakpoint(bp);
              }}
            />
          </div>

          {breakpointTooWide && (
            <p className="ss-edit-panel__bp-note" role="note">
              Preview is too narrow to show <strong>{activeBreakpoint.name}</strong> (≥
              {activeBreakpoint.minPx}px). Edits still apply at this breakpoint — widen the preview
              to see them.
            </p>
          )}

          {/* Edit target: this element's own utilities, or a shared custom class. */}
          <ClassBar
            customClasses={customClasses}
            elementClass={
              editTarget.kind === 'element' ? currentClass : (selection?.signature.className ?? '')
            }
            editTarget={editTarget}
            canCreate={canCreateClass}
            onEditElement={onEditElement}
            onEditClass={onEditClass}
            onApplyExisting={onApplyClass}
            onUnapply={onUnapplyClass}
            onCreate={onCreateClass}
          />
        </div>
      )}

      <div className="ss-edit-panel__body" data-value-field-menu-boundary>
        {!selection && <EditorIntro />}

        {textResolution?.status === 'read_only' && selection && (
          <DynamicTextHelp
            signature={selection.signature}
            resolution={resolution}
            pulseKey={textBlockedNonce}
          />
        )}

        {/* No class at all: offer inserting the first one (writes a fresh class
            attribute to source) instead of a dead-end banner. Classless images
            skip it — the Image section already carries their state. */}
        {resolution?.status === 'no_class' && selection && !isImage && onAddFirstClass && (
          <NoClassState tag={selection.signature.tagName} onAddClass={onAddFirstClass} />
        )}

        {/* For a classless image the class resolver's "not a static string" verdict is
            expected (there's nothing to style-edit) — the Image section carries the
            state instead of a confusing read-only banner. */}
        {resolution?.status === 'read_only' &&
          textResolution?.status !== 'read_only' &&
          (!isImage || !!selection?.signature.className) && (
            <p className="ss-edit-panel__readonly">{resolution.reason}</p>
          )}

        {isImage && selection && (
          <ImageSection
            signature={selection.signature}
            resolution={imageResolution ?? null}
            projectPath={projectPath}
            onReplace={onReplaceImage}
          />
        )}

        {controlsVisible && (
          <>
            {resolution?.status === 'resolved' && (
              <div className="ss-edit-panel__source-context">
                <div className="ss-edit-panel__source">
                  {onOpenInCode ? (
                    <button
                      type="button"
                      className="ss-edit-panel__srclink"
                      title="Open in the Code tab"
                      onClick={() => onOpenInCode(resolution.file, resolution.line)}
                    >
                      <code>
                        {resolution.file}:{resolution.line}
                      </code>
                      <CodeIcon size={12} />
                    </button>
                  ) : (
                    <code>
                      {resolution.file}:{resolution.line}
                    </code>
                  )}
                  {resolution.confidence !== 'unique' && resolution.confidence !== 'source' && (
                    <span
                      className="ss-edit-panel__badge ss-edit-panel__badge--approx"
                      title="These classes appear more than once in your code, so the source was located by surrounding context — double-check before saving."
                    >
                      approx.
                    </span>
                  )}
                  {(selection?.signature.unlayeredProps?.length ?? 0) > 0 && <CustomCssHint />}
                </div>

                {selection && selection.instanceCount > 1 && (
                  <p className="ss-edit-panel__multi">
                    Editing {selection.instanceCount} elements that share this source
                  </p>
                )}
                <UsageScope
                  usage={usage}
                  instanceCount={selection?.instanceCount ?? 1}
                  onOpenInCode={onOpenInCode}
                />
              </div>
            )}
            {resolution?.status === 'multi' && (
              <MultiSourceControl
                locations={resolution.locations}
                target={multiTarget}
                onChange={onMultiTargetChange}
              />
            )}

            {CONTROL_SECTIONS.map((section) => (
              <PropSection
                key={section.id}
                title={section.title}
                sectionId={section.id}
                defaultOpen={section.defaultOpen}
              >
                {section.controls.map((control) => {
                  if (control.kind === 'positionBox' && !positioned) return null;
                  if (control.kind === 'enum') {
                    const label = control.control.label;
                    if ((label === 'Direction' || label === 'Wrap') && !flexLayout) return null;
                    if ((label === 'Justify' || label === 'Align items') && !flexOrGridLayout)
                      return null;
                  }
                  return (
                    <PropControlRenderer key={control.key} control={control} ctx={controlCtx} />
                  );
                })}
              </PropSection>
            ))}

            <PropSection title="Applied classes" sectionId="classes" defaultOpen>
              <div className="ss-edit-panel__classes" title={currentClass}>
                {currentClass}
              </div>
            </PropSection>
          </>
        )}

        <p className="ss-edit-panel__beta">
          <strong>Visual editor is in beta.</strong> Hit a bug or have feedback? We'd genuinely
          appreciate hearing about it.
        </p>
        <Button
          variant="default"
          width="fill"
          leftIcon={<SlackIcon size={12} />}
          className="ss-edit-panel__slack"
          onClick={() => void openUrl(SLACK_INVITE_URL)}
          title="Join the Ship Studio community on Slack"
        >
          Join the Slack
        </Button>
      </div>

      {controlsVisible && (
        <div className="ss-edit-panel__footer">
          <button
            type="button"
            role="switch"
            aria-checked={autoSave}
            className="ss-edit-panel__autosave"
            onClick={onToggleAutoSave}
            title="Automatically save edits to source as you go"
          >
            <span className={`ss-edit-panel__switch${autoSave ? ' is-on' : ''}`} aria-hidden />
            Auto-save
          </button>
          {!editable ? (
            // Resolving the source location — Save isn't available yet.
            <span className="ss-edit-panel__locating">Locating source…</span>
          ) : autoSave ? (
            <StatusBadge saving={dirty} />
          ) : dirty ? (
            <Button variant="primary" onClick={onCommit} leftIcon={<SaveIcon size={14} />}>
              Save to source
            </Button>
          ) : (
            <StatusBadge saving={false} />
          )}
        </div>
      )}
    </div>
  );
}
