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
import { validateColorContrastSnapshot } from '../lib/colorContrast';
import {
  locateCssRules,
  applyCssRuleText,
  deleteCssRule,
  deleteCssRules,
  wrapCssRule,
  createCssRule,
  listCssClasses,
  listCssSelectors,
  listCssVariables,
  listStylesheets,
  replaceCssSelectorList,
  renameCssAtRule,
  splitCssSelectorList,
  mergeCascade,
  applyCascadeActivity,
  positionCascadeDrafts,
  rulesToLocate,
  rowKey,
  isStaleCssRuleError,
  selectCssRuleTargetFile,
  cssRuleWriteTargetFile,
  type MatchedRule,
  type RuleLocation,
  type CascadeRow,
  type CssRuleSourceIdentity,
} from '../lib/cssCascade';
import { parseRuleBody, serializeRuleBody, overriddenProps, type RuleBody } from '../lib/cssBody';
import { keyframesName, parseRulePrelude } from '../lib/cssStructures';
import { logger } from '../lib/logger';
import { useFrameRebind } from './useFrameRebind';
import { useSelectionCleared } from './useSelectionCleared';
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

export interface CascadeSelection {
  signature: ElementSignature;
  instanceCount: number;
  /** Proxy-issued selection identity, used to expire selection-scoped review plans. */
  selectionId?: string;
}

interface Params {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  projectPath: string;
  enabled: boolean;
  /** The project bundles CSS Modules (Next.js) — unmapped module-hashed selectors
   *  get a CSS-Modules explanation instead of the generic read-only reason. */
  cssModulesHint?: boolean;
  onToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

function findActivity(row: CascadeRow, rules: MatchedRule[]): MatchedRule | undefined {
  const identity = row.runtimeIdentity;
  return rules.find((rule) => {
    const candidate = rule.runtimeIdentity;
    if (identity && candidate) {
      return (
        identity.stylesheetIndex === candidate.stylesheetIndex &&
        JSON.stringify(identity.rulePath) === JSON.stringify(candidate.rulePath) &&
        identity.selectorMemberIndex === candidate.selectorMemberIndex
      );
    }
    return rule.sourceOrder === row.sourceOrder && rule.selector === row.selector;
  });
}

function identitySelectors(identity: CssRuleSourceIdentity): string[] {
  return identity.selectorMembers.filter((_, index) => index !== identity.selectorMemberIndex);
}

function cascadeActivityOverrides(
  rows: Map<string, CascadeRow>,
  rules: MatchedRule[],
  previous: Record<string, Map<string, string>>
): Record<string, Map<string, string>> {
  const next = { ...previous };
  for (const [key, row] of rows) {
    const match = findActivity(row, rules);
    if (match) next[key] = overriddenProps(match);
  }
  return next;
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
  const [pendingSaveKeys, setPendingSaveKeys] = useState<Set<string>>(() => new Set());
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
  const savePromises = useRef<Record<string, Promise<CssRuleSourceIdentity | undefined>>>({});
  const scheduleSaveRef = useRef<(key: string) => void>(() => {});

  const selTokenRef = useRef(0);
  const activityRef = useRef<MatchedRule[] | null>(null);
  const refreshWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshRequestIdRef = useRef(0);
  // The last selected element's signature — replayed after an HMR reload so the
  // panel re-reads the element's current source (instant sync after edits).
  const lastSignatureRef = useRef<ElementSignature | null>(null);
  const contrastSelectionRef = useRef<{
    selectionId: string;
    domPath: string;
    requestId: number;
  } | null>(null);
  const contrastRequestIdRef = useRef(0);
  const projectPathRef = useRef(projectPath);
  const previousProjectPathRef = useRef(projectPath);
  projectPathRef.current = projectPath;
  const selectedInstanceCountRef = useRef(1);

  const clearRefreshWatchdog = useCallback(() => {
    if (refreshWatchdogRef.current !== null) {
      clearTimeout(refreshWatchdogRef.current);
      refreshWatchdogRef.current = null;
    }
    refreshRequestIdRef.current += 1;
  }, []);
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

  /** Refresh source snapshots for sibling rows after a known write to the same sheet.
   *  If a row's current authored body no longer matches what it was loaded with, it
   *  stays read-only until the next selection instead of inheriting a newer identity
   *  and risking an overwrite of external edits. */
  const refreshSourceIdentities = useCallback(
    async (
      changedIdentity: CssRuleSourceIdentity,
      keepKey?: string,
      force = false,
      token = selTokenRef.current
    ) => {
      const currentProject = projectPath;
      const matched = activityRef.current;
      let locateByRuntime = new Map<MatchedRule, RuleLocation>();
      if (matched) {
        const toLocate = rulesToLocate(matched);
        const queries = toLocate.map((entry) => entry.query);
        try {
          const locations = queries.length ? await locateCssRules(currentProject, queries) : [];
          if (projectPathRef.current !== currentProject || selTokenRef.current !== token) {
            return;
          }
          toLocate.forEach((entry, index) => {
            locateByRuntime.set(matched[entry.index], locations[index]);
          });
        } catch {
          locateByRuntime = new Map();
        }
      }
      if (projectPathRef.current !== currentProject || selTokenRef.current !== token) return;
      setRows((previous) =>
        previous.map((row) => {
          const key = rowKey(row);
          if (key === keepKey || row.sourceIdentity?.sourcePath !== changedIdentity.sourcePath) {
            return row;
          }
          if (!force && row.sourceIdentity.sourceVersion === changedIdentity.sourceVersion)
            return row;
          const active = matched ? findActivity(row, matched) : undefined;
          const location = active ? locateByRuntime.get(active) : undefined;
          if (
            location?.status === 'resolved' &&
            location.source_identity &&
            row.innerText === location.inner_text
          ) {
            return {
              ...row,
              editable: true,
              file: location.file,
              line: location.line,
              innerText: location.inner_text,
              sourceIdentity: location.source_identity,
              sharedSelectors: identitySelectors(location.source_identity),
              runtimeIdentity: undefined,
              readonlyReason: undefined,
            };
          }
          return {
            ...row,
            editable: false,
            sourceIdentity: undefined,
            runtimeIdentity: undefined,
            readonlyReason: 'The stylesheet changed. Reselect the element to refresh this rule.',
          };
        })
      );
    },
    [projectPath]
  );

  // Nothing is selected any more — either the cascade we are showing was read
  // out of a frame the editor has since left, or the user clicked the canvas
  // background and dropped the selection.
  const forgetSelection = useCallback(() => {
    clearRefreshWatchdog();
    contrastSelectionRef.current = null;
    activityRef.current = null;
    ++selTokenRef.current;
    selectedInstanceCountRef.current = 1;
    setSelection(null);
    setRows([]);
    setBodies({});
    bodiesRef.current = {};
    baselineInner.current = {};
    setOverridden({});
    lastSignatureRef.current = null;
  }, [clearRefreshWatchdog]);
  useFrameRebind(iframeRef, forgetSelection);
  useSelectionCleared(iframeRef, forgetSelection);

  const cancelScheduledSave = useCallback((key: string) => {
    clearTimeout(saveTimers.current[key]);
    delete saveTimers.current[key];
    setPendingSaveKeys((previous) => {
      if (!previous.has(key)) return previous;
      const next = new Set(previous);
      next.delete(key);
      return next;
    });
  }, []);

  const clearTimers = useCallback(() => {
    Object.values(previewTimers.current).forEach(clearTimeout);
    Object.values(saveTimers.current).forEach(clearTimeout);
    previewTimers.current = {};
    saveTimers.current = {};
    setPendingSaveKeys(new Set());
    clearRefreshWatchdog();
  }, [clearRefreshWatchdog]);

  /** Re-read the selected element's cascade after a verified source mutation. */
  const refreshSelection = useCallback(() => {
    const signature = lastSignatureRef.current;
    if (!editMode || !signature) return;
    clearRefreshWatchdog();
    const requestId = ++refreshRequestIdRef.current;
    setLoading(true);
    refreshWatchdogRef.current = setTimeout(() => {
      if (refreshRequestIdRef.current !== requestId) return;
      refreshWatchdogRef.current = null;
      setLoading(false);
    }, 2000);
    post({ type: 'ss:reselect', signature });
  }, [clearRefreshWatchdog, editMode, post]);

  // A project switch invalidates any cascade or source lookup still in flight and
  // drops the previous project's selection, row bodies, and proposed destinations.
  useEffect(() => {
    if (previousProjectPathRef.current === projectPath) return;
    previousProjectPathRef.current = projectPath;
    ++selTokenRef.current;
    clearTimers();
    activityRef.current = null;
    lastSignatureRef.current = null;
    contrastSelectionRef.current = null;
    selectedInstanceCountRef.current = 1;
    createdRowsRef.current = new Map();
    draftKeysRef.current = new Set();
    draftIndexRef.current = new Map();
    bodiesRef.current = {};
    baselineInner.current = {};
    setSelection(null);
    setRows([]);
    setBodies({});
    setOverridden({});
    setSavingKeys(new Set());
    setLoading(false);
    setClassSuggestions([]);
    setExistingSelectors([]);
    setVariableSuggestions([]);
  }, [projectPath, clearTimers]);

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
        selectionId?: string;
        domPath?: string;
        requestId?: number;
        contrastSnapshot?: unknown;
        computedColor?: string;
        computedBackgroundColor?: string;
        count?: number;
        rules?: MatchedRule[];
      } | null;
      if (!d) return;

