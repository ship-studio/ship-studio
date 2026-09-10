/**
 * Diagnose why a DOM element has a zero-sized layout box.
 *
 * `Terminal` waits for its container to report nonzero
 * `getBoundingClientRect()` dimensions before mounting xterm, and used to log
 * only the container's *inline* `style.display` when that never happened
 * within 10s (issue #863). Harbr never sets `display` via inline
 * style — it's controlled by CSS classes and `visibility` (background/hidden
 * panes are kept mounted with `visibility: hidden` so their PTYs keep
 * running, see `dropTarget.ts`) — so every real-world report came back with
 * empty strings that explained nothing.
 *
 * @module lib/containerVisibility
 */

/** Computed-style facts that explain a zero-sized layout box. */
export interface ContainerVisibilityDiagnostics {
  display: string;
  visibility: string;
  /** `true` when a `display:none` ancestor removed the element from layout. */
  offsetParentIsNull: boolean;
  parentDisplay: string | null;
}

/** Read the diagnostics `getComputedStyle` needs to explain a zero rect. */
export function diagnoseZeroSizedContainer(container: HTMLElement): ContainerVisibilityDiagnostics {
  const computed = getComputedStyle(container);
  return {
    display: computed.display,
    visibility: computed.visibility,
    offsetParentIsNull: container.offsetParent === null,
    parentDisplay: container.parentElement
      ? getComputedStyle(container.parentElement).display
      : null,
  };
}

/**
 * True when the diagnostics point at a pane that is *supposed* to have no
 * layout box right now — a `display:none` ancestor (background tab/project)
 * or `visibility: hidden` (the hidden-but-mounted pattern above) — as
 * opposed to a container that's genuinely in the visible layout tree and
 * still, inexplicably, zero-sized.
 */
export function isLegitimatelyHiddenPane(diagnostics: ContainerVisibilityDiagnostics): boolean {
  return diagnostics.offsetParentIsNull || diagnostics.visibility !== 'visible';
}
