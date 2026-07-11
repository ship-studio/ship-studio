/**
 * Element Settings controller — backs the "Settings" tab of the cascade editor
 * (Stacki's Style/Settings split). Edits the selected element's MARKUP rather than
 * its CSS:
 *   - CLASSES: add/remove via the className resolver/editor (`lib/edit`), with a
 *     live `ss:mutate` so the page updates immediately. Fully editable.
 *   - TAG / ATTRIBUTES: read from the element's source HTML (`lib/edit-html`) and
 *     shown for reference. (Editing tag/attributes is a fast-follow — markup
 *     rewrites need care.)
 *
 * Security: messages are posted only to the preview iframe's own contentWindow. The
 * `'*'` target origin is deliberate — the preview's origin is a per-project
 * `http://localhost:<port>` and is `about:blank` between refreshes, so a fixed origin
 * would silently drop messages. The trust boundary that matters is INBOUND: the in-iframe
 * script (`select_script.html`) ignores `message` events whose source isn't its parent, so
 * a foreign page loaded in the preview can't drive edits.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  resolveClassnameSource,
  applyClassnameEdit,
  applyClassnameEditMulti,
  insertClassAttr,
  type ElementSignature,
} from '../lib/edit';
import { resolveElementHtml, applyElementHtml } from '../lib/edit-html';
import { setAttribute as setAttrInHtml } from '../lib/htmlAttrs';
import { logger } from '../lib/logger';
import { trackEvent } from '../lib/analytics';
import { asCommandError, formatCommandError } from '../lib/errors';

function toastText(err: unknown): string {
  return formatCommandError(asCommandError(err));
}

export interface ElementAttr {
  name: string;
  value: string;
}

export interface ElementSettings {
  tag: string;
  classes: string[];
  attributes: ElementAttr[];
  addClass: (name: string) => void;
  removeClass: (name: string) => void;
  /** Set or add an attribute on the element's opening tag (written to source). */
  setAttribute: (name: string, value: string) => void;
  /** Rename an attribute's key, preserving its value (one source write). */
  renameAttribute: (oldName: string, newName: string, value: string) => void;
  removeAttribute: (name: string) => void;
  /** Whether the element resolved to editable source markup (attributes editable). */
  canEditAttributes: boolean;
  /** The element's resolved markup location in source (file + 1-based line), if known. */
  location: { file: string; line: number } | null;
  busy: boolean;
}

/** Parse the attributes of an element's opening tag (excluding `class`, which the
 *  CLASSES editor owns). Best-effort, string/quote aware via a global regex. */
function parseAttributes(html: string): ElementAttr[] {
  const open = /^<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(html.trim());
  if (!open) return [];
  const attrsPart = open[2];
  const re = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  const out: ElementAttr[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrsPart)) !== null) {
    const name = m[1];
    if (name.toLowerCase() === 'class') continue;
    out.push({ name, value: m[2] ?? m[3] ?? m[4] ?? '' });
  }
  return out;
}

interface Params {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  projectPath: string;
  enabled: boolean;
  signature: ElementSignature | null;
  onToast: (message: string, type?: 'success' | 'error') => void;
}

