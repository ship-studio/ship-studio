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
  type CssRuleSourceIdentity,
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
  /** Physical host-file line for the keyframes prelude. */
  line?: number;
  body: RuleBody;
}

interface Params {
  projectPath: string;
  enabled: boolean;
  onToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

export function useCssAnimations({ projectPath, enabled, onToast }: Params) {
  const [animations, setAnimations] = useState<AnimationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const baselineRef = useRef<Record<string, string>>({});
  const identityRef = useRef<Record<string, CssRuleSourceIdentity>>({});
  const fileRef = useRef<Record<string, string>>({});
  const bodiesRef = useRef<Record<string, RuleBody>>({});
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const projectPathRef = useRef(projectPath);
  const requestIdRef = useRef(0);
  const refreshIdRef = useRef(0);
  projectPathRef.current = projectPath;

  const reload = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    const requestedProject = projectPath;
    setLoading(true);
    try {
      const sels = (await listCssSelectors(projectPath)).filter(isKeyframesSelector);
      if (requestIdRef.current !== requestId || projectPathRef.current !== requestedProject) return;
      if (sels.length === 0) {
        setAnimations([]);
        baselineRef.current = {};
        identityRef.current = {};
        fileRef.current = {};
        bodiesRef.current = {};
        return;
      }
      const locs = await locateCssRules(
        projectPath,
        sels.map((selector) => ({ selector, mediaText: null, href: null }))
      );
      const rows: AnimationRow[] = [];
      sels.forEach((selector, i) => {
        const loc = locs[i];
        if (loc && loc.status === 'resolved' && loc.source_identity) {
          const body = parseRuleBody(loc.inner_text);
          rows.push({
            selector,
            name: keyframesName(selector),
            file: loc.file,
            line: loc.line,
            body,
          });
          baselineRef.current[selector] = loc.inner_text;
          identityRef.current[selector] = loc.source_identity;
          fileRef.current[selector] = loc.file;
          bodiesRef.current[selector] = body;
        }
      });
      if (requestIdRef.current !== requestId || projectPathRef.current !== requestedProject) return;
      setAnimations(rows);
    } catch (err) {
      logger.error('[CssAnimations] load failed', {
        error: formatCommandError(asCommandError(err)),
      });
      onToast(toastText(err), 'error');
    } finally {
      if (requestIdRef.current === requestId && projectPathRef.current === requestedProject) {
        setLoading(false);
      }
    }
  }, [projectPath, onToast]);

  /** Re-pin unchanged keyframe siblings after a sheet write invalidates their
   *  whole-file source snapshot. Dirty bodies only adopt a fresh identity when
   *  their source body is still byte-for-byte the baseline they were loaded from. */
  const refreshIdentities = useCallback(
    async (file: string, keepSelector?: string) => {
      const requestedProject = projectPath;
      const requestId = ++refreshIdRef.current;
      try {
        const selectors = (await listCssSelectors(requestedProject)).filter(isKeyframesSelector);
        const locations = await locateCssRules(
          requestedProject,
          selectors.map((selector) => ({ selector, mediaText: null, href: null }))
        );
        if (projectPathRef.current !== requestedProject || refreshIdRef.current !== requestId) {
          return;
        }
        selectors.forEach((selector, index) => {
          if (selector === keepSelector) return;
          const location = locations[index];
          const oldBaseline = baselineRef.current[selector];
          if (
            location?.status === 'resolved' &&
            location.source_identity &&
            location.file === file &&
            oldBaseline === location.inner_text
          ) {
            identityRef.current[selector] = location.source_identity;
            fileRef.current[selector] = location.file;
          }
        });
      } catch {
        // A later save with the old snapshot fails closed and asks for a reload.
      }
    },
    [projectPath]
  );

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
      const sourceIdentity = identityRef.current[selector];
      if (!body || !file || oldInner === undefined || !sourceIdentity) return;
      const requestedProject = projectPath;
      const newInner = serializeRuleBody(body);
      if (newInner === oldInner) return;
      try {
        const identity = await applyCssRuleText(
          projectPath,
          file,
          selector,
          null,
          oldInner,
          newInner,
          sourceIdentity
        );
        if (projectPathRef.current !== requestedProject) return;
        baselineRef.current[selector] = identity.innerText;
        identityRef.current[selector] = identity;
        void refreshIdentities(file, selector);
        void trackEvent('visual_edit_saved', { kind: 'keyframes', mode: 'css-code' });
      } catch (err) {
        logger.error('[CssAnimations] save failed', {
          error: formatCommandError(asCommandError(err)),
        });
        onToast(toastText(err), 'error');
      }
    },
    [projectPath, onToast, refreshIdentities]
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
        onToast('No stylesheet found to add the animation to.', 'info');
        return;
      }
      try {
        const identity = await createCssRule(projectPath, file, selector);
        if (projectPathRef.current !== projectPath) return;
        const body: RuleBody = { items: [] };
        baselineRef.current[selector] = identity.innerText;
        identityRef.current[selector] = identity;
        fileRef.current[selector] = file;
        bodiesRef.current[selector] = body;
        setAnimations((prev) => [...prev, { selector, name, file, body }]);
        void refreshIdentities(file, selector);
        void trackEvent('visual_edit_saved', { kind: 'keyframes', mode: 'css-code' });
      } catch (err) {
        logger.error('[CssAnimations] create failed', {
          error: formatCommandError(asCommandError(err)),
        });
        onToast(toastText(err), 'error');
      }
    },
    [projectPath, animations, onToast, refreshIdentities]
  );

  /** Rename an animation (`@keyframes apply` → `@keyframes fade`). References on
   *  elements (`animation: apply`) aren't rewritten — update those separately. */
  const rename = useCallback(
    async (oldSelector: string, newName: string) => {
      const file = fileRef.current[oldSelector];
      const oldInner = baselineRef.current[oldSelector];
      const sourceIdentity = identityRef.current[oldSelector];
      if (!file || oldInner === undefined || !sourceIdentity) return;
      const name = newName.trim().replace(/^@(-[a-z]+-)?keyframes\s+/i, '');
      if (!name) return;
      const newSelector = `@keyframes ${name}`;
      if (newSelector === oldSelector) return;
      if (animations.some((a) => a.selector === newSelector)) {
        onToast(`An animation named “${name}” already exists.`, 'error');
        return;
      }
      try {
        const nextIdentity = await renameCssSelector(
          projectPath,
          file,
          oldSelector,
          null,
          oldInner,
          newSelector,
          sourceIdentity
        );
        if (projectPathRef.current !== projectPath) return;
        // Re-key the per-animation refs onto the new selector.
        baselineRef.current[newSelector] = nextIdentity.innerText;
        identityRef.current[newSelector] = nextIdentity;
        fileRef.current[newSelector] = file;
        const body = bodiesRef.current[oldSelector];
        if (body) bodiesRef.current[newSelector] = body;
        delete baselineRef.current[oldSelector];
        delete identityRef.current[oldSelector];
        delete fileRef.current[oldSelector];
        delete bodiesRef.current[oldSelector];
        setAnimations((prev) =>
          prev.map((a) => (a.selector === oldSelector ? { ...a, selector: newSelector, name } : a))
        );
        void refreshIdentities(file, newSelector);
        void trackEvent('visual_edit_saved', { kind: 'keyframes', mode: 'css-code' });
      } catch (err) {
        logger.error('[CssAnimations] rename failed', {
          error: formatCommandError(asCommandError(err)),
        });
        onToast(toastText(err), 'error');
      }
    },
    [projectPath, animations, onToast, refreshIdentities]
  );

  const remove = useCallback(
    async (selector: string) => {
      const file = fileRef.current[selector];
      const identity = identityRef.current[selector];
      if (!file || !identity) return;
      clearTimeout(saveTimers.current[selector]);
      try {
        await deleteCssRule(
          projectPath,
          file,
          selector,
          null,
          baselineRef.current[selector] ?? '',
          identity
        );
        if (projectPathRef.current !== projectPath) return;
        setAnimations((prev) => prev.filter((a) => a.selector !== selector));
        delete bodiesRef.current[selector];
        delete baselineRef.current[selector];
        delete identityRef.current[selector];
        void refreshIdentities(file);
        void trackEvent('visual_edit_saved', { kind: 'keyframes', mode: 'css-code' });
      } catch (err) {
        logger.error('[CssAnimations] delete failed', {
          error: formatCommandError(asCommandError(err)),
        });
        onToast(toastText(err), 'error');
      }
    },
    [projectPath, onToast, refreshIdentities]
  );

  return { animations, loading, setBody, create, rename, remove, reload };
}
