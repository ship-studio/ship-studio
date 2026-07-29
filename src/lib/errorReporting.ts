/**
 * Automatic error reporting to the Ship Studio admin agent.
 *
 * Uncaught frontend errors (ErrorBoundary, window.onerror, unhandledrejection)
 * are forwarded to the Rust backend (`report_frontend_error`), which scrubs
 * home-dir paths and relays them to the admin agent. The agent investigates
 * against the codebase, files deduplicated GitHub issues, and can open draft
 * fix PRs. See docs/error-reporting.md for the full contract.
 *
 * Rules enforced here (the Rust side re-checks them all):
 * - Fire-and-forget — never throws, never blocks the UX.
 * - Production builds only (VITE_BUG_REPORT_FORCE=1 overrides for testing).
 * - One report per fingerprint per app session, with a session hard cap.
 *
 * @module lib/errorReporting
 */

import { invoke } from '@tauri-apps/api/core';

export interface ErrorReport {
  message: string;
  stack?: string;
  /** Subsystem/feature name, e.g. 'react-error-boundary', 'window-error'. */
  source?: string;
  /**
   * Stable slug for known catch-sites (e.g. 'publish-staging-io-error').
   * Repeat occurrences of the same fingerprint land on the agent's existing
   * session instead of filing duplicate issues. Omit for generic handlers —
   * the backend/server derive one from the message + top stack frame.
   */
  fingerprint?: string;
}

/** Varying messages defeat fingerprint dedup — stop after this many reports. */
const MAX_REPORTS_PER_SESSION = 20;

const reportedKeys = new Set<string>();

/** Session dedup key: explicit fingerprint, else source + truncated message. */
export function dedupeKey(report: ErrorReport): string {
  return report.fingerprint ?? `${report.source ?? 'frontend'}:${report.message.slice(0, 200)}`;
}

/**
 * Records the report's dedup key and returns whether it should be sent.
 * True only for the first occurrence per session, under the session cap.
 */
export function shouldReport(report: ErrorReport): boolean {
  if (reportedKeys.size >= MAX_REPORTS_PER_SESSION) return false;
  const key = dedupeKey(report);
  if (reportedKeys.has(key)) return false;
  reportedKeys.add(key);
  return true;
}

function reportingEnabled(): boolean {
  return import.meta.env.PROD || import.meta.env.VITE_BUG_REPORT_FORCE === '1';
}

/**
 * Report an uncaught error to the admin agent. Safe to call from anywhere,
 * including error paths — it can never throw or reject.
 */
export function reportError(report: ErrorReport): void {
  try {
    if (!reportingEnabled()) return;
    if (!shouldReport(report)) return;
    void invoke('report_frontend_error', {
      message: report.message,
      stack: report.stack,
      source: report.source ?? 'frontend',
      fingerprint: report.fingerprint,
    }).catch(() => {});
  } catch {
    // Error reporting must never be the thing that crashes the app.
  }
}
