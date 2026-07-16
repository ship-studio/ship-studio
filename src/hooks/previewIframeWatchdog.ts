/**
 * Decision logic for the preview blank-iframe watchdog (issue #179).
 *
 * The dev server can be perfectly healthy while the preview iframe renders
 * nothing: top-level health checks succeed, but the subframe load aborts —
 * e.g. an auth-middleware redirect loop (Clerk development keys bounce
 * through `<slug>.clerk.accounts.dev`; WebKit refuses the third-party cookie
 * in a cross-site iframe and eventually gives up with "too many HTTP
 * redirects", leaving an empty frame and no error anywhere).
 *
 * The proxy injects a script into every HTML response that posts
 * `shipstudio:alive` to the parent on parse. The watchdog arms whenever the
 * iframe is (re)pointed at the injected-proxy URL and flips `iframeBlank`
 * if no proof-of-life message arrives within the window — surfacing an
 * actionable overlay instead of a silent blank pane.
 *
 * Kept as pure functions so the arming policy is unit-testable without
 * mounting the preview.
 */

/** How long a freshly navigated iframe gets to prove it rendered (ms).
 *  Generous enough for an on-demand page compile of a warm dev server (the
 *  server itself is already up — readiness gating handled the cold start),
 *  and self-healing: a page that finishes late still posts its proof, which
 *  clears the overlay. */
export const IFRAME_BLANK_TIMEOUT_MS = 10_000;

/** What caused a (re)arm attempt. */
export type IframeWatchdogTrigger =
  /** The app pointed the iframe at a new URL (initial load, refresh, page select). */
  | 'navigation'
  /** The iframe element fired `load` — one per document hop. */
  | 'load';

export interface IframeWatchdogState {
  /** The dev server passed its readiness probe. */
  serverReady: boolean;
  /** The iframe URL goes through the injecting proxy. Without injection no
   *  page can ever prove life, so arming would always false-positive
   *  (e.g. proxy failed to start and the preview fell back to the direct
   *  dev-server URL). */
  proxyActive: boolean;
  /** A proof-of-life message arrived since the last explicit navigation.
   *  Injected scripts post on parse — before `load` fires — so a `load` from
   *  an already-proven document must not re-arm (the page won't post again
   *  and would be falsely flagged blank). */
  aliveSinceNavigation: boolean;
}

export type IframeWatchdogAction = 'arm' | 'skip';

/**
 * Whether a trigger should (re)start the blank-iframe timer.
 *
 * - Never arm unless the server is ready AND the proxy (script injection) is
 *   active — anything else can't produce proof and would false-positive.
 * - `'navigation'` always arms: the document is being replaced, so the old
 *   proof no longer stands (the caller resets `aliveSinceNavigation`).
 * - `'load'` arms only when the current navigation hasn't proven life yet —
 *   it gives each unproven document hop (redirect chains, about:blank
 *   bounces) a fresh window instead of firing mid-hop.
 */
export function decideIframeWatchdogArm(
  trigger: IframeWatchdogTrigger,
  state: IframeWatchdogState
): IframeWatchdogAction {
  if (!state.serverReady || !state.proxyActive) return 'skip';
  if (trigger === 'load' && state.aliveSinceNavigation) return 'skip';
  return 'arm';
}

/**
 * Does a message of this `type` prove the iframe rendered a real (injected)
 * document? Any `shipstudio:*` message comes from a proxy-injected script,
 * and `ss:*` messages come from the visual-editor layer — both only exist in
 * a page that parsed and ran.
 */
export function isPreviewProofOfLife(type: unknown): boolean {
  return typeof type === 'string' && (type.startsWith('shipstudio:') || type.startsWith('ss:'));
}
