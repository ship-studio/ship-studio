/**
 * CodeHealthPanel component for running code quality checks.
 *
 * Provides a collapsible panel with buttons to run:
 * - Tests (npm test, vitest, jest, etc.)
 * - Linting (eslint, lint, etc.)
 * - Type checking (tsc, typecheck, etc.)
 * - Format checking (prettier, format, etc.)
 *
 * Displays visual pass/fail indicators and persists results between sessions.
 *
 * State management is handled by the useCodeHealth hook.
 *
 * @module components/CodeHealthPanel
 */

import { useState, useImperativeHandle, forwardRef } from 'react';
import {
  HealthCheckResult,
  ScriptCategory,
  ScriptSuggestion,
  formatRelativeTime,
  formatDuration,
} from '../lib/health';
import {
  useCodeHealth,
  CATEGORIES,
  CATEGORY_LABELS,
  type CheckStatus,
  type CheckState,
} from '../hooks/useCodeHealth';
import { ChevronIcon, ChevronRightIcon, SpinnerIcon, CloseIcon, CopyIcon, FileIcon } from './icons';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { useOptionalToast } from '../contexts/ToastContext';

interface CodeHealthPanelProps {
  projectPath: string;
  onAskClaude?: (prompt: string) => void;
  onHealthOutput?: (output: string) => void;
  /** Content to render on the left of the toolbar (e.g., Restart Server button) */
  toolbarLeft?: React.ReactNode;
  /** Content to render on the right of the toolbar (e.g., Show Preview button) */
  toolbarRight?: React.ReactNode;
}

export interface CodeHealthPanelRef {
  runAllChecks: () => Promise<void>;
  refreshScripts: () => Promise<void>;
}

