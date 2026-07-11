/**
 * Code-first CSS editor controller (vanilla-CSS projects) — the structured cascade
 * card GUI. Click an element → every author rule that styles it renders as a card
 * (in cascade order), each rule's properties as editable GUI rows, nested rules as
 * nested cards.
 *
 * Editing is **live + auto-saved**: a card edit mutates the rule's structured body
 * (`lib/cssBody`), which is serialized and (a) previewed in place in the iframe via
 * the CSSOM (`ss:previewRuleText`, debounced ~120ms) and (b) written to the source
 * `.css` via `apply_css_rule_text` (debounced ~600ms, drift-guarded). No Save buttons.
 *
 * Security: only messages from the preview iframe's own contentWindow are trusted.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ElementSignature } from '../lib/edit';
import {
  locateCssRules,
  applyCssRuleText,
  deleteCssRule,
  wrapCssRule,
  createCssRule,
  listStylesheets,
  listCssClasses,
  listCssSelectors,
  listCssVariables,
  renameCssSelector,
  renameCssAtRule,
  mergeCascade,
  rulesToLocate,
  rowKey,
  type MatchedRule,
  type RuleLocation,
  type CascadeRow,
} from '../lib/cssCascade';
import { parseRuleBody, serializeRuleBody, overriddenProps, type RuleBody } from '../lib/cssBody';
import { keyframesName, parseRulePrelude } from '../lib/cssStructures';
import { logger } from '../lib/logger';
import { trackEvent } from '../lib/analytics';
import { asCommandError, formatCommandError } from '../lib/errors';

function toastText(err: unknown): string {
  return formatCommandError(asCommandError(err));
}

const PREVIEW_DEBOUNCE_MS = 120;
const SAVE_DEBOUNCE_MS = 600;

/** Approximate specificity of a simple selector (the element's own class/id/tag), for
 *  ordering draft cards within the cascade. */
function draftSpecificity(selector: string): [number, number, number] {
  if (selector.startsWith('#')) return [1, 0, 0];
  if (selector.startsWith('.')) return [0, 1, 0];
  return [0, 0, 1];
}

