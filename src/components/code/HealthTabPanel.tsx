/**
 * HealthTabPanel — tab-native UI for code health checks. Lives inside the
 * Inspect panel's "Health" tab. Designed to fill the tab body, not the
 * thin toolbar row that the legacy `CodeHealthPanel` was built for.
 *
 * Layout:
 *   ┌──────────────────────────────────────────┐
 *   │ Header: summary + Run all + Auto + …     │
 *   ├──────────────────────────────────────────┤
 *   │ Check rows (one per script category)     │
 *   ├──────────────────────────────────────────┤
 *   │ Output panel (selected check's output)   │
 *   └──────────────────────────────────────────┘
 *
 * The data layer is unchanged — this component consumes `useCodeHealth`.
 */

import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { ScriptCategory, formatRelativeTime, formatDuration } from '../../lib/health';
import {
  useCodeHealth,
  CATEGORIES,
  CATEGORY_LABELS,
  type CheckStatus,
  type CheckState,
} from '../../hooks/useCodeHealth';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useOptionalToast } from '../../contexts/ToastContext';
import { stripAnsi } from '../../lib/ansi';
import { Button } from '../primitives/Button';
import { ModalFrame } from '../primitives/ModalFrame';
import { Spinner } from '../primitives/Spinner';
import { FileIcon, CopyIcon, ResetIcon } from '../icons';

const CATEGORY_HINTS: Record<ScriptCategory, string> = {
  test: "Runs your project's test suite (vitest, jest, etc.) and reports pass/fail.",
  lint: 'Static analysis (eslint, biome, etc.) that flags style violations and likely bugs without running the code.',
  typecheck:
    "TypeScript's type checker (tsc --noEmit). Catches type errors the dev server skips for speed.",
  format:
    "Verifies every file matches your formatter's style (prettier, biome). Read-only — no files are modified.",
};

interface HealthTabPanelProps {
  projectPath: string;
  onAskClaude?: (prompt: string) => void;
  onHealthOutput?: (output: string) => void;
}

export interface HealthTabPanelRef {
  runAllChecks: () => Promise<void>;
  refreshScripts: () => Promise<void>;
}