export function useElementSettings({
  iframeRef,
  projectPath,
  enabled,
  signature,
  onToast,
}: Params): ElementSettings {
  const [classes, setClasses] = useState<string[]>([]);
  const [attributes, setAttributes] = useState<ElementAttr[]>([]);
  const [canEditAttributes, setCanEditAttributes] = useState(false);
  const [busy, setBusy] = useState(false);
  // The element's resolved markup location in source (file + 1-based line), for "Copy id".
  const [location, setLocation] = useState<{ file: string; line: number } | null>(null);

  const sigRef = useRef<ElementSignature | null>(signature);
  sigRef.current = signature;
  // The element's current source markup (drift-guard baseline for attribute writes).
  const htmlRef = useRef<string | null>(null);
  const tag = signature?.tagName ?? '';

  const post = useCallback(
    (msg: unknown) => iframeRef.current?.contentWindow?.postMessage(msg, '*'),
    [iframeRef]
  );

  // Seed classes from the signature; resolve the element's markup for attributes.
  useEffect(() => {
    if (!enabled || !signature) {
      setClasses([]);
      setAttributes([]);
      setCanEditAttributes(false);
      setLocation(null);
      htmlRef.current = null;
      return;
    }
    setClasses(signature.className.split(/\s+/).filter(Boolean));
    let cancelled = false;
    void resolveElementHtml(projectPath, signature)
      .then((res) => {
        if (cancelled) return;
        htmlRef.current = res.html;
        setAttributes(parseAttributes(res.html));
        setCanEditAttributes(true);
        setLocation({ file: res.file, line: res.line });
      })
      .catch(() => {
        if (cancelled) return;
        htmlRef.current = null;
        setAttributes([]);
        setCanEditAttributes(false);
        setLocation(null);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, projectPath, signature]);

  /** Set/add/remove (value === null) an attribute on the element's opening tag,
   *  drift-guarded against the resolved markup, then refresh the local list. */
  const applyAttr = useCallback(
    async (name: string, value: string | null) => {
      const sig = sigRef.current;
      const oldHtml = htmlRef.current;
      if (!sig || oldHtml == null) {
        onToast("Can't edit this element's attributes in source.", 'error');
        return;
      }
      const newHtml = setAttrInHtml(oldHtml, name, value);
      if (newHtml == null || newHtml === oldHtml) return;
      setBusy(true);
      try {
        await applyElementHtml(projectPath, sig, oldHtml, newHtml);
        htmlRef.current = newHtml;
        setAttributes(parseAttributes(newHtml));
        void trackEvent('visual_style_saved', { mode: 'css-code', attr_edit: true });
      } catch (err) {
        logger.error('[ElementSettings] attribute edit failed', { error: String(err) });
        onToast(toastText(err), 'error');
      } finally {
        setBusy(false);
      }
    },
    [projectPath, onToast]
  );

  /** Rename an attribute's key (remove old + add new in ONE source write so it never
   *  flickers a half-renamed tag), preserving the value. */
  const renameAttr = useCallback(
    async (oldName: string, newName: string, value: string) => {
      const sig = sigRef.current;
      const oldHtml = htmlRef.current;
      const n = newName.trim();
      if (!sig || oldHtml == null) {
        onToast("Can't edit this element's attributes in source.", 'error');
        return;
      }
      if (!n || n === oldName) return;
      const without = setAttrInHtml(oldHtml, oldName, null) ?? oldHtml;
      const newHtml = setAttrInHtml(without, n, value);
      if (newHtml == null || newHtml === oldHtml) return;
      setBusy(true);
      try {
        await applyElementHtml(projectPath, sig, oldHtml, newHtml);
        htmlRef.current = newHtml;
        setAttributes(parseAttributes(newHtml));
        void trackEvent('visual_style_saved', { mode: 'css-code', attr_edit: true });
      } catch (err) {
        logger.error('[ElementSettings] attribute rename failed', { error: String(err) });
        onToast(toastText(err), 'error');
      } finally {
        setBusy(false);
      }
    },
    [projectPath, onToast]
  );

  /** Rewrite the element's `class` attribute in source (and live in the preview). */
  const writeClassAttr = useCallback(
    async (nextClass: string): Promise<boolean> => {
      const sig = sigRef.current;
      if (!sig) return false;
      const res = await resolveClassnameSource(projectPath, sig);
      if (res.status !== 'resolved' && res.status !== 'multi') {
        onToast("Can't edit this element's classes in source — change them in code.", 'error');
        return false;
      }
      const prev = res.class_name;
      if (nextClass === prev) return true;
      post({ type: 'ss:suppressReload' });
      if (res.status === 'resolved') {
        await applyClassnameEdit(projectPath, res.file, res.line, prev, nextClass);
      } else {
        await applyClassnameEditMulti(projectPath, res.locations, prev, nextClass);
      }
      const nextSig = { ...sig, className: nextClass };
      sigRef.current = nextSig;
      post({ type: 'ss:mutate', className: nextClass, rules: [] });
      post({ type: 'ss:commit' });
      return true;
    },
    [projectPath, onToast, post]
  );

  /** Add the FIRST class to an element that has none: there's no class literal in
   *  source to resolve or replace, so the backend INSERTS a fresh class attribute
   *  on the element's open tag (located by ancestor/text anchoring). On success,
   *  proceed exactly like a successful `writeClassAttr` (live mutate + commit). */
  const insertFirstClass = useCallback(
    async (name: string): Promise<boolean> => {
      const sig = sigRef.current;
      if (!sig) return false;
      post({ type: 'ss:suppressReload' });
      await insertClassAttr(projectPath, sig, name);
      sigRef.current = { ...sig, className: name };
      post({ type: 'ss:mutate', className: name, rules: [] });
      post({ type: 'ss:commit' });
      return true;
    },
    [projectPath, post]
  );

  const addClass = useCallback(
    async (name: string) => {
      const n = name.trim().replace(/^\./, '');
      if (!n || classes.includes(n)) return;
      setBusy(true);
      try {
        const next = [...classes, n];
        // No existing classes → insert a fresh attribute; otherwise rewrite the
        // existing literal. Failures throw with the backend's specific reason.
        const written =
          classes.length === 0 ? await insertFirstClass(n) : await writeClassAttr(next.join(' '));
        if (written) {
          setClasses(next);
          void trackEvent('visual_class_added', { mode: 'css-code' });
        }
      } catch (err) {
        logger.error('[ElementSettings] add class failed', { error: String(err) });
        onToast(toastText(err), 'error');
      } finally {
        setBusy(false);
      }
    },
    [classes, writeClassAttr, insertFirstClass, onToast]
  );

  const removeClass = useCallback(
    async (name: string) => {
      setBusy(true);
      try {
        const next = classes.filter((c) => c !== name);
        if (await writeClassAttr(next.join(' '))) {
          setClasses(next);
          void trackEvent('visual_class_removed', { mode: 'css-code' });
        }
      } catch (err) {
        logger.error('[ElementSettings] remove class failed', { error: String(err) });
        onToast(toastText(err), 'error');
      } finally {
        setBusy(false);
      }
    },
    [classes, writeClassAttr, onToast]
  );

  return {
    tag,
    classes,
    attributes,
    addClass: (n) => void addClass(n),
    removeClass: (n) => void removeClass(n),
    setAttribute: (name, value) => void applyAttr(name, value),
    renameAttribute: (oldName, newName, value) => void renameAttr(oldName, newName, value),
    removeAttribute: (name) => void applyAttr(name, null),
    canEditAttributes,
    location,
    busy,
  };
}