      if (d.type === 'ss:contrastDirty') {
        const current = contrastSelectionRef.current;
        if (
          !current ||
          d.selectionId !== current.selectionId ||
          d.domPath !== current.domPath ||
          lastSignatureRef.current?.domPath !== current.domPath
        ) {
          return;
        }
        const requestId = ++contrastRequestIdRef.current;
        current.requestId = requestId;
        post({
          type: 'ss:requestContrastSnapshot',
          selectionId: current.selectionId,
          domPath: current.domPath,
          requestId,
        });
        return;
      }

      if (d.type === 'ss:contrastSnapshot') {
        const current = contrastSelectionRef.current;
        const lastSignature = lastSignatureRef.current;
        if (
          !current ||
          !lastSignature ||
          d.requestId !== current.requestId ||
          d.selectionId !== current.selectionId ||
          d.domPath !== current.domPath ||
          lastSignature.domPath !== current.domPath
        ) {
          return;
        }
        const contrastSnapshot = validateColorContrastSnapshot(d.contrastSnapshot);
        if (!contrastSnapshot) return;
        selectedInstanceCountRef.current =
          contrastSnapshot.groupCount ?? selectedInstanceCountRef.current;
        const nextSignature = {
          ...lastSignature,
          contrastSnapshot: {
            ...contrastSnapshot,
            groupCount: selectedInstanceCountRef.current,
          },
          computedColor:
            typeof d.computedColor === 'string' ? d.computedColor : lastSignature.computedColor,
          computedBackgroundColor:
            typeof d.computedBackgroundColor === 'string'
              ? d.computedBackgroundColor
              : lastSignature.computedBackgroundColor,
        };
        lastSignatureRef.current = nextSignature;
        setSelection((prev) =>
          prev && prev.signature.domPath === current.domPath
            ? {
                ...prev,
                signature: {
                  ...prev.signature,
                  contrastSnapshot: nextSignature.contrastSnapshot,
                  computedColor: nextSignature.computedColor,
                  computedBackgroundColor: nextSignature.computedBackgroundColor,
                },
              }
            : prev
        );
        return;
      }

      if (d.type === 'ss:select' && d.signature) {
        const instanceCount = d.count ?? 1;
        selectedInstanceCountRef.current = instanceCount;
        const rawSnapshot = validateColorContrastSnapshot(d.signature.contrastSnapshot);
        const signature: ElementSignature = {
          ...d.signature,
          contrastSnapshot: rawSnapshot ? { ...rawSnapshot, groupCount: instanceCount } : undefined,
        };
        contrastSelectionRef.current =
          typeof d.selectionId === 'string' &&
          d.selectionId.length > 0 &&
          d.selectionId.length <= 128 &&
          typeof signature.domPath === 'string'
            ? { selectionId: d.selectionId, domPath: signature.domPath, requestId: 0 }
            : null;
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
        const nextPath = signature.domPath;
        const sameElement =
          !!prev &&
          (prevPath != null || nextPath != null
            ? prevPath === nextPath
            : prev.tagName === signature.tagName && prev.className === signature.className);
        lastSignatureRef.current = signature;
        activityRef.current = null;
        ++selTokenRef.current;
        clearTimers();
        post({ type: 'ss:clearRulePreview' });
        setSelection({
          signature,
          instanceCount,
          ...(typeof d.selectionId === 'string' && d.selectionId.length > 0
            ? { selectionId: d.selectionId }
            : {}),
        });
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
        return;
      }

      if (d.type === 'ss:cascadeActivity' && Array.isArray(d.rules)) {
        if (
          !contrastSelectionRef.current ||
          d.selectionId !== contrastSelectionRef.current.selectionId
        )
          return;
        activityRef.current = d.rules;
        setRows((prev) => applyCascadeActivity(prev, d.rules!));
        setOverridden((prev) => cascadeActivityOverrides(rowByKeyRef.current, d.rules!, prev));
        return;
      }

