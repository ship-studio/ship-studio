/**
 * Element Settings controller — backs the "Settings" tab of the cascade editor
 * (Stacki's Style/Settings split). Edits the selected element's MARKUP rather than
 * its CSS:
 *   - CLASSES: add/remove via the className resolver/editor (`lib/edit`), with a
 *     live `ss:mutate` so the page updates immediately. Fully editable.
 *   - TEXT: resolves a direct static source text run, displays decoded text, and
 *     writes entity-escaped user input through the guarded text editor API.
 *   - TAG / ATTRIBUTES: read from and surgically update resolved source markup;
 *     tag changes replace only the paired source tag names.
 *
 * Security: messages are posted only to the preview iframe's own contentWindow. The
 * `'*'` target origin is deliberate — the preview's origin is a per-project
 * `http://localhost:<port>` and is `about:blank` between refreshes, so a fixed origin
 * would silently drop messages. The trust boundary that matters is INBOUND: the in-iframe
 * script (`select_script.html`) ignores `message` events whose source isn't its parent, so
 * a foreign page loaded in the preview can't drive edits.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  resolveClassnameSource,
  applyClassnameEdit,
  applyClassnameEditMulti,
  insertClassAttr,
  resolveTextSource,
  applyTextEdit,
  type ElementSignature,
} from '../lib/edit';
import { resolveElementHtml, applyElementHtml, type ElementSourceAnchor } from '../lib/edit-html';
import { setAttribute as setAttrInHtml } from '../lib/htmlAttrs';
import {
  compatibleMarkupTags,
  decodeTextEntities,
  directTextReason,
  encodeDirectTextForSource,
  replaceMarkupTagName,
  type MarkupTagOption,
} from '../lib/edit-markup';
import { logger } from '../lib/logger';
import { trackEvent } from '../lib/analytics';
import { asCommandError, formatCommandError } from '../lib/errors';
import { isExpectedStructuralRefusal } from './useElementStructure';

function toastText(err: unknown): string {
  return formatCommandError(asCommandError(err));
}

/**
 * Log a settings-write failure at the right level, then toast it.
 *
 * The backend refuses by design when it can't tell which element in source the
 * user clicked (`edit.rs`'s classname-resolution ladder: "Couldn't tell which
 * <img> in source to add the class to…"). Those messages are already accurate
 * and actionable, so they must not reach the bug pipeline — `logger.error` and
 * an 'error' toast would both file one on every occurrence (issue #818, same
 * distinction `useElementStructure` makes in #402/#723).
 */
function reportSettingsFailure(
  what: string,
  err: unknown,
  onToast: (message: string, type?: 'success' | 'error' | 'info') => void
): void {
  const message = toastText(err);
  const expected = isExpectedStructuralRefusal(message);
  if (expected) {
    logger.warn(`[ElementSettings] ${what} refused`, { error: message });
  } else {
    logger.error(`[ElementSettings] ${what} failed`, { error: message });
  }
  onToast(message, expected ? 'info' : 'error');
}

export interface ElementAttr {
  name: string;
  value: string;
  /** True when this JSX/templating value is an expression rather than a literal. */
  isExpression?: boolean;
}

export interface ElementSettings {
  /** Stable identity for resetting Settings drafts when preview selection changes. */
  selectionKey: string;
  tag: string;
  tagOptions: MarkupTagOption[];
  canEditTag: boolean;
  setTag: (tag: string) => Promise<boolean>;
  classes: string[];
  attributes: ElementAttr[];
  text: string;
  textReason: string | null;
  canEditText: boolean;
  setText: (text: string) => Promise<boolean>;
  addClass: (name: string) => void;
  renameClass: (oldName: string, newName: string) => void;
  removeClass: (name: string) => void;
  /** Set or add an attribute on the element's opening tag (written to source). */
  setAttribute: (name: string, value: string | null) => Promise<boolean>;
  /** Rename an attribute's key, preserving its value (one source write). */
  renameAttribute: (oldName: string, newName: string, value: string) => void;
  removeAttribute: (name: string) => void;
  /** Whether the element resolved to editable source markup (attributes editable). */
  canEditAttributes: boolean;
  /** State of the selected element's source markup lookup. */
  sourceMarkupStatus: 'idle' | 'resolving' | 'resolved' | 'unavailable';
  /** Why image attribute writes are disabled, when source targeting is unsafe. */
  imageAttributeEditBlockReason?: 'ambiguous' | 'spread' | 'mismatch' | null;
  /** The element's resolved markup location in source (file + 1-based line), if known. */
  location: { file: string; line: number } | null;
  busy: boolean;
}

