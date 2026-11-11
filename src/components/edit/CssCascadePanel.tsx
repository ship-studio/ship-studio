/**
 * Code-first CSS editor panel (vanilla-CSS projects) — the structured cascade card
 * GUI. Click an element → its whole cascade renders as a stack of cards (one per
 * rule, in cascade order), each rule's properties as editable GUI rows, nested
 * rules as nested cards. A GUI layer on real CSS, not abstracted controls.
 *
 * Shares the `ss-edit-panel` chrome (draggable header, pin, close) with the other
 * editor panels.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { PinIcon, FileTextIcon } from '@/components/icons';
import { CloseIcon, CheckIcon } from '@/components/icons';
import { PlusIcon } from '@/components/icons';
import { CopyIcon } from '@/components/icons';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { Spinner } from '../primitives/Spinner';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { IconButton } from '../primitives/IconButton';
import { SearchField } from '../primitives/SearchField';
import { Tooltip } from '../primitives/Tooltip';
import { ToggleButton } from '../primitives/ToggleButton';
import { Tabs, TabsList, TabsTab } from '../primitives/Tabs';
import { CascadeRuleCard } from './CascadeRuleCard';
import { CascadeSourceGroupCard } from './CascadeSourceGroupCard';
import { CssConsolidationReviewPopover } from './CssConsolidationReviewPopover';
import { ElementSettingsPanel } from './ElementSettingsPanel';
import { CssAnimationsPanel } from './CssAnimationsPanel';
import { MediaQueryGroupCard } from './MediaQueryGroupCard';
import { CascadeChip } from './CascadeChip';
import { CascadeToolbar } from './CascadeToolbar';
import { SuggestionPopover, suggestionOptionId, type Suggestion } from './SuggestionPopover';
import { WRAP_ITEMS, searchStructures, parseRulePrelude } from '../../lib/cssStructures';
import { isMediaQueryComplete } from '../../lib/mediaQueries';
import {
  cascadeSourceProvenance,
  groupCascadeRows,
  resolveCssSourceLine,
  rowKey,
  type CascadeGroupItem,
  type CascadeRow,
  type MatchedRuleQuery,
} from '../../lib/cssCascade';
import { searchCascadeRow } from '../../lib/cascadeSearch';
import {
  cascadeMediaCollapseKey,
  cascadeFileCollapseKey,
  cascadeSourceBackingFile,
  cascadeSourceCollapseKey,
  cascadeSourceFileLabel,
  CASCADE_DISPLAY_ORDER_PREFERENCE_KEY,
  cascadeRuleCollapseKey,
  collectNestedCollapseKeys,
  groupCascadeItemsByFile,
  isCascadeFileGroup,
  isCascadeGroupCollapseKey,
  orderCascadeRowsForDisplay,
  type CascadeFileGroup,
  type CascadeDisplayOrder,
} from '../../lib/cascadePresentation';
import { addDeclaration, parseRuleBody, type RuleBody } from '../../lib/cssBody';
import type { CascadeSelection } from '../../hooks/useCssCascadeEditor';
import type { ElementSettings } from '../../hooks/useElementSettings';
import type { useCssAnimations } from '../../hooks/useCssAnimations';
import { colorContrastContexts, type ColorVariableDefinition } from '../../lib/colorContrast';
import { useLocalStorageFlag } from '../../hooks/useLocalStorageFlag';
import { useElementDisplayPreferences } from '../../hooks/useElementDisplayPreferences';
import { getElementIcon } from './element-icons';
import { useCommands } from '../../commands/useCommands';
import type { OpenInCode } from '../../lib/code';

/** The panel's top-level view: element style/settings, or project-global animation CSS. */
type Scope = 'style' | 'settings' | 'animations';
const noRefreshCascade = () => undefined;

function isSimpleCssClassName(name: string): boolean {
  return /^(?:--|-[A-Za-z_]|[A-Za-z_])[A-Za-z0-9_-]*$/.test(name);
}

function mediaConditionKey(condition: string): string {
  return condition.replace(/\s+/g, '').toLowerCase();
}

function sourceNavigationQuery(row: CascadeRow): MatchedRuleQuery | null {
  if (!row.selector) return null;
  return {
    selector: row.selector,
    mediaText: row.mediaText,
    href: null,
    layer: row.layer,
    container: row.container ?? null,
    supports: row.supports ?? null,
    selectorMemberIndex: row.selectorMemberIndex,
    contextPath: row.contextPath,
    identityDeclarations: row.identityDeclarations,
    runtimeIdentity: row.runtimeIdentity,
  };
}

function rowBelongsToSourceFile(row: CascadeRow, file: string): boolean {
  const source = cascadeSourceProvenance(row);
  if (!source) return false;
  return source.kind === 'resolved' ? source.file === file : source.files.includes(file);
}

function firstSourceRowForFile(rows: readonly CascadeRow[], file: string): CascadeRow | undefined {
  return rows.find((row) => row.selector && rowBelongsToSourceFile(row, file));
}

function firstSourceCandidateLineForFile(
  rows: readonly CascadeRow[],
  file: string
): number | undefined {
  return (
    rows
      .flatMap((row) => row.sourceCandidates ?? [])
      .find((candidate) => candidate.file === file && candidate.line != null)?.line ?? undefined
  );
}

function rowsInCascadeItem(item: CascadeGroupItem): CascadeRow[] {
  return item.kind === 'media' ? item.rows : [item.row];
}

function sourceOccurrenceKey(row: CascadeRow): string | null {
  const identity = row.sourceIdentity;
  return identity ? JSON.stringify([identity.sourcePath, identity.selectorOffset]) : null;
}

interface DraftMediaQuery {
  id: number;
  condition: string;
  selectors: string[];
}

interface Props {
  selection: CascadeSelection | null;
  rows: CascadeRow[];
  loading: boolean;
  bodies: Record<string, RuleBody>;
  overridden: Record<string, Map<string, string>>;
  onChangeBody: (key: string, body: RuleBody) => void;
  onDeleteRule: (key: string) => void | Promise<void>;
  onDeleteRules?: (keys: string[]) => void | Promise<void>;
  onRemoveSelectorMember?: (key: string) => void | Promise<void>;
  onSplitSelectorList?: (key: string) => void | Promise<void>;
  onWrapRule: (key: string, atPrelude: string) => void;
  onRenameRule: (key: string, newSelector: string) => void;
  onRenameAtRule: (key: string, newMedia: string) => void;
  onAddSelector: (selector: string, atPrelude?: string) => void | Promise<void>;
  /** `.class` suggestions for the selector autocomplete. */
  selectorSuggestions: string[];
  /** Full text of every existing rule selector (`.card`, `@keyframes reveal`) — shown
   *  in "Add selector" so existing rules are discoverable and re-surfaced on a match. */
  existingSelectors: string[];
  /** Project CSS variables (`--foo`) for `var(--…)` value autocomplete. */
  variables: string[];
  /** Project `@keyframes` names for `animation` value autocomplete. */
  animations: string[];
  colorVariables?: readonly ColorVariableDefinition[];
  projectPath?: string;
  settings: ElementSettings;
  /** Project-global Animations editor state (`@keyframes`). */
  animationsState: ReturnType<typeof useCssAnimations>;
  onClose: () => void;
  /** Open a known cascade source in the workspace Code tab. */
  onOpenInCode?: OpenInCode;
  /** Re-read the current selection after a verified source mutation. */
  onRefreshCascade?: () => void;
  /** Keep snapshot-sensitive consolidation actions disabled while CSS writes are pending. */
  hasPendingWrites?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  /** Controlled view — lets the Cmd+K palette open the panel directly to Style,
   *  Variables, or Animate. Uncontrolled (local state) when omitted. */
  scope?: Scope;
  onScopeChange?: (scope: Scope) => void;
}