      if (d.type === 'ss:cascade' && Array.isArray(d.rules)) {
        const matched = d.rules;
        const token = selTokenRef.current;
        // The initial cascade contains the same exact runtime identities as a
        // later resize activity update. Keep it available immediately so a source
        // write can refresh sibling rows without waiting for the viewport to move.
        activityRef.current = matched;
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
            if (selTokenRef.current !== token || projectPathRef.current !== projectPath) return;
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
            const sameRule = (a: CascadeRow, b: CascadeRow) => {
              const aSource = a.sourceIdentity;
              const bSource = b.sourceIdentity;
              if (aSource && bSource) {
                return (
                  aSource.sourcePath === bSource.sourcePath &&
                  aSource.selectorOffset === bSource.selectorOffset
                );
              }
              return (
                a.selector === b.selector &&
                (a.mediaText ?? null) === (b.mediaText ?? null) &&
                (a.file ?? null) === (b.file ?? null)
              );
            };
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
            const draftRows: CascadeRow[] = [];

            // Draft cards: the element's own selectors (classes, then tag) with no base
            // rule yet — empty editable cards placed in cascade order. They aren't
            // written to source until the first property is saved (see saveRule).
            draftKeysRef.current = new Set();
            const sig = lastSignatureRef.current;
            if (sig) {
              const targetFile = selectCssRuleTargetFile(finalRows);
              if (selTokenRef.current === token && projectPathRef.current === projectPath) {
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
                    draft: true,
                    draftTargetFile: targetFile,
                  };
                  const key = rowKey(draft);
                  draftKeysRef.current.add(key);
                  nextBodies[key] = { items: [] };
                  nextBaseline[key] = '\n';
                  nextOverridden[key] = new Map();
                  draftRows.push(draft);
                }
              }
            }

            const rowsWithDrafts = positionCascadeDrafts([...finalRows, ...draftRows]);
            const activity = activityRef.current;
            setRows(activity ? applyCascadeActivity(rowsWithDrafts, activity) : rowsWithDrafts);
            setBodies(nextBodies);
            bodiesRef.current = nextBodies;
            baselineInner.current = nextBaseline;
            setOverridden(
              activity
                ? cascadeActivityOverrides(
                    new Map(rowsWithDrafts.map((r) => [rowKey(r), r])),
                    activity,
                    nextOverridden
                  )
                : nextOverridden
            );
          } catch (err) {
            logger.error('[CssCascade] locate failed', {
              error: formatCommandError(asCommandError(err)),
            });
            if (selTokenRef.current === token && projectPathRef.current === projectPath) {
              setRows(mergeCascade(matched, new Map(), { cssModulesHint }));
              onToast(toastText(err), 'error');
            }
          } finally {
            if (selTokenRef.current === token && projectPathRef.current === projectPath) {
              setLoading(false);
            }
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
      if (!row || !row.editable || row.selector == null || !body || !row.runtimeIdentity) return;
      if (projectPathRef.current !== projectPath) return;
      post({
        type: 'ss:previewRuleText',
        ruleKey: key,
        identity: row.runtimeIdentity,
        // Keep the browser's full selector list. Editing a matched member still edits
        // the authored shared rule and must not drop its sibling selectors in preview.
        cssText: `${row.runtimeIdentity.selectorList} {${serializeRuleBody(body)}}`,
      });
    },
    [post, projectPath]
  );

  /** Persist a rule's current body to source (drift-guarded), then bake the preview. */
  const saveRuleNow = useCallback(
    async (key: string): Promise<CssRuleSourceIdentity | undefined> => {
      const row = rowByKeyRef.current.get(key);
      const body = bodiesRef.current[key];
      if (!row || !row.editable || row.selector == null || !body) return undefined;
      if (projectPathRef.current !== projectPath) return undefined;
      const oldInner = baselineInner.current[key];
      const newInner = serializeRuleBody(body);
      if (oldInner === undefined || newInner === oldInner) return row.sourceIdentity;
      const targetFile = cssRuleWriteTargetFile(row);
      if (!targetFile) {
        if (row.draft) {
          onToast('No verified stylesheet destination is known for this selector yet.', 'info');
        }
        return undefined;
      }
      const token = selTokenRef.current;
      let writeTargetFile = targetFile;
      setSavingKeys((prev) => new Set(prev).add(key));
      post({ type: 'ss:suppressReload' });
      try {
        let sourceIdentity = row.sourceIdentity;
        let sourceBaseline = oldInner;
        // A draft's rule doesn't exist in source yet — create the (empty) rule on its
        // first real property, then write the body into it. After this it's a normal card.
        if (draftKeysRef.current.has(key)) {
          sourceIdentity = await createCssRule(projectPath, targetFile, row.selector);
          if (selTokenRef.current !== token || projectPathRef.current !== projectPath)
            return undefined;
          sourceBaseline = sourceIdentity.innerText;
          draftKeysRef.current.delete(key);
        }
        if (!sourceIdentity) {
          onToast(
            'This rule has no verified source occurrence. Reselect the element to refresh it.',
            'info'
          );
          return undefined;
        }
        let nextIdentity: CssRuleSourceIdentity;
        try {
          nextIdentity = await applyCssRuleText(
            projectPath,
            writeTargetFile,
            row.selector,
            row.mediaText,
            sourceBaseline,
            newInner,
            sourceIdentity
          );
        } catch (err) {
          if (!isStaleCssRuleError(err)) throw err;
          let locations: RuleLocation[];
          try {
            locations = await locateCssRules(projectPath, [
              { selector: row.selector, mediaText: row.mediaText, href: null },
            ]);
          } catch {
            throw err;
          }
          const location = locations[0];
          if (location?.status !== 'resolved' || !location.source_identity) throw err;
          if (selTokenRef.current !== token || projectPathRef.current !== projectPath)
            return undefined;
          writeTargetFile = location.file;
          sourceBaseline = location.inner_text;
          sourceIdentity = location.source_identity;
          nextIdentity = await applyCssRuleText(
            projectPath,
            writeTargetFile,
            row.selector,
            row.mediaText,
            sourceBaseline,
            newInner,
            sourceIdentity
          );
        }
        if (selTokenRef.current !== token || projectPathRef.current !== projectPath)
          return undefined;
        const latestBody = bodiesRef.current[key] ?? body;
        const savedRow: CascadeRow = {
          ...row,
          file: writeTargetFile,
          draft: false,
          draftTargetFile: undefined,
          innerText: nextIdentity.innerText,
          sourceIdentity: nextIdentity,
          sharedSelectors: identitySelectors(nextIdentity),
        };
        const savedKey = rowKey(savedRow);
        if (savedKey !== key) {
          const pendingPreview = previewTimers.current[key];
          if (pendingPreview !== undefined) clearTimeout(pendingPreview);
          delete previewTimers.current[key];
          const pendingSave = saveTimers.current[key];
          if (pendingSave !== undefined) clearTimeout(pendingSave);
          delete saveTimers.current[key];
          bodiesRef.current[savedKey] = latestBody;
          delete bodiesRef.current[key];
          delete baselineInner.current[key];
          setBodies((previous) => {
            const next = { ...previous, [savedKey]: latestBody };
            delete next[key];
            return next;
          });
          setOverridden((previous) => {
            const next = { ...previous, [savedKey]: previous[key] ?? new Map() };
            delete next[key];
            return next;
          });
          setPendingSaveKeys((previous) => {
            if (!previous.has(key)) return previous;
            const next = new Set(previous);
            next.delete(key);
            next.add(savedKey);
            return next;
          });
          previewTimers.current[savedKey] = setTimeout(() => {
            delete previewTimers.current[savedKey];
            previewRule(savedKey);
          }, PREVIEW_DEBOUNCE_MS);
        }
        baselineInner.current[savedKey] = nextIdentity.innerText;
        setRows((previous) => previous.map((item) => (rowKey(item) === key ? savedRow : item)));
        post({ type: 'ss:commitRulePreview', ruleKey: key });
        void refreshSourceIdentities(nextIdentity, savedKey, false, token);
        if (serializeRuleBody(latestBody) !== nextIdentity.innerText) {
          scheduleSaveRef.current(savedKey);
        }
        void trackEvent('visual_edit_saved', { kind: 'style', mode: 'css-code' });
        return nextIdentity;
      } catch (err) {
        if (selTokenRef.current !== token || projectPathRef.current !== projectPath)
          return undefined;
        logger[isStaleCssRuleError(err) ? 'warn' : 'error']('[CssCascade] write-back failed', {
          error: formatCommandError(asCommandError(err)),
        });
        onToast(
          'The CSS source changed since this rule was loaded. Reselect the element before editing.',
          'info'
        );
        return undefined;
      } finally {
        setSavingKeys((prev) => {
          const n = new Set(prev);
          n.delete(key);
          return n;
        });
      }
    },
    [projectPath, onToast, post, previewRule, refreshSourceIdentities]
  );

  /** Serialize saves for one row so an explicit Split flush cannot race its debounce. */
  const saveRule = useCallback(
    (key: string): Promise<CssRuleSourceIdentity | undefined> => {
      const previous = savePromises.current[key] ?? Promise.resolve(undefined);
      const operation = previous.catch(() => undefined).then(() => saveRuleNow(key));
      savePromises.current[key] = operation;
      const clear = () => {
        if (savePromises.current[key] === operation) delete savePromises.current[key];
      };
      void operation.then(clear, clear);
      return operation;
    },
    [saveRuleNow]
  );

  const scheduleSave = useCallback(
    (key: string) => {
      cancelScheduledSave(key);
      setPendingSaveKeys((previous) => new Set(previous).add(key));
      saveTimers.current[key] = setTimeout(() => {
        delete saveTimers.current[key];
        setPendingSaveKeys((previous) => {
          if (!previous.has(key)) return previous;
          const next = new Set(previous);
          next.delete(key);
          return next;
        });
        void saveRule(key);
      }, SAVE_DEBOUNCE_MS);
    },
    [cancelScheduledSave, saveRule]
  );
  scheduleSaveRef.current = scheduleSave;

  /** Remove the selected selector-list member or whole rule, using its exact identity. */
  const deleteRule = useCallback(
    async (key: string, removeMemberOnly = false) => {
      const row = rowByKeyRef.current.get(key);
      if (!row || !row.editable || row.file == null || row.selector == null || !row.sourceIdentity)
        return;
      clearTimeout(previewTimers.current[key]);
      cancelScheduledSave(key);
      const token = selTokenRef.current;
      post({ type: 'ss:suppressReload' });
      try {
        await deleteCssRule(
          projectPath,
          row.file,
          row.selector,
          row.mediaText,
          baselineInner.current[key] ?? '',
          row.sourceIdentity,
          removeMemberOnly
        );
        if (projectPathRef.current !== projectPath || selTokenRef.current !== token) return;
        post({ type: 'ss:clearRulePreview', ruleKey: key });
        post({
          type: removeMemberOnly ? 'ss:removeSelectorMemberPreview' : 'ss:deleteRulePreview',
          ruleKey: key,
          identity: row.runtimeIdentity,
        });
        setRows((prev) => prev.filter((r) => rowKey(r) !== key));
        setBodies((prev) => {
          const n = { ...prev };
          delete n[key];
          return n;
        });
        delete bodiesRef.current[key];
        delete baselineInner.current[key];
        void refreshSourceIdentities(row.sourceIdentity, undefined, true, token);
        void trackEvent('visual_edit_saved', { kind: 'rule', mode: 'css-code' });
      } catch (err) {
        if (projectPathRef.current !== projectPath || selTokenRef.current !== token) return;
        // Stale (the rule changed or went away since the card was seeded) is
        // an expected editing race, not a bug. Unlike the body-preserving
        // writes below this is NOT retried against the re-located rule: that
        // would delete content the user hasn't seen (issue #1008).
        logger[isStaleCssRuleError(err) ? 'warn' : 'error']('[CssCascade] delete failed', {
          error: formatCommandError(asCommandError(err)),
        });
        onToast(toastText(err), 'error');
      }
    },
    [cancelScheduledSave, projectPath, onToast, post, refreshSourceIdentities]
  );

  const removeSelectorMember = useCallback((key: string) => deleteRule(key, true), [deleteRule]);

  const deleteRules = useCallback(
    async (keys: string[]) => {
      const selected = keys
        .map((key) => ({ key, row: rowByKeyRef.current.get(key) }))
        .filter(
          (item): item is { key: string; row: CascadeRow } =>
            item.row?.editable === true && item.row.file != null && item.row.sourceIdentity != null
        );
      if (selected.length !== keys.length || selected.length === 0) {
        onToast(
          'Some rules no longer have a verified source occurrence. Reselect the element.',
          'info'
        );
        return;
      }
      const file = selected[0].row.file!;
      if (selected.some((item) => item.row.file !== file)) {
        onToast('Rules from different stylesheets cannot be deleted as one media group.', 'info');
        return;
      }
      const token = selTokenRef.current;
      for (const { key } of selected) {
        clearTimeout(previewTimers.current[key]);
        cancelScheduledSave(key);
        post({ type: 'ss:clearRulePreview', ruleKey: key });
      }
      post({ type: 'ss:suppressReload' });
      try {
        await deleteCssRules(
          projectPath,
          file,
          selected.map(({ row }) => row.sourceIdentity!)
        );
        if (projectPathRef.current !== projectPath || selTokenRef.current !== token) return;
        post({
          type: 'ss:deleteRulesPreview',
          identities: selected.map(({ row }) => row.runtimeIdentity).filter(Boolean),
        });
        const removedKeys = new Set(keys);
        setRows((previous) => previous.filter((row) => !removedKeys.has(rowKey(row))));
        setBodies((previous) => {
          const next = { ...previous };
          for (const key of keys) delete next[key];
          return next;
        });
        for (const key of keys) {
          delete bodiesRef.current[key];
          delete baselineInner.current[key];
        }
        void refreshSourceIdentities(selected[0].row.sourceIdentity!, undefined, true, token);
        void trackEvent('visual_edit_saved', { kind: 'rule', mode: 'css-code' });
      } catch (err) {
        if (projectPathRef.current !== projectPath || selTokenRef.current !== token) return;
        onToast(toastText(err), 'error');
      }
    },
    [cancelScheduledSave, projectPath, onToast, post, refreshSourceIdentities]
  );

  const splitSelectorList = useCallback(
    async (key: string) => {
      const row = rowByKeyRef.current.get(key);
      if (
        !row?.editable ||
        !row.file ||
        !row.selector ||
        !row.sourceIdentity ||
        row.sourceIdentity.selectorMembers.length < 2 ||
        row.sourceIdentity.selectorListSplitSafe !== true
      ) {
        return;
      }
      const token = selTokenRef.current;
      clearTimeout(previewTimers.current[key]);
      cancelScheduledSave(key);
      try {
        // Flush the row's debounced body write through the same per-row save queue before
        // asking Rust to split the source rule. This keeps the declarations identical in
        // every resulting rule and gives the split a current exact source snapshot.
        let identity = await saveRule(key);
        if (projectPathRef.current !== projectPath || selTokenRef.current !== token) return;
        if (!identity) {
          onToast(
            'This rule could not be saved before splitting. Reselect it and try again.',
            'info'
          );
          return;
        }
        const latestBody = bodiesRef.current[key];
        if (latestBody && serializeRuleBody(latestBody) !== baselineInner.current[key]) {
          identity = await saveRule(key);
        }
        if (!identity) {
          onToast(
            'This rule could not be saved before splitting. Reselect it and try again.',
            'info'
          );
          return;
        }
        const runtimeIdentity =
          rowByKeyRef.current.get(key)?.runtimeIdentity ?? row.runtimeIdentity;
        post({ type: 'ss:suppressReload' });
        post({ type: 'ss:commitRulePreview', ruleKey: key });
        const result = await splitCssSelectorList(projectPath, row.file, identity);
        if (projectPathRef.current !== projectPath || selTokenRef.current !== token) return;

        const remaps = new Map(
          result.remappedRules.map((remap) => [
            JSON.stringify([remap.oldSelectorOffset, remap.selectorMemberIndex]),
            remap.identity,
          ])
        );
        const remapRow = (candidate: CascadeRow): CascadeRow => {
          const oldIdentity = candidate.sourceIdentity;
          if (!oldIdentity || oldIdentity.sourcePath !== row.file) {
            return { ...candidate, runtimeIdentity: undefined };
          }
          const nextIdentity = remaps.get(
            JSON.stringify([oldIdentity.selectorOffset, oldIdentity.selectorMemberIndex])
          );
          const oldMember = oldIdentity.selectorMembers[oldIdentity.selectorMemberIndex];
          const isSplitRule = oldIdentity.selectorOffset === identity.selectorOffset;
          const matchesExactMember =
            nextIdentity &&
            oldMember === nextIdentity.matchedSelector &&
            oldIdentity.contextPath.join('\u0000') === nextIdentity.contextPath.join('\u0000') &&
            (isSplitRule || candidate.innerText === nextIdentity.innerText);
          if (!nextIdentity || !matchesExactMember) {
            return {
              ...candidate,
              editable: false,
              sourceIdentity: undefined,
              runtimeIdentity: undefined,
              readonlyReason: 'The stylesheet changed. Reselect the element to refresh this rule.',
            };
          }
          return {
            ...candidate,
            selector: nextIdentity.matchedSelector,
            innerText: nextIdentity.innerText,
            sourceIdentity: nextIdentity,
            sharedSelectors: identitySelectors(nextIdentity),
            runtimeIdentity: undefined,
          };
        };
        const previousRows = [...rowByKeyRef.current.values()];
        const nextRows = previousRows.map(remapRow);
        const movedKeys = new Map(
          previousRows.map((candidate, index) => [rowKey(candidate), rowKey(nextRows[index])])
        );
        const moveRecord = <T>(record: Record<string, T>): Record<string, T> => {
          const next = { ...record };
          for (const [oldKey, newKey] of movedKeys) {
            if (oldKey === newKey || !(oldKey in record)) continue;
            next[newKey] = record[oldKey];
            delete next[oldKey];
          }
          return next;
        };
        bodiesRef.current = moveRecord(bodiesRef.current);
        baselineInner.current = moveRecord(baselineInner.current);
        for (const nextRow of nextRows) {
          if (nextRow.sourceIdentity?.sourcePath === row.file) {
            baselineInner.current[rowKey(nextRow)] = nextRow.sourceIdentity.innerText;
          }
        }
        setRows(nextRows);
        rowByKeyRef.current = new Map(nextRows.map((candidate) => [rowKey(candidate), candidate]));
        setBodies((previous) => moveRecord(previous));
        setOverridden((previous) => moveRecord(previous));
        const nextCreatedRows = new Map<string, CascadeRow>();
        for (const [createdKey, createdRow] of createdRowsRef.current) {
          const nextCreatedRow = remapRow(createdRow);
          nextCreatedRows.set(movedKeys.get(createdKey) ?? rowKey(nextCreatedRow), nextCreatedRow);
        }
        createdRowsRef.current = nextCreatedRows;
        post({
          type: 'ss:splitSelectorListPreview',
          identity: runtimeIdentity,
          ruleKey: key,
        });
        const signature = lastSignatureRef.current;
        if (signature) {
          setTimeout(() => {
            if (projectPathRef.current === projectPath && selTokenRef.current === token) {
              post({ type: 'ss:reselect', signature });
            }
          }, 0);
        }
      } catch (err) {
        if (projectPathRef.current !== projectPath || selTokenRef.current !== token) return;
        onToast(toastText(err), 'error');
      }
    },
    [cancelScheduledSave, onToast, post, projectPath, saveRule]
  );

  /**
   * Run a body-preserving source write (rename, re-condition, wrap) against a
   * card's rule. When the backend rejects it as stale — the rule was renamed or
   * reformatted since the card was seeded — re-locate the rule in the current
   * source and retry ONCE with its real file and body, as `saveRule` does
   * (issues #584/#1008). Retries with the exact source identity returned by
   * a fresh lookup and returns that matched identity with the write result.
   */
  const writeWithStaleRetry = useCallback(
    async <T>(
      row: CascadeRow & {
        file: string;
        selector: string;
        sourceIdentity: CssRuleSourceIdentity;
      },
      oldInner: string,
      write: (file: string, oldInner: string, sourceIdentity: CssRuleSourceIdentity) => Promise<T>
    ): Promise<{ value: T; matchedIdentity: CssRuleSourceIdentity }> => {
      const initialIdentity = row.sourceIdentity;
      try {
        return {
          value: await write(row.file, oldInner, initialIdentity),
          matchedIdentity: initialIdentity,
        };
      } catch (err) {
        if (!isStaleCssRuleError(err)) throw err;
        const locs = await locateCssRules(projectPath, [
          { selector: row.selector, mediaText: row.mediaText, href: null },
        ]).catch(() => []);
        const loc = locs[0];
        if (loc?.status !== 'resolved' || !loc.source_identity) throw err;
        return {
          value: await write(loc.file, loc.inner_text, loc.source_identity),
          matchedIdentity: loc.source_identity,
        };
      }
    },
    [projectPath]
  );

  /** Wrap a top-level rule in an at-rule (the `@` above the selector). For `@media`
   *  we optimistically update the card's media context so editing continues; HMR
   *  recompiles the moved rule. */
  const wrapRule = useCallback(
    async (key: string, atPrelude: string) => {
      const row = rowByKeyRef.current.get(key);
      if (!row || !row.editable || row.file == null || row.selector == null) return;
      if (!row.sourceIdentity) {
        onToast(
          'This rule has no verified source occurrence. Reselect the element to refresh it.',
          'info'
        );
        return;
      }
      clearTimeout(previewTimers.current[key]);
      cancelScheduledSave(key);
      const token = selTokenRef.current;
      post({ type: 'ss:suppressReload' });
      const target = {
        ...row,
        file: row.file,
        selector: row.selector,
        sourceIdentity: row.sourceIdentity,
      };
      try {
        const { value: identity } = await writeWithStaleRetry(
          target,
          baselineInner.current[key] ?? '',
          (file, oldInner, sourceIdentity) =>
            wrapCssRule(
              projectPath,
              file,
              target.selector,
              target.mediaText,
              atPrelude,
              oldInner,
              sourceIdentity
            )
        );
        if (projectPathRef.current !== projectPath || selTokenRef.current !== token) return;
        const m = atPrelude.trim();
        const lower = m.toLowerCase();
        const media = lower.startsWith('@media') ? m.slice('@media'.length).trim() : row.mediaText;
        const nextRow = {
          ...row,
          sourceIdentity: identity,
          innerText: identity.innerText,
          mediaText: media,
          layer: lower.startsWith('@layer') ? m.slice('@layer'.length).trim() || null : row.layer,
          container: lower.startsWith('@container')
            ? m.slice('@container'.length).trim() || null
            : row.container,
          supports: lower.startsWith('@supports')
            ? m.slice('@supports'.length).trim() || null
            : row.supports,
          runtimeIdentity: undefined,
        };
        setRows((previous) =>
          previous.map((candidate) => (rowKey(candidate) === key ? nextRow : candidate))
        );
        baselineInner.current[key] = identity.innerText;
        post({ type: 'ss:clearRulePreview', ruleKey: key });
        void refreshSourceIdentities(identity, key, false, token);
        scheduleSave(key);
        void trackEvent('visual_edit_saved', { kind: 'rule', mode: 'css-code' });
      } catch (err) {
        if (projectPathRef.current !== projectPath || selTokenRef.current !== token) return;
        // A still-stale rejection means the rule disappeared during re-location.
        logger[isStaleCssRuleError(err) ? 'warn' : 'error']('[CssCascade] wrap failed', {
          error: formatCommandError(asCommandError(err)),
        });
        onToast(toastText(err), 'error');
      }
    },
    [
      cancelScheduledSave,
      projectPath,
      onToast,
      post,
      refreshSourceIdentities,
      scheduleSave,
      writeWithStaleRetry,
    ]
  );

  /** Create a brand-new rule for `selector` and add it as an editable card you can
   *  style immediately (optimistic — the real cascade refreshes on HMR/reselect). */
  const addSelector = useCallback(
    async (input: string, fixedAtPrelude?: string) => {
      const raw = input.trim();
      if (!raw) return;

      // The smart selector field composes `[@condition] [selector]`. Split it: a
      // condition (`@media (…)`, `@container (…)`, `@supports (…)`) creates a CONDITIONAL
      // rule (`@condition { selector { } }`); a bare condition with no selector targets
      // the element's primary selector. A plain selector creates a base rule.
      const parsed = fixedAtPrelude
        ? { condition: fixedAtPrelude, selector: raw }
        : parseRulePrelude(raw);
      const condition = parsed.condition ?? (raw.startsWith('@') ? raw : null);
      let sel = fixedAtPrelude ? raw : parsed.condition ? parsed.selector : raw;
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

      let targetFile = selectCssRuleTargetFile([...rowByKeyRef.current.values()]);
      if (!targetFile) {
        try {
          targetFile = (await listStylesheets(projectPath))[0];
        } catch {
          targetFile = undefined;
        }
      }
      if (!targetFile) {
        onToast('No stylesheet found to add the rule to.', 'info');
        return;
      }

      // Pin a rule into the panel as an editable card. Created rules persist across
      // cascade refreshes (see createdRowsRef) so they never silently vanish.
      const pin = (identity: CssRuleSourceIdentity) => {
        const file = identity.sourcePath;
        const innerText = identity.innerText;
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
          sourceIdentity: identity,
          sharedSelectors: identitySelectors(identity),
        };
        const key = rowKey(newRow);
        const body = parseRuleBody(innerText);
        createdRowsRef.current.set(key, newRow);
        setRows((prev) => [newRow, ...prev.filter((r) => rowKey(r) !== key)]);
        setBodies((prev) => ({ ...prev, [key]: body }));
        bodiesRef.current[key] = body;
        baselineInner.current[key] = innerText;
        setOverridden((prev) => ({ ...prev, [key]: new Map() }));
        return key;
      };

      post({ type: 'ss:suppressReload' });
      const token = selTokenRef.current;
      try {
        const identity = await createCssRule(projectPath, targetFile, sel, atPrelude);
        if (selTokenRef.current !== token || projectPathRef.current !== projectPath) return;
        const pinnedKey = pin(identity);
        void refreshSourceIdentities(identity, pinnedKey, false, token);
        void trackEvent('visual_edit_saved', { kind: 'rule', mode: 'css-code' });
      } catch (err) {
        if (selTokenRef.current !== token || projectPathRef.current !== projectPath) return;
        // A Tauri-rejected CommandError is a plain object — String(err) renders
        // "[object Object]", which both broke the already-exists detection below
        // and made the logged error useless (issue #380).
        const msg = formatCommandError(asCommandError(err));
        // The rule already exists in source but doesn't match this element (so it
        // isn't in the cascade). Surface the real rule for editing instead of erroring
        // — typing an existing selector should just open it.
        if (msg.includes('already exists')) {
          try {
            const [loc] = await locateCssRules(projectPath, [
              { selector: sel, mediaText: null, href: null },
            ]);
            if (selTokenRef.current !== token || projectPathRef.current !== projectPath) return;
            if (loc?.status === 'resolved' && loc.source_identity) {
              const pinnedKey = pin(loc.source_identity);
              void refreshSourceIdentities(loc.source_identity, pinnedKey, false, token);
              return;
            }
          } catch {
            /* fall through to a soft message below */
          }
          // It exists but we couldn't pin it here (e.g. it lives in a sheet we can't
          // open). Don't show a scary validation error — explain plainly.
          // By design, not a malfunction — 'error' toasts auto-file bug
          // reports (issue #869).
          onToast(`“${sel}” already exists — open it from its stylesheet.`, 'info');
          return;
        }
        logger.error('[CssCascade] add selector failed', { error: msg });
        onToast(toastText(err), 'error');
      }
    },
    [projectPath, onToast, post, refreshSourceIdentities]
  );

  /** Replace a rule's full selector list. Keep the resulting card pinned across
   *  reselects if none of its new members match the current element. */
  const renameSelector = useCallback(
    async (key: string, newSelector: string) => {
      const row = rowByKeyRef.current.get(key);
      const ns = newSelector.trim();
      if (!row || !row.editable || row.file == null || row.selector == null) return;
      if (!ns || ns === (row.sourceIdentity?.selector ?? row.selector)) return;
      if (!row.sourceIdentity) {
        onToast(
          'This rule has no verified source occurrence. Reselect the element to refresh it.',
          'info'
        );
        return;
      }
      // Cancel any in-flight debounced preview/save on the OLD key — once we re-key below
      // it would fire against a dead key and silently drop the edit.
      clearTimeout(previewTimers.current[key]);
      cancelScheduledSave(key);
      const token = selTokenRef.current;
      const previousRuntimeIdentity = row.runtimeIdentity;
      // A source selector change invalidates the exact CSSOM selector-list evidence.
      // Restore any temporary body preview before the source and runtime identities move.
      post({ type: 'ss:clearRulePreview', ruleKey: key });
      post({ type: 'ss:suppressReload' });
      const target = {
        ...row,
        file: row.file,
        selector: row.selector,
        sourceIdentity: row.sourceIdentity,
      };
      try {
        const { value: identity } = await writeWithStaleRetry(
          target,
          baselineInner.current[key] ?? '',
          (file, oldInner, sourceIdentity) =>
            replaceCssSelectorList(
              projectPath,
              file,
              target.selector,
              target.mediaText,
              oldInner,
              ns,
              sourceIdentity
            )
        );
        if (projectPathRef.current !== projectPath || selTokenRef.current !== token) return;
        const newRow: CascadeRow = {
          ...row,
          selector: identity.matchedSelector,
          innerText: identity.innerText,
          sourceIdentity: identity,
          sharedSelectors: identitySelectors(identity),
          runtimeIdentity: undefined,
        };
        const newKey = rowKey(newRow);
        // Move the per-rule state to the new key.
        if (bodiesRef.current[key]) {
          bodiesRef.current[newKey] = bodiesRef.current[key];
          delete bodiesRef.current[key];
        }
        if (baselineInner.current[key] !== undefined) {
          delete baselineInner.current[key];
        }
        baselineInner.current[newKey] = identity.innerText;
        setRows((prev) =>
          prev.map((r) => (rowKey(r) === key ? newRow : { ...r, runtimeIdentity: undefined }))
        );
        rowByKeyRef.current = new Map(
          [...rowByKeyRef.current.values()].map((candidate) => [
            rowKey(candidate) === key ? newKey : rowKey(candidate),
            rowKey(candidate) === key ? newRow : { ...candidate, runtimeIdentity: undefined },
          ])
        );
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
        createdRowsRef.current.delete(key);
        createdRowsRef.current.set(newKey, newRow);
        if (previousRuntimeIdentity) {
          post({
            type: 'ss:replaceSelectorListPreview',
            identity: previousRuntimeIdentity,
            selectorList: identity.selectorMembers.join(', '),
          });
        }
        // Re-arm the save under the NEW key (deferred so the row refs settle first) so a
        // body edit that was mid-debounce when the rename landed still persists. saveRule
        // is a no-op when the body matches its baseline, so this is safe to always schedule.
        scheduleSave(newKey);
        void refreshSourceIdentities(identity, newKey, false, token);
        void trackEvent('visual_edit_saved', { kind: 'rule', mode: 'css-code' });
      } catch (err) {
        if (projectPathRef.current !== projectPath || selTokenRef.current !== token) return;
        scheduleSave(key);
        // Still stale after re-locating is an expected source race (issue #1008).
        logger[isStaleCssRuleError(err) ? 'warn' : 'error']('[CssCascade] rename failed', {
          error: formatCommandError(asCommandError(err)),
        });
        onToast(toastText(err), 'error');
      }
    },
    [
      cancelScheduledSave,
      projectPath,
      onToast,
      post,
      scheduleSave,
      refreshSourceIdentities,
      writeWithStaleRetry,
    ]
  );

  /** Change the `@media` condition wrapping a rule. Re-keys on the new media; HMR
   *  refreshes the (shared) wrapper's sibling rules. */
  const renameAtRule = useCallback(
    async (key: string, newMedia: string) => {
      const row = rowByKeyRef.current.get(key);
      const nm = newMedia.trim();
      if (!row || !row.editable || row.file == null || row.selector == null || !nm) return;
      if (nm === row.mediaText) return;
      if (!row.sourceIdentity) {
        onToast(
          'This rule has no verified source occurrence. Reselect the element to refresh it.',
          'info'
        );
        return;
      }
      // Cancel any in-flight debounced preview/save on the OLD key (re-keyed below).
      clearTimeout(previewTimers.current[key]);
      cancelScheduledSave(key);
      const token = selTokenRef.current;
      post({ type: 'ss:suppressReload' });
      const target = {
        ...row,
        file: row.file,
        selector: row.selector,
        sourceIdentity: row.sourceIdentity,
      };
      try {
        const { value: renameResult, matchedIdentity: sourceIdentity } = await writeWithStaleRetry(
          target,
          baselineInner.current[key] ?? '',
          (file, oldInner, currentIdentity) =>
            renameCssAtRule(
              projectPath,
              file,
              target.selector,
              target.mediaText,
              oldInner,
              nm,
              currentIdentity
            )
        );
        if (projectPathRef.current !== projectPath || selTokenRef.current !== token) return;
        const renamedIdentity = renameResult.selected;
        const remappedByOldMember = new Map(
          renameResult.remappedRules.map(
            (remap) =>
              [
                JSON.stringify([remap.oldSelectorOffset, remap.selectorMemberIndex]),
                remap.identity,
              ] as const
          )
        );
        const affectedRows = [...rowByKeyRef.current.values()].flatMap((candidate) => {
          const previousIdentity = candidate.sourceIdentity;
          if (
            !previousIdentity ||
            previousIdentity.sourcePath !== sourceIdentity.sourcePath ||
            previousIdentity.sourceVersion !== sourceIdentity.sourceVersion
          ) {
            return [];
          }
          const identity = remappedByOldMember.get(
            JSON.stringify([previousIdentity.selectorOffset, previousIdentity.selectorMemberIndex])
          );
          return identity ? [{ candidate, identity }] : [];
        });
        if (!affectedRows.some(({ candidate }) => rowKey(candidate) === key)) {
          affectedRows.push({ candidate: row, identity: renamedIdentity });
        }

        const moves = affectedRows.map(({ candidate, identity }) => {
          const oldKey = rowKey(candidate);
          const oldNearestMedia = [...(candidate.sourceIdentity?.contextPath ?? [])]
            .reverse()
            .find((context) => /^@media\b/i.test(context.trim()));
          const newNearestMedia = [...identity.contextPath]
            .reverse()
            .find((context) => /^@media\b/i.test(context.trim()));
          const mediaContextChanged = oldNearestMedia !== newNearestMedia;
          const mediaText = mediaContextChanged
            ? (newNearestMedia?.replace(/^\s*@media\b/i, '').trim() ?? null)
            : candidate.mediaText;
          const minMatch = mediaContextChanged
            ? /min-width\s*:\s*([\d.]+)px/i.exec(mediaText ?? '')
            : null;
          const mediaMinPx = mediaContextChanged
            ? minMatch
              ? Math.round(parseFloat(minMatch[1]))
              : null
            : candidate.mediaMinPx;
          const nextRow: CascadeRow = {
            ...candidate,
            mediaText,
            mediaMinPx,
            contextPath: identity.contextPath,
            innerText: identity.innerText,
            sourceIdentity: identity,
            sharedSelectors: identitySelectors(identity),
            // The wrapper changed, so none of the previous CSSOM paths are reusable.
            runtimeIdentity: undefined,
          };
          return { oldKey, newKey: rowKey(nextRow), nextRow, candidate, identity };
        });
        const movedByOldKey = new Map(moves.map((move) => [move.oldKey, move]));
        const matched = activityRef.current;
        if (matched) {
          const refreshedByRuntime = new Map<MatchedRule, MatchedRule>();
          for (const { candidate, identity, nextRow } of moves) {
            const active = findActivity(candidate, matched);
            if (!active) continue;
            refreshedByRuntime.set(active, {
              ...active,
              mediaText: nextRow.mediaText,
              mediaMinPx: nextRow.mediaMinPx,
              contextPath: identity.contextPath,
              // The backend returned the exact new source identity; the old CSSOM path
              // belongs to the previous media wrapper and cannot be reused.
              runtimeIdentity: undefined,
            });
          }
          if (refreshedByRuntime.size > 0) {
            activityRef.current = matched.map((active) => refreshedByRuntime.get(active) ?? active);
          }
        }
        const moveRecord = <T>(record: Record<string, T>): Record<string, T> => {
          const next = { ...record };
          for (const { oldKey, newKey } of moves) {
            if (oldKey === newKey || !(oldKey in record)) continue;
            next[newKey] = record[oldKey];
            delete next[oldKey];
          }
          return next;
        };

        // Cancel callbacks that still point at the old identities before re-keying.
        for (const { oldKey } of moves) {
          clearTimeout(previewTimers.current[oldKey]);
          cancelScheduledSave(oldKey);
        }
        bodiesRef.current = moveRecord(bodiesRef.current);
        baselineInner.current = moveRecord(baselineInner.current);
        for (const { newKey, identity } of moves) {
          baselineInner.current[newKey] = identity.innerText;
        }
        setRows((prev) =>
          prev.map((candidate) => movedByOldKey.get(rowKey(candidate))?.nextRow ?? candidate)
        );
        setBodies((prev) => moveRecord(prev));
        setOverridden((prev) => moveRecord(prev));
        setSavingKeys((prev) => {
          const next = new Set(prev);
          for (const { oldKey, newKey } of moves) {
            if (oldKey !== newKey && next.delete(oldKey)) next.add(newKey);
          }
          return next;
        });

        // Keep optimistic rows attached to their new keys.
        const nextCreatedRows = new Map<string, CascadeRow>();
        for (const [createdKey, createdRow] of createdRowsRef.current) {
          const move = movedByOldKey.get(createdKey);
          nextCreatedRows.set(move?.newKey ?? createdKey, move?.nextRow ?? createdRow);
        }
        createdRowsRef.current = nextCreatedRows;
        draftKeysRef.current = new Set(
          [...draftKeysRef.current].map(
            (draftKey) => movedByOldKey.get(draftKey)?.newKey ?? draftKey
          )
        );
        // Re-arm pending body saves under the new identities (a no-op when the body
        // already matches its baseline).
        for (const { newKey } of moves) {
          scheduleSave(newKey);
        }
        void refreshSourceIdentities(
          renamedIdentity,
          moves.find((move) => move.oldKey === key)?.newKey,
          false,
          token
        );
        void trackEvent('visual_edit_saved', { kind: 'rule', mode: 'css-code' });
      } catch (err) {
        if (projectPathRef.current !== projectPath || selTokenRef.current !== token) return;
        // Still stale after re-locating is an expected source race (issue #1008).
        logger[isStaleCssRuleError(err) ? 'warn' : 'error']('[CssCascade] rename at-rule failed', {
          error: formatCommandError(asCommandError(err)),
        });
        onToast(toastText(err), 'error');
      }
    },
    [
      cancelScheduledSave,
      projectPath,
      onToast,
      post,
      scheduleSave,
      refreshSourceIdentities,
      writeWithStaleRetry,
    ]
  );

  /** Update one card's body model → debounced live preview + auto-save. */
  const setBody = useCallback(
    (key: string, body: RuleBody) => {
      bodiesRef.current = { ...bodiesRef.current, [key]: body };
      setBodies((prev) => ({ ...prev, [key]: body }));
      clearTimeout(previewTimers.current[key]);
      previewTimers.current[key] = setTimeout(() => previewRule(key), PREVIEW_DEBOUNCE_MS);
      scheduleSave(key);
    },
    [previewRule, scheduleSave]
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
    deleteRules,
    removeSelectorMember,
    splitSelectorList,
    wrapRule,
    addSelector,
    renameSelector,
    renameAtRule,
    classSuggestions,
    existingSelectors,
    variableSuggestions,
    animationSuggestions,
    loading,
    savingKeys,
    hasPendingWrites: pendingSaveKeys.size > 0 || savingKeys.size > 0,
    refreshSelection,
  };
}
