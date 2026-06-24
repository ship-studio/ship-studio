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
} from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Button } from '../primitives/Button';
import { EnumDropdown } from './EnumDropdown';
import { MultiSourceControl } from './MultiSourceControl';
import { UsageScope } from './UsageScope';
import { CodeIcon } from './CodeIcon';
import { SlackIcon } from '../icons/brand';
import { PinIcon } from '../icons/layout';
import { PropSection } from './PropSection';
import { ImageSection } from './ImageSection';
import { PropControlRenderer, type ControlRenderCtx } from './PropControlRenderer';
import { ClassBar } from './ClassBar';
import type { CustomClass } from '../../lib/customClasses';
import type { EditTarget } from '../../hooks/useVisualEditor';
import { CONTROL_SECTIONS } from '../../lib/editControls';
import { breakpointPrefixes, type UsageReport } from '../../lib/edit';
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

const SLACK_INVITE_URL =
  'https://join.slack.com/t/shipstudiocommunity/shared_invite/zt-41vbyaoo0-_pZWNPyMdvMoF6neuDYw7g';

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
    <div className="ss-edit-panel__saved" aria-live="polite">
      {saving ? (
        'Saving…'
      ) : (
        <>
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Saved
        </>
      )}
    </div>
  );
}

/** Small "?" glyph that reveals a custom tooltip on hover/focus. */
function HelpHint({ text }: { text: string }) {
  return (
    <span className="ss-edit-panel__help" tabIndex={0} role="img" aria-label={text}>
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <path
          d="M5.8 6.2c0-1.2 1-2 2.2-2s2.2.8 2.2 2c0 .8-.5 1.3-1.1 1.6-.6.4-1.1.7-1.1 1.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
        <circle cx="8" cy="11.5" r="0.7" fill="currentColor" />
      </svg>
      <span className="ss-edit-panel__help-tip" role="tooltip">
        {text}
      </span>
    </span>
  );
}

/** Empty-state intro shown before any element is selected — explains what the
 *  visual editor is and how it works, instead of a bare one-line hint. */
function IntroCheck() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M20 6 9 17l-5-5"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
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
        size="sm"
        block
        onClick={() => void copy(buildAgentRequest(signature, resolution))}
      >
        {isCopied ? 'Copied — paste it to your agent' : 'Copy request for your agent'}
      </Button>
    </div>
  );
}

/** Subtle info dot shown by the source line when the element is styled by a custom
 *  CSS class — its tooltip explains that edits use `!important` to win the cascade. */
function CustomCssHint() {
  return (
    <span
      className="ss-edit-panel__csshint"
      tabIndex={0}
      role="img"
      aria-label="Styled by a custom CSS class — edits use !important so they take effect"
    >
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="8" cy="4.6" r="0.8" fill="currentColor" />
        <path
          d="M8 7v4.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
      <span className="ss-edit-panel__csshint-tip" role="tooltip">
        Styled by a custom CSS class — edits use <code>!important</code> so they take effect.
      </span>
    </span>
  );
}

interface Props {
  selection: Selection | null;
  /** Project root — the Image section's asset picker lists assets from it. */
  projectPath: string;
  /** The class string currently applied live (what "Save" will persist). */
  currentClass: string;
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
  /** All breakpoints (Base + detected), ascending by min-width. */
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
  /** Step the gap utility one notch up (1) or down (-1). */
  onStepGap: (dir: 1 | -1) => void;
  /** Set one side of padding/margin to a scale step or arbitrary value. */
  onSetSide: (type: BoxType, side: Side, value: SpacingValue) => void;
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

const PANEL_WIDTH = 264;

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
  const controlsVisible = !!selection && resolution?.status !== 'read_only';

  // Cascade-resolution context for the active breakpoint, threaded to each control
  // so they show the effective value at this layer and which breakpoint set it.
  const layer = useMemo<LayerContext>(
    () => ({ bp: activeBreakpoint, ordered: breakpoints, known: breakpointPrefixes(breakpoints) }),
    [activeBreakpoint, breakpoints]
  );

  // Shared render context for every control row (the registry renders generically).
  const controlCtx = useMemo<ControlRenderCtx>(
    () => ({
      currentClass,
      layer,
      onApplyEnum,
      onReset,
      onSetSide,
      onStepGap,
      computed: {
        color: selection?.signature.computedColor,
        'background-color': selection?.signature.computedBackgroundColor,
      },
    }),
    [currentClass, layer, onApplyEnum, onReset, onSetSide, onStepGap, selection]
  );

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
            ×
          </button>
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
              options={breakpoints.map((bp) => ({
                label: bp.minPx > 0 ? `${bp.name} · ≥${bp.minPx}px` : 'Base · all widths',
                token: bp.name,
              }))}
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

      <div className="ss-edit-panel__body">
        {!selection && <EditorIntro />}

        {textResolution?.status === 'read_only' && selection && (
          <DynamicTextHelp
            signature={selection.signature}
            resolution={resolution}
            pulseKey={textBlockedNonce}
          />
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
              <>
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
                  {resolution.confidence !== 'unique' && (
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
              </>
            )}
            {resolution?.status === 'multi' && (
              <MultiSourceControl
                locations={resolution.locations}
                target={multiTarget}
                onChange={onMultiTargetChange}
              />
            )}

            {CONTROL_SECTIONS.map((section) => (
              <PropSection key={section.id} title={section.title} defaultOpen={section.defaultOpen}>
                {section.controls.map((control) => (
                  <PropControlRenderer key={control.key} control={control} ctx={controlCtx} />
                ))}
              </PropSection>
            ))}

            <div className="ss-edit-panel__classes" title={currentClass}>
              {currentClass}
            </div>
          </>
        )}

        <p className="ss-edit-panel__beta">
          <strong>Visual editor is in beta.</strong> Hit a bug or have feedback? We'd genuinely
          appreciate hearing about it.
        </p>
        <button
          type="button"
          className="ss-edit-panel__slack"
          onClick={() => void openUrl(SLACK_INVITE_URL)}
          title="Join the Ship Studio community on Slack"
        >
          <SlackIcon size={12} />
          Join the Slack
        </button>
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
            <Button size="sm" variant="primary" onClick={onCommit}>
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
