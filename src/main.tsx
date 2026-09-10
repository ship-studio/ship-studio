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
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { WebAuthGate } from './components/WebAuthGate';
import { exposeReactGlobals, lookupBlobOwner, markPluginCrashed } from './lib/plugin-loader';
import { uninstallPlugin } from './lib/plugins';
import { exposePluginContextRef } from './contexts/PluginContext';
import { reportError } from './lib/errorReporting';
import { classifyRejection, describeRejectionReason } from './lib/globalErrorFilters';
import { createScrollbarScanner, rootsFromMutations } from './lib/scrollbarScan';
import { isExpectedCommandError } from './lib/errors';
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
  if (!isPluginError) {
    // A backend-classified Expected value thrown synchronously is the same
    // non-bug it is on the rejection path (issue #916) — never file it.
    if (isExpectedCommandError(event.error)) {
      console.warn('[Harbr] Uncaught Expected backend error — not reported:', msg);
      return;
    }
    // App bug (not third-party plugin code) — report to the admin agent.
    reportError({
      message: msg,
      stack: event.error instanceof Error ? event.error.stack : undefined,
      source: 'window-error',
    });
    return;
  }

  event.preventDefault();
  console.error('[Harbr] Plugin error caught by global handler:', msg);

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
  const message = reason instanceof Error ? reason.message : describeRejectionReason(reason);

  switch (classifyRejection(reason)) {
    case 'plugin':
      event.preventDefault();
      console.error('[Harbr] Plugin unhandled rejection caught by global handler:', reason);
      return;

    case 'tauri-race':
      // Inert Tauri v2 runtime race — suppressed to keep the console clean.
      event.preventDefault();
      return;

    case 'expected':
      // The backend already classified this a recognized environment state
      // with a user-side fix. Nobody caught the promise, which is worth a
      // local trace, but it is not a malfunction and must not be filed as
      // one (issue #916).
      console.warn('[Harbr] Uncaught Expected backend error — not reported:', message);
      return;

    case 'report':
      // Genuine unhandled rejection from app code — report to the admin agent.
      reportError({
        message,
        stack: reason instanceof Error ? reason.stack : undefined,
        source: 'unhandled-rejection',
      });
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

// Attach OverlayScrollbars to scrollable elements, wherever and whenever they
// appear. The deciding — and, more to the point, the *not* re-deciding — lives
// in `lib/scrollbarScan.ts`; this half owns the options and the observer.
const OS_OPTS = { scrollbars: { theme: 'os-theme-shipstudio', autoHide: 'move' as const } };
const ASSET_SCROLL_SELECTOR = '.assets-list-container';
const ASSET_OS_OPTS = {
  scrollbars: { theme: 'os-theme-shipstudio', autoHide: 'never' as const },
};

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
  // ValueField menus are fixed, body-portaled listboxes. OverlayScrollbars
  // rewrites their children and collapses the menu's max-content width in
  // WebKit, leaving an open listbox mounted but visually hidden.
  '.value-field__menu',
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
  // The Code file browser hides its native scrollbar and owns a flex layout.
  // OverlayScrollbars changes the sidebar's child layout while relocating the
  // tree into a viewport, which can leave visible file rows outside the
  // clickable hit-test area in WKWebView.
  '.code-tab-sidebar-content',
  // PROTOTYPE (workflows/inbox): the two inbox panes are grid tracks with an
  // explicit 0 minimum. OverlayScrollbars relocates their children into a
  // viewport that is sized wider than the host track, so rows paint past the
  // divider instead of eliding. Same reason .workspace-sidebar-scroll opts out.
  '.inbox-list',
  '.workflow-row-activity',
  '.inbox-detail-pane',
  // The breakpoint canvas is a design surface, not a document: it scrolls
  // itself, positions its own content, and reads its own box to decide the fit
  // scale and how far the canvas may be pushed past its frames. Relocating its
  // children into a viewport wrapper breaks both halves of that — the scroll
  // offsets are written to a node that no longer scrolls, and the host stops
  // clipping, so the canvas's own height feeds back into the size it measures
  // itself by and the surface runs away to millions of pixels.
  '.preview-canvas',
  // The comment list replaces its children often; preserve React's DOM
  // ownership. It lives in the Team panel now rather than a floating one.
  '.team-thread-list',
].join(', ');

const scrollbarScanner = createScrollbarScanner({
  skipSelector: OS_SKIP_SELECTOR,
  assetSelector: ASSET_SCROLL_SELECTOR,
  attach: (el, isAssetScrollContainer) => {
    OverlayScrollbars(el, isAssetScrollContainer ? ASSET_OS_OPTS : OS_OPTS);
  },
});

requestAnimationFrame(() => {
  scrollbarScanner.scan(document.body);

  // Disconnect previous observer if HMR reload
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
  const prevObserver = (window as any).__scrollbarObserver;
  if (prevObserver instanceof MutationObserver) {
    prevObserver.disconnect();
  }

  // Records are collected across the debounce window rather than dropped,
  // because they are now the whole input: a coalesced batch that forgot which
  // subtrees arrived would have nothing left to scan but the document.
  let timer: number | undefined;
  let pending: MutationRecord[] = [];
  let running = false;

  const flush = () => {
    timer = undefined;
    const records = pending;
    pending = [];
    running = true;
    const { added, changed } = rootsFromMutations(records);
    // A class or inline-style change can turn an element — or, through the
    // cascade, one of its descendants — scrollable when it wasn't.
    for (const el of changed) {
      if (el.isConnected) scrollbarScanner.invalidate(el);
    }
    for (const el of changed) {
      if (el.isConnected) scrollbarScanner.scan(el);
    }
    for (const el of added) {
      if (el.isConnected) scrollbarScanner.scan(el);
    }
    // Cleared a frame later so the mutations this pass just caused (attaching
    // OverlayScrollbars rewrites the host's children) don't re-trigger it.
    requestAnimationFrame(() => {
      running = false;
    });
  };

  const observer = new MutationObserver((records) => {
    if (running) return;
    pending.push(...records);
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(flush, 250);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
  (window as any).__scrollbarObserver = observer;
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    // The only attributes that can change computed overflow.
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
});

// Parse project path from URL if present (for project windows)
const urlParams = new URLSearchParams(window.location.search);
const initialProjectPath = urlParams.get('project');

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <WebAuthGate>
        <App initialProjectPath={initialProjectPath} />
      </WebAuthGate>
    </ErrorBoundary>
  </React.StrictMode>
);