export const CodeHealthPanel = forwardRef<CodeHealthPanelRef, CodeHealthPanelProps>(
  function CodeHealthPanel(
    { projectPath, onAskClaude, onHealthOutput, toolbarLeft, toolbarRight },
    ref
  ) {
    const [isExpanded, setIsExpanded] = useState(false);
    const { showToast } = useOptionalToast();
    const onToast = (message: string, type?: 'success' | 'error') => showToast(message, type);
    const { copy: copyOutput } = useCopyToClipboard({
      onCopy: () => onToast?.('Output copied', 'success'),
    });
    const { copy: copyPackageJson } = useCopyToClipboard({
      onCopy: () => onToast?.('package.json copied', 'success'),
    });
    const { copy: copyScript } = useCopyToClipboard({
      onCopy: () => onToast?.('Script copied to clipboard', 'success'),
    });

    const health = useCodeHealth({ projectPath, onToast, onAskClaude, onHealthOutput });

    // Expose methods via ref for parent component
    useImperativeHandle(
      ref,
      () => ({
        runAllChecks: health.runAllChecks,
        refreshScripts: health.loadScriptsAndStatus,
      }),
      [health.runAllChecks, health.loadScriptsAndStatus]
    );

    return (
      <>
        {/* Main toolbar row with Restart Server, Health indicator, and preview actions */}
        <div className="terminal-toolbar">
          {toolbarLeft}
          {health.showHealthPanel && (
            <>
              <button
                className="health-toggle"
                onClick={() => setIsExpanded(!isExpanded)}
                title={isExpanded ? 'Collapse health panel' : 'Expand health panel'}
                data-education-id="health-panel"
              >
                {isExpanded ? <ChevronIcon size={10} /> : <ChevronRightIcon size={10} />}
                <span className="health-label">Health</span>
                <span className="health-summary">
                  {CATEGORIES.map((cat) => {
                    const state = health.checkStates[cat];
                    if (state.status === 'missing') return null;
                    return <StatusDot key={cat} status={state.status} size={6} />;
                  })}
                </span>
                {!isExpanded && (
                  <span className="health-collapsed-info">
                    {health.passingCount > 0 && (
                      <span className="health-count pass">{health.passingCount} passing</span>
                    )}
                    {health.failingCount > 0 && (
                      <span className="health-count fail">{health.failingCount} failing</span>
                    )}
                    {health.notRunCount > 0 && (
                      <span className="health-count idle">{health.notRunCount} not run</span>
                    )}
                  </span>
                )}
              </button>
              {health.isAutoRunEnabled && (
                <span className="health-countdown" title="Auto-run countdown">
                  <svg
                    width={10}
                    height={10}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                  <span>{health.formatCountdown(health.autoRunSecondsRemaining)}</span>
                </span>
              )}
            </>
          )}
          {toolbarRight}
        </div>

        {/* Expanded health toolbar row */}
        {health.showHealthPanel && isExpanded && (
          <div className="health-panel">
            <div className="health-buttons">
              {CATEGORIES.map((category) => {
                const state = health.checkStates[category];
                if (state.status === 'missing') return null;

                return (
                  <HealthButton
                    key={category}
                    label={CATEGORY_LABELS[category]}
                    state={state}
                    onClick={() => health.handleButtonClick(category)}
                    onRerun={() => void health.runCheck(category)}
                  />
                );
              })}

              <button
                className="health-run-all"
                onClick={() => void health.runAllChecks()}
                disabled={health.isAnyRunning || health.isRunningAll}
                title="Run all available checks"
              >
                {health.isRunningAll ? <SpinnerIcon size={12} /> : 'Run All'}
              </button>

              <button
                className={`health-auto-run ${health.isAutoRunEnabled ? 'active' : ''}`}
                onClick={health.handleAutoRunToggle}
                disabled={health.isRunningAll}
                title={
                  health.isAutoRunEnabled
                    ? `Auto-run in ${health.formatCountdown(health.autoRunSecondsRemaining)} (click to disable)`
                    : 'Enable auto-run every 15 minutes'
                }
              >
                {health.isAutoRunEnabled ? (
                  <>
                    <svg
                      width={10}
                      height={10}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                    <span>{health.formatCountdown(health.autoRunSecondsRemaining)}</span>
                  </>
                ) : (
                  <svg
                    width={12}
                    height={12}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                )}
              </button>

              <button
                className="health-pkg-json"
                onClick={() => void health.handleShowPackageJson()}
                disabled={health.isLoadingPackageJson}
                title="View package.json"
              >
                {health.isLoadingPackageJson ? <SpinnerIcon size={12} /> : <FileIcon size={12} />}
              </button>

              <button
                className="health-refresh"
                onClick={() => void health.handleRefresh()}
                disabled={health.isRefreshing}
                title="Refresh scripts from package.json"
              >
                {health.isRefreshing ? (
                  <SpinnerIcon size={12} />
                ) : (
                  <svg
                    width={12}
                    height={12}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                )}
              </button>

              {/* Suggestions indicator */}
              {health.detectedScripts?.suggestions &&
                health.detectedScripts.suggestions.length > 0 && (
                  <button
                    className="health-suggestions-btn"
                    onClick={() => health.setShowSuggestions(true)}
                    title={`${health.detectedScripts.suggestions.length} script suggestion${health.detectedScripts.suggestions.length > 1 ? 's' : ''} available`}
                  >
                    <svg
                      width={12}
                      height={12}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="16" />
                      <line x1="8" y1="12" x2="16" y2="12" />
                    </svg>
                    <span>{health.detectedScripts.suggestions.length}</span>
                  </button>
                )}
            </div>
          </div>
        )}

        {/* Error Modal */}
        {health.errorModalCategory && health.checkStates[health.errorModalCategory].result && (
          <HealthErrorModal
            category={health.errorModalCategory}
            result={health.checkStates[health.errorModalCategory].result!}
            onClose={() => health.setErrorModalCategory(null)}
            onCopy={() => {
              const result = health.checkStates[health.errorModalCategory!].result;
              if (result) {
                void copyOutput(result.stdout || result.stderr);
              }
            }}
            onAskClaude={() => health.handleAskClaude(health.errorModalCategory!)}
            onRerun={() => {
              const cat = health.errorModalCategory!;
              health.setErrorModalCategory(null);
              void health.runCheck(cat);
            }}
          />
        )}

        {/* Package.json Modal */}
        {health.showPackageJson && health.packageJsonContent && (
          <PackageJsonModal
            content={health.packageJsonContent}
            onClose={() => health.setShowPackageJson(false)}
            onCopy={() => {
              void copyPackageJson(health.packageJsonContent!);
            }}
          />
        )}

        {/* Suggestions Modal */}
        {health.showSuggestions &&
          health.detectedScripts?.suggestions &&
          health.detectedScripts.suggestions.length > 0 && (
            <SuggestionsModal
              suggestions={health.detectedScripts.suggestions}
              onClose={() => health.setShowSuggestions(false)}
              onCopy={(text: string) => {
                void copyScript(text);
              }}
              onAskClaude={(suggestions: ScriptSuggestion[]) => {
                const scriptLines = suggestions
                  .map((s) => `"${s.scriptName}": "${s.scriptCommand}"`)
                  .join('\n    ');
                const prompt = `Please add the following scripts to my package.json file in the "scripts" section:\n\n    ${scriptLines}\n\nMake sure to preserve all existing scripts and formatting.`;
                onAskClaude?.(prompt);
                health.setShowSuggestions(false);
              }}
            />
          )}
      </>
    );
  }
);