export function CssCascadePanel({
  selection,
  rows,
  loading,
  bodies,
  overridden,
  onChangeBody,
  onDeleteRule,
  onDeleteRules,
  onRemoveSelectorMember,
  onSplitSelectorList,
  onWrapRule,
  onRenameRule,
  onRenameAtRule,
  onAddSelector,
  selectorSuggestions,
  existingSelectors,
  variables,
  animations,
  colorVariables,
  projectPath,
  settings,
  animationsState,
  onClose,
  onOpenInCode,
  pinned = false,
  onTogglePin,
  scope: controlledScope,
  onScopeChange,
  onRefreshCascade,
  hasPendingWrites = false,
}: Props) {
  const colorContrast = useMemo(
    () => colorContrastContexts(selection?.signature.contrastSnapshot),
    [selection?.signature.contrastSnapshot]
  );
  const [localScope, setLocalScope] = useState<Scope>('style');
  const scope = controlledScope ?? localScope;
  const setScope = onScopeChange ?? setLocalScope;
  const [settingsVisitedSelectionKey, setSettingsVisitedSelectionKey] = useState<string | null>(
    () => (scope === 'settings' ? settings.selectionKey : null)
  );
  const mountSettingsPanel =
    settingsVisitedSelectionKey === settings.selectionKey || scope === 'settings';
  const imageDimensionRule = useMemo(() => {
    const selectedClasses = (selection?.signature.className ?? '').split(/\s+/).filter(Boolean);
    for (const className of selectedClasses) {
      if (!isSimpleCssClassName(className)) continue;
      const selector = `.${className}`;
      const row = rows.find(
        (candidate) =>
          candidate.selector === selector &&
          candidate.mediaText == null &&
          candidate.editable &&
          (candidate.draft ? Boolean(candidate.draftTargetFile) : Boolean(candidate.sourceIdentity))
      );
      if (row) return row;
    }
    return null;
  }, [rows, selection]);
  const setImageCssDimension = useCallback(
    (property: 'width' | 'height', value: string | null) => {
      const row = imageDimensionRule;
      if (!row) return false;
      if (
        value !== null &&
        typeof CSS !== 'undefined' &&
        typeof CSS.supports === 'function' &&
        !CSS.supports(property, value)
      ) {
        return false;
      }

      const key = rowKey(row);
      const body = bodies[key] ?? parseRuleBody(row.innerText ?? '\n');
      const propertyIndexes = body.items.flatMap((item, index) =>
        item.kind === 'decl' && item.prop.toLowerCase() === property ? [index] : []
      );
      if (value === null) {
        if (propertyIndexes.length === 0) return true;
        onChangeBody(key, {
          items: body.items.filter(
            (item) => !(item.kind === 'decl' && item.prop.toLowerCase() === property)
          ),
        });
        return true;
      }

      const lastIndex = propertyIndexes[propertyIndexes.length - 1];
      if (lastIndex === undefined) {
        onChangeBody(key, addDeclaration(body, { prop: property, value, important: false }));
      } else {
        onChangeBody(key, {
          items: body.items.map((item, index) =>
            index === lastIndex && item.kind === 'decl' ? { ...item, value } : item
          ),
        });
      }
      return true;
    },
    [bodies, imageDimensionRule, onChangeBody]
  );
  const imageCssDimensions = useMemo(() => {
    if (!imageDimensionRule) return undefined;
    const body =
      bodies[rowKey(imageDimensionRule)] ?? parseRuleBody(imageDimensionRule.innerText ?? '\n');
    const dimensions: Partial<Record<'width' | 'height', string>> = {};
    for (const item of body.items) {
      if (item.kind !== 'decl') continue;
      const property = item.prop.toLowerCase();
      if (property === 'width' || property === 'height') dimensions[property] = item.value;
    }
    return dimensions;
  }, [bodies, imageDimensionRule]);
  const refreshCascade = onRefreshCascade ?? noRefreshCascade;
  // Refresh the project-global data when its scope becomes visible.
  const reloadAnimations = animationsState.reload;
  useEffect(() => {
    if (scope === 'animations') void reloadAnimations();
  }, [scope, reloadAnimations]);
  // Copy ID: the element's selector (tag + classes), so you can paste it to your agent
  // and describe the change you want ("make a .button--secondary hover state pop").
  const { showToast } = useOptionalToast();
  const { copy: copyElementId, isCopied: idCopied } = useCopyToClipboard({
    onCopy: () => showToast('Element id copied — paste it to your agent', 'success'),
  });
  const { showTagIcons, showTagSansSerif, showTagColors } = useElementDisplayPreferences();
  // Collapse state keyed by rule identity (selector + media), not the per-element row
  // key — so minimizing a shared rule like `*` keeps it minimized across element
  // switches. Lives on the panel (which stays mounted), so it survives reselection.
  const [collapsedRules, setCollapsedRules] = useState<Set<string>>(() => new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [selectorEditRequest, setSelectorEditRequest] = useState<{
    sourceKey: string;
    rowKey: string;
    id: number;
  } | null>(null);
  const selectorEditRequestCounter = useRef(0);
  const [newestAtBottom, setNewestAtBottom] = useLocalStorageFlag(
    CASCADE_DISPLAY_ORDER_PREFERENCE_KEY,
    false
  );
  const displayOrder: CascadeDisplayOrder = newestAtBottom ? 'newest-bottom' : 'newest-top';
  const setDisplayOrder = useCallback(
    (order: CascadeDisplayOrder) => setNewestAtBottom(order === 'newest-bottom'),
    [setNewestAtBottom]
  );
  const [searchCollapsedOverrides, setSearchCollapsedOverrides] = useState<Map<string, boolean>>(
    () => new Map()
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const searchFieldId = useId();
  const [searchOpen, setSearchOpen] = useState(false);
  const searchFocusTargetRef = useRef<'input' | 'button' | null>(null);
  // A newly-composed media query has no selector (and therefore no cascade row) yet.
  // Keep it as an empty normal group until the user adds its first selector.
  const [draftMediaQueries, setDraftMediaQueries] = useState<DraftMediaQuery[]>([]);
  const draftMediaIndex = useRef(0);
  const query = searchTerm.trim();
  const normalizedQuery = query.toLocaleLowerCase();
  const searchActive = normalizedQuery.length > 0;
  const changeSearch = useCallback((next: string) => {
    setSearchTerm(next);
    setSearchCollapsedOverrides(new Map());
  }, []);
  const openSearch = useCallback(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
      return;
    }
    searchFocusTargetRef.current = 'input';
    setSearchOpen(true);
  }, [searchOpen]);
  const closeSearch = useCallback(() => {
    changeSearch('');
    searchFocusTargetRef.current = 'button';
    setSearchOpen(false);
  }, [changeSearch]);
  const toggleSearch = useCallback(() => {
    if (searchOpen) closeSearch();
    else openSearch();
  }, [closeSearch, openSearch, searchOpen]);
  useEffect(() => {
    const target = searchFocusTargetRef.current;
    if (target === 'input' && searchOpen) {
      searchInputRef.current?.focus();
      searchFocusTargetRef.current = null;
    } else if (target === 'button' && !searchOpen) {
      searchButtonRef.current?.focus();
      searchFocusTargetRef.current = null;
    }
  }, [searchOpen]);
  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeSearch();
  };
  const toggleCollapsed = useCallback((ruleKey: string) => {
    setCollapsedRules((prev) => {
      const next = new Set(prev);
      if (next.has(ruleKey)) next.delete(ruleKey);
      else next.add(ruleKey);
      return next;
    });
  }, []);
  const toggleSearchCollapsed = useCallback((ruleKey: string, collapsed: boolean) => {
    setSearchCollapsedOverrides((previous) => new Map(previous).set(ruleKey, collapsed));
  }, []);
  const allCollapseKeys = useMemo(() => {
    const keys = new Set<string>();
    // Source headers have their own controls; bulk actions only affect the cards inside them.
    for (const displayItem of groupCascadeItemsByFile(groupCascadeRows(rows))) {
      const items = isCascadeFileGroup(displayItem) ? displayItem.items : [displayItem];
      for (const item of items) {
        if (item.kind === 'media') keys.add(cascadeMediaCollapseKey(item.key));
        const itemRows = item.kind === 'media' ? item.rows : [item.row];
        for (const row of itemRows) {
          const ruleKey = cascadeRuleCollapseKey(row.selector ?? '', row.mediaText ?? '');
          keys.add(ruleKey);
          const body = bodies[rowKey(row)];
          if (body)
            collectNestedCollapseKeys(body, ruleKey).forEach((nestedKey) => keys.add(nestedKey));
        }
      }
    }
    for (const { id, selectors } of draftMediaQueries) {
      const mediaKey = `draft-media:${id}`;
      keys.add(mediaKey);
      selectors.forEach((selector) => keys.add(`${mediaKey}|${selector}`));
    }
    return [...keys];
  }, [bodies, draftMediaQueries, rows]);
  const animationCollapseKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const animation of animationsState.animations) {
      const ruleKey = cascadeRuleCollapseKey(animation.selector);
      keys.add(ruleKey);
      collectNestedCollapseKeys(animation.body, ruleKey).forEach((nestedKey) =>
        keys.add(nestedKey)
      );
    }
    return [...keys];
  }, [animationsState.animations]);
  const activeCollapseKeys = scope === 'animations' ? animationCollapseKeys : allCollapseKeys;
  const collapseAll = useCallback(() => {
    if (searchActive) {
      setSearchCollapsedOverrides((previous) => {
        const next = new Map([...previous].filter(([key]) => isCascadeGroupCollapseKey(key)));
        activeCollapseKeys.forEach((key) => next.set(key, true));
        return next;
      });
      return;
    }
    setCollapsedRules((previous) => {
      const next = new Set([...previous].filter(isCascadeGroupCollapseKey));
      activeCollapseKeys.forEach((key) => next.add(key));
      return next;
    });
  }, [activeCollapseKeys, searchActive]);
  const expandAll = useCallback(() => {
    if (searchActive) {
      setSearchCollapsedOverrides((previous) => {
        const next = new Map([...previous].filter(([key]) => isCascadeGroupCollapseKey(key)));
        activeCollapseKeys.forEach((key) => next.set(key, false));
        return next;
      });
      return;
    }
    setCollapsedRules((previous) => new Set([...previous].filter(isCascadeGroupCollapseKey)));
  }, [activeCollapseKeys, searchActive]);
  const allCollapsed =
    activeCollapseKeys.length > 0 &&
    activeCollapseKeys.every((key) =>
      searchActive ? searchCollapsedOverrides.get(key) === true : collapsedRules.has(key)
    );
  const collapseControl = useMemo(
    () => ({
      collapsedKeys: collapsedRules,
      searchCollapsedOverrides,
      toggle: toggleCollapsed,
      toggleSearch: toggleSearchCollapsed,
    }),
    [collapsedRules, searchCollapsedOverrides, toggleCollapsed, toggleSearchCollapsed]
  );
  const displayRows = useMemo(
    () => orderCascadeRowsForDisplay(rows, displayOrder),
    [displayOrder, rows]
  );
  const displayItems = useMemo(() => groupCascadeRows(displayRows), [displayRows]);
  const displayItemsBySource = useMemo(() => groupCascadeItemsByFile(displayItems), [displayItems]);
  const requestSelectorEdit = useCallback(
    (row: CascadeRow) => {
      const sourceKey = sourceOccurrenceKey(row);
      if (!sourceKey) return;
      changeSearch('');
      setCollapsedRules((previous) => {
        const next = new Set(previous);
        next.delete(cascadeRuleCollapseKey(row.selector ?? '', row.mediaText ?? ''));
        for (const sourceGroup of displayItemsBySource) {
          const items = isCascadeFileGroup(sourceGroup) ? sourceGroup.items : [sourceGroup];
          const targetItem = items.find((item) =>
            rowsInCascadeItem(item).some((candidate) => rowKey(candidate) === rowKey(row))
          );
          if (!targetItem) continue;
          if (isCascadeFileGroup(sourceGroup)) {
            next.delete(
              sourceGroup.kind === 'source'
                ? cascadeSourceCollapseKey(sourceGroup.source)
                : cascadeFileCollapseKey(sourceGroup.file)
            );
          }
          if (targetItem.kind === 'media') {
            next.delete(cascadeMediaCollapseKey(targetItem.key));
          }
          break;
        }
        return next;
      });
      setSelectorEditRequest({
        sourceKey,
        rowKey: rowKey(row),
        id: ++selectorEditRequestCounter.current,
      });
    },
    [changeSearch, displayItemsBySource]
  );
  const knownSourceFiles = useMemo(() => {
    const files = new Map<string, boolean>();
    for (const row of rows) {
      const source = cascadeSourceProvenance(row);
      if (source?.kind === 'resolved') {
        if (!files.has(source.file)) files.set(source.file, false);
      } else if (source?.kind === 'multiple') {
        source.files.forEach((file) => files.set(file, true));
      }
    }
    return [...files.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);
  const sourceNavigationRequestRef = useRef(0);
  useEffect(
    () => () => {
      sourceNavigationRequestRef.current += 1;
    },
    [
      projectPath,
      selection?.signature.domPath,
      selection?.signature.tagName,
      selection?.signature.className,
    ]
  );
  const openSourceInCode = useCallback(
    async (file: string, row: CascadeRow | undefined, candidateLine?: number) => {
      if (!onOpenInCode) return;
      const requestId = ++sourceNavigationRequestRef.current;
      if (candidateLine != null) {
        onOpenInCode(cascadeSourceBackingFile(file), candidateLine);
        return;
      }
      const matched = row && sourceNavigationQuery(row);
      if (!matched) {
        showToast(`No displayed CSS rule is available for ${file}.`, 'error');
        return;
      }
      if (!projectPath) {
        showToast(
          `Couldn't resolve the matching CSS rule in ${file}: project path is unavailable.`,
          'error'
        );
        return;
      }

      try {
        const line = await resolveCssSourceLine(projectPath, file, matched);
        if (requestId !== sourceNavigationRequestRef.current) return;
        onOpenInCode(cascadeSourceBackingFile(file), line);
      } catch (error) {
        if (requestId !== sourceNavigationRequestRef.current) return;
        const detail = formatCommandError(asCommandError(error));
        logger.warn('Could not resolve CSS source navigation target', { file, error: detail });
        showToast(`Couldn't resolve the matching CSS rule in ${file}: ${detail}`, 'error');
      }
    },
    [onOpenInCode, projectPath, showToast]
  );
  const openAnimationSourceInCode = useCallback(
    (file: string, line: number | undefined, selector: string) => {
      if (!onOpenInCode) return;
      const requestId = ++sourceNavigationRequestRef.current;
      const codeFile = cascadeSourceBackingFile(file);
      if (line != null) {
        onOpenInCode(codeFile, line);
        return;
      }
      if (!projectPath) {
        showToast(
          `Couldn't resolve the matching CSS rule in ${file}: project path is unavailable.`,
          'error'
        );
        return;
      }

      void resolveCssSourceLine(projectPath, file, { selector, mediaText: null, href: null })
        .then((resolvedLine) => {
          if (requestId === sourceNavigationRequestRef.current) {
            onOpenInCode(codeFile, resolvedLine);
          }
        })
        .catch((error) => {
          if (requestId !== sourceNavigationRequestRef.current) return;
          const detail = formatCommandError(asCommandError(error));
          logger.warn('Could not resolve animation source navigation target', {
            file,
            selector,
            error: detail,
          });
          showToast(`Couldn't resolve the matching CSS rule in ${file}: ${detail}`, 'error');
        });
    },
    [onOpenInCode, projectPath, showToast]
  );
  useCommands(
    () =>
      onOpenInCode && selection && scope === 'style'
        ? knownSourceFiles.map(([file, ambiguousCandidate]) => ({
            id: `css.openSource.${encodeURIComponent(file)}`,
            title: `Open ${ambiguousCandidate ? 'candidate ' : ''}${cascadeSourceFileLabel(file)} in Code`,
            subtitle: `${ambiguousCandidate ? 'Ambiguous CSS source candidate' : 'CSS source'} ${file} — opens at its first matching rule`,
            icon: <FileTextIcon size={14} />,
            category: 'navigation' as const,
            when: 'project' as const,
            keywords: ['css', 'style', 'source', 'file', 'code', 'open'],
            run: () => {
              const candidateLine = firstSourceCandidateLineForFile(displayRows, file);
              void openSourceInCode(file, firstSourceRowForFile(displayRows, file), candidateLine);
            },
          }))
        : [],
    [displayRows, knownSourceFiles, onOpenInCode, openSourceInCode, scope, selection]
  );
  useCommands(() => {
    if (scope !== 'style' || !projectPath) return [];
    const sourceRows = new Map<string, CascadeRow>();
    for (const row of rows) {
      const sourceKey = sourceOccurrenceKey(row);
      if (
        row.editable &&
        !row.draft &&
        row.sourceIdentity &&
        sourceKey &&
        !sourceRows.has(sourceKey)
      ) {
        sourceRows.set(sourceKey, row);
      }
    }
    const memberRows = rows.filter(
      (row) =>
        row.editable && !row.draft && row.sourceIdentity && (row.sharedSelectors?.length ?? 0) > 0
    );
    return [
      ...[...sourceRows.entries()].map(([, row]) => ({
        id: `css.editSelectorList.${encodeURIComponent(row.sourceIdentity!.sourcePath)}.${row.sourceIdentity!.selectorOffset}`,
        title: `Edit selector list ${row.sourceIdentity!.selector}`,
        subtitle: `Replace the full selector list in ${row.sourceIdentity!.sourcePath}`,
        icon: <FileTextIcon size={14} />,
        category: 'action' as const,
        when: 'project' as const,
        keywords: ['css', 'selector', 'list', 'edit', 'rename', 'comma'],
        run: () => requestSelectorEdit(row),
      })),
      ...(onSplitSelectorList
        ? [...sourceRows.entries()]
            .filter(
              ([, row]) =>
                row.sourceIdentity?.selectorListSplitSafe === true &&
                row.sourceIdentity.selectorMembers.length > 1
            )
            .map(([, row]) => ({
              id: `css.splitSelectorList.${encodeURIComponent(row.sourceIdentity!.sourcePath)}.${row.sourceIdentity!.selectorOffset}`,
              title: `Split selector list ${row.sourceIdentity!.selector}`,
              subtitle: `Create one adjacent rule per selector with the same declarations and cascade location`,
              icon: <FileTextIcon size={14} />,
              category: 'action' as const,
              when: 'project' as const,
              keywords: ['css', 'selector', 'split', 'shared', 'independent'],
              run: () => void onSplitSelectorList(rowKey(row)),
            }))
        : []),
      ...(onRemoveSelectorMember
        ? memberRows.map((row) => ({
            id: `css.removeSelectorMember.${encodeURIComponent(row.sourceIdentity!.sourcePath)}.${row.sourceIdentity!.selectorOffset}.${row.sourceIdentity!.selectorMemberIndex}`,
            title: `Remove ${row.selector} from its shared rule`,
            subtitle: 'Keep the other selectors and declarations in place',
            icon: <FileTextIcon size={14} />,
            category: 'action' as const,
            when: 'project' as const,
            keywords: ['css', 'selector', 'remove', 'shared', 'member'],
            run: () => void onRemoveSelectorMember(rowKey(row)),
          }))
        : []),
    ];
  }, [onRemoveSelectorMember, onSplitSelectorList, projectPath, requestSelectorEdit, rows, scope]);
  const sourcePathMatchesSearch = (path: string) =>
    path.toLocaleLowerCase().includes(normalizedQuery) ||
    cascadeSourceFileLabel(path).toLocaleLowerCase().includes(normalizedQuery);
  const sourceMatchesSearch = (group: CascadeFileGroup) => {
    if (!searchActive) return false;
    if (group.kind === 'destination') return sourcePathMatchesSearch(group.file);
    const { source } = group;
    return (
      (source.kind === 'multiple' && 'ambiguous'.includes(normalizedQuery)) ||
      (source.kind === 'resolved'
        ? sourcePathMatchesSearch(source.file)
        : source.files.some(sourcePathMatchesSearch))
    );
  };
  const rowMatchesSearch = (row: CascadeRow) => {
    if (!searchActive) return true;
    const sourceMatches = [
      row.draft ? row.draftTargetFile : row.file,
      ...(row.draft ? [] : (row.sourceFiles ?? [])),
    ]
      .filter((file): file is string => Boolean(file))
      .some(sourcePathMatchesSearch);
    return searchCascadeRow(row, bodies[rowKey(row)], normalizedQuery).matches || sourceMatches;
  };
  const itemMatchesSearch = (item: CascadeGroupItem) => {
    if (!searchActive) return true;
    return item.kind === 'rule'
      ? rowMatchesSearch(item.row)
      : item.condition.toLocaleLowerCase().includes(normalizedQuery) ||
          item.rows.some(rowMatchesSearch);
  };
  const itemHasVisibleGeneratedStyle = (item: CascadeGroupItem, revealAll = false) => {
    if (item.kind === 'rule') {
      return Boolean(item.row.generatedCssOutput) && (revealAll || rowMatchesSearch(item.row));
    }

    const conditionMatches =
      searchActive && item.condition.toLocaleLowerCase().includes(normalizedQuery);
    return item.rows.some(
      (row) =>
        Boolean(row.generatedCssOutput) && (revealAll || conditionMatches || rowMatchesSearch(row))
    );
  };
  const hasVisibleGeneratedStyles =
    scope === 'style' &&
    !loading &&
    displayItemsBySource.some((item) =>
      isCascadeFileGroup(item)
        ? item.items.some((cascadeItem) =>
            itemHasVisibleGeneratedStyle(cascadeItem, sourceMatchesSearch(item))
          )
        : itemHasVisibleGeneratedStyle(item)
    );
  const orderedDraftMediaQueries = useMemo(
    () => (displayOrder === 'newest-top' ? draftMediaQueries : [...draftMediaQueries].reverse()),
    [displayOrder, draftMediaQueries]
  );
  const visibleDraftMediaQueries = searchActive
    ? orderedDraftMediaQueries.flatMap((draft) => {
        const conditionMatches = draft.condition.toLocaleLowerCase().includes(normalizedQuery);
        const selectors = conditionMatches
          ? draft.selectors
          : draft.selectors.filter((selector) =>
              selector.toLocaleLowerCase().includes(normalizedQuery)
            );
        return conditionMatches || selectors.length > 0 ? [{ ...draft, selectors }] : [];
      })
    : orderedDraftMediaQueries;
  const hasVisibleCascadeItems =
    visibleDraftMediaQueries.length > 0 ||
    displayItemsBySource.some((item) =>
      isCascadeFileGroup(item)
        ? sourceMatchesSearch(item) || item.items.some(itemMatchesSearch)
        : itemMatchesSearch(item)
    );
  const classes = (selection?.signature.className ?? '').split(/\s+/).filter(Boolean);
  const selectedSelector = selection
    ? `${selection.signature.tagName}${classes.map((className) => `.${className}`).join('')}`
    : '';
  const copyIdValue =
    selection && settings.location
      ? `${settings.location.file}:${settings.location.line} (${selectedSelector})`
      : selectedSelector;
  const targetClassName = [
    'ss-cascade-target',
    showTagSansSerif && 'ss-cascade-target--sans-serif',
    !showTagColors && 'ss-cascade-target--monochrome',
  ]
    .filter(Boolean)
    .join(' ');
  const selectedTagIcon =
    selection && showTagIcons ? getElementIcon(selection.signature.tagName) : undefined;
  const selectedTarget = selection ? (
    <div className={targetClassName}>
      {selectedTagIcon ? (
        <span className="ss-cascade-target__tag-icon" title={`<${selection.signature.tagName}>`}>
          {selectedTagIcon}
        </span>
      ) : (
        <span className="ss-cascade-target__tag" data-tone="tag">
          {selection.signature.tagName}
        </span>
      )}
      {selectedTagIcon && classes.length === 0 && (
        <span className="ss-cascade-target__tag" data-tone="tag">
          {selection.signature.tagName}
        </span>
      )}
      <span className="ss-cascade-target__selector">
        {classes.length > 0 && (
          <span className="ss-cascade-target__classes">
            {classes.map((c) => (
              <span key={c} className="ss-cascade-target__class">
                .{c}
              </span>
            ))}
          </span>
        )}
        {selection.instanceCount > 1 && (
          <span className="ss-cascade-target__count">×{selection.instanceCount}</span>
        )}
      </span>
      <Tooltip
        content={
          <>
            Copy ID &amp; Location: <code className="ss-tooltip__value">{copyIdValue}</code>
          </>
        }
      >
        <IconButton
          className="ss-cascade-target__copy"
          variant="ghost"
          size="compact"
          icon={idCopied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          aria-label={idCopied ? 'Element ID copied' : 'Copy ID'}
          onClick={() => void copyElementId(copyIdValue)}
        />
      </Tooltip>
    </div>
  ) : null;
  // The element's own classes lead the "Add selector" suggestions (so a class you
  // just added in Settings is one click away from getting a rule), then the rest of
  // the project's classes, then every existing rule selector (incl. `@keyframes …`)
  // so what's already defined is discoverable and re-openable rather than duplicated.
  const addSelectorOptions = [
    ...new Set([...classes.map((c) => `.${c}`), ...selectorSuggestions, ...existingSelectors]),
  ];

  const addDraftMediaQuery = (condition: string) => {
    const next = condition.trim();
    setDraftMediaQueries((current) => {
      const duplicate = current.some(({ condition: item }) =>
        next ? mediaConditionKey(item) === mediaConditionKey(next) : item === ''
      );
      return duplicate
        ? current
        : [{ id: ++draftMediaIndex.current, condition: next, selectors: [] }, ...current];
    });
  };
  const renameDraftMediaQuery = async (id: number, next: string) => {
    const value = next.trim();
    const draft = draftMediaQueries.find((query) => query.id === id);
    if (draft && isMediaQueryComplete(value) && draft.selectors.length > 0) {
      setDraftMediaQueries((queries) => queries.filter((query) => query.id !== id));
      for (const selector of draft.selectors) {
        await onAddSelector(selector, `@media ${value}`);
      }
      return;
    }
    setDraftMediaQueries((queries) =>
      queries.map((query) => (query.id === id ? { ...query, condition: value } : query))
    );
  };
  const deleteDraftMediaQuery = (id: number) => {
    setDraftMediaQueries((queries) => queries.filter((query) => query.id !== id));
  };
  const addDraftMediaSelector = (id: number, selector: string) => {
    const value = selector.trim();
    if (!value) return;
    setDraftMediaQueries((queries) =>
      queries.map((query) =>
        query.id !== id || query.selectors.includes(value)
          ? query
          : { ...query, selectors: [...query.selectors, value] }
      )
    );
  };
  const deleteDraftMediaSelector = (id: number, selector: string) => {
    setDraftMediaQueries((queries) =>
      queries.map((query) =>
        query.id === id
          ? { ...query, selectors: query.selectors.filter((item) => item !== selector) }
          : query
      )
    );
  };

  const renderRuleCard = (
    row: CascadeRow,
    insideMedia = false,
    enclosingConditionMatches = false,
    insideSource = false,
    sourceGroupMatches = false
  ) => {
    const key = rowKey(row);
    const collapseKey = cascadeRuleCollapseKey(row.selector ?? '', row.mediaText ?? '');
    const searchResult = searchCascadeRow(row, bodies[key], normalizedQuery);
    const rowSourceMatches =
      searchActive &&
      [row.draft ? row.draftTargetFile : row.file, ...(row.draft ? [] : (row.sourceFiles ?? []))]
        .filter((file): file is string => Boolean(file))
        .some(sourcePathMatchesSearch);
    const matchesAll =
      searchResult.matchesAll ||
      enclosingConditionMatches ||
      sourceGroupMatches ||
      rowSourceMatches;
    const searchMatches =
      searchActive &&
      (searchResult.matches || enclosingConditionMatches || sourceGroupMatches || rowSourceMatches);
    const searchCollapseOverride = searchCollapsedOverrides.get(collapseKey);
    const collapsed = searchMatches
      ? (searchCollapseOverride ?? false)
      : collapsedRules.has(collapseKey);
    const onToggleCollapse = () => {
      if (searchMatches) toggleSearchCollapsed(collapseKey, !collapsed);
      else toggleCollapsed(collapseKey);
    };
    const mediaText = insideMedia ? null : row.mediaText;
    const showSource = !insideMedia && !insideSource && !row.draft;
    if (row.editable && bodies[key]) {
      return (
        <CascadeRuleCard
          key={key}
          editable
          selector={row.selector ?? ''}
          file={showSource ? row.file : undefined}
          line={showSource ? row.line : undefined}
          mediaText={mediaText}
          layer={row.layer}
          container={row.container}
          supports={row.supports}
          inactive={insideMedia ? false : row.inactiveMedia}
          overridden={row.inactiveMedia ? new Map() : (overridden[key] ?? new Map())}
          body={bodies[key]}
          collapseKey={collapseKey}
          collapseControl={collapseControl}
          draft={row.draft}
          draftTargetKnown={row.draft ? row.draftTargetFile != null : undefined}
          unmatched={row.unmatched}
          onChange={(b) => onChangeBody(key, b)}
          onDelete={() => {
            void onDeleteRule(key);
          }}
          sharedSelectors={row.sharedSelectors}
          selectorList={row.sourceIdentity?.selector ?? row.runtimeIdentity?.selectorList}
          selectorListSplitSafe={row.sourceIdentity?.selectorListSplitSafe}
          selectorEditRequestId={
            selectorEditRequest?.rowKey === key ? selectorEditRequest.id : undefined
          }
          onSelectorEditRequestHandled={(requestId) =>
            setSelectorEditRequest((current) => (current?.id === requestId ? null : current))
          }
          onRemoveSelector={
            onRemoveSelectorMember ? () => void onRemoveSelectorMember(key) : undefined
          }
          onSplitSelectorList={
            onSplitSelectorList ? () => void onSplitSelectorList(key) : undefined
          }
          // A draft rule doesn't exist in source yet — no rename/wrap until it is
          // created by adding the first property.
          onWrap={row.draft || insideMedia ? undefined : (at) => onWrapRule(key, at)}
          onRename={row.draft ? undefined : (s) => onRenameRule(key, s)}
          onRenameAtRule={row.draft || insideMedia ? undefined : (m) => onRenameAtRule(key, m)}
          selectorSuggestions={selectorSuggestions}
          variables={variables}
          colorVariables={colorVariables}
          projectPath={projectPath}
          colorContrast={colorContrast}
          animations={animations}
          collapsed={collapsed}
          onToggleCollapse={onToggleCollapse}
          searchTerm={searchTerm}
          searchMatchesAll={matchesAll}
          searchCollapseOverride={searchMatches ? searchCollapseOverride : undefined}
        />
      );
    }
    return (
      <CascadeRuleCard
        key={key}
        editable={false}
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        collapseKey={collapseKey}
        collapseControl={collapseControl}
        searchTerm={searchTerm}
        searchMatchesAll={matchesAll}
        searchCollapseOverride={searchMatches ? searchCollapseOverride : undefined}
        selector={row.selector ?? 'element.style'}
        selectorList={row.sourceIdentity?.selector ?? row.runtimeIdentity?.selectorList}
        file={showSource ? row.file : undefined}
        line={showSource ? row.line : undefined}
        sourceFiles={showSource ? row.sourceFiles : undefined}
        mediaText={mediaText}
        layer={row.layer}
        container={row.container}
        supports={row.supports}
        inactive={insideMedia ? false : row.inactiveMedia}
        overridden={row.inactiveMedia ? new Map() : (overridden[key] ?? new Map())}
        readonlyReason={row.readonlyReason}
        colorVariables={colorVariables}
        decls={row.declarations.map((d) => ({
          prop: d.prop,
          value: d.value,
          important: d.important,
        }))}
      />
    );
  };

  const renderCascadeItem = (
    item: CascadeGroupItem,
    insideSource = false,
    sourceGroupMatches = false
  ) => {
    if (item.kind === 'rule') {
      if (searchActive && !sourceGroupMatches && !rowMatchesSearch(item.row)) return null;
      return renderRuleCard(item.row, false, false, insideSource, sourceGroupMatches);
    }

    const conditionMatches =
      searchActive && item.condition.toLocaleLowerCase().includes(normalizedQuery);
    const visibleRows =
      sourceGroupMatches || conditionMatches ? item.rows : item.rows.filter(rowMatchesSearch);
    if (searchActive && !sourceGroupMatches && !conditionMatches && visibleRows.length === 0)
      return null;
    const groupCollapseKey = cascadeMediaCollapseKey(item.key);
    const groupMatches =
      searchActive && (sourceGroupMatches || conditionMatches || visibleRows.length > 0);
    const searchCollapseOverride = searchCollapsedOverrides.get(groupCollapseKey);
    const groupCollapsed = groupMatches
      ? (searchCollapseOverride ?? false)
      : collapsedRules.has(groupCollapseKey);
    const groupEditableRow = item.rows.find(
      (row) => row.editable && !row.draft && bodies[rowKey(row)]
    );
    const groupDeletableRows = item.rows.filter(
      (row) => row.editable && !row.draft && bodies[rowKey(row)]
    );
    const sourceFiles = insideSource
      ? []
      : [...new Set(item.rows.flatMap((row) => (row.file ? [row.file] : (row.sourceFiles ?? []))))];

    return (
      <MediaQueryGroupCard
        key={item.key}
        condition={item.condition}
        file={sourceFiles.length === 1 ? sourceFiles[0] : undefined}
        sourceFiles={sourceFiles}
        inactive={item.rows.some((row) => row.inactiveMedia)}
        collapsed={groupCollapsed}
        onToggleCollapse={() => {
          if (groupMatches) {
            toggleSearchCollapsed(groupCollapseKey, !groupCollapsed);
          } else {
            toggleCollapsed(groupCollapseKey);
          }
        }}
        onRename={
          groupEditableRow
            ? (condition) => onRenameAtRule(rowKey(groupEditableRow), condition)
            : undefined
        }
        onDelete={
          onDeleteRules && groupDeletableRows.length === item.rows.length
            ? () => void onDeleteRules(groupDeletableRows.map(rowKey))
            : undefined
        }
        addSelector={
          groupEditableRow ? (
            <AddSelectorBar
              onAddSelector={onAddSelector}
              suggestions={addSelectorOptions}
              existing={existingSelectors}
              fixedCondition={`@media ${item.condition}`}
            />
          ) : undefined
        }
      >
        {visibleRows.map((row) =>
          renderRuleCard(
            row,
            true,
            conditionMatches || sourceGroupMatches,
            insideSource,
            sourceGroupMatches
          )
        )}
      </MediaQueryGroupCard>
    );
  };

  const renderSourceGroup = (group: CascadeFileGroup) => {
    const groupSourceMatches = sourceMatchesSearch(group);
    if (searchActive && !groupSourceMatches && !group.items.some(itemMatchesSearch)) return null;
    const displayedSourceRows = group.items.flatMap((item) => {
      const itemRows = rowsInCascadeItem(item);
      if (!searchActive || groupSourceMatches) return itemRows;
      if (item.kind === 'media' && item.condition.toLocaleLowerCase().includes(normalizedQuery)) {
        return itemRows;
      }
      return itemRows.filter(rowMatchesSearch);
    });
    const collapseKey =
      group.kind === 'source'
        ? cascadeSourceCollapseKey(group.source)
        : cascadeFileCollapseKey(group.file);
    const groupMatches =
      searchActive && (groupSourceMatches || group.items.some(itemMatchesSearch));
    const searchCollapseOverride = searchCollapsedOverrides.get(collapseKey);
    const collapsed = groupMatches
      ? (searchCollapseOverride ?? false)
      : collapsedRules.has(collapseKey);
    const count = group.items.reduce(
      (total, item) => total + (item.kind === 'rule' ? 1 : item.rows.length),
      0
    );

    return (
      <CascadeSourceGroupCard
        key={group.key}
        runKey={group.key}
        source={group.kind === 'source' ? group.source : undefined}
        destinationFile={group.kind === 'destination' ? group.file : undefined}
        count={count}
        collapsed={collapsed}
        onOpenInCode={
          group.kind === 'source' && onOpenInCode
            ? (file, line) => {
                void openSourceInCode(file, firstSourceRowForFile(displayedSourceRows, file), line);
              }
            : undefined
        }
        onToggleCollapse={() => {
          if (groupMatches) toggleSearchCollapsed(collapseKey, !collapsed);
          else toggleCollapsed(collapseKey);
        }}
      >
        {group.items.map((item) => renderCascadeItem(item, true, groupSourceMatches))}
      </CascadeSourceGroupCard>
    );
  };

  const renderCascadeDisplayItems = () => {
    const renderedItems: ReactNode[] = [];
    let index = 0;

    while (index < displayItemsBySource.length) {
      const item = displayItemsBySource[index];
      if (isCascadeFileGroup(item)) {
        renderedItems.push(renderSourceGroup(item));
        index += 1;
        continue;
      }

      renderedItems.push(renderCascadeItem(item));
      index += 1;
    }

    return renderedItems;
  };

  const renderDraftMediaQuery = ({ id, condition, selectors }: DraftMediaQuery) => {
    const groupCollapseKey = `draft-media:${id}`;
    const conditionMatches =
      searchActive && condition.toLocaleLowerCase().includes(normalizedQuery);
    const groupMatches = searchActive && (conditionMatches || selectors.length > 0);
    const searchCollapseOverride = searchCollapsedOverrides.get(groupCollapseKey);
    const collapsed = groupMatches
      ? (searchCollapseOverride ?? false)
      : collapsedRules.has(groupCollapseKey);

    return (
      <MediaQueryGroupCard
        key={groupCollapseKey}
        condition={condition}
        autoFocusQuery
        commitQueryOnAppend
        collapsed={collapsed}
        onToggleCollapse={() => {
          if (groupMatches) {
            toggleSearchCollapsed(groupCollapseKey, !collapsed);
          } else {
            toggleCollapsed(groupCollapseKey);
          }
        }}
        onRename={(next) => void renameDraftMediaQuery(id, next)}
        onDelete={() => deleteDraftMediaQuery(id)}
        addSelector={
          <AddSelectorBar
            onAddSelector={(selector, atPrelude) => {
              if (isMediaQueryComplete(condition)) {
                deleteDraftMediaQuery(id);
                void onAddSelector(selector, atPrelude);
              } else {
                addDraftMediaSelector(id, selector);
              }
            }}
            suggestions={addSelectorOptions}
            existing={existingSelectors}
            fixedCondition={`@media ${condition}`}
          />
        }
      >
        {selectors.map((selector) => {
          const collapseKey = `${groupCollapseKey}|${selector}`;
          const selectorMatches = selector.toLocaleLowerCase().includes(normalizedQuery);
          const searchMatches = searchActive && (conditionMatches || selectorMatches);
          const searchCollapse = searchCollapsedOverrides.get(collapseKey);
          const selectorCollapsed = searchMatches
            ? (searchCollapse ?? false)
            : collapsedRules.has(collapseKey);

          return (
            <CascadeRuleCard
              key={selector}
              editable
              draft
              selector={selector}
              body={parseRuleBody('')}
              overridden={new Map()}
              onChange={() => undefined}
              onDelete={() => deleteDraftMediaSelector(id, selector)}
              selectorSuggestions={selectorSuggestions}
              variables={variables}
              colorVariables={colorVariables}
              projectPath={projectPath}
              colorContrast={colorContrast}
              animations={animations}
              pendingReason="Complete the media query before editing properties."
              collapsed={selectorCollapsed}
              onToggleCollapse={() => {
                if (searchMatches) {
                  toggleSearchCollapsed(collapseKey, !selectorCollapsed);
                } else {
                  toggleCollapsed(collapseKey);
                }
              }}
              collapseKey={collapseKey}
              collapseControl={collapseControl}
              searchTerm={searchTerm}
              searchMatchesAll={conditionMatches}
              searchCollapseOverride={searchMatches ? searchCollapse : undefined}
            />
          );
        })}
      </MediaQueryGroupCard>
    );
  };

  const scopeHeader = selection ? (
    <div className="ss-cascade-header">
      <div className="ss-cascade-header__main">
        {selectedTarget}
        <CascadeToolbar
          kind={scope === 'animations' ? 'animations' : 'rules'}
          disabled={scope === 'settings'}
          searchOpen={scope !== 'settings' && searchOpen}
          searchButtonRef={searchButtonRef}
          searchFieldId={searchFieldId}
          onSearchOpen={openSearch}
          onSearchToggle={toggleSearch}
          order={displayOrder}
          onOrderChange={setDisplayOrder}
          allCollapsed={allCollapsed}
          onCollapseAll={collapseAll}
          onExpandAll={expandAll}
        />
      </div>
      {scope !== 'settings' && searchOpen && (
        <SearchField
          id={searchFieldId}
          ref={searchInputRef}
          value={searchTerm}
          onChange={changeSearch}
          onKeyDown={handleSearchKeyDown}
          aria-label={
            scope === 'animations'
              ? 'Search CSS animations, properties, and values'
              : 'Search CSS selectors, properties, and values'
          }
          placeholder={scope === 'animations' ? 'Search animations' : 'Search CSS'}
          clearLabel="Clear CSS search"
          className="ss-cascade-header__search"
        />
      )}
    </div>
  ) : null;

  return (
    <div
      className={`ss-edit-panel ss-cascade-panel ss-cascade-panel--dockable${
        pinned ? ' ss-edit-panel--pinned' : ''
      }`}
      data-testid="css-cascade-panel"
      data-scope={scope}
    >
      <div className="ss-edit-panel__header" data-dockable-drag-handle>
        <span className="ss-edit-panel__title workspace-panel-title">CSS</span>
        <span className="ss-edit-panel__header-actions">
          {onTogglePin && (
            <ToggleButton
              variant="ghost"
              size="compact"
              className="button--icon-only panel-pin-toggle"
              onClick={onTogglePin}
              title={pinned ? 'Unpin — float over the preview' : 'Pin to the window'}
              aria-label={pinned ? 'Unpin CSS panel' : 'Pin CSS panel to the window'}
              pressed={pinned}
              leftIcon={<PinIcon size={13} />}
            />
          )}
          <IconButton
            variant="ghost"
            size="compact"
            onClick={onClose}
            title="Close CSS panel"
            aria-label="Close CSS panel"
            icon={<CloseIcon size={14} />}
          />
        </span>
      </div>

      <div className="ss-edit-panel__body">
        {scopeHeader}
        <Tabs
          value={scope}
          mode="navigation"
          onValueChange={(next) => {
            if (scope === 'settings' || next === 'settings') {
              setSettingsVisitedSelectionKey(settings.selectionKey);
            }
            setScope(next as Scope);
          }}
        >
          <TabsList className="ss-cascade-scope" aria-label="CSS panel view">
            <TabsTab value="style">Style</TabsTab>
            <TabsTab value="settings">Settings</TabsTab>
            <TabsTab value="animations">Animate</TabsTab>
          </TabsList>
        </Tabs>
        {scope === 'style' && projectPath && selection && (
          <CssConsolidationReviewPopover
            projectPath={projectPath}
            selection={selection}
            rows={rows}
            bodies={bodies}
            searchTerm={searchTerm}
            loading={loading}
            hasPendingWrites={hasPendingWrites}
            onRefreshCascade={refreshCascade}
          />
        )}
        <div className="ss-cascade-content">
          {mountSettingsPanel && selection && (
            <div
              className="ss-cascade-settings"
              hidden={scope !== 'settings'}
              aria-hidden={scope !== 'settings'}
            >
              <ElementSettingsPanel
                key={settings.selectionKey}
                settings={settings}
                signature={selection.signature}
                projectPath={projectPath}
                onOpenInCode={onOpenInCode}
                onSetCssDimension={imageDimensionRule ? setImageCssDimension : undefined}
                cssDimensions={imageCssDimensions}
                active={scope === 'settings'}
              />
            </div>
          )}
          {scope === 'animations' ? (
            <CssAnimationsPanel
              animations={animationsState.animations}
              loading={animationsState.loading}
              selectorSuggestions={selectorSuggestions}
              variables={variables}
              onChangeBody={animationsState.setBody}
              onDelete={(s) => void animationsState.remove(s)}
              onCreate={(n) => void animationsState.create(n)}
              onRename={(s, n) => void animationsState.rename(s, n)}
              searchTerm={searchTerm}
              displayOrder={displayOrder}
              collapseControl={collapseControl}
              onOpenInCode={onOpenInCode ? openAnimationSourceInCode : undefined}
              onClearSearch={() => changeSearch('')}
            />
          ) : !selection ? (
            <p className="ss-cascade-empty">Click an element to see the CSS that styles it.</p>
          ) : scope === 'style' ? (
            <>
              {loading ? (
                <div className="ss-cascade-loading">
                  <Spinner size="sm" />
                </div>
              ) : (
                <>
                  {hasVisibleGeneratedStyles && (
                    <p className="ss-cascade-generated-note" role="note">
                      These styles are generated from source files. Source edits appear after the
                      stylesheet rebuilds.
                    </p>
                  )}
                  <div className="ss-cascade-cards">
                    {displayOrder === 'newest-top' && (
                      <AddSelectorBar
                        onAddSelector={onAddSelector}
                        onAddMediaQuery={addDraftMediaQuery}
                        suggestions={addSelectorOptions}
                        existing={existingSelectors}
                      />
                    )}
                    {displayOrder === 'newest-top' &&
                      visibleDraftMediaQueries.map(renderDraftMediaQuery)}
                    {renderCascadeDisplayItems()}
                    {displayOrder === 'newest-bottom' &&
                      visibleDraftMediaQueries.map(renderDraftMediaQuery)}

                    {searchActive && !hasVisibleCascadeItems && (
                      <p className="ss-cascade-empty" role="status">
                        No CSS selectors or properties match “{query}”.
                        <TextButton onClick={() => changeSearch('')}>Clear search</TextButton>
                      </p>
                    )}
                    {!searchActive && rows.length === 0 && draftMediaQueries.length === 0 && (
                      <p className="ss-cascade-empty">No CSS rules match this element.</p>
                    )}
                    {displayOrder === 'newest-bottom' && (
                      <AddSelectorBar
                        onAddSelector={onAddSelector}
                        onAddMediaQuery={addDraftMediaQuery}
                        suggestions={addSelectorOptions}
                        existing={existingSelectors}
                      />
                    )}
                  </div>
                </>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** "Add selector" affordance: a button that expands to a selector input with a
 *  live autocomplete of the project's class names (and a "new rule" row for free
 *  text), creating a new rule for the element. */
export function AddSelectorBar({
  onAddSelector,
  onAddMediaQuery,
  suggestions,
  existing,
  fixedCondition,
}: {
  onAddSelector: (selector: string, atPrelude?: string) => void | Promise<void>;
  /** Creates an empty media group before any selector is added to it. */
  onAddMediaQuery?: (condition: string) => void;
  suggestions: string[];
  /** Selectors that already have a rule — tagged "existing" and re-opened on pick. */
  existing: string[];
  /** When present, the selector is added inside this existing `@media` wrapper. */
  fixedCondition?: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const listId = useId();

  const submit = (value: string) => {
    const v = value.trim();
    if (v) void onAddSelector(v, fixedCondition);
    setText('');
    setActive(0);
    setOpen(false);
  };

  const beginMediaQuery = (value: string): boolean => {
    const trimmed = value.trim();
    const [keyword = '', ...conditionParts] = trimmed.split(/\s+/);
    // Accept the useful partials too (`@m`, `@med`, …), while leaving other
    // at-rules on the existing condition autocomplete path.
    if (keyword.length < 2 || !'@media'.startsWith(keyword.toLowerCase())) return false;
    onAddMediaQuery?.(keyword.toLowerCase() === '@media' ? conditionParts.join(' ') : '');
    setText('');
    setActive(0);
    setOpen(false);
    return true;
  };

  const existingSet = new Set(existing);
  // Smart staged autofill: compose one rule prelude `[@condition] [selector]`. While you
  // type the `@…` it suggests CONDITIONS (any kind — width, dark mode, print, container
  // / style query, supports); once the condition is set it suggests your project's
  // CLASSES for the selector. Picking a condition keeps you typing; picking a class (or
  // Enter) creates `@condition { selector { } }`.
  const parsed = fixedCondition
    ? { condition: fixedCondition, selector: text, stage: 'selector' as const }
    : parseRulePrelude(text);
  let items: Suggestion[];
  if (parsed.stage === 'condition' && !fixedCondition) {
    // `@media` covers the full media-query space the catalog offers — widths AND dark
    // mode, print, hover, reduced motion, orientation. `@container`/`@supports` aren't
    // suggested yet (the cascade walker doesn't report their condition, so a rule inside
    // them wouldn't stay locatable on save); they'll join once that lands.
    const conds = searchStructures(WRAP_ITEMS, text.trim()).filter((w) =>
      w.insert.startsWith('@media')
    );
    const showFree = text.trim().length > 1 && !conds.some((w) => w.insert === text.trim());
    items = [
      ...(showFree ? [{ value: text.trim(), label: text.trim(), hint: 'new condition' }] : []),
      ...conds.map((w) => ({ value: w.insert, label: w.label, hint: w.hint })),
    ];
  } else {
    const q = parsed.selector;
    const selectorMatches = (
      q ? suggestions.filter((s) => s.toLowerCase().includes(q.toLowerCase())) : suggestions
    )
      .filter((s) => !s.trim().startsWith('@'))
      .slice(0, 10);
    const showCreate = q.length > 0 && !selectorMatches.includes(q);
    items = [
      ...(showCreate ? [{ value: q, label: q, hint: 'new rule' }] : []),
      ...selectorMatches.map((s) => ({
        value: s,
        label: s,
        hint: existingSet.has(s) ? 'existing' : undefined,
      })),
    ];
  }

  // Picking a CONDITION fills it and leaves you typing the selector; picking a SELECTOR
  // (or pressing Enter on one) composes `condition selector` and creates the rule.
  const pick = (value: string) => {
    if (parsed.stage === 'condition' && !fixedCondition) {
      setText(`${value} `);
      setActive(0);
      anchorEl?.focus();
    } else {
      submit(fixedCondition ? value : parsed.condition ? `${parsed.condition} ${value}` : value);
    }
  };

  const action = (
    <div className={`ss-cascade-action${fixedCondition ? ' ss-cascade-action--nested' : ''}`}>
      {fixedCondition ? (
        <TextButton
          className={`ss-cascade-card__add${open ? ' is-open' : ''}`}
          leftIcon={<PlusIcon size={12} />}
          aria-expanded={open}
          data-cascade-add-selector
          onClick={() => setOpen(true)}
        >
          Add selector
        </TextButton>
      ) : (
        <Button
          variant="default"
          width="fill"
          leftIcon={<PlusIcon size={11} />}
          aria-expanded={open}
          data-cascade-add-selector
          onClick={() => setOpen(true)}
        >
          Add selector
        </Button>
      )}
    </div>
  );

  const selectorComposer = (
    <section className="ss-cascade-card ss-cascade-selector-composer" aria-label="New selector">
      <header className="ss-cascade-card__head">
        <div className="ss-cascade-card__selector-row">
          <span className="ss-cascade-card__collapse" aria-hidden="true" />
          <CascadeChip
            tone={text.trimStart().startsWith('@') ? 'media' : 'selector'}
            editing
            className="ss-cascade-card__selector-edit"
          >
            <input
              className="ss-cascade-chip__input"
              autoFocus
              value={text}
              size={Math.max(text.length, 1)}
              spellCheck={false}
              autoComplete="off"
              role="combobox"
              aria-expanded={items.length > 0}
              aria-controls={listId}
              aria-activedescendant={
                items.length > 0 ? suggestionOptionId(listId, active) : undefined
              }
              aria-autocomplete="list"
              aria-label="Add selector"
              placeholder=".class-name"
              onFocus={(e) => setAnchorEl(e.currentTarget)}
              onChange={(e) => {
                setText(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (!fixedCondition && beginMediaQuery(text)) return;
                  if (items[active]) pick(items[active].value);
                  else submit(text);
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, items.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setText('');
                  setOpen(false);
                }
              }}
              onBlur={() => setOpen(false)}
            />
          </CascadeChip>
          <SuggestionPopover
            anchor={anchorEl}
            items={items}
            active={active}
            onPick={pick}
            width={280}
            flip={false}
            listId={listId}
          />
        </div>
      </header>
    </section>
  );

  const composer = open ? selectorComposer : null;

  return fixedCondition ? (
    <>
      {composer}
      {action}
    </>
  ) : (
    <>
      {action}
      {composer}
    </>
  );
}