function skipAttributeExpression(source: string, at: number): number | null {
  let depth = 1;
  let index = at + 1;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') index += 2;
        else if (source[index] === quote) {
          index += 1;
          break;
        } else index += 1;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2);
      if (close < 0) return null;
      index = close + 2;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return null;
}

/** Parse literal opening-tag attributes, ignoring spreads and excluding class
 *  names (which the CLASSES editor owns). Values stay source-backed as written. */
function parseAttributes(html: string): ElementAttr[] {
  const source = html.trim();
  const open = /^<[a-zA-Z][\w:-]*/.exec(source);
  if (!open) return [];
  let index = open[0].length;
  const out: ElementAttr[] = [];
  while (index < source.length) {
    while (/\s/.test(source[index] ?? '')) index += 1;
    if (index >= source.length || source[index] === '>' || source[index] === '/') break;
    if (source[index] === '{') {
      const after = skipAttributeExpression(source, index);
      if (after === null) break;
      index = after;
      continue;
    }

    const nameStart = index;
    while (index < source.length && !/[\s=/>]/.test(source[index])) index += 1;
    if (index === nameStart) {
      index += 1;
      continue;
    }
    const name = source.slice(nameStart, index);
    while (/\s/.test(source[index] ?? '')) index += 1;
    let value = '';
    let isExpression = false;
    if (source[index] === '=') {
      index += 1;
      while (/\s/.test(source[index] ?? '')) index += 1;
      const quote = source[index];
      if (quote === '"' || quote === "'") {
        const start = ++index;
        while (index < source.length) {
          if (source[index] === '\\') index += 2;
          else if (source[index] === quote) break;
          else index += 1;
        }
        value = source.slice(start, index);
        if (source[index] === quote) index += 1;
      } else if (source[index] === '{') {
        const start = index;
        const after = skipAttributeExpression(source, index);
        if (after === null) break;
        value = source.slice(start, after);
        isExpression = true;
        index = after;
      } else {
        const start = index;
        while (index < source.length && !/[\s>]/.test(source[index])) index += 1;
        value = source.slice(start, index);
      }
    }
    if (!['class', 'classname'].includes(name.toLowerCase()))
      out.push(isExpression ? { name, value, isExpression } : { name, value });
  }
  return out;
}

/** True when a spread could supply any image attribute, which this editor cannot
 *  inspect or safely preserve during an attribute write. */
function hasAttributeSpread(html: string): boolean {
  const source = html.trim();
  const open = /^<[a-zA-Z][\w:-]*/.exec(source);
  if (!open) return true;
  let index = open[0].length;
  while (index < source.length) {
    while (/\s/.test(source[index] ?? '')) index += 1;
    if (index >= source.length || source[index] === '>' || source[index] === '/') return false;
    if (source[index] === '{') {
      const start = index;
      const after = skipAttributeExpression(source, index);
      if (after === null) return true;
      if (
        source
          .slice(start + 1, after - 1)
          .trimStart()
          .startsWith('...')
      )
        return true;
      index = after;
      continue;
    }
    const nameStart = index;
    while (index < source.length && !/[\s=/>]/.test(source[index])) index += 1;
    if (index === nameStart) return true;
    while (/\s/.test(source[index] ?? '')) index += 1;
    if (source[index] !== '=') continue;
    index += 1;
    while (/\s/.test(source[index] ?? '')) index += 1;
    const quote = source[index];
    if (quote === '"' || quote === "'") {
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') index += 2;
        else if (source[index] === quote) {
          index += 1;
          break;
        } else index += 1;
      }
    } else if (source[index] === '{') {
      const after = skipAttributeExpression(source, index);
      if (after === null) return true;
      index = after;
    } else {
      while (index < source.length && !/[\s>]/.test(source[index])) index += 1;
    }
  }
  return true;
}

function ancestorTags(signature: ElementSignature): string[] {
  return signature.elementPath?.slice(0, -1).map((item) => item.tagName) ?? [];
}

