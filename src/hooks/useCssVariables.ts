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

function saveKey(variable: Pick<VariableRow, 'file' | 'line' | 'name'>): string {
  return `${variable.file}\0${variable.line}\0${variable.name}`;
}

export interface VariableRow extends CssVariableDef {
  /** Editable when defined on `:root` (the common, unambiguous case). */
  editable: boolean;
}

interface Params {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  projectPath: string;
  enabled: boolean;
  onToast: (message: string, type?: 'success' | 'error') => void;
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
    return () => Object.values(timers).forEach(clearTimeout);
  }, []);

  /** Edit a `:root` token's value: optimistic state + instant preview + debounced save. */
  const setValue = useCallback(
    (variable: VariableRow, value: string) => {
      setVariables((prev) =>
        prev.map((v) => (saveKey(v) === saveKey(variable) ? { ...v, value } : v))
      );
      post({ type: 'ss:setVar', name: variable.name, value });
      const key = saveKey(variable);
      clearTimeout(saveTimers.current[key]);
      saveTimers.current[key] = setTimeout(async () => {
        try {
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
        } catch (err) {
          logger.error('[CssVariables] save failed', {
            error: formatCommandError(asCommandError(err)),
          });
          onToast(toastText(err), 'error');
        }
      }, SAVE_DEBOUNCE_MS);
    },
    [projectPath, onToast, post]
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
        onToast('No stylesheet found to add the variable to.', 'error');
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
      try {
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
        logger.error('[CssVariables] delete failed', {
          error: formatCommandError(asCommandError(err)),
        });
        onToast(toastText(err), 'error');
        throw err;
      }
    },
    [projectPath, onToast, onVariableDeleted, post, reload]
  );

  return {
    variables,
    loading,
    setValue,
    addVariable,
    analyzeDeletion,
    deleteVariable,
    reload,
  };
}