// Status indicator dot/icon
function StatusDot({ status, size = 8 }: { status: CheckStatus; size?: number }) {
  switch (status) {
    case 'idle':
      return (
        <span className="status-dot idle" style={{ width: size, height: size }}>
          <svg width={size} height={size} viewBox="0 0 10 10">
            <circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </span>
      );
    case 'running':
      return <SpinnerIcon size={size} className="status-dot running" />;
    case 'pass':
      return (
        <span className="status-dot pass" style={{ width: size, height: size }}>
          <svg width={size} height={size} viewBox="0 0 10 10">
            <circle cx="5" cy="5" r="4" fill="currentColor" />
          </svg>
        </span>
      );
    case 'fail':
      return (
        <span className="status-dot fail" style={{ width: size, height: size }}>
          <svg width={size} height={size} viewBox="0 0 10 10">
            <line x1="2" y1="2" x2="8" y2="8" stroke="currentColor" strokeWidth="2" />
            <line x1="8" y1="2" x2="2" y2="8" stroke="currentColor" strokeWidth="2" />
          </svg>
        </span>
      );
    default:
      return null;
  }
}

// Individual health check button with tooltip
interface HealthButtonProps {
  label: string;
  state: CheckState;
  onClick: () => void;
  onRerun: () => void;
}

function HealthButton({ label, state, onClick, onRerun }: HealthButtonProps) {
  const [showTooltip, setShowTooltip] = useState(false);

  const tooltipContent = () => {
    if (!state.result) {
      return 'Never run';
    }
    return (
      <>
        <div>Last ran: {formatRelativeTime(state.result.lastRun)}</div>
        <div>Duration: {formatDuration(state.result.durationMs)}</div>
      </>
    );
  };

  return (
    <div
      className="health-button-wrapper"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <button
        className={`health-button ${state.status}`}
        onClick={onClick}
        disabled={state.status === 'running'}
        title={state.status === 'fail' ? 'Click to view errors' : `Run ${label.toLowerCase()}`}
      >
        <StatusDot status={state.status} size={10} />
        <span>{label}</span>
      </button>

      {/* Re-run button for failed checks */}
      {state.status === 'fail' && (
        <button
          className="health-rerun"
          onClick={(e) => {
            e.stopPropagation();
            onRerun();
          }}
          title="Re-run check"
        >
          <svg
            width={10}
            height={10}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
          </svg>
        </button>
      )}

      {showTooltip && <div className="health-tooltip">{tooltipContent()}</div>}
    </div>
  );
}

// Error detail modal
interface HealthErrorModalProps {
  category: ScriptCategory;
  result: HealthCheckResult;
  onClose: () => void;
  onCopy: () => void;
  onAskClaude: () => void;
  onRerun: () => void;
}