interface Params {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  projectPath: string;
  enabled: boolean;
  signature: ElementSignature | null;
  onToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

export function useElementSettings({
  iframeRef,
  projectPath,
  enabled,
  signature,
  onToast,
}: Params): ElementSettings {
  const selectionKey = signature
    ? JSON.stringify({
        domPath: signature.domPath,
        elementPath: signature.elementPath?.map((item) => item.domPath),
        sourceFile: signature.sourceFile,
        sourceLine: signature.sourceLine,
        sourceColumn: signature.sourceColumn,
        tagName: signature.tagName,
        className: signature.className,
        text: signature.text,
        attrSrc: signature.attrSrc,
        attrAlt: signature.attrAlt,
        attrWidth: signature.attrWidth,
        attrHeight: signature.attrHeight,
        attrLoading: signature.attrLoading,
      })
    : '';
  const [classes, setClasses] = useState<string[]>([]);
  const [attributes, setAttributes] = useState<ElementAttr[]>([]);
  const [canEditAttributes, setCanEditAttributes] = useState(false);
  const [sourceMarkupStatus, setSourceMarkupStatus] = useState<
    'idle' | 'resolving' | 'resolved' | 'unavailable'
  >('idle');
  const [imageAttributeEditBlockReason, setImageAttributeEditBlockReason] = useState<
    'ambiguous' | 'spread' | 'mismatch' | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [tag, setTagValue] = useState(signature?.tagName ?? '');
  const [tagOptions, setTagOptions] = useState<MarkupTagOption[]>([]);
  const [canEditTag, setCanEditTag] = useState(false);
  const [text, setTextValue] = useState('');
  const [textReason, setTextReason] = useState<string | null>(null);
  const [canEditText, setCanEditText] = useState(false);
  // The element's resolved markup location in source (file + 1-based line), for "Copy id".
  const [location, setLocation] = useState<{ file: string; line: number } | null>(null);

  const sigRef = useRef<ElementSignature | null>(signature);
  // Preview-only iframe updates create a fresh signature object. Keep the latest
  // selection available to writes without restarting source resolution unless
  // its source-relevant selection key changes.
  useLayoutEffect(() => {
    sigRef.current = signature;
  }, [signature]);
  // The element's current source markup (drift-guard baseline for attribute writes).
  const htmlRef = useRef<string | null>(null);
  const imageSourceAnchorRef = useRef<ElementSourceAnchor | null>(null);
  const imageAttributeEditBlockRef = useRef<'ambiguous' | 'spread' | 'mismatch' | null>(null);
  const textTargetRef = useRef<{
    file: string;
    line: number;
    column: number;
    text: string;
  } | null>(null);
  const selectionTokenRef = useRef(0);
  const writeLockRef = useRef(false);

  const post = useCallback(
    (msg: unknown) => iframeRef.current?.contentWindow?.postMessage(msg, '*'),
    [iframeRef]
  );

  const beginWrite = useCallback(() => {
    if (writeLockRef.current) return false;
    writeLockRef.current = true;
    setBusy(true);
    return true;
  }, []);

  const endWrite = useCallback(() => {
    writeLockRef.current = false;
    setBusy(false);
  }, []);

  // Seed the selected source and its two independent safe edit resolutions. A
  // generation token prevents a slow resolver for the previous selection from
  // overwriting the current element's text, tag options, or write baseline.
  useEffect(() => {
    const token = ++selectionTokenRef.current;
    const selectedSignature = sigRef.current;
    if (!enabled || !selectedSignature) {
      setClasses([]);
      setAttributes([]);
      setCanEditAttributes(false);
      setSourceMarkupStatus('idle');
      setImageAttributeEditBlockReason(null);
      imageAttributeEditBlockRef.current = null;
      setLocation(null);
      setTagValue('');
      setTagOptions([]);
      setCanEditTag(false);
      setTextValue('');
      setTextReason(null);
      setCanEditText(false);
      htmlRef.current = null;
      imageSourceAnchorRef.current = null;
      textTargetRef.current = null;
      return;
    }
    setTagValue(selectedSignature.tagName);
    setTagOptions([{ tag: selectedSignature.tagName, label: selectedSignature.tagName }]);
    setCanEditTag(false);
    setClasses(selectedSignature.className.split(/\s+/).filter(Boolean));
    setAttributes([]);
    setCanEditAttributes(false);
    setSourceMarkupStatus('resolving');
    setImageAttributeEditBlockReason(null);
    imageAttributeEditBlockRef.current = null;
    setLocation(null);
    setTextValue('');
    setTextReason('Resolving selected text…');
    setCanEditText(false);
    htmlRef.current = null;
    imageSourceAnchorRef.current = null;
    textTargetRef.current = null;
    let cancelled = false;
    void resolveElementHtml(projectPath, selectedSignature)
      .then((res) => {
        if (cancelled || token !== selectionTokenRef.current) return;
        htmlRef.current = res.html;
        const sourceAttributes = parseAttributes(res.html);
        setAttributes(sourceAttributes);
        setSourceMarkupStatus('resolved');
        const sourceAttributeNames = new Set(
          sourceAttributes.map((attribute) => attribute.name.toLowerCase())
        );
        const renderedImageAttributes = [
          ['src', selectedSignature.attrSrc],
          ['alt', selectedSignature.attrAlt],
          ['width', selectedSignature.attrWidth],
          ['height', selectedSignature.attrHeight],
          ['loading', selectedSignature.attrLoading],
        ] as const;
        const hasUnmatchedRenderedAttribute = renderedImageAttributes.some(
          ([name, value]) => value != null && !sourceAttributeNames.has(name)
        );
        const imageBlockReason =
          selectedSignature.tagName.toLowerCase() === 'img'
            ? res.locations && res.locations.length > 1
              ? 'ambiguous'
              : hasAttributeSpread(res.html)
                ? 'spread'
                : hasUnmatchedRenderedAttribute
                  ? 'mismatch'
                  : null
            : null;
        imageAttributeEditBlockRef.current = imageBlockReason;
        setImageAttributeEditBlockReason(imageBlockReason);
        setCanEditAttributes(imageBlockReason === null);
        imageSourceAnchorRef.current =
          selectedSignature.tagName.toLowerCase() === 'img' &&
          imageBlockReason === null &&
          !res.locations?.length &&
          res.sourceStart != null &&
          res.sourceHash
            ? { file: res.file, sourceStart: res.sourceStart, sourceHash: res.sourceHash }
            : null;
        setLocation({ file: res.file, line: res.line });
        const options = compatibleMarkupTags(
          res.html,
          selectedSignature.tagName,
          ancestorTags(selectedSignature)
        );
        setTagOptions(options);
        setCanEditTag(options.length > 1);
      })
      .catch(() => {
        if (cancelled || token !== selectionTokenRef.current) return;
        htmlRef.current = null;
        imageSourceAnchorRef.current = null;
        setAttributes([]);
        setCanEditAttributes(false);
        setSourceMarkupStatus('unavailable');
        setImageAttributeEditBlockReason(null);
        imageAttributeEditBlockRef.current = null;
        setLocation(null);
        const options = compatibleMarkupTags(
          null,
          selectedSignature.tagName,
          ancestorTags(selectedSignature)
        );
        setTagOptions(options);
        setCanEditTag(false);
      });
    void resolveTextSource(projectPath, selectedSignature)
      .then((res) => {
        if (cancelled || token !== selectionTokenRef.current) return;
        if (res.status === 'resolved') {
          textTargetRef.current = {
            file: res.file,
            line: res.line,
            column: res.column,
            text: res.text,
          };
          setTextValue(decodeTextEntities(res.text));
          const unsafeReason = directTextReason(res.text);
          setTextReason(unsafeReason);
          setCanEditText(unsafeReason === null);
        } else {
          textTargetRef.current = null;
          setTextValue('');
          setTextReason(res.reason || 'This element has no safely editable static text.');
          setCanEditText(false);
        }
      })
      .catch(() => {
        if (cancelled || token !== selectionTokenRef.current) return;
        textTargetRef.current = null;
        setTextValue('');
        setTextReason('This element’s text could not be resolved in source.');
        setCanEditText(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, projectPath, selectionKey]);

  /** Set/add/remove (value === null) an attribute on the element's opening tag,
   *  drift-guarded against the resolved markup, then refresh the local list. */
  const applyAttr = useCallback(
    async (name: string, value: string | null): Promise<boolean> => {
      const sig = sigRef.current;
      const token = selectionTokenRef.current;
      const oldHtml = htmlRef.current;
      if (!sig || oldHtml == null) {
        onToast("Can't edit this element's attributes in source.", 'error');
        return false;
      }
      if (sig.tagName.toLowerCase() === 'img' && imageAttributeEditBlockRef.current) {
        onToast(
          imageAttributeEditBlockRef.current === 'ambiguous'
            ? 'This image appears in several source locations. Update it in code so only the intended image changes.'
            : imageAttributeEditBlockRef.current === 'spread'
              ? 'This image uses a spread attribute that may provide its values. Update it in code so its attributes stay in sync.'
              : 'The selected image’s rendered attributes do not match the source markup found. Update it in code so the intended image stays in sync.',
          'info'
        );
        return false;
      }
      if (name.toLowerCase() === 'src' && value !== null) {
        const oldAttributes = parseAttributes(oldHtml);
        const currentSrc = oldAttributes.find((attr) => attr.name.toLowerCase() === 'src');
        if (currentSrc?.isExpression) {
          onToast("This image source is set by code and can't be replaced here.", 'info');
          return false;
        }
        if (currentSrc?.value === value) return true;
        if (ancestorTags(sig).some((tag) => tag.toLowerCase() === 'picture')) {
          onToast(
            'This image is inside a <picture> element. Update it in code so responsive sources stay in sync.',
            'info'
          );
          return false;
        }
        if (hasAttributeSpread(oldHtml)) {
          onToast(
            'This image uses a spread attribute. Update its source in code so responsive images stay in sync.',
            'info'
          );
          return false;
        }
        const srcset = oldAttributes.find((attr) => attr.name.toLowerCase() === 'srcset');
        if (srcset?.isExpression) {
          onToast(
            'This image uses a code-generated srcset. Update the image source in code so its responsive sources stay in sync.',
            'info'
          );
          return false;
        }
      }
      let newHtml = setAttrInHtml(oldHtml, name, value);
      if (newHtml == null) return false;
      if (name.toLowerCase() === 'src' && value !== null) {
        const srcset = parseAttributes(oldHtml).find(
          (attr) => attr.name.toLowerCase() === 'srcset'
        );
        if (srcset) newHtml = setAttrInHtml(newHtml, 'srcset', null) ?? newHtml;
      }
      if (newHtml === oldHtml) return true;
      if (!beginWrite()) return false;
      try {
        if (name.toLowerCase() === 'src' && value !== null) post({ type: 'ss:suppressReload' });
        const sourceAnchor =
          sig.tagName.toLowerCase() === 'img' && !imageAttributeEditBlockRef.current
            ? imageSourceAnchorRef.current
            : null;
        const result = sourceAnchor
          ? await applyElementHtml(projectPath, sig, oldHtml, newHtml, undefined, sourceAnchor)
          : await applyElementHtml(projectPath, sig, oldHtml, newHtml);
        if (token !== selectionTokenRef.current) return false;
        if (sourceAnchor) imageSourceAnchorRef.current = result?.sourceAnchor ?? null;
        htmlRef.current = newHtml;
        setAttributes(parseAttributes(newHtml));
        const options = compatibleMarkupTags(newHtml, sig.tagName, ancestorTags(sig));
        setTagOptions(options);
        setCanEditTag(options.length > 1);
        if (name.toLowerCase() === 'src' && value !== null) {
          post({ type: 'ss:setSrc', value });
          post({ type: 'ss:commit' });
        }
        void trackEvent('visual_edit_saved', { kind: 'attribute', mode: 'css-code' });
        return true;
      } catch (err) {
        reportSettingsFailure('attribute edit', err, onToast);
        return false;
      } finally {
        endWrite();
      }
    },
    [projectPath, onToast, beginWrite, endWrite, post]
  );

  /** Rename an attribute's key (remove old + add new in ONE source write so it never
   *  flickers a half-renamed tag), preserving the value. */
  const renameAttr = useCallback(
    async (oldName: string, newName: string, value: string) => {
      const sig = sigRef.current;
      const token = selectionTokenRef.current;
      const oldHtml = htmlRef.current;
      const n = newName.trim();
      if (!sig || oldHtml == null) {
        onToast("Can't edit this element's attributes in source.", 'error');
        return;
      }
      if (sig.tagName.toLowerCase() === 'img' && imageAttributeEditBlockRef.current) {
        onToast(
          imageAttributeEditBlockRef.current === 'ambiguous'
            ? 'This image appears in several source locations. Update it in code so only the intended image changes.'
            : imageAttributeEditBlockRef.current === 'spread'
              ? 'This image uses a spread attribute that may provide its values. Update it in code so its attributes stay in sync.'
              : 'The selected image’s rendered attributes do not match the source markup found. Update it in code so the intended image stays in sync.',
          'info'
        );
        return;
      }
      if (!n || n === oldName) return;
      const without = setAttrInHtml(oldHtml, oldName, null) ?? oldHtml;
      const newHtml = setAttrInHtml(without, n, value);
      if (newHtml == null || newHtml === oldHtml) return;
      if (!beginWrite()) return;
      try {
        const sourceAnchor =
          sig.tagName.toLowerCase() === 'img' && !imageAttributeEditBlockRef.current
            ? imageSourceAnchorRef.current
            : null;
        const result = sourceAnchor
          ? await applyElementHtml(projectPath, sig, oldHtml, newHtml, undefined, sourceAnchor)
          : await applyElementHtml(projectPath, sig, oldHtml, newHtml);
        if (token !== selectionTokenRef.current) return;
        if (sourceAnchor) imageSourceAnchorRef.current = result?.sourceAnchor ?? null;
        htmlRef.current = newHtml;
        setAttributes(parseAttributes(newHtml));
        const options = compatibleMarkupTags(newHtml, sig.tagName, ancestorTags(sig));
        setTagOptions(options);
        setCanEditTag(options.length > 1);
        void trackEvent('visual_edit_saved', { kind: 'attribute', mode: 'css-code' });
      } catch (err) {
        reportSettingsFailure('attribute rename', err, onToast);
      } finally {
        endWrite();
      }
    },
    [projectPath, onToast, beginWrite, endWrite]
  );

  /** Rewrite the element's `class` attribute in source (and live in the preview). */
  const writeClassAttr = useCallback(
    async (nextClass: string): Promise<boolean> => {
      const sig = sigRef.current;
      const token = selectionTokenRef.current;
      if (!sig) return false;
      const res = await resolveClassnameSource(projectPath, sig);
      if (res.status !== 'resolved' && res.status !== 'multi') {
        // A dynamic/computed className the editor declines to rewrite is a
        // by-design refusal, not a malfunction — 'error' toasts auto-file bug
        // reports (issue #870).
        onToast("Can't edit this element's classes in source — change them in code.", 'info');
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
      if (token !== selectionTokenRef.current) return false;
      const nextSig = { ...sig, className: nextClass };
      sigRef.current = nextSig;
      post({ type: 'ss:mutate', className: nextClass, rules: [] });
      post({ type: 'ss:commit' });
      // Refresh every editor/structural hook with the new source anchor. Without
      // this, a renamed class looks correct but duplicate/delete still hold the
      // old signature until the user manually reselects the element.
      post({ type: 'ss:reselect', signature: nextSig });
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
      const token = selectionTokenRef.current;
      if (!sig) return false;
      post({ type: 'ss:suppressReload' });
      await insertClassAttr(projectPath, sig, name);
      if (token !== selectionTokenRef.current) return false;
      sigRef.current = { ...sig, className: name };
      post({ type: 'ss:mutate', className: name, rules: [] });
      post({ type: 'ss:commit' });
      post({ type: 'ss:reselect', signature: sigRef.current });
      return true;
    },
    [projectPath, post]
  );

  const addClass = useCallback(
    async (name: string) => {
      const n = name.trim().replace(/^\./, '');
      if (!n || classes.includes(n)) return;
      if (!beginWrite()) return;
      try {
        const next = [...classes, n];
        // No existing classes → insert a fresh attribute; otherwise rewrite the
        // existing literal. Failures throw with the backend's specific reason.
        const written =
          classes.length === 0 ? await insertFirstClass(n) : await writeClassAttr(next.join(' '));
        if (written) {
          setClasses(next);
          void trackEvent('visual_edit_saved', { kind: 'class', mode: 'css-code' });
        }
      } catch (err) {
        reportSettingsFailure('add class', err, onToast);
      } finally {
        endWrite();
      }
    },
    [classes, writeClassAttr, insertFirstClass, onToast, beginWrite, endWrite]
  );

  const removeClass = useCallback(
    async (name: string) => {
      if (!beginWrite()) return;
      try {
        const next = classes.filter((c) => c !== name);
        if (await writeClassAttr(next.join(' '))) {
          setClasses(next);
          void trackEvent('visual_edit_saved', { kind: 'class', mode: 'css-code' });
        }
      } catch (err) {
        reportSettingsFailure('remove class', err, onToast);
      } finally {
        endWrite();
      }
    },
    [classes, writeClassAttr, onToast, beginWrite, endWrite]
  );

  const renameClass = useCallback(
    async (oldName: string, newName: string) => {
      const n = newName.trim().replace(/^\./, '');
      if (!n || n === oldName) return;
      if (/\s/.test(n)) {
        onToast('A class name cannot contain spaces.', 'error');
        return;
      }
      if (classes.includes(n)) {
        onToast(`.${n} is already on this element.`, 'error');
        return;
      }
      if (!beginWrite()) return;
      try {
        const next = classes.map((c) => (c === oldName ? n : c));
        if (await writeClassAttr(next.join(' '))) {
          setClasses(next);
          void trackEvent('visual_edit_saved', { kind: 'class', mode: 'css-code' });
        }
      } catch (err) {
        // Same refusal ladder as the other settings mutations — by-design
        // ambiguity/validation refusals must not file bug reports (#818).
        reportSettingsFailure('rename class', err, onToast);
      } finally {
        endWrite();
      }
    },
    [classes, writeClassAttr, onToast, beginWrite, endWrite]
  );

  /** Save a direct text literal with the source resolver's old-text drift guard.
   *  User characters are encoded as source entities, so '<', '&', and braces
   *  remain text in JSX/HTML rather than becoming markup or an expression. */
  const saveText = useCallback(
    async (nextText: string): Promise<boolean> => {
      const sig = sigRef.current;
      const token = selectionTokenRef.current;
      const target = textTargetRef.current;
      if (!sig || !target || !canEditText || directTextReason(target.text)) {
        onToast("This element's text can't be edited safely in source.", 'info');
        return false;
      }
      const sourceText = encodeDirectTextForSource(nextText);
      if (sourceText === target.text) {
        setTextValue(nextText);
        return true;
      }
      if (!beginWrite()) return false;
      post({ type: 'ss:suppressReload' });
      try {
        await applyTextEdit(
          projectPath,
          target.file,
          target.line,
          target.column,
          target.text,
          sourceText
        );
        if (token !== selectionTokenRef.current) return true;

        const nextTarget = { ...target, text: sourceText };
        const nextSig = { ...sig, text: nextText };
        textTargetRef.current = nextTarget;
        sigRef.current = nextSig;
        setTextValue(nextText);
        setTextReason(null);
        setCanEditText(true);

        // Text and markup share source. Invalidate the old HTML baseline before
        // the refetch so a later attribute edit can never restore stale content.
        htmlRef.current = null;
        setCanEditAttributes(false);
        setCanEditTag(false);
        post({ type: 'ss:setText', value: nextText });
        post({ type: 'ss:commit' });
        post({ type: 'ss:reselect', signature: nextSig });
        void trackEvent('visual_edit_saved', { kind: 'text', mode: 'css-code' });
        onToast('Saved to source', 'success');

        try {
          const refreshed = await resolveElementHtml(projectPath, nextSig);
          if (token !== selectionTokenRef.current) return true;
          htmlRef.current = refreshed.html;
          setAttributes(parseAttributes(refreshed.html));
          setCanEditAttributes(true);
          setLocation({ file: refreshed.file, line: refreshed.line });
          const options = compatibleMarkupTags(
            refreshed.html,
            nextSig.tagName,
            ancestorTags(nextSig)
          );
          setTagOptions(options);
          setCanEditTag(options.length > 1);
        } catch (err) {
          if (token === selectionTokenRef.current) {
            logger.warn(
              '[ElementSettings] refreshed markup after text edit could not be resolved',
              {
                error: toastText(err),
              }
            );
            htmlRef.current = null;
            setCanEditAttributes(false);
            setCanEditTag(false);
            setTagOptions(compatibleMarkupTags(null, nextSig.tagName, ancestorTags(nextSig)));
          }
        }
        return true;
      } catch (err) {
        reportSettingsFailure('text edit', err, onToast);
        return false;
      } finally {
        endWrite();
      }
    },
    [canEditText, projectPath, onToast, beginWrite, endWrite, post]
  );

  /** Convert the selected native text/container tag by replacing only the paired
   *  tag-name spans in freshly resolved source markup. The ancestor path is part
   *  of compatibility checks so links/headings cannot become invalidly nested. */
  const changeTag = useCallback(
    async (nextTag: string): Promise<boolean> => {
      const sig = sigRef.current;
      const token = selectionTokenRef.current;
      if (!sig) return false;
      if (nextTag.toLowerCase() === sig.tagName.toLowerCase()) return true;
      if (!beginWrite()) return false;
      try {
        const fresh = await resolveElementHtml(projectPath, sig);
        if (token !== selectionTokenRef.current) return false;
        const options = compatibleMarkupTags(fresh.html, sig.tagName, ancestorTags(sig));
        if (!options.some((option) => option.tag === nextTag.toLowerCase())) {
          onToast('That tag is not compatible with this element’s source content.', 'info');
          return false;
        }
        const nextHtml = replaceMarkupTagName(fresh.html, sig.tagName, nextTag);
        if (nextHtml == null || nextHtml === fresh.html) {
          onToast('This element’s source markup could not be safely converted.', 'info');
          return false;
        }

        post({ type: 'ss:suppressReload' });
        await applyElementHtml(projectPath, sig, fresh.html, nextHtml);
        if (token !== selectionTokenRef.current) return true;

        const nextSig = { ...sig, tagName: nextTag.toLowerCase() };
        const nextToken = ++selectionTokenRef.current;
        sigRef.current = nextSig;
        htmlRef.current = nextHtml;
        textTargetRef.current = null;
        setTagValue(nextSig.tagName);
        setTextValue('');
        setTextReason('Resolving selected text…');
        setCanEditText(false);
        setAttributes(parseAttributes(nextHtml));
        setCanEditAttributes(true);
        setLocation({ file: fresh.file, line: fresh.line });
        const nextOptions = compatibleMarkupTags(nextHtml, nextSig.tagName, ancestorTags(nextSig));
        setTagOptions(nextOptions);
        setCanEditTag(nextOptions.length > 1);
        // The in-frame handler replaces selected nodes synchronously while
        // preserving their attributes and children. postMessage preserves FIFO
        // order, so re-selection sees the updated native tag without a timer.
        post({ type: 'ss:setTag', value: nextSig.tagName });
        post({ type: 'ss:commit' });
        post({ type: 'ss:reselect', signature: nextSig });
        void trackEvent('visual_edit_saved', { kind: 'tag', mode: 'css-code' });

        try {
          const textResolution = await resolveTextSource(projectPath, nextSig);
          if (nextToken !== selectionTokenRef.current) return true;
          if (textResolution.status === 'resolved') {
            textTargetRef.current = {
              file: textResolution.file,
              line: textResolution.line,
              column: textResolution.column,
              text: textResolution.text,
            };
            setTextValue(decodeTextEntities(textResolution.text));
            const unsafeReason = directTextReason(textResolution.text);
            setTextReason(unsafeReason);
            setCanEditText(unsafeReason === null);
          } else {
            textTargetRef.current = null;
            setTextValue('');
            setTextReason(
              textResolution.reason || 'This element has no safely editable static text.'
            );
            setCanEditText(false);
          }
        } catch {
          if (nextToken === selectionTokenRef.current) {
            textTargetRef.current = null;
            setTextValue('');
            setTextReason('This element’s text could not be resolved in source.');
            setCanEditText(false);
          }
        }
        return true;
      } catch (err) {
        reportSettingsFailure('tag conversion', err, onToast);
        return false;
      } finally {
        endWrite();
      }
    },
    [projectPath, onToast, beginWrite, endWrite, post]
  );

  return {
    selectionKey,
    tag,
    tagOptions,
    canEditTag,
    setTag: changeTag,
    classes,
    attributes,
    text,
    textReason,
    canEditText,
    setText: saveText,
    addClass: (n) => void addClass(n),
    renameClass: (oldName, newName) => void renameClass(oldName, newName),
    removeClass: (n) => void removeClass(n),
    setAttribute: (name, value) => applyAttr(name, value),
    renameAttribute: (oldName, newName, value) => void renameAttr(oldName, newName, value),
    removeAttribute: (name) => void applyAttr(name, null),
    canEditAttributes,
    sourceMarkupStatus,
    imageAttributeEditBlockReason,
    location,
    busy,
  };
}
