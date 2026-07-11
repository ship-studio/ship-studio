/**
 * Animations editor controller — the project's `@keyframes` rules. Like variables,
 * animations are stylesheet-global (a named animation referenced from elements via
 * `animation`), so this is scoped to the PROJECT, not the selected element.
 *
 * Each `@keyframes` rule's body is the structured `RuleBody` model (its keyframe steps
 * as nested rules), edited through the same cards as the cascade editor. Edits are
 * auto-saved to source via `apply_css_rule_text` (debounced, drift-guarded). Live CSSOM
 * preview of a keyframes block isn't meaningful on its own (it only renders once an
 * element references it), so changes reflect on the next HMR reload.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listCssSelectors,
  locateCssRules,
  applyCssRuleText,
  createCssRule,
  deleteCssRule,
  renameCssSelector,
  listStylesheets,
} from '../lib/cssCascade';
import { parseRuleBody, serializeRuleBody, type RuleBody } from '../lib/cssBody';
import { isKeyframesSelector } from '../lib/cssStructures';
import { logger } from '../lib/logger';
import { trackEvent } from '../lib/analytics';
import { asCommandError, formatCommandError } from '../lib/errors';

function toastText(err: unknown): string {
  return formatCommandError(asCommandError(err));
}

const SAVE_DEBOUNCE_MS = 600;

/** `@keyframes reveal` / `@-webkit-keyframes reveal` → `reveal`. */
function keyframesName(selector: string): string {
  return selector
    .trim()
    .replace(/^@(-[a-z]+-)?keyframes\s+/i, '')
    .trim();
}

export interface AnimationRow {
  /** Full prelude (`@keyframes reveal`). */
  selector: string;
  /** Just the animation name (`reveal`). */
  name: string;
  file: string;
  body: RuleBody;
}

interface Params {
  projectPath: string;
  enabled: boolean;
  onToast: (message: string, type?: 'success' | 'error') => void;
}

