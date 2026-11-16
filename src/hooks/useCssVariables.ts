/**
 * Variables editor controller — the project's CSS custom properties as a design-tokens
 * panel. Custom properties are defined on stylesheet rules and referenced via `var(--…)`,
 * so this is scoped to the PROJECT, not the selected element.
 *
 * Editing a token is **live + auto-saved**: the change previews on its exact live
 * selector when that source rule can be identified unambiguously, then is written to
 * source via `set_css_variable` (debounced, surgical). The source identity travels with
 * the preview so duplicate names in different scopes stay independent.
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

function toastText(err: unknown): string {
  return formatCommandError(asCommandError(err));
}

const SAVE_DEBOUNCE_MS = 500;

function saveKey(variable: Pick<VariableRow, 'file' | 'selector' | 'line' | 'name'>): string {
  return `${variable.file}\0${variable.selector}\0${variable.line}\0${variable.name}`;
}

export interface VariableRow extends CssVariableDef {
  /** This file/selector/line/name identity uniquely identifies one source definition. */
  editable: boolean;
}

/** Stable identity for a definition; names alone are not unique across source rules. */
export function cssVariableId(variable: Pick<VariableRow, 'file' | 'selector' | 'line' | 'name'>) {
  return `${variable.file}\0${variable.selector}\0${variable.line}\0${variable.name}`;
}

function cssVariableMessageIdentity(
  variable: Pick<VariableRow, 'file' | 'selector' | 'line' | 'name'>
) {
  return {
    key: cssVariableId(variable),
    file: variable.file,
    selector: variable.selector,
    line: variable.line,
    name: variable.name,
  };
}

function cssVariableSource(variable: Pick<VariableRow, 'file' | 'selector' | 'line'>): string {
  return `${variable.file}\0${variable.selector}\0${variable.line}`;
}

interface Params {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  projectPath: string;
  enabled: boolean;
  onToast: (message: string, type?: 'success' | 'error' | 'info') => void;
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
      const definitionCounts = new Map<string, number>();
      for (const definition of defs) {
        const id = cssVariableId(definition);
        definitionCounts.set(id, (definitionCounts.get(id) ?? 0) + 1);
      }
      setVariables(
        defs.map((definition) => ({
          ...definition,
          // A repeated file/selector/line/name identity cannot safely distinguish
          // same-line duplicate declarations, so keep those values read-only.
          editable: definitionCounts.get(cssVariableId(definition)) === 1,
        }))
      );
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
      // Commit the preview by its definition identity. The iframe clears only an
      // inline fallback; an exact stylesheet rule already contains the saved value.
      post({
        type: 'ss:clearVar',
        identity: cssVariableMessageIdentity(variable),
        commit: true,
      });
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
    const pending = Object.values(pendingValues.current);
    for (const { variable } of pending) {
      post({ type: 'ss:clearVar', identity: cssVariableMessageIdentity(variable) });
    }
    Object.values(saveTimers.current).forEach(clearTimeout);
    saveTimers.current = {};
    pendingValues.current = {};
  }, [post]);

  /** Edit one scoped token: optimistic state + exact preview + debounced source save. */
  const setValue = useCallback(
    (variable: VariableRow, value: string) => {
      setVariables((prev) =>
        prev.map((v) => (saveKey(v) === saveKey(variable) ? { ...v, value } : v))
      );
      post({
        type: 'ss:setVar',
        identity: cssVariableMessageIdentity(variable),
        value,
      });
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
        onToast('No stylesheet found to add the variable to.', 'info');
        return;
      }
      try {
        await addCssVariable(projectPath, file, name, value);
        const identity = {
          key: `pending\0${file}\0:root\0${name}`,
          file,
          selector: ':root',
          line: null,
          name,
        };
        post({
          type: 'ss:setVar',
          identity,
          value,
        });
        // Keep a source-rule preview if HMR has loaded it; otherwise clear only
        // the temporary :root inline fallback after the source write.
        post({
          type: 'ss:clearVar',
          identity,
          commit: true,
        });
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
        for (const variable of variables) {
          if (variable.name === name) {
            post({ type: 'ss:clearVar', identity: cssVariableMessageIdentity(variable) });
          }
        }
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
    [
      discardPendingSaves,
      flushPendingSaves,
      projectPath,
      onToast,
      onVariableDeleted,
      post,
      reload,
      variables,
    ]
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
