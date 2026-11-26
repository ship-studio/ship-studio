/**
 * What every React error boundary in the app does with a caught render error.
 *
 * Shared by the top-level `ErrorBoundary` and the per-surface
 * `PanelErrorBoundary`, so containing a crash to one panel never costs the
 * report: the same `frontend-crash` source, the same component stack, and the
 * same plugin auto-removal. A panel boundary adds `panel` to the context so the
 * report says which surface it was (#1211 could not).
 */

import type { ErrorInfo } from 'react';
import { logger } from './logger';
import { lookupBlobOwner, markPluginCrashed } from './plugin-loader';
import { uninstallPlugin } from './plugins';

export interface RenderCrashContext {
  /** The surface that contained the crash, e.g. `variables`, `modal:Settings`. */
  panel?: string;
}

export function reportRenderCrash(
  error: Error,
  errorInfo: Pick<ErrorInfo, 'componentStack'>,
  context: RenderCrashContext = {}
): void {
  // logError also reports the crash to the admin agent (logger forwards
  // error-level logs — see docs/error-reporting.md).
  logger.logError(
    error,
    {
      componentStack: errorInfo.componentStack ?? undefined,
      ...(context.panel ? { panel: context.panel } : {}),
    },
    'frontend-crash'
  );

  // Auto-remove crashing plugins so they don't crash again on Continue/Retry.
  const blobMatch = /blob:[^\s:)]+/.exec(error.stack ?? '');
  if (!blobMatch) return;
  const owner = lookupBlobOwner(blobMatch[0]);
  if (!owner) return;
  markPluginCrashed(owner.pluginId);
  void uninstallPlugin(owner.projectPath, owner.pluginId).catch((e) =>
    console.error(`Failed to auto-remove plugin "${owner.pluginId}":`, e)
  );
}
