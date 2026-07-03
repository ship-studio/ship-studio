/**
 * Hook for managing code health check state and execution.
 *
 * Handles script detection, check running, auto-run timer,
 * persisted results, and package.json viewing.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  DetectedScripts,
  HealthCheckResult,
  ScriptCategory,
  detectHealthScripts,
  runHealthScript,
  getHealthStatus,
  getPackageJson,
  formatDuration,
  getFixPrompt,
} from '../lib/health';
import { logger } from '../lib/logger';
import { asCommandError, formatCommandError } from '../lib/errors';

export type CheckStatus = 'idle' | 'running' | 'pass' | 'fail' | 'missing';

export interface CheckState {
  status: CheckStatus;
  result: HealthCheckResult | null;
  scriptName: string | null;
}

export const CATEGORIES: ScriptCategory[] = ['test', 'lint', 'typecheck', 'format'];
export const CATEGORY_LABELS: Record<ScriptCategory, string> = {
  test: 'Test',
  lint: 'Lint',
  typecheck: 'Types',
  format: 'Format',
};

const AUTO_RUN_INTERVAL_SECONDS = 15 * 60;

interface UseCodeHealthParams {
  projectPath: string;
  onToast?: (message: string, type?: 'success' | 'error') => void;
  onAskClaude?: (prompt: string) => void;
  onHealthOutput?: (output: string) => void;
}

export function useCodeHealth({
  projectPath,
  onToast,
  onAskClaude,
  onHealthOutput,
}: UseCodeHealthParams) {
  const [detectedScripts, setDetectedScripts] = useState<DetectedScripts | null>(null);
  const [checkStates, setCheckStates] = useState<Record<ScriptCategory, CheckState>>({
    test: { status: 'idle', result: null, scriptName: null },
    lint: { status: 'idle', result: null, scriptName: null },
    typecheck: { status: 'idle', result: null, scriptName: null },
    format: { status: 'idle', result: null, scriptName: null },
  });
  const [errorModalCategory, setErrorModalCategory] = useState<ScriptCategory | null>(null);
  const [isRunningAll, setIsRunningAll] = useState(false);
  const runAllAbortRef = useRef(false);
  const [showPackageJson, setShowPackageJson] = useState(false);
  const [packageJsonContent, setPackageJsonContent] = useState<string | null>(null);
  const [isLoadingPackageJson, setIsLoadingPackageJson] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Auto-run state
  const [isAutoRunEnabled, setIsAutoRunEnabled] = useState(false);
  const [autoRunSecondsRemaining, setAutoRunSecondsRemaining] = useState(AUTO_RUN_INTERVAL_SECONDS);
  const autoRunIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoRunTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRunStartRef = useRef<number>(0);

  // Helper to emit output to logs
  const emitOutput = useCallback(
    (message: string) => {
      if (onHealthOutput) {
        onHealthOutput(message);
      }
    },
    [onHealthOutput]
  );

  // Load/refresh scripts and persisted status
  const loadScriptsAndStatus = useCallback(async () => {
    if (!projectPath) return;

    try {
      const scripts = await detectHealthScripts(projectPath);
      setDetectedScripts(scripts);

      const newStates: Record<ScriptCategory, CheckState> = {
        test: {
          status: scripts.test ? 'idle' : 'missing',
          result: null,
          scriptName: scripts.test,
        },
        lint: {
          status: scripts.lint ? 'idle' : 'missing',
          result: null,
          scriptName: scripts.lint,
        },
        typecheck: {
          status: scripts.typecheck ? 'idle' : 'missing',
          result: null,
          scriptName: scripts.typecheck,
        },
        format: {
          status: scripts.format ? 'idle' : 'missing',
          result: null,
          scriptName: scripts.format,
        },
      };

      const savedStatus = await getHealthStatus(projectPath);
      if (savedStatus) {
        for (const category of CATEGORIES) {
          const result = savedStatus[category];
          if (result && newStates[category].scriptName) {
            newStates[category].status = result.status === 'pass' ? 'pass' : 'fail';
            newStates[category].result = result;
          }
        }
      }

      setCheckStates(newStates);
    } catch (e) {
      logger.error('Failed to detect health scripts', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, [projectPath]);

  // Detect scripts on mount and when project changes
  useEffect(() => {
    void loadScriptsAndStatus();
  }, [loadScriptsAndStatus]);

  // Refresh scripts (called after Claude modifies package.json)
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await loadScriptsAndStatus();
    setIsRefreshing(false);
    onToast?.('Scripts refreshed', 'success');
  }, [loadScriptsAndStatus, onToast]);

  const runCheck = useCallback(
    async (category: ScriptCategory): Promise<'pass' | 'fail' | undefined> => {
      const scriptName = checkStates[category].scriptName;
      if (!scriptName || !projectPath) return undefined;

      setCheckStates((prev) => ({
        ...prev,
        [category]: { ...prev[category], status: 'running' },
      }));

      const timestamp = new Date().toLocaleTimeString();
      emitOutput(
        `\x1b[90m[${timestamp}]\x1b[0m Running \x1b[36m${CATEGORY_LABELS[category]}\x1b[0m check (${scriptName})...\r\n`
      );

      try {
        const result = await runHealthScript(projectPath, category, scriptName);

        setCheckStates((prev) => ({
          ...prev,
          [category]: {
            ...prev[category],
            status: result.status === 'pass' ? 'pass' : 'fail',
            result,
          },
        }));

        const duration = formatDuration(result.durationMs);
        if (result.status === 'pass') {
          emitOutput(
            `\x1b[32m✓\x1b[0m ${CATEGORY_LABELS[category]} passed \x1b[90m(${duration})\x1b[0m\r\n`
          );
          onToast?.(`${CATEGORY_LABELS[category]} passed`, 'success');
          return 'pass';
        } else {
          emitOutput(
            `\x1b[31m✕\x1b[0m ${CATEGORY_LABELS[category]} failed \x1b[90m(${duration})\x1b[0m\r\n`
          );
          const output = result.stdout || result.stderr;
          if (output) {
            emitOutput(`\x1b[90m───────────────────────────────────────\x1b[0m\r\n`);
            emitOutput(output.replace(/\n/g, '\r\n'));
            if (!output.endsWith('\n')) {
              emitOutput('\r\n');
            }
            emitOutput(`\x1b[90m───────────────────────────────────────\x1b[0m\r\n`);
          }
          onToast?.(`${CATEGORY_LABELS[category]} failed`, 'error');
          return 'fail';
        }
      } catch (e) {
        const message = formatCommandError(asCommandError(e));
        emitOutput(`\x1b[31m✕\x1b[0m ${CATEGORY_LABELS[category]} error: ${message}\r\n`);
        setCheckStates((prev) => ({
          ...prev,
          [category]: {
            ...prev[category],
            status: 'fail',
            result: {
              status: 'fail',
              lastRun: new Date().toISOString(),
              durationMs: 0,
              stdout: '',
              stderr: message,
              exitCode: 1,
              scriptName,
              category,
            },
          },
        }));
        onToast?.(`${CATEGORY_LABELS[category]} failed: ${message}`, 'error');
        return 'fail';
      }
    },
    [checkStates, projectPath, onToast, emitOutput]
  );

  const runAllChecks = useCallback(async () => {
    runAllAbortRef.current = false;
    setIsRunningAll(true);

    const availableCategories = CATEGORIES.filter(
      (cat) => checkStates[cat].scriptName && checkStates[cat].status !== 'missing'
    );

    if (availableCategories.length > 0) {
      emitOutput(`\r\n\x1b[1m━━━ Running All Health Checks ━━━\x1b[0m\r\n\r\n`);
    }

    let localPassed = 0;
    let localFailed = 0;

    for (const category of availableCategories) {
      if (runAllAbortRef.current) break;
      const result = await runCheck(category);
      if (result === 'pass') {
        localPassed++;
      } else if (result === 'fail') {
        localFailed++;
      }
    }

    if (availableCategories.length > 0 && !runAllAbortRef.current) {
      emitOutput(`\r\n\x1b[1m━━━ Health Checks Complete ━━━\x1b[0m\r\n`);
      if (localFailed > 0) {
        emitOutput(`\x1b[31m${localFailed} failed\x1b[0m, ${localPassed} passed\r\n\r\n`);
      } else {
        emitOutput(`\x1b[32mAll ${localPassed} checks passed\x1b[0m\r\n\r\n`);
      }
    }

    setIsRunningAll(false);
  }, [checkStates, runCheck, emitOutput]);

  // Auto-run timer effect: uses a setTimeout for the actual trigger
  // and a 30-second interval to update the countdown display (instead of every 1s)
  useEffect(() => {
    if (isAutoRunEnabled) {
      autoRunStartRef.current = Date.now();
      setAutoRunSecondsRemaining(AUTO_RUN_INTERVAL_SECONDS);

      // Schedule the actual check execution
      const scheduleRun = () => {
        autoRunTimeoutRef.current = setTimeout(() => {
          void runAllChecks();
          // Reset for next cycle
          autoRunStartRef.current = Date.now();
          setAutoRunSecondsRemaining(AUTO_RUN_INTERVAL_SECONDS);
          scheduleRun();
        }, AUTO_RUN_INTERVAL_SECONDS * 1000);
      };
      scheduleRun();

      // Update countdown display every 30 seconds
      autoRunIntervalRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - autoRunStartRef.current) / 1000);
        const remaining = Math.max(0, AUTO_RUN_INTERVAL_SECONDS - elapsed);
        setAutoRunSecondsRemaining(remaining);
      }, 30000);
    } else {
      if (autoRunTimeoutRef.current) {
        clearTimeout(autoRunTimeoutRef.current);
        autoRunTimeoutRef.current = null;
      }
      if (autoRunIntervalRef.current) {
        clearInterval(autoRunIntervalRef.current);
        autoRunIntervalRef.current = null;
      }
      setAutoRunSecondsRemaining(AUTO_RUN_INTERVAL_SECONDS);
    }

    return () => {
      if (autoRunTimeoutRef.current) {
        clearTimeout(autoRunTimeoutRef.current);
        autoRunTimeoutRef.current = null;
      }
      if (autoRunIntervalRef.current) {
        clearInterval(autoRunIntervalRef.current);
        autoRunIntervalRef.current = null;
      }
    };
  }, [isAutoRunEnabled, runAllChecks]);

  // Format seconds as MM:SS
  const formatCountdown = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleAutoRunToggle = useCallback(() => {
    setIsAutoRunEnabled((prev) => !prev);
    if (!isAutoRunEnabled) {
      onToast?.('Auto-run enabled (every 15 min)', 'success');
    }
  }, [isAutoRunEnabled, onToast]);

  const handleButtonClick = useCallback(
    (category: ScriptCategory) => {
      const state = checkStates[category];
      if (state.status === 'running' || state.status === 'missing') return;

      if (state.status === 'fail' && state.result) {
        setErrorModalCategory(category);
      } else {
        void runCheck(category);
      }
    },
    [checkStates, runCheck]
  );

  const handleAskClaude = useCallback(
    (category: ScriptCategory) => {
      const result = checkStates[category].result;
      if (!result) return;

      const prompt = `${getFixPrompt(category)}\n\n${result.stdout || result.stderr}`;
      onAskClaude?.(prompt);
      setErrorModalCategory(null);
    },
    [checkStates, onAskClaude]
  );

  const handleShowPackageJson = useCallback(async () => {
    if (!projectPath) return;

    setIsLoadingPackageJson(true);
    try {
      const content = await getPackageJson(projectPath);
      setPackageJsonContent(content);
      setShowPackageJson(true);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      onToast?.(`Failed to load package.json: ${message}`, 'error');
    } finally {
      setIsLoadingPackageJson(false);
    }
  }, [projectPath, onToast]);

  // Computed values
  const hasAnyScripts = CATEGORIES.some((cat) => checkStates[cat].scriptName);
  const showHealthPanel = detectedScripts?.hasPackageJson && hasAnyScripts;
  const passingCount = CATEGORIES.filter((cat) => checkStates[cat].status === 'pass').length;
  const failingCount = CATEGORIES.filter((cat) => checkStates[cat].status === 'fail').length;
  const notRunCount = CATEGORIES.filter(
    (cat) => checkStates[cat].status === 'idle' && checkStates[cat].scriptName
  ).length;
  const isAnyRunning = CATEGORIES.some((cat) => checkStates[cat].status === 'running');

  return {
    // State
    detectedScripts,
    checkStates,
    errorModalCategory,
    setErrorModalCategory,
    isRunningAll,
    showPackageJson,
    setShowPackageJson,
    packageJsonContent,
    isLoadingPackageJson,
    showSuggestions,
    setShowSuggestions,
    isRefreshing,
    isAutoRunEnabled,
    autoRunSecondsRemaining,

    // Handlers
    runCheck,
    runAllChecks,
    loadScriptsAndStatus,
    handleRefresh,
    handleAutoRunToggle,
    handleButtonClick,
    handleAskClaude,
    handleShowPackageJson,
    formatCountdown,

    // Computed
    showHealthPanel,
    passingCount,
    failingCount,
    notRunCount,
    isAnyRunning,
  };
}
