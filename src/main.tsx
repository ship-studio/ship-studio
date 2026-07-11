/**
 * Application entry point.
 *
 * Renders the main App component into the DOM root element.
 * Wrapped in React.StrictMode for development warnings and checks.
 *
 * Supports multi-window: if a `project` URL parameter is present,
 * the window opens directly to that project instead of the projects list.
 *
 * @module main
 */

import './instrument';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { reactErrorHandler } from '@sentry/react';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { exposeReactGlobals, lookupBlobOwner, markPluginCrashed } from './lib/plugin-loader';
import { uninstallPlugin } from './lib/plugins';
import { exposePluginContextRef } from './contexts/PluginContext';
import { OverlayScrollbars } from 'overlayscrollbars';
import 'overlayscrollbars/overlayscrollbars.css';

// Expose React globals and context ref for plugins before any rendering
exposeReactGlobals(React, ReactDOM);
exposePluginContextRef();

// Global safety net: catch unhandled errors from plugins.
// Plugins that bundle their own React can throw errors that escape React error
// boundaries entirely. This catches them and auto-removes the crashing plugin.
window.addEventListener('error', (event) => {
  const err = event.error as { message?: string } | undefined;
  const msg: string = (typeof err?.message === 'string' ? err.message : event.message) ?? '';
  const isPluginError =
    event.filename?.startsWith('blob:') ||
    msg.includes('Plugin context') ||
    msg.includes('plugin-sdk');
  if (!isPluginError) return;

  event.preventDefault();
  console.error('[Ship Studio] Plugin error caught by global handler:', msg);

  // Identify and auto-remove the crashing plugin
  const blobUrl = event.filename?.startsWith('blob:') ? event.filename : null;
  const owner = blobUrl ? lookupBlobOwner(blobUrl) : null;
  if (owner) {
    markPluginCrashed(owner.pluginId);
    void uninstallPlugin(owner.projectPath, owner.pluginId).catch((e) =>
      console.error(`Failed to auto-remove plugin "${owner.pluginId}":`, e)
    );
  }
});
window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason;
  const stack = reason instanceof Error ? reason.stack || '' : String(reason);
  const message = reason instanceof Error ? reason.message : String(reason);

  if (stack.includes('blob:')) {
    event.preventDefault();
    console.error('[Ship Studio] Plugin unhandled rejection caught by global handler:', reason);
    return;
  }

  // Silently drop Tauri's internal race: when a plugin:pty|read invoke's
  // response arrives after the component that issued it unmounted (common
  // during rapid project switches), the runtime looks up a listener that
  // was already garbage-collected and throws TypeError accessing
  // `listeners[eventId].handlerId` from its injected bootstrap script.
  // This is a Tauri v2 runtime bug — not our code — and doesn't affect
  // functionality. Suppressing to keep the console clean.
  if (
    message.includes('listeners[eventId]') ||
    stack.includes('listeners[eventId]') ||
    (message.includes('handlerId') && stack.includes('user-script'))
  ) {
    event.preventDefault();
  }
});

// Patch removeChild to handle nodes relocated by OverlayScrollbars.
// When OS wraps a scrollable element, it moves children into a viewport wrapper.
// If React then unmounts the parent, it tries to removeChild on the original nodes
// which are no longer direct children — causing a crash. This patch handles that.
// TODO: Consider scoping this patch to OverlayScrollbars containers instead of global Node.prototype — global patch may mask real DOM bugs elsewhere
// eslint-disable-next-line @typescript-eslint/unbound-method
const origRemoveChild = Node.prototype.removeChild;
Node.prototype.removeChild = function <T extends Node>(child: T): T {
  if (child.parentNode !== this) {
    // Node was relocated (likely by OverlayScrollbars) — remove from actual parent
    if (child.parentNode) return child.parentNode.removeChild(child);
    return child;
  }
  return origRemoveChild.call(this, child) as T;
};

// Same motivation for insertBefore: if OverlayScrollbars has relocated the
// reference node into its viewport wrapper, React's commit phase calls
// `parent.insertBefore(newNode, referenceNode)` against the original parent,
// which throws NotFoundError ("The object can not be found here."). Redirect
// the insert to the reference node's current parent — the viewport is always
// a descendant of the original host so visually it lands in the right place.
// eslint-disable-next-line @typescript-eslint/unbound-method
const origInsertBefore = Node.prototype.insertBefore;
Node.prototype.insertBefore = function <T extends Node>(newNode: T, referenceNode: Node | null): T {
  if (referenceNode && referenceNode.parentNode && referenceNode.parentNode !== this) {
    return referenceNode.parentNode.insertBefore(newNode, referenceNode);
  }
  return origInsertBefore.call(this, newNode, referenceNode) as T;
};