export function useCssAnimations({ projectPath, enabled, onToast }: Params) {
  const [animations, setAnimations] = useState<AnimationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const baselineRef = useRef<Record<string, string>>({});
  const fileRef = useRef<Record<string, string>>({});
  const bodiesRef = useRef<Record<string, RuleBody>>({});
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const sels = (await listCssSelectors(projectPath)).filter(isKeyframesSelector);
      if (sels.length === 0) {
        setAnimations([]);
        return;
      }
      const locs = await locateCssRules(
        projectPath,
        sels.map((selector) => ({ selector, mediaText: null, href: null }))
      );
      const rows: AnimationRow[] = [];
      sels.forEach((selector, i) => {
        const loc = locs[i];
        if (loc && loc.status === 'resolved') {
          const body = parseRuleBody(loc.inner_text);
          rows.push({ selector, name: keyframesName(selector), file: loc.file, body });
          baselineRef.current[selector] = loc.inner_text;
          fileRef.current[selector] = loc.file;
          bodiesRef.current[selector] = body;
        }
      });
      setAnimations(rows);
    } catch (err) {
      logger.error('[CssAnimations] load failed', { error: String(err) });
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

  const saveAnimation = useCallback(
    async (selector: string) => {
      const body = bodiesRef.current[selector];
      const file = fileRef.current[selector];
      const oldInner = baselineRef.current[selector];
      if (!body || !file || oldInner === undefined) return;
      const newInner = serializeRuleBody(body);
      if (newInner === oldInner) return;
      try {
        await applyCssRuleText(projectPath, file, selector, null, oldInner, newInner);
        baselineRef.current[selector] = newInner;
        void trackEvent('visual_style_saved', { mode: 'css-code', keyframes: true });
      } catch (err) {
        logger.error('[CssAnimations] save failed', { error: String(err) });
        onToast(toastText(err), 'error');
      }
    },
    [projectPath, onToast]
  );

  /** Update one animation's body model → debounced auto-save. */
  const setBody = useCallback(
    (selector: string, body: RuleBody) => {
      bodiesRef.current[selector] = body;
      setAnimations((prev) => prev.map((a) => (a.selector === selector ? { ...a, body } : a)));
      clearTimeout(saveTimers.current[selector]);
      saveTimers.current[selector] = setTimeout(
        () => void saveAnimation(selector),
        SAVE_DEBOUNCE_MS
      );
    },
    [saveAnimation]
  );

  /** Create a new `@keyframes <name>` and add it optimistically (empty, ready to fill). */
  const create = useCallback(
    async (rawName: string) => {
      const name = rawName.trim().replace(/^@(-[a-z]+-)?keyframes\s+/i, '');
      if (!name) return;
      const selector = `@keyframes ${name}`;
      if (animations.some((a) => a.selector === selector)) return;
      let file: string | undefined = animations[0]?.file;
      if (!file) {
        try {
          file = (await listStylesheets(projectPath))[0];
        } catch {
          file = undefined;
        }
      }
      if (!file) {
        onToast('No stylesheet found to add the animation to.', 'error');
        return;
      }
      try {
        await createCssRule(projectPath, file, selector);
        const body: RuleBody = { items: [] };
        baselineRef.current[selector] = '\n';
        fileRef.current[selector] = file;
        bodiesRef.current[selector] = body;
        setAnimations((prev) => [...prev, { selector, name, file, body }]);
        void trackEvent('visual_style_saved', { mode: 'css-code', keyframes_added: true });
      } catch (err) {
        logger.error('[CssAnimations] create failed', { error: String(err) });
        onToast(toastText(err), 'error');
      }
    },
    [projectPath, animations, onToast]
  );

  /** Rename an animation (`@keyframes apply` → `@keyframes fade`). References on
   *  elements (`animation: apply`) aren't rewritten — update those separately. */
  const rename = useCallback(
    async (oldSelector: string, newName: string) => {
      const file = fileRef.current[oldSelector];
      const oldInner = baselineRef.current[oldSelector];
      if (!file || oldInner === undefined) return;
      const name = newName.trim().replace(/^@(-[a-z]+-)?keyframes\s+/i, '');
      if (!name) return;
      const newSelector = `@keyframes ${name}`;
      if (newSelector === oldSelector) return;
      if (animations.some((a) => a.selector === newSelector)) {
        onToast(`An animation named “${name}” already exists.`, 'error');
        return;
      }
      try {
        await renameCssSelector(projectPath, file, oldSelector, null, oldInner, newSelector);
        // Re-key the per-animation refs onto the new selector.
        baselineRef.current[newSelector] = oldInner;
        fileRef.current[newSelector] = file;
        const body = bodiesRef.current[oldSelector];
        if (body) bodiesRef.current[newSelector] = body;
        delete baselineRef.current[oldSelector];
        delete fileRef.current[oldSelector];
        delete bodiesRef.current[oldSelector];
        setAnimations((prev) =>
          prev.map((a) => (a.selector === oldSelector ? { ...a, selector: newSelector, name } : a))
        );
        void trackEvent('visual_style_saved', { mode: 'css-code', keyframes_renamed: true });
      } catch (err) {
        logger.error('[CssAnimations] rename failed', { error: String(err) });
        onToast(toastText(err), 'error');
      }
    },
    [projectPath, animations, onToast]
  );

  const remove = useCallback(
    async (selector: string) => {
      const file = fileRef.current[selector];
      if (!file) return;
      clearTimeout(saveTimers.current[selector]);
      try {
        await deleteCssRule(projectPath, file, selector, null, baselineRef.current[selector] ?? '');
        setAnimations((prev) => prev.filter((a) => a.selector !== selector));
        delete bodiesRef.current[selector];
        delete baselineRef.current[selector];
        void trackEvent('visual_style_saved', { mode: 'css-code', keyframes_deleted: true });
      } catch (err) {
        logger.error('[CssAnimations] delete failed', { error: String(err) });
        onToast(toastText(err), 'error');
      }
    },
    [projectPath, onToast]
  );

  return { animations, loading, setBody, create, rename, remove, reload };
}
