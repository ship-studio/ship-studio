/**
 * Variables editor controller — the project's CSS custom properties as a design-tokens
 * panel. Custom properties are stylesheet-global (defined on `:root`, referenced via
 * `var(--…)`), so this is scoped to the PROJECT, not the selected element.
 *
 * Editing a `:root` token is **live + auto-saved**: the change previews instantly in the
 * iframe (`ss:setVar`, which sets the property on the live `:root` rule) and is written
 * to source via `set_css_variable` (debounced, surgical). Tokens scoped to other
 * selectors are surfaced read-only (we don't guess which scope you meant to edit).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getCssVariables, type CssVariableDef } from '../lib/cssCascade';
import {
  addCssVariable,
  analyzeCssVariableDeletion,
  deleteCssVariable,
  setCssVariable,
  reorderCssVariables,
  listStylesheets,
  type CssVariableDeleteImpact,
} from '../lib/edit-css';
import { logger } from '../lib/logger';
import { trackEvent } from '../lib/analytics';
import { asCommandError, formatCommandError } from '../lib/errors';
import type { ToastOptions } from './useToasts';

function toastText(err: unknown): string {
  return formatCommandError(asCommandError(err));
}

const SAVE_DEBOUNCE_MS = 500;

function saveKey(variable: Pick<VariableRow, 'file' | 'line' | 'name'>): string {
  return `${variable.file}\0${variable.line}\0${variable.name}`;
}

export interface VariableRow extends CssVariableDef {
  /** Editable when defined on `:root` (the common, unambiguous case). */
  editable: boolean;
}

/** Stable identity for a definition; names alone are not unique across source rules. */
export function cssVariableId(variable: Pick<VariableRow, 'file' | 'selector' | 'line' | 'name'>) {
  return `${variable.file}\0${variable.selector}\0${variable.line}\0${variable.name}`;
}

function cssVariableSource(variable: Pick<VariableRow, 'file' | 'selector' | 'line'>): string {
  return `${variable.file}\0${variable.selector}\0${variable.line}`;
}

interface Params {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  projectPath: string;
  enabled: boolean;
  onToast: (message: string, type?: 'success' | 'error', options?: ToastOptions) => void;
  /** Keep the Visual Editor's unsaved/live class state in sync with source rewrites. */
  onVariableDeleted?: (name: string, value: string) => void;
}