function HealthErrorModal({
  category,
  result,
  onClose,
  onCopy,
  onAskClaude,
  onRerun,
}: HealthErrorModalProps) {
  const output = result.stdout || result.stderr;

  return (
    <div className="health-modal-overlay" onClick={onClose}>
      <div className="health-modal" onClick={(e) => e.stopPropagation()}>
        <div className="health-modal-header">
          <div className="health-modal-title">
            <StatusDot status="fail" size={16} />
            <span>{CATEGORY_LABELS[category]} Check Failed</span>
          </div>
          <button className="health-modal-close" onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="health-modal-content">
          <pre className="health-modal-output">{output || 'No output'}</pre>
        </div>

        <div className="health-modal-footer">
          <div className="health-modal-meta">
            <span>Exit code: {result.exitCode}</span>
            <span>Duration: {formatDuration(result.durationMs)}</span>
          </div>
          <div className="health-modal-actions">
            <button className="health-modal-btn secondary" onClick={onCopy}>
              <CopyIcon size={12} />
              Copy Output
            </button>
            <button className="health-modal-btn secondary" onClick={onRerun}>
              Re-run
            </button>
            <button className="health-modal-btn primary" onClick={onAskClaude}>
              Ask Claude to Fix
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Package.json viewer modal
interface PackageJsonModalProps {
  content: string;
  onClose: () => void;
  onCopy: () => void;
}

function PackageJsonModal({ content, onClose, onCopy }: PackageJsonModalProps) {
  // Try to format the JSON nicely
  let formattedContent = content;
  try {
    const parsed: unknown = JSON.parse(content);
    formattedContent = JSON.stringify(parsed, null, 2);
  } catch {
    // If parsing fails, use the raw content
  }

  return (
    <div className="health-modal-overlay" onClick={onClose}>
      <div className="health-modal health-modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="health-modal-header">
          <div className="health-modal-title health-modal-title-neutral">
            <FileIcon size={16} />
            <span>package.json</span>
          </div>
          <button className="health-modal-close" onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="health-modal-content">
          <pre className="health-modal-output health-modal-json">{formattedContent}</pre>
        </div>

        <div className="health-modal-footer">
          <div className="health-modal-meta">
            <span>Read-only view</span>
          </div>
          <div className="health-modal-actions">
            <button className="health-modal-btn secondary" onClick={onCopy}>
              <CopyIcon size={12} />
              Copy
            </button>
            <button className="health-modal-btn primary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Suggestions modal for adding missing scripts
interface SuggestionsModalProps {
  suggestions: ScriptSuggestion[];
  onClose: () => void;
  onCopy: (text: string) => void;
  onAskClaude?: (suggestions: ScriptSuggestion[]) => void;
}

function SuggestionsModal({ suggestions, onClose, onCopy, onAskClaude }: SuggestionsModalProps) {
  return (
    <div className="health-modal-overlay" onClick={onClose}>
      <div className="health-modal" onClick={(e) => e.stopPropagation()}>
        <div className="health-modal-header">
          <div className="health-modal-title health-modal-title-neutral">
            <svg
              width={16}
              height={16}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <span>Suggested Scripts</span>
          </div>
          <button className="health-modal-close" onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="health-modal-content">
          <p className="health-suggestions-intro">
            The following packages are installed but don't have corresponding scripts in your
            package.json. Add these scripts to enable health checks:
          </p>
          <div className="health-suggestions-list">
            {suggestions.map((suggestion, index) => (
              <div key={index} className="health-suggestion-item">
                <div className="health-suggestion-header">
                  <span className="health-suggestion-category">
                    {CATEGORY_LABELS[suggestion.category]}
                  </span>
                  <span className="health-suggestion-reason">{suggestion.reason}</span>
                </div>
                <div className="health-suggestion-script">
                  <code>
                    "{suggestion.scriptName}": "{suggestion.scriptCommand}"
                  </code>
                  <button
                    className="health-suggestion-copy"
                    onClick={() =>
                      onCopy(`"${suggestion.scriptName}": "${suggestion.scriptCommand}"`)
                    }
                    title="Copy to clipboard"
                  >
                    <CopyIcon size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="health-modal-footer">
          <div className="health-modal-meta">
            <span>Add these to your package.json "scripts" section</span>
          </div>
          <div className="health-modal-actions">
            <button className="health-modal-btn secondary" onClick={onClose}>
              Close
            </button>
            {onAskClaude && (
              <button className="health-modal-btn primary" onClick={() => onAskClaude(suggestions)}>
                Ask Claude to Add
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