export const HealthTabPanel = forwardRef<HealthTabPanelRef, HealthTabPanelProps>(
  function HealthTabPanel({ projectPath, onAskClaude, onHealthOutput }, ref) {
    const { showToast } = useOptionalToast();
    const onToast = (message: string, type?: 'success' | 'error') => showToast(message, type);
    const { copy: copyOutput } = useCopyToClipboard({
      onCopy: () => onToast('Output copied', 'success'),
    });
    const { copy: copyPackageJson } = useCopyToClipboard({
      onCopy: () => onToast('package.json copied', 'success'),
    });

    const health = useCodeHealth({ projectPath, onToast, onAskClaude, onHealthOutput });

    useImperativeHandle(
      ref,
      () => ({
        runAllChecks: health.runAllChecks,
        refreshScripts: health.loadScriptsAndStatus,
      }),
      [health.runAllChecks, health.loadScriptsAndStatus]
    );

    // Which row's output is shown below. `null` means "nothing run yet".
    const [selected, setSelected] = useState<ScriptCategory | null>(null);

    /* Auto-pick the most useful row to show output for. We key the effect on
       a small derived signature instead of `health.checkStates` directly —
       the hook returns a fresh state object every render, so depending on it
       would re-evaluate on every render, not only when statuses changed. */
    const statusSignature = CATEGORIES.map(
      (c) => `${c}:${health.checkStates[c].status}:${health.checkStates[c].result?.lastRun ?? ''}`
    ).join('|');

    useEffect(() => {
      if (selected && health.checkStates[selected].status !== 'missing') return;
      const visible = CATEGORIES.filter((c) => health.checkStates[c].status !== 'missing');
      const firstFail = visible.find((c) => health.checkStates[c].status === 'fail');
      const firstWithResult = visible.find((c) => health.checkStates[c].result);
      setSelected(firstFail ?? firstWithResult ?? visible[0] ?? null);
      // statusSignature captures the parts of checkStates we actually read.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [statusSignature]);

    const selectedState: CheckState | null =
      selected && health.checkStates[selected].status !== 'missing'
        ? health.checkStates[selected]
        : null;
    const selectedResult = selectedState?.result ?? null;
    /* Combine stdout and stderr — many tools (vitest, eslint) write the
       primary report to stdout, and tools like tsc write *errors* to stdout
       too. But some formatters (prettier) emit the diff to stderr. Showing
       both, in order, is safer than picking one and silently dropping the
       other. */
    const selectedOutput = selectedResult
      ? stripAnsi(
          [selectedResult.stdout, selectedResult.stderr].filter(Boolean).join('\n')
        ).trimEnd()
      : '';

    const packageJsonOpen = health.showPackageJson && !!health.packageJsonContent;
    const modal = (
      <PackageJsonModal
        isOpen={packageJsonOpen}
        content={health.packageJsonContent ?? ''}
        onClose={() => health.setShowPackageJson(false)}
        onCopy={() => void copyPackageJson(health.packageJsonContent ?? '')}
      />
    );

    if (!health.showHealthPanel) {
      return (
        <>
          <div className="health-tab health-tab--empty">
            <div className="health-tab-empty">
              <div className="health-tab-empty-title">No health checks configured</div>
              <p className="health-tab-empty-body">
                {health.detectedScripts?.hasPackageJson === false
                  ? 'This project has no package.json, so there are no scripts to run.'
                  : 'Add a test, lint, typecheck, or format script to package.json to enable checks here.'}
              </p>
              {health.detectedScripts?.hasPackageJson && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void health.handleShowPackageJson()}
                  disabled={health.isLoadingPackageJson}
                  leftIcon={<FileIcon size={12} />}
                >
                  View package.json
                </Button>
              )}
            </div>
          </div>
          {modal}
        </>
      );
    }

    return (
      <div className="health-tab">
        {/* Header */}
        <div className="health-tab-header">
          <div className="health-tab-summary">
            <SummaryPill kind="pass" count={health.passingCount} label="passing" />
            <SummaryPill kind="fail" count={health.failingCount} label="failing" />
            <SummaryPill kind="idle" count={health.notRunCount} label="not run" />
          </div>
          <div className="health-tab-actions">
            <Button
              variant="primary"
              size="sm"
              onClick={() => void health.runAllChecks()}
              disabled={health.isAnyRunning || health.isRunningAll}
            >
              {health.isRunningAll ? (
                <>
                  <Spinner size="sm" /> Running…
                </>
              ) : (
                'Run all'
              )}
            </Button>
            <Button
              variant={health.isAutoRunEnabled ? 'secondary' : 'ghost'}
              size="sm"
              onClick={health.handleAutoRunToggle}
              title={
                health.isAutoRunEnabled
                  ? `Auto-run in ${health.formatCountdown(health.autoRunSecondsRemaining)} (click to disable)`
                  : 'Run all checks every 15 minutes'
              }
            >
              {health.isAutoRunEnabled
                ? `Auto · ${health.formatCountdown(health.autoRunSecondsRemaining)}`
                : 'Auto-run off'}
            </Button>
            <button
              type="button"
              className="health-tab-icon-btn"
              onClick={() => void health.handleRefresh()}
              disabled={health.isRefreshing}
              title="Re-detect scripts from package.json"
              aria-label="Refresh scripts"
            >
              {health.isRefreshing ? <Spinner size="sm" /> : <ResetIcon size={12} />}
            </button>
            <button
              type="button"
              className="health-tab-icon-btn"
              onClick={() => void health.handleShowPackageJson()}
              disabled={health.isLoadingPackageJson}
              title="View package.json"
              aria-label="View package.json"
            >
              {health.isLoadingPackageJson ? <Spinner size="sm" /> : <FileIcon size={12} />}
            </button>
          </div>
        </div>

        {/* Check rows. Each row is a plain <li>; a button inside takes the
            "select this row" click, and action buttons sit beside it as
            siblings — no nested-button anti-pattern. */}
        <ul className="health-tab-list" role="list">
          {CATEGORIES.map((cat) => {
            const state = health.checkStates[cat];
            if (state.status === 'missing') return null;
            const isSelected = selected === cat;
            const lastRun = state.result?.lastRun;
            return (
              <li
                key={cat}
                className={`health-tab-row health-tab-row--${state.status} ${
                  isSelected ? 'is-selected' : ''
                }`}
              >
                <button
                  type="button"
                  className="health-tab-row-main"
                  onClick={() => {
                    setSelected(cat);
                    /* Clicking a never-run row both selects it and kicks off
                       the check — otherwise the click has no observable
                       effect beyond a row highlight, since the output pane
                       has nothing to show. Re-runs of completed checks still
                       go through the dedicated "Run" button. */
                    if (!state.result && state.status === 'idle' && !health.isRunningAll) {
                      void health.runCheck(cat);
                    }
                  }}
                  aria-current={isSelected ? 'true' : undefined}
                >
                  <StatusGlyph status={state.status} />
                  <span className="health-tab-row-label">{CATEGORY_LABELS[cat]}</span>
                </button>
                {/* `?` lives outside the row-main button so it can be its own
                    focusable widget. Nesting interactive elements inside a
                    <button> is an a11y anti-pattern and breaks Tab focus. */}
                <HelpHint label={CATEGORY_HINTS[cat]} />
                <span className="health-tab-row-status">{statusText(state)}</span>
                {state.result?.durationMs !== undefined && (
                  <span className="health-tab-row-meta">
                    {formatDuration(state.result.durationMs)}
                  </span>
                )}
                {lastRun && (
                  <span className="health-tab-row-time" title={new Date(lastRun).toLocaleString()}>
                    {formatRelativeTime(lastRun)}
                  </span>
                )}
                <div className="health-tab-row-actions">
                  {state.status === 'fail' && onAskClaude && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => health.handleAskClaude(cat)}
                      title="Ask Claude to fix"
                    >
                      Ask Claude
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void health.runCheck(cat)}
                    disabled={state.status === 'running' || health.isRunningAll}
                    title={state.result ? 'Re-run check' : 'Run check'}
                  >
                    {state.status === 'running' ? <Spinner size="sm" /> : 'Run'}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>

        {/* Output pane */}
        <div className="health-tab-output">
          {selected && selectedState && selectedResult ? (
            <>
              <div className="health-tab-output-header">
                <div className="health-tab-output-title">
                  <StatusGlyph status={selectedState.status} />
                  <span>{CATEGORY_LABELS[selected]} output</span>
                  <span className="health-tab-output-meta">
                    exit {selectedResult.exitCode} · {formatDuration(selectedResult.durationMs)}
                  </span>
                </div>
                <div className="health-tab-output-actions">
                  <button
                    type="button"
                    className="health-tab-icon-btn"
                    onClick={() => void copyOutput(selectedOutput)}
                    title="Copy output"
                    aria-label="Copy output"
                  >
                    <CopyIcon size={12} />
                  </button>
                  {selectedState.status === 'fail' && onAskClaude && (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => health.handleAskClaude(selected)}
                    >
                      Ask Claude to fix
                    </Button>
                  )}
                </div>
              </div>
              <pre className="health-tab-output-body">{selectedOutput || 'No output'}</pre>
            </>
          ) : (
            <div className="health-tab-output-empty">
              {selected ? 'Run this check to see output.' : 'Run a check to see its output here.'}
            </div>
          )}
        </div>

        {/* Inline suggestions card */}
        {(() => {
          const suggestions = health.detectedScripts?.suggestions ?? [];
          if (suggestions.length === 0) return null;
          return (
            <div className="health-tab-suggestions">
              <div className="health-tab-suggestions-header">
                <span className="health-tab-suggestions-title">
                  {suggestions.length} suggested {suggestions.length === 1 ? 'script' : 'scripts'}
                </span>
                {onAskClaude && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const lines = suggestions
                        .map((s) => `"${s.scriptName}": "${s.scriptCommand}"`)
                        .join('\n    ');
                      onAskClaude(
                        `Please add the following scripts to my package.json file in the "scripts" section:\n\n    ${lines}\n\nMake sure to preserve all existing scripts and formatting.`
                      );
                    }}
                  >
                    Ask Claude to add
                  </Button>
                )}
              </div>
              <ul className="health-tab-suggestions-list">
                {suggestions.map((s, i) => (
                  <li key={i} className="health-tab-suggestion">
                    <code className="health-tab-suggestion-code">
                      "{s.scriptName}": "{s.scriptCommand}"
                    </code>
                    <span className="health-tab-suggestion-reason">{s.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })()}

        {modal}
      </div>
    );
  }
);

function statusText(state: CheckState): string {
  switch (state.status) {
    case 'pass':
      return 'Passing';
    case 'fail':
      return 'Failing';
    case 'running':
      return 'Running';
    case 'idle':
      return state.result ? 'Idle' : 'Not run';
    case 'missing':
      // Filtered out by `visibleCategories`, but TypeScript wants the case.
      return '';
  }
}

/** Small "?" badge after a label. Custom CSS-only tooltip (instead of the
 *  native `title` attribute) so the popover appears instantly on hover —
 *  the OS-level title delay made these feel laggy. The tooltip itself is
 *  a non-interactive sibling span shown via `:hover` on the wrapper. */
function HelpHint({ label }: { label: string }) {
  return (
    <span
      className="health-tab-help"
      role="img"
      aria-label={label}
      // Stop the click from bubbling into the row's "select" handler.
      onClick={(e) => e.stopPropagation()}
    >
      <svg width={11} height={11} viewBox="0 0 16 16" aria-hidden="true">
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
      <span className="health-tab-help-tooltip" role="tooltip">
        {label}
      </span>
    </span>
  );
}

function StatusGlyph({ status }: { status: CheckStatus }) {
  if (status === 'missing') return null;
  if (status === 'running')
    return <Spinner size="sm" className="health-tab-glyph running" label="Running" />;
  return <span className={`health-tab-glyph dot ${status}`} aria-hidden="true" />;
}

function SummaryPill({
  kind,
  count,
  label,
}: {
  kind: 'pass' | 'fail' | 'idle';
  count: number;
  label: string;
}) {
  if (count === 0) return null;
  return (
    <span className={`health-tab-pill ${kind}`}>
      <span className="health-tab-pill-count">{count}</span>
      <span className="health-tab-pill-label">{label}</span>
    </span>
  );
}

function PackageJsonModal({
  isOpen,
  content,
  onClose,
  onCopy,
}: {
  isOpen: boolean;
  content: string;
  onClose: () => void;
  onCopy: () => void;
}) {
  let formatted = content;
  try {
    const parsed: unknown = JSON.parse(content);
    formatted = JSON.stringify(parsed, null, 2);
  } catch {
    // raw content
  }
  return (
    <ModalFrame isOpen={isOpen} onClose={onClose} title="package.json">
      <pre className="health-tab-pkg-json">{formatted}</pre>
      <div className="health-tab-pkg-json-actions">
        <Button variant="secondary" size="sm" onClick={onCopy} leftIcon={<CopyIcon size={12} />}>
          Copy
        </Button>
        <Button variant="primary" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </ModalFrame>
  );
}