export function useCssVariables({
  iframeRef,
  projectPath,
  enabled,
  onToast,
  onVariableDeleted,
}: Params) {
  const [variables, setVariables] = useState<VariableRow[]>([]);
  const [loading, setLoading] = useState(false);
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pendingValues = useRef<Record<string, { variable: VariableRow; value: string }>>({});
  const saveWorkers = useRef<Partial<Record<string, Promise<void>>>>({});

  const post = useCallback(
    (msg: unknown) => iframeRef.current?.contentWindow?.postMessage(msg, '*'),
    [iframeRef]
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const defs = await getCssVariables(projectPath);
      setVariables(defs.map((v) => ({ ...v, editable: v.selector === ':root' })));
    } catch (err) {
      logger.error('[CssVariables] load failed', {
        error: formatCommandError(asCommandError(err)),
      });
      onToast(toastText(err), 'error');
    } finally {
      setLoading(false);
    }
  }, [projectPath, onToast]);

  useEffect(() => {
    if (!enabled) return;
    void reload();
  }, [enabled, reload]);

  useEffect(() => {
    const timers = saveTimers.current;
    return () => {
      Object.values(timers).forEach(clearTimeout);
      pendingValues.current = {};
    };
  }, []);

  const persistValue = useCallback(
    async (variable: VariableRow, value: string) => {
      await setCssVariable(
        projectPath,
        variable.file,
        variable.selector,
        variable.line,
        variable.name,
        value
      );
      // Drop any inline fallback so the source value takes over once HMR injects it.
      post({ type: 'ss:clearVar', name: variable.name });
      void trackEvent('visual_edit_saved', { kind: 'variable', mode: 'css-code' });
    },
    [post, projectPath]
  );

  const runSaveWorker = useCallback(
    async (key: string) => {
      // One worker owns each source definition. If another edit arrives while
      // a write is in flight, it remains pending and is written only after the
      // current write settles, so an older value can never land after a newer one.
      for (;;) {
        const pending = pendingValues.current[key];
        if (!pending) return;
        try {
          await persistValue(pending.variable, pending.value);
        } catch (err) {
          // Keep the failed value pending so a later edit can retry it. The
          // rejection is also surfaced to flushPendingSaves, which blocks a
          // reorder from being written on top of an unsaved value.
          logger.error('[CssVariables] save failed', {
            error: formatCommandError(asCommandError(err)),
          });
          onToast(toastText(err), 'error');
          throw err;
        }
        if (pendingValues.current[key] === pending) delete pendingValues.current[key];
      }
    },
    [onToast, persistValue]
  );

  const ensureSaveWorker = useCallback(
    (key: string) => {
      if (saveWorkers.current[key]) return;
      const worker = runSaveWorker(key);
      saveWorkers.current[key] = worker;
      // Keep the original promise in saveWorkers so flush can observe a
      // rejection, while consuming the settlement side-effect's rejection to
      // avoid an unhandled promise warning for ordinary debounced saves.
      const clearWorker = () => {
        if (saveWorkers.current[key] === worker) delete saveWorkers.current[key];
      };
      void worker.then(clearWorker, clearWorker);
    },
    [runSaveWorker]
  );

  /** Flush debounced and in-flight value writes before changing declaration order. */
  const flushPendingSaves = useCallback(async () => {
    for (;;) {
      for (const [key] of Object.entries(pendingValues.current)) {
        clearTimeout(saveTimers.current[key]);
        delete saveTimers.current[key];
        ensureSaveWorker(key);
      }
      const waits = Object.values(saveWorkers.current).filter(
        (worker): worker is Promise<void> => worker !== undefined
      );
      if (waits.length === 0) {
        if (Object.keys(pendingValues.current).length === 0) return;
        continue;
      }
      const results = await Promise.allSettled(waits);
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      );
      if (failure) throw failure.reason;
      if (
        Object.keys(pendingValues.current).length === 0 &&
        Object.keys(saveWorkers.current).length === 0
      ) {
        return;
      }
    }
  }, [ensureSaveWorker]);

  const discardPendingSaves = useCallback(() => {
    const pendingNames = new Set(
      Object.values(pendingValues.current).map(({ variable }) => variable.name)
    );
    for (const name of pendingNames) post({ type: 'ss:clearVar', name });
    Object.values(saveTimers.current).forEach(clearTimeout);
    saveTimers.current = {};
    pendingValues.current = {};
  }, [post]);

  /** Edit a `:root` token's value: optimistic state + instant preview + debounced save. */
  const setValue = useCallback(
    (variable: VariableRow, value: string) => {
      setVariables((prev) =>
        prev.map((v) => (saveKey(v) === saveKey(variable) ? { ...v, value } : v))
      );
      post({ type: 'ss:setVar', name: variable.name, value });
      const key = saveKey(variable);
      pendingValues.current[key] = { variable, value };
      clearTimeout(saveTimers.current[key]);
      saveTimers.current[key] = setTimeout(() => {
        delete saveTimers.current[key];
        ensureSaveWorker(key);
      }, SAVE_DEBOUNCE_MS);
    },
    [ensureSaveWorker, post]
  );

  /** Reorder declarations within one exact source rule, with optimistic state. */
  const reorderVariables = useCallback(
    async (ordered: VariableRow[]) => {
      if (ordered.length === 0) return;
      const source = cssVariableSource(ordered[0]);
      if (ordered.some((variable) => cssVariableSource(variable) !== source)) {
        onToast('Variables can only be reordered within one :root rule.', 'error');
        await reload();
        return;
      }
      const sourceVariable = ordered[0];
      setVariables((prev) => {
        const byId = new Map(ordered.map((variable) => [cssVariableId(variable), variable]));
        let nextIndex = 0;
        return prev.map((variable) => {
          if (cssVariableSource(variable) !== source) return variable;
          const replacement = ordered[nextIndex++];
          return replacement && byId.has(cssVariableId(replacement)) ? replacement : variable;
        });
      });

      try {
        await flushPendingSaves();
      } catch {
        // The worker already logged and toasted the failed value save. Reload
        // the source of truth and do not reorder against an unknown value.
        discardPendingSaves();
        await reload();
        return;
      }
      try {
        await reorderCssVariables(
          projectPath,
          sourceVariable.file,
          sourceVariable.selector,
          sourceVariable.line,
          ordered.map(({ name, file, selector, line }) => ({ name, file, selector, line }))
        );
        void trackEvent('visual_edit_saved', { kind: 'variable', mode: 'css-code' });
      } catch (err) {
        logger.error('[CssVariables] reorder failed', {
          error: formatCommandError(asCommandError(err)),
        });
        onToast(toastText(err), 'error');
        await reload();
      }
    },
    [discardPendingSaves, flushPendingSaves, onToast, projectPath, reload]
  );

  /** Add a new `--token: value` to `:root` (creating the `:root` rule if needed). */
  const addVariable = useCallback(
    async (rawName: string, value: string) => {
      const name = rawName.trim().startsWith('--') ? rawName.trim() : `--${rawName.trim()}`;
      if (name === '--' || variables.some((v) => v.name === name && v.selector === ':root')) return;
      let file = variables.find((v) => v.selector === ':root')?.file;
      if (!file) {
        try {
          file = (await listStylesheets(projectPath))[0];
        } catch {
          file = undefined;
        }
      }
      if (!file) {
        // A project state the user can act on, not a malfunction (issue #1015).
        onToast('No stylesheet found to add the variable to.', 'error', { expected: true });
        return;
      }
      try {
        await addCssVariable(projectPath, file, name, value);
        post({ type: 'ss:setVar', name, value });
        void trackEvent('visual_edit_saved', { kind: 'variable', mode: 'css-code' });
        await reload();
      } catch (err) {
        logger.error('[CssVariables] add failed', {
          error: formatCommandError(asCommandError(err)),
        });
        onToast(toastText(err), 'error');
      }
    },
    [projectPath, variables, onToast, post, reload]
  );

  const analyzeDeletion = useCallback(
    async (name: string, value: string) => {
      try {
        return await analyzeCssVariableDeletion(projectPath, name, value);
      } catch (err) {
        logger.error('[CssVariables] delete analysis failed', {
          error: formatCommandError(asCommandError(err)),
        });
        onToast(toastText(err), 'error');
        throw err;
      }
    },
    [projectPath, onToast]
  );

  const deleteVariable = useCallback(
    async (name: string, value: string, impact: CssVariableDeleteImpact) => {
      for (const key of Object.keys(saveTimers.current)) {
        if (!key.endsWith(`\0${name}`)) continue;
        clearTimeout(saveTimers.current[key]);
        delete saveTimers.current[key];
      }
      let pendingSaveError: unknown = null;
      try {
        // A just-edited value must reach source before the definition is
        // removed; otherwise the in-flight value write could resurrect stale
        // source text after the deletion.
        try {
          await flushPendingSaves();
        } catch (err) {
          pendingSaveError = err;
          discardPendingSaves();
          await reload();
          throw err;
        }
        const result = await deleteCssVariable(projectPath, name, value, impact);
        onVariableDeleted?.(name, value);
        post({ type: 'ss:clearVar', name });
        void trackEvent('visual_edit_saved', { kind: 'variable', mode: 'css-code' });
        await reload();
        onToast(
          `Deleted ${name} and updated ${result.usageCount} ${result.usageCount === 1 ? 'usage' : 'usages'}.`,
          'success'
        );
        return result;
      } catch (err) {
        // A pending value worker already logged and toasted its own failure;
        // avoid presenting the same error a second time from deletion.
        if (err !== pendingSaveError) {
          logger.error('[CssVariables] delete failed', {
            error: formatCommandError(asCommandError(err)),
          });
          onToast(toastText(err), 'error');
        }
        throw err;
      }
    },
    [discardPendingSaves, flushPendingSaves, projectPath, onToast, onVariableDeleted, post, reload]
  );

  return {
    variables,
    loading,
    setValue,
    addVariable,
    analyzeDeletion,
    deleteVariable,
    reorderVariables,
    reload,
  };
}