/** Compare specificity tuples (a−b, MSB first). */
function specCmp(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Insert a draft row into the cascade list (which is sorted highest-priority first),
 *  mutating in place: before the first ACTIVE row with lower specificity, but above the
 *  inactive-media block. */
function insertDraftByCascade(rows: CascadeRow[], draft: CascadeRow): void {
  const ds = draft.specificity;
  let i = rows.findIndex((r) => !r.inactiveMedia && specCmp(r.specificity, ds) < 0);
  if (i < 0) {
    const inactive = rows.findIndex((r) => r.inactiveMedia);
    i = inactive < 0 ? rows.length : inactive;
  }
  rows.splice(i, 0, draft);
}

export interface CascadeSelection {
  signature: ElementSignature;
  instanceCount: number;
}

interface Params {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  projectPath: string;
  enabled: boolean;
  /** The project bundles CSS Modules (Next.js) — unmapped module-hashed selectors
   *  get a CSS-Modules explanation instead of the generic read-only reason. */
  cssModulesHint?: boolean;
  onToast: (message: string, type?: 'success' | 'error') => void;
}

export function useCssCascadeEditor({
  iframeRef,
  projectPath,
  enabled,
  cssModulesHint = false,
  onToast,
}: Params) {
  const [editModeOn, setEditModeOn] = useState(false);
  const editMode = enabled && editModeOn;

  const [selection, setSelection] = useState<CascadeSelection | null>(null);
  const [rows, setRows] = useState<CascadeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [bodies, setBodies] = useState<Record<string, RuleBody>>({});
  const [overridden, setOverridden] = useState<Record<string, Map<string, string>>>({});
  const [savingKeys, setSavingKeys] = useState<Set<string>>(() => new Set());
  // The rowKey of a just-created rule ("Add selector"), so the panel can auto-open its
  // "+ Add" menu for the editing flow. Cleared shortly after (one-shot).
  const [justCreatedKey, setJustCreatedKey] = useState<string | null>(null);
  // Project class names for selector autocomplete (loaded when edit mode opens).
  const [classSuggestions, setClassSuggestions] = useState<string[]>([]);
  // Every existing rule selector (full text), so "Add selector" can suggest what's
  // already defined and re-surface it on a match instead of erroring.
  const [existingSelectors, setExistingSelectors] = useState<string[]>([]);
  // Project CSS variables (`--foo`) for `var(--…)` value autocomplete.
  const [variableSuggestions, setVariableSuggestions] = useState<string[]>([]);

  // Per-rule source baseline (drift guard + diff) and latest body, in refs so the
  // debounced callbacks read fresh values without re-binding.
  const baselineInner = useRef<Record<string, string>>({});
  const bodiesRef = useRef<Record<string, RuleBody>>({});
  const previewTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const selTokenRef = useRef(0);
  // The last selected element's signature — replayed after an HMR reload so the
  // panel re-reads the element's current source (instant sync after edits).
  const lastSignatureRef = useRef<ElementSignature | null>(null);
  // Synthetic indices for optimistically-added rules (kept clear of real cascade
  // indices, which start at 0).
  const synthIndex = useRef(1_000_000);
  // Locally-created rules (via "Add selector") keyed by rowKey. They're kept pinned
  // in the panel across cascade refreshes — even if the new selector doesn't match
  // the element yet — so a freshly-added rule never silently vanishes. Cleared when
  // a different element is selected; an entry is dropped once the real cascade
  // includes it (confirmed).
  const createdRowsRef = useRef<Map<string, CascadeRow>>(new Map());
  // Keys of draft cards (the element's own selectors with no rule yet). A draft's rule
  // is created in source on its first saved property; until then it's display-only.
  const draftKeysRef = useRef<Set<string>>(new Set());
  // Stable synthetic index per draft selector, REUSED across cascade rebuilds — so a
  // draft's rowKey (and thus its React key) doesn't change every refresh. Without this,
  // each rebuild remounted the draft card, destroying any open "+ Add" menu / edit state
  // ("+ Add doesn't work" on NEW cards). Reset only on a genuine element change.
  const draftIndexRef = useRef<Map<string, number>>(new Map());
  const editModeOnRef = useRef(false);
  useEffect(() => {
    editModeOnRef.current = editModeOn;
  }, [editModeOn]);

  const rowByKey = useMemo(() => {
    const m = new Map<string, CascadeRow>();
    for (const r of rows) m.set(rowKey(r), r);
    return m;
  }, [rows]);
  const rowByKeyRef = useRef(rowByKey);
  rowByKeyRef.current = rowByKey;

  const post = useCallback(
    (msg: unknown) => iframeRef.current?.contentWindow?.postMessage(msg, '*'),
    [iframeRef]
  );

  const clearTimers = useCallback(() => {
    Object.values(previewTimers.current).forEach(clearTimeout);
    Object.values(saveTimers.current).forEach(clearTimeout);
    previewTimers.current = {};
    saveTimers.current = {};
  }, []);

  // Activate the in-iframe selection layer in CASCADE mode while editing; re-arm on HMR.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (editMode) {
      post({ type: 'ss:activate', cascade: true });
      // After an HMR reload, re-arm the layer AND replay the last selection so the
      // panel re-reads the element's current source (instant read after edits).
      const reactivate = () => {
        post({ type: 'ss:activate', cascade: true });
        const sig = lastSignatureRef.current;
        if (sig) setTimeout(() => post({ type: 'ss:reselect', signature: sig }), 60);
      };
      iframe?.addEventListener('load', reactivate);
      return () => iframe?.removeEventListener('load', reactivate);
    }
    post({ type: 'ss:deactivate' });
  }, [editMode, post, iframeRef]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  // Project class names + CSS variables for autocomplete.
  useEffect(() => {
    if (!editMode) return;
    let cancelled = false;
    void listCssClasses(projectPath)
      .then((cs) => !cancelled && setClassSuggestions(cs))
      .catch(() => undefined);
    void listCssSelectors(projectPath)
      .then((ss) => !cancelled && setExistingSelectors(ss))
      .catch(() => undefined);
    void listCssVariables(projectPath)
      .then((vs) => !cancelled && setVariableSuggestions(vs))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [editMode, projectPath]);

  // Receive the clicked element's signature + its cascade; build the card models.
  useEffect(() => {
    if (!editMode) return;
    const handler = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as {
        type?: string;
        signature?: ElementSignature;
        count?: number;
        rules?: MatchedRule[];
      } | null;
      if (!d) return;

      if (d.type === 'ss:select' && d.signature) {
        // Is this the SAME element re-selected (e.g. the iframe re-arms after an HMR
        // reload), or a genuinely different element? On a re-select we must NOT wipe the
        // optimistic state: a freshly-created rule lives only in `createdRowsRef` until
        // it has a property (the cascade walker skips empty rules), so clearing it here
        // made new rules — especially conditional `@media` ones — vanish on the next HMR.
        const prev = lastSignatureRef.current;
        // Identity is the element's structural path (`domPath`), not tag+class — two
        // sibling `<button class="btn">` are different elements and must NOT share
        // optimistic state. `domPath` is stable across an HMR reload of the same tree,
        // so a genuine re-select still counts as the same element. (Fall back to
        // tag+class only if the walker didn't report a path.)
        const prevPath = (prev as { domPath?: string } | null)?.domPath;
        const nextPath = (d.signature as { domPath?: string }).domPath;
        const sameElement =
          !!prev &&
          (prevPath != null || nextPath != null
            ? prevPath === nextPath
            : prev.tagName === d.signature.tagName && prev.className === d.signature.className);
        lastSignatureRef.current = d.signature;
        ++selTokenRef.current;
        clearTimers();
        post({ type: 'ss:clearRulePreview' });
        setSelection({ signature: d.signature, instanceCount: d.count ?? 1 });
        if (!sameElement) {
          createdRowsRef.current = new Map();
          draftIndexRef.current = new Map();
          setRows([]);
          setBodies({});
          bodiesRef.current = {};
          baselineInner.current = {};
          setOverridden({});
          setSavingKeys(new Set());
        }
        setLoading(true);
        void trackEvent('visual_element_selected', { mode: 'css-code', tag: d.signature.tagName });
        return;
      }

      if (d.type === 'ss:cascade' && Array.isArray(d.rules)) {
        const matched = d.rules;
        const token = selTokenRef.current;
        void (async () => {
          try {
            const toLocate = rulesToLocate(matched);
            const locations: RuleLocation[] = toLocate.length
              ? await locateCssRules(
                  projectPath,
                  toLocate.map((x) => x.query)
                )
              : [];
            const locByIndex = new Map<number, RuleLocation>();
            toLocate.forEach((x, k) => locByIndex.set(x.index, locations[k]));
            if (selTokenRef.current !== token) return;
            const merged = mergeCascade(matched, locByIndex, { cssModulesHint });

            const nextBodies: Record<string, RuleBody> = {};
            const nextOverridden: Record<string, Map<string, string>> = {};
            const nextBaseline: Record<string, string> = {};
            merged.forEach((row, i) => {
              const key = rowKey(row);
              nextOverridden[key] = overriddenProps(matched[i] ?? { declarations: [] });
              if (row.editable && row.innerText != null) {
                nextBodies[key] = parseRuleBody(row.innerText);
                nextBaseline[key] = row.innerText;
              }
            });

            // Pin locally-created rules the cascade doesn't include (a new selector
            // that doesn't match this element yet) so they never silently vanish.
            // Drop any the real cascade now confirms — matched by LOGICAL identity
            // (selector + media + file), not rowKey: the optimistic row and the
            // HMR-resolved row carry different `index`es, so a key compare would never
            // dedupe them and the card would appear twice (esp. for conditional rules,
            // whose selector matches the element so the cascade always re-reports them).
            const sameRule = (a: CascadeRow, b: CascadeRow) =>
              a.selector === b.selector &&
              (a.mediaText ?? null) === (b.mediaText ?? null) &&
              (a.file ?? null) === (b.file ?? null);
            const extraRows: CascadeRow[] = [];
            for (const [key, createdRow] of createdRowsRef.current) {
              if (merged.some((m) => sameRule(m, createdRow))) {
                createdRowsRef.current.delete(key);
                continue;
              }
              const body = bodiesRef.current[key] ?? parseRuleBody(createdRow.innerText ?? '\n');
              nextBodies[key] = body;
              nextBaseline[key] = baselineInner.current[key] ?? createdRow.innerText ?? '\n';
              nextOverridden[key] = new Map();
              // A created rule WITH content that the cascade doesn't report → its selector
              // doesn't match this element (the walker reports every matching non-empty
              // rule). Flag it so the card says "doesn't match" instead of implying it
              // applies. An empty one is just a fresh rule being built — don't flag it.
              const unmatched = body.items.length > 0;
              extraRows.push(unmatched ? { ...createdRow, unmatched: true } : createdRow);
            }
            const finalRows = [...extraRows, ...merged];

            // Draft cards: the element's own selectors (classes, then tag) with no base
            // rule yet — empty editable cards placed in cascade order. They aren't
            // written to source until the first property is saved (see saveRule).
            draftKeysRef.current = new Set();
            const sig = lastSignatureRef.current;
            if (sig) {
              let targetFile = finalRows.find((r) => r.editable && r.file)?.file;
              if (!targetFile) {
                try {
                  targetFile = (await listStylesheets(projectPath))[0];
                } catch {
                  targetFile = undefined;
                }
              }
              if (targetFile && selTokenRef.current === token) {
                const sigClasses = sig.className.split(/\s+/).filter(Boolean);
                const candidates = [
                  ...new Set([...sigClasses.map((c) => `.${c}`), sig.tagName].filter(Boolean)),
                ];
                const styledBase = new Set(
                  finalRows.filter((r) => !r.mediaText && r.selector).map((r) => r.selector)
                );
                for (const selector of candidates) {
                  if (styledBase.has(selector)) continue;
                  // Stable index per selector → stable rowKey → the draft card isn't
                  // remounted on each cascade rebuild (preserves its open "+ Add" menu).
                  let draftIdx = draftIndexRef.current.get(selector);
                  if (draftIdx === undefined) {
                    draftIdx = ++synthIndex.current;
                    draftIndexRef.current.set(selector, draftIdx);
                  }
                  const draft: CascadeRow = {
                    index: draftIdx,
                    selector,
                    declarations: [],
                    specificity: draftSpecificity(selector),
                    mediaText: null,
                    mediaMinPx: null,
                    inactiveMedia: false,
                    layer: null,
                    origin: 'author',
                    editable: true,
                    file: targetFile,
                    line: 0,
                    innerText: '\n',
                    draft: true,
                  };
                  const key = rowKey(draft);
                  draftKeysRef.current.add(key);
                  nextBodies[key] = { items: [] };
                  nextBaseline[key] = '\n';
                  nextOverridden[key] = new Map();
                  insertDraftByCascade(finalRows, draft);
                }
              }
            }

            setRows(finalRows);
            setBodies(nextBodies);
            bodiesRef.current = nextBodies;
            baselineInner.current = nextBaseline;
            setOverridden(nextOverridden);
          } catch (err) {
            logger.error('[CssCascade] locate failed', { error: String(err) });
            if (selTokenRef.current === token) {
              setRows(mergeCascade(matched, new Map(), { cssModulesHint }));
              onToast(toastText(err), 'error');
            }
          } finally {
            if (selTokenRef.current === token) setLoading(false);
          }
        })();
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [editMode, projectPath, post, iframeRef, onToast, clearTimers, cssModulesHint]);

  /** Live-preview a rule's current body in place (in-iframe CSSOM). */
  const previewRule = useCallback(
    (key: string) => {
      const row = rowByKeyRef.current.get(key);
      const body = bodiesRef.current[key];
      if (!row || !row.editable || row.selector == null || !body) return;
      post({
        type: 'ss:previewRuleText',
        ruleKey: key,
        selector: row.selector,
        mediaText: row.mediaText,
        // Pin the exact rule by cascade position so a duplicate selector (base + @layer)
        // previews the one the panel is showing, not the first textual match.
        order: row.sourceOrder,
        cssText: `${row.selector} {${serializeRuleBody(body)}}`,
      });
    },
    [post]
  );

  /** Persist a rule's current body to source (drift-guarded), then bake the preview. */
  const saveRule = useCallback(
    async (key: string) => {
      const row = rowByKeyRef.current.get(key);
      const body = bodiesRef.current[key];
      if (!row || !row.editable || row.file == null || row.selector == null || !body) return;
      const oldInner = baselineInner.current[key];
      const newInner = serializeRuleBody(body);
      if (oldInner === undefined || newInner === oldInner) return;
      setSavingKeys((prev) => new Set(prev).add(key));
      post({ type: 'ss:suppressReload' });
      try {
        // A draft's rule doesn't exist in source yet — create the (empty) rule on its
        // first real property, then write the body into it. After this it's a normal card.
        if (draftKeysRef.current.has(key)) {
          try {
            await createCssRule(projectPath, row.file, row.selector);
          } catch (err) {
            if (!String(err).includes('already exists')) throw err;
          }
          draftKeysRef.current.delete(key);
        }
        await applyCssRuleText(
          projectPath,
          row.file,
          row.selector,
          row.mediaText,
          oldInner,
          newInner
        );
        baselineInner.current[key] = newInner; // new drift baseline
        post({ type: 'ss:commitRulePreview', ruleKey: key });
        void trackEvent('visual_style_saved', { mode: 'css-code' });
      } catch (err) {
        // The source drifted from our baseline (a prior save's formatting, an HMR
        // re-read, an external edit). Re-read the current source and retry ONCE so
        // editing stays "instant" instead of hitting a drift wall.
        if (/source changed/i.test(toastText(err))) {
          try {
            const locs = await locateCssRules(projectPath, [
              { selector: row.selector, mediaText: row.mediaText, href: null },
            ]);
            const loc = locs[0];
            if (loc && loc.status === 'resolved') {
              await applyCssRuleText(
                projectPath,
                row.file,
                row.selector,
                row.mediaText,
                loc.inner_text,
                newInner
              );
              baselineInner.current[key] = newInner;
              post({ type: 'ss:commitRulePreview', ruleKey: key });
              return;
            }
          } catch {
            /* fall through to the toast below */
          }
        }
        logger.error('[CssCascade] write-back failed', { error: String(err) });
        onToast(toastText(err), 'error');
      } finally {
        setSavingKeys((prev) => {
          const n = new Set(prev);
          n.delete(key);
          return n;
        });
      }
    },
    [projectPath, onToast, post]
  );

  /** Delete a whole rule from source, drop its card, and remove it live. */
  const deleteRule = useCallback(
    async (key: string) => {
      const row = rowByKeyRef.current.get(key);
      if (!row || !row.editable || row.file == null || row.selector == null) return;
      clearTimeout(previewTimers.current[key]);
      clearTimeout(saveTimers.current[key]);
      post({ type: 'ss:suppressReload' });
      try {
        await deleteCssRule(
          projectPath,
          row.file,
          row.selector,
          row.mediaText,
          baselineInner.current[key] ?? ''
        );
        post({ type: 'ss:clearRulePreview', ruleKey: key });
        post({
          type: 'ss:deleteRulePreview',
          selector: row.selector,
          mediaText: row.mediaText,
          order: row.sourceOrder,
        });
        setRows((prev) => prev.filter((r) => rowKey(r) !== key));
        setBodies((prev) => {
          const n = { ...prev };
          delete n[key];
          return n;
        });
        delete bodiesRef.current[key];
        delete baselineInner.current[key];
        void trackEvent('visual_style_saved', { mode: 'css-code', deleted: true });
      } catch (err) {
        logger.error('[CssCascade] delete failed', { error: String(err) });
        onToast(toastText(err), 'error');
      }
    },
    [projectPath, onToast, post]
  );

  /** Wrap a top-level rule in an at-rule (the `@` above the selector). For `@media`
   *  we optimistically update the card's media context so editing continues; HMR
   *  recompiles the moved rule. */
  const wrapRule = useCallback(
    async (key: string, atPrelude: string) => {
      const row = rowByKeyRef.current.get(key);
      if (!row || !row.editable || row.file == null || row.selector == null) return;
      post({ type: 'ss:suppressReload' });
      try {
        await wrapCssRule(
          projectPath,
          row.file,
          row.selector,
          row.mediaText,
          atPrelude,
          baselineInner.current[key] ?? ''
        );
        const m = atPrelude.trim();
        const cond = m.toLowerCase().startsWith('@media') ? m.slice('@media'.length).trim() : null;
        if (cond)
          setRows((prev) => prev.map((r) => (rowKey(r) === key ? { ...r, mediaText: cond } : r)));
        else onToast('Wrapped — reselect the element to keep editing.', 'success');
        void trackEvent('visual_style_saved', { mode: 'css-code', wrapped: true });
      } catch (err) {
        logger.error('[CssCascade] wrap failed', { error: String(err) });
        onToast(toastText(err), 'error');
      }
    },
    [projectPath, onToast, post]
  );

  /** Create a brand-new rule for `selector` and add it as an editable card you can
   *  style immediately (optimistic — the real cascade refreshes on HMR/reselect). */
  const addSelector = useCallback(
    async (input: string) => {
      const raw = input.trim();
      if (!raw) return;

      // The smart selector field composes `[@condition] [selector]`. Split it: a
      // condition (`@media (…)`, `@container (…)`, `@supports (…)`) creates a CONDITIONAL
      // rule (`@condition { selector { } }`); a bare condition with no selector targets
      // the element's primary selector. A plain selector creates a base rule.
      const parsed = parseRulePrelude(raw);
      const condition = parsed.condition ?? (raw.startsWith('@') ? raw : null);
      let sel = parsed.condition ? parsed.selector : raw;
      let atPrelude: string | null = null;
      let condMediaText: string | null = null;
      let condMinPx: number | null = null;
      if (condition) {
        if (!sel) {
          // Condition but no selector typed → scope the element's primary selector.
          const sig = lastSignatureRef.current;
          const firstClass = sig?.className.split(/\s+/).filter(Boolean)[0];
          sel = firstClass ? `.${firstClass}` : (sig?.tagName ?? '');
        }
        if (!sel) {
          onToast('Type a selector (or select an element) for the conditional rule.', 'error');
          return;
        }
        atPrelude = condition;
        // For @media, capture the condition text + min-width so the optimistic card shows
        // the right media chip immediately (other conditions resolve on the next reload).
        condMediaText = condition.toLowerCase().startsWith('@media')
          ? condition.slice('@media'.length).trim()
          : null;
        const min = /min-width\s*:\s*([\d.]+)px/i.exec(condition);
        condMinPx = min ? Math.round(parseFloat(min[1])) : null;
      }

      // Is this exact rule (selector + at-rule condition) already on screen? If so, don't
      // create a duplicate — it's right there to edit. (The backend skips its dup-check for
      // wrapped rules, so this guard lives here.) The condition is compared whitespace- and
      // case-insensitively across @media / @container / @supports — not just @media — so a
      // case-different or non-media condition can't slip a duplicate through.
      const condSig = (kind: string, cond: string | null | undefined) =>
        `${kind}|${(cond ?? '').replace(/\s+/g, '').toLowerCase()}`;
      const rowCondSig = (r: CascadeRow) =>
        r.mediaText
          ? condSig('media', r.mediaText)
          : r.container
            ? condSig('container', r.container)
            : r.supports
              ? condSig('supports', r.supports)
              : condSig('base', '');
      // Slice the TRIMMED prelude (`at`), not the raw `atPrelude` — a leading space would
      // otherwise offset the slice and produce a garbage condition key (missed dedup).
      const at = (atPrelude ?? '').trim();
      const atLower = at.toLowerCase();
      const newSig = !atPrelude
        ? condSig('base', '')
        : atLower.startsWith('@media')
          ? condSig('media', at.slice('@media'.length))
          : atLower.startsWith('@container')
            ? condSig('container', at.slice('@container'.length))
            : atLower.startsWith('@supports')
              ? condSig('supports', at.slice('@supports'.length))
              : condSig('other', at);
      const alreadyShown = [...rowByKeyRef.current.values()].some(
        (r) => r.editable && r.selector === sel && rowCondSig(r) === newSig
      );
      if (alreadyShown) return;

      let targetFile = [...rowByKeyRef.current.values()].find((r) => r.editable && r.file)?.file;
      if (!targetFile) {
        try {
          targetFile = (await listStylesheets(projectPath))[0];
        } catch {
          targetFile = undefined;
        }
      }
      if (!targetFile) {
        onToast('No stylesheet found to add the rule to.', 'error');
        return;
      }

      // Pin a rule into the panel as an editable card. Created rules persist across
      // cascade refreshes (see createdRowsRef) so they never silently vanish.
      const pin = (file: string, innerText: string) => {
        const newRow: CascadeRow = {
          index: ++synthIndex.current,
          selector: sel,
          declarations: [],
          specificity: [0, 0, 0],
          mediaText: condMediaText,
          mediaMinPx: condMinPx,
          inactiveMedia: false,
          layer: null,
          origin: 'author',
          editable: true,
          file,
          line: 0,
          innerText,
        };
        const key = rowKey(newRow);
        const body = parseRuleBody(innerText);
        createdRowsRef.current.set(key, newRow);
        setRows((prev) => [newRow, ...prev.filter((r) => rowKey(r) !== key)]);
        setBodies((prev) => ({ ...prev, [key]: body }));
        bodiesRef.current[key] = body;
        baselineInner.current[key] = innerText;
        setOverridden((prev) => ({ ...prev, [key]: new Map() }));
        // Editing-flow: open the new card's "+ Add" menu so the user jumps straight to
        // its first property. One-shot — cleared so later refreshes don't re-open it.
        setJustCreatedKey(key);
        window.setTimeout(() => setJustCreatedKey((k) => (k === key ? null : k)), 1500);
      };

      post({ type: 'ss:suppressReload' });
      const token = selTokenRef.current;
      try {
        await createCssRule(projectPath, targetFile, sel, atPrelude);
        // Re-locate the just-written rule and pin it with the EXACT source body, so the
        // drift baseline matches and the first edit never trips the drift guard. This is
        // critical for conditional (`@media`) rules: their wrapped indentation differs
        // from a naive empty body, which previously forced a drift retry on first save.
        let pinFile = targetFile;
        let innerText = '\n';
        try {
          const [loc] = await locateCssRules(projectPath, [
            { selector: sel, mediaText: condMediaText, href: null },
          ]);
          if (loc?.status === 'resolved') {
            pinFile = loc.file;
            innerText = loc.inner_text;
          }
        } catch {
          /* keep the empty-body fallback — the drift retry covers the mismatch */
        }
        if (selTokenRef.current !== token) return; // element changed while writing
        pin(pinFile, innerText);
        void trackEvent('visual_style_saved', {
          mode: 'css-code',
          created_rule: true,
          conditional: condition != null,
        });
      } catch (err) {
        const msg = String(err);
        // The rule already exists in source but doesn't match this element (so it
        // isn't in the cascade). Surface the real rule for editing instead of erroring
        // — typing an existing selector should just open it.
        if (msg.includes('already exists')) {
          try {
            const [loc] = await locateCssRules(projectPath, [
              { selector: sel, mediaText: null, href: null },
            ]);
            if (loc?.status === 'resolved') {
              pin(loc.file, loc.inner_text);
              return;
            }
          } catch {
            /* fall through to a soft message below */
          }
          // It exists but we couldn't pin it here (e.g. it lives in a sheet we can't
          // open). Don't show a scary validation error — explain plainly.
          onToast(`“${sel}” already exists — open it from its stylesheet.`, 'error');
          return;
        }
        logger.error('[CssCascade] add selector failed', { error: msg });
        onToast(toastText(err), 'error');
      }
    },
    [projectPath, onToast, post]
  );

  /** Change a rule's selector to anything (complex selectors included). Re-keys the
   *  local state so editing continues; HMR/reselect refreshes whether it still
   *  matches the element. */
  const renameSelector = useCallback(
    async (key: string, newSelector: string) => {
      const row = rowByKeyRef.current.get(key);
      const ns = newSelector.trim();
      if (!row || !row.editable || row.file == null || row.selector == null) return;
      if (!ns || ns === row.selector) return;
      // Cancel any in-flight debounced preview/save on the OLD key — once we re-key below
      // it would fire against a dead key and silently drop the edit.
      clearTimeout(previewTimers.current[key]);
      clearTimeout(saveTimers.current[key]);
      post({ type: 'ss:suppressReload' });
      try {
        await renameCssSelector(
          projectPath,
          row.file,
          row.selector,
          row.mediaText,
          baselineInner.current[key] ?? '',
          ns
        );
        const newRow: CascadeRow = { ...row, selector: ns };
        const newKey = rowKey(newRow);
        // Move the per-rule state to the new key.
        if (bodiesRef.current[key]) {
          bodiesRef.current[newKey] = bodiesRef.current[key];
          delete bodiesRef.current[key];
        }
        if (baselineInner.current[key] !== undefined) {
          baselineInner.current[newKey] = baselineInner.current[key];
          delete baselineInner.current[key];
        }
        setRows((prev) => prev.map((r) => (rowKey(r) === key ? newRow : r)));
        setBodies((prev) => {
          if (!(key in prev)) return prev;
          const n = { ...prev };
          n[newKey] = n[key];
          delete n[key];
          return n;
        });
        setOverridden((prev) => {
          if (!(key in prev)) return prev;
          const n = { ...prev };
          n[newKey] = n[key];
          delete n[key];
          return n;
        });
        // Re-arm the save under the NEW key (deferred so the row refs settle first) so a
        // body edit that was mid-debounce when the rename landed still persists. saveRule
        // is a no-op when the body matches its baseline, so this is safe to always schedule.
        clearTimeout(saveTimers.current[newKey]);
        saveTimers.current[newKey] = setTimeout(() => void saveRule(newKey), SAVE_DEBOUNCE_MS);
        void trackEvent('visual_style_saved', { mode: 'css-code', renamed: true });
      } catch (err) {
        logger.error('[CssCascade] rename failed', { error: String(err) });
        onToast(toastText(err), 'error');
      }
    },
    [projectPath, onToast, post, saveRule]
  );

  /** Change the `@media` condition wrapping a rule. Re-keys on the new media; HMR
   *  refreshes the (shared) wrapper's sibling rules. */
  const renameAtRule = useCallback(
    async (key: string, newMedia: string) => {
      const row = rowByKeyRef.current.get(key);
      const nm = newMedia.trim();
      if (!row || !row.editable || row.file == null || row.selector == null || !nm) return;
      if (nm === row.mediaText) return;
      // Cancel any in-flight debounced preview/save on the OLD key (re-keyed below).
      clearTimeout(previewTimers.current[key]);
      clearTimeout(saveTimers.current[key]);
      post({ type: 'ss:suppressReload' });
      try {
        await renameCssAtRule(
          projectPath,
          row.file,
          row.selector,
          row.mediaText,
          baselineInner.current[key] ?? '',
          nm
        );
        const minMatch = /min-width\s*:\s*([\d.]+)px/i.exec(nm);
        const newRow: CascadeRow = {
          ...row,
          mediaText: nm,
          mediaMinPx: minMatch ? Math.round(parseFloat(minMatch[1])) : null,
        };
        const newKey = rowKey(newRow);
        if (bodiesRef.current[key]) {
          bodiesRef.current[newKey] = bodiesRef.current[key];
          delete bodiesRef.current[key];
        }
        if (baselineInner.current[key] !== undefined) {
          baselineInner.current[newKey] = baselineInner.current[key];
          delete baselineInner.current[key];
        }
        setRows((prev) => prev.map((r) => (rowKey(r) === key ? newRow : r)));
        setBodies((prev) => {
          if (!(key in prev)) return prev;
          const n = { ...prev };
          n[newKey] = n[key];
          delete n[key];
          return n;
        });
        setOverridden((prev) => {
          if (!(key in prev)) return prev;
          const n = { ...prev };
          n[newKey] = n[key];
          delete n[key];
          return n;
        });
        // Re-arm a pending body save under the new key (deferred; no-op if unchanged).
        clearTimeout(saveTimers.current[newKey]);
        saveTimers.current[newKey] = setTimeout(() => void saveRule(newKey), SAVE_DEBOUNCE_MS);
        void trackEvent('visual_style_saved', { mode: 'css-code', renamedAtRule: true });
      } catch (err) {
        logger.error('[CssCascade] rename at-rule failed', { error: String(err) });
        onToast(toastText(err), 'error');
      }
    },
    [projectPath, onToast, post, saveRule]
  );

  /** Update one card's body model → debounced live preview + auto-save. */
  const setBody = useCallback(
    (key: string, body: RuleBody) => {
      bodiesRef.current = { ...bodiesRef.current, [key]: body };
      setBodies((prev) => ({ ...prev, [key]: body }));
      clearTimeout(previewTimers.current[key]);
      previewTimers.current[key] = setTimeout(() => previewRule(key), PREVIEW_DEBOUNCE_MS);
      clearTimeout(saveTimers.current[key]);
      saveTimers.current[key] = setTimeout(() => void saveRule(key), SAVE_DEBOUNCE_MS);
    },
    [previewRule, saveRule]
  );

  const toggleEditMode = useCallback(() => {
    const turningOn = !editModeOnRef.current;
    editModeOnRef.current = turningOn;
    void trackEvent(turningOn ? 'visual_edit_started' : 'visual_edit_stopped', {
      mode: 'css-code',
    });
    if (!turningOn) {
      clearTimers();
      lastSignatureRef.current = null;
    }
    setEditModeOn((prev) => {
      if (prev) {
        setSelection(null);
        setRows([]);
        setBodies({});
        bodiesRef.current = {};
        baselineInner.current = {};
        setOverridden({});
        setSavingKeys(new Set());
      }
      return !prev;
    });
  }, [clearTimers]);

  // `@keyframes` names defined in the project — suggested as `animation` values.
  const animationSuggestions = useMemo(
    () => existingSelectors.map(keyframesName).filter((n): n is string => n !== null),
    [existingSelectors]
  );

  return {
    editMode,
    toggleEditMode,
    selection,
    rows,
    bodies,
    overridden,
    setBody,
    deleteRule,
    wrapRule,
    addSelector,
    renameSelector,
    renameAtRule,
    classSuggestions,
    existingSelectors,
    variableSuggestions,
    animationSuggestions,
    justCreatedKey,
    loading,
    savingKeys,
  };
}