// Initialize OverlayScrollbars on scrollable elements.
// Uses a debounced MutationObserver to catch dynamically added containers.
// Skips elements with scrollbar-width: none (intentionally hidden scrollbars).
const OS_ATTR = 'data-os-init';
const OS_OPTS = { scrollbars: { theme: 'os-theme-shipstudio', autoHide: 'move' as const } };

// Elements that should never get OverlayScrollbars (use CSS class matching).
// Includes containers that hide native scrollbars via scrollbar-width: none /
// ::-webkit-scrollbar { display: none } — the getComputedStyle check for
// scrollbarWidth can fail in WKWebView, so we explicitly list them here.
const OS_SKIP_SELECTOR = [
  '[class*="-modal"]',
  '[class*="-overlay"]',
  '[class*="-dropdown"]',
  '.branches-tab',
  '.prs-tab',
  '.dashboard-with-changelog',
  '.dashboard-scroll-container',
  '.changelog-list',
  '.support-panel',
  // Workspace sidebar scroll owns its own webkit scrollbar styling and
  // applies `!important` block layout to its direct children. Letting
  // OverlayScrollbars wrap it breaks the scrollbar entirely (the OS
  // viewport gets caught by the `> *` rule) and makes the list unscrollable
  // when several projects are open.
  '.workspace-sidebar-scroll',
  // CodeMirror owns its own scrolling. Its `.cm-scroller` is overflow:auto, so
  // OverlayScrollbars would otherwise grab it and relocate the gutter/content
  // out of CodeMirror's flex row — the line-number gutter collapses to full
  // width and the code stacks below it (Code tab editor, visual editor).
  '.cm-editor',
].join(', ');

function initScrollbars() {
  document.querySelectorAll<HTMLElement>('*').forEach((el) => {
    // Skip elements already processed
    if (el.hasAttribute(OS_ATTR)) return;
    // Skip OverlayScrollbars internal elements (viewport, content, scrollbar wrappers).
    // This is CRITICAL: OS creates a viewport with overflow:scroll inside the host.
    // Without this guard, initScrollbars would detect that viewport, init OS on it,
    // creating another viewport inside it — an infinite nesting loop that causes
    // 100% CPU and ever-growing memory.
    if (
      el.hasAttribute('data-overlayscrollbars-viewport') ||
      el.hasAttribute('data-overlayscrollbars-padding') ||
      el.hasAttribute('data-overlayscrollbars-content') ||
      el.hasAttribute('data-overlayscrollbars') ||
      el.closest('[data-overlayscrollbars]')
    )
      return;
    // Skip elements inside modals, overlays, dropdowns
    if (el.closest(OS_SKIP_SELECTOR)) return;
    // Skip non-HTML elements (SVG, etc.)
    if (!(el instanceof HTMLElement)) return;

    const style = getComputedStyle(el);
    // Skip elements that intentionally hide scrollbars
    if (style.scrollbarWidth === 'none') return;
    const oy = style.overflowY;
    if (oy === 'auto' || oy === 'scroll') {
      el.setAttribute(OS_ATTR, '');
      OverlayScrollbars(el, OS_OPTS);
    }
  });
}

requestAnimationFrame(() => {
  initScrollbars();

  // Disconnect previous observer if HMR reload
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
  const prevObserver = (window as any).__scrollbarObserver;
  if (prevObserver instanceof MutationObserver) {
    prevObserver.disconnect();
  }

  let timer: number;
  let running = false;
  const observer = new MutationObserver(() => {
    // Don't re-schedule if already running (prevents cascading mutations from re-triggering)
    if (running) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      running = true;
      initScrollbars();
      // Delay clearing the flag so mutations caused by initScrollbars itself are ignored
      requestAnimationFrame(() => {
        running = false;
      });
    }, 250);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
  (window as any).__scrollbarObserver = observer;
  observer.observe(document.body, { childList: true, subtree: true });
});

// Parse project path from URL if present (for project windows)
const urlParams = new URLSearchParams(window.location.search);
const initialProjectPath = urlParams.get('project');

ReactDOM.createRoot(document.getElementById('root') as HTMLElement, {
  // Only report errors that escape ErrorBoundary. Caught errors already flow
  // through `logger.logError` → backend `log_frontend_event` → `tracing::error!`
  // → sentry_tracing layer, so wiring `onCaughtError` here would double-report.
  onUncaughtError: reactErrorHandler(),
  onRecoverableError: reactErrorHandler(),
}).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App initialProjectPath={initialProjectPath} />
    </ErrorBoundary>
  </React.StrictMode>
);
