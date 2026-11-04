import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FileTextIcon } from '@/components/icons';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useCommands } from '../../commands/useCommands';
import { useAsyncState } from '../../hooks/useAsyncState';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  applyCssConsolidation,
  reviewCssConsolidations,
  type CssConsolidationCandidate,
  type CascadeRow,
  rowKey,
} from '../../lib/cssCascade';
import { searchCascadeRow } from '../../lib/cascadeSearch';
import {
  cssConsolidationCandidateKey,
  relevantCssConsolidationCandidates,
  type CssConsolidationSourceRef,
} from '../../lib/cssConsolidationPresentation';
import type { CascadeSelection } from '../../hooks/useCssCascadeEditor';
import type { RuleBody } from '../../lib/cssBody';
import { Button } from '../primitives/Button';
import { Dropdown } from '../primitives/Dropdown';
import { Spinner } from '../primitives/Spinner';
import { TextButton } from '../primitives/TextButton';

interface Props {
  projectPath: string;
  selection: CascadeSelection;
  rows: CascadeRow[];
  bodies: Record<string, RuleBody>;
  searchTerm: string;
  loading: boolean;
  hasPendingWrites?: boolean;
  onRefreshCascade: () => void;
}

interface SourceRows {
  visible: CssConsolidationSourceRef[];
  versions: Array<[string, string]>;
}

function collectSourceRows(
  rows: CascadeRow[],
  bodies: Record<string, RuleBody>,
  searchTerm: string
): SourceRows {
  const withIdentity = rows.flatMap((row) => {
    const identity = row.sourceIdentity;
    if (row.origin !== 'author' || row.draft || !identity?.sourcePath || !identity.sourceVersion) {
      return [];
    }
    return [
      {
        row,
        source: {
          file: identity.sourcePath,
          sourceVersion: identity.sourceVersion,
          selectorOffset: identity.selectorOffset,
        },
      },
    ];
  });

  const versionsByFile = new Map<string, Set<string>>();
  for (const { source } of withIdentity) {
    const versions = versionsByFile.get(source.file) ?? new Set<string>();
    versions.add(source.sourceVersion);
    versionsByFile.set(source.file, versions);
  }

  const stableVersions = new Map<string, string>();
  for (const [file, versions] of versionsByFile) {
    if (versions.size !== 1) continue;
    const [version] = versions;
    if (version) stableVersions.set(file, version);
  }
  const all = withIdentity.filter(
    ({ source }) => stableVersions.get(source.file) === source.sourceVersion
  );
  const query = searchTerm.trim().toLocaleLowerCase();
  const visible = all
    .filter(({ row, source }) => {
      if (!query) return true;
      if (source.file.toLocaleLowerCase().includes(query)) return true;
      return searchCascadeRow(row, bodies[rowKey(row)], query).matches;
    })
    .map(({ source }) => source);

  return {
    visible,
    versions: [...stableVersions.entries()].sort(([left], [right]) => left.localeCompare(right)),
  };
}

/**
 * Narrow backend-authored consolidation plans to exact source occurrences in the
 * current cascade, then expose those plans in the panel's shared anchored popover.
 */
export function CssConsolidationReviewPopover({
  projectPath,
  selection,
  rows,
  bodies,
  searchTerm,
  loading,
  hasPendingWrites = false,
  onRefreshCascade,
}: Props) {
  const sourceRows = useMemo(
    () => collectSourceRows(rows, bodies, searchTerm),
    [bodies, rows, searchTerm]
  );
  const selectionKey = JSON.stringify([
    selection.selectionId ?? null,
    selection.signature.domPath ?? null,
    selection.signature.tagName,
    selection.signature.className,
    selection.signature.ancestorClasses,
    selection.instanceCount,
  ]);
  const scanKey = useMemo(
    () =>
      !loading && sourceRows.versions.length > 0
        ? JSON.stringify([projectPath, selectionKey, sourceRows.versions])
        : null,
    [loading, projectPath, selectionKey, sourceRows.versions]
  );

  const [reviewRevision, setReviewRevision] = useState(0);
  const projectPathRef = useRef(projectPath);
  useLayoutEffect(() => {
    projectPathRef.current = projectPath;
  }, [projectPath]);

  const invalidateReview = useCallback(
    (requestedProject: string) => {
      setReviewRevision((revision) => revision + 1);
      if (projectPathRef.current === requestedProject) onRefreshCascade();
    },
    [onRefreshCascade]
  );

  if (!scanKey) return null;

  const viewKey = JSON.stringify([
    selectionKey,
    searchTerm.trim().toLocaleLowerCase(),
    sourceRows.visible
      .map((source) => `${source.file}\u0000${source.sourceVersion}\u0000${source.selectorOffset}`)
      .sort(),
  ]);

  return (
    <CssConsolidationReviewPopoverForSnapshot
      key={`${scanKey}:${reviewRevision}`}
      projectPath={projectPath}
      visibleSources={sourceRows.visible}
      searchTerm={searchTerm}
      viewKey={viewKey}
      hasPendingWrites={hasPendingWrites}
      onInvalidateReview={invalidateReview}
    />
  );
}

interface SnapshotProps {
  projectPath: string;
  visibleSources: CssConsolidationSourceRef[];
  searchTerm: string;
  viewKey: string;
  hasPendingWrites: boolean;
  onInvalidateReview: (projectPath: string) => void;
}

type ApplyResult = { ok: true } | { ok: false; message: string };

function CssConsolidationReviewPopoverForSnapshot({
  projectPath,
  visibleSources,
  searchTerm,
  viewKey,
  hasPendingWrites,
  onInvalidateReview,
}: SnapshotProps) {
  const { showToast } = useOptionalToast();
  const loadReview = useCallback(() => reviewCssConsolidations(projectPath), [projectPath]);
  const {
    data: review,
    error: reviewError,
    execute: executeReview,
    reset: resetReview,
  } = useAsyncState(loadReview);
  const requestedReviewRef = useRef(false);

  useEffect(() => {
    if (visibleSources.length === 0 || requestedReviewRef.current) return;
    requestedReviewRef.current = true;
    void executeReview();
  }, [executeReview, visibleSources.length]);

  const applyPlan = useCallback(
    async (candidate: CssConsolidationCandidate): Promise<ApplyResult> => {
      try {
        await applyCssConsolidation(projectPath, candidate);
        return { ok: true };
      } catch (cause) {
        return { ok: false, message: formatCommandError(asCommandError(cause)) };
      }
    },
    [projectPath]
  );
  const { execute: executeApply, isLoading: isApplying } = useAsyncState(applyPlan);
  const [applyingKey, setApplyingKey] = useState<string | null>(null);
  const applyingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const candidates = useMemo(
    () => relevantCssConsolidationCandidates(review?.candidates ?? [], visibleSources, searchTerm),
    [review, searchTerm, visibleSources]
  );
  const applyCandidate = useCallback(
    async (candidate: CssConsolidationCandidate) => {
      const key = cssConsolidationCandidateKey(candidate);
      if (
        applyingRef.current ||
        hasPendingWrites ||
        !candidates.some((current) => cssConsolidationCandidateKey(current) === key)
      ) {
        return;
      }

      applyingRef.current = true;
      setApplyingKey(key);
      const outcome = await executeApply(candidate);
      applyingRef.current = false;
      if (mountedRef.current) setApplyingKey(null);

      if (!outcome) return;
      onInvalidateReview(projectPath);
      if (outcome.ok) showToast('Safe CSS consolidation applied.', 'success');
      else showToast(`Couldn't apply this CSS consolidation: ${outcome.message}`, 'error');
    },
    [candidates, executeApply, hasPendingWrites, onInvalidateReview, projectPath, showToast]
  );

  if (candidates.length > 0) {
    return (
      <CssConsolidationDropdown
        key={viewKey}
        candidates={candidates}
        applying={isApplying}
        applyingKey={applyingKey}
        hasPendingWrites={hasPendingWrites}
        onApply={applyCandidate}
      />
    );
  }

  if (reviewError && visibleSources.length > 0) {
    return (
      <div className="ss-cascade-consolidation-action ss-cascade-consolidation-action--status">
        <p className="ss-css-consolidation-status ss-css-consolidation-status--error" role="alert">
          Couldn't check safe CSS consolidations: {reviewError.message}{' '}
          <TextButton
            variant="accent"
            onClick={() => {
              resetReview();
              void executeReview();
            }}
          >
            Retry
          </TextButton>
        </p>
      </div>
    );
  }

  if (!review && visibleSources.length > 0) {
    return (
      <div className="ss-cascade-consolidation-action ss-cascade-consolidation-action--status">
        <div className="ss-css-consolidation-status" role="status">
          <Spinner size="sm" />
          <span>Checking safe CSS consolidations…</span>
        </div>
      </div>
    );
  }

  return null;
}

interface ConsolidationDropdownProps {
  candidates: CssConsolidationCandidate[];
  applying: boolean;
  applyingKey: string | null;
  hasPendingWrites: boolean;
  onApply: (candidate: CssConsolidationCandidate) => void | Promise<void>;
}

function CssConsolidationDropdown({
  candidates,
  applying,
  applyingKey,
  hasPendingWrites,
  onApply,
}: ConsolidationDropdownProps) {
  const [open, setOpen] = useState(false);
  const openPopover = useCallback(() => setOpen(true), []);

  useCommands(
    () => [
      {
        id: 'css.reviewConsolidations',
        title: 'Review safe CSS consolidations',
        subtitle: 'Review backend-verified adjacent rules for this selection',
        icon: <FileTextIcon size={14} />,
        category: 'action' as const,
        when: 'project' as const,
        keywords: ['css', 'style', 'consolidate', 'merge', 'rules', 'review'],
        run: openPopover,
      },
    ],
    [openPopover]
  );

  return (
    <div className="ss-cascade-consolidation-action">
      <Dropdown
        presentation="popover"
        ariaLabel="Safe CSS consolidations"
        portal
        align="right"
        open={open}
        onOpenChange={setOpen}
        menuClassName="ss-css-consolidation-popover"
        trigger={(triggerProps) => (
          <TextButton
            {...triggerProps}
            variant="accent"
            leftIcon={<FileTextIcon size={13} />}
            aria-label="Review safe consolidations"
          >
            Review safe consolidations
          </TextButton>
        )}
      >
        <div className="ss-css-consolidation-popover__content">
          <header className="ss-css-consolidation-popover__header">
            <strong>Safe CSS consolidations</strong>
            <span>{candidates.length}</span>
          </header>
          <p className="ss-css-consolidation-popover__intro">
            Each proposal combines adjacent authored rules with the same full selector list. Nothing
            changes until you apply a proposal.
          </p>
          {hasPendingWrites && (
            <p className="ss-css-consolidation-status" role="status">
              Wait for current CSS edits to finish saving before applying a consolidation.
            </p>
          )}
          <div className="ss-css-consolidation-popover__candidates">
            {candidates.map((candidate) => {
              const candidateKey = cssConsolidationCandidateKey(candidate);
              return (
                <details className="ss-css-consolidation-popover__candidate" key={candidateKey}>
                  <summary>
                    <code>{candidate.file}</code>
                    <code>{candidate.first.selector}</code>
                  </summary>
                  <div className="ss-css-consolidation-popover__diff">
                    <div>
                      <span>Before</span>
                      <pre>{candidate.before}</pre>
                    </div>
                    <div>
                      <span>After</span>
                      <pre>{candidate.after}</pre>
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    size="compact"
                    width="fill"
                    disabled={applying || hasPendingWrites}
                    onClick={() => void onApply(candidate)}
                  >
                    {applyingKey === candidateKey ? 'Applying…' : 'Apply consolidation'}
                  </Button>
                </details>
              );
            })}
          </div>
        </div>
      </Dropdown>
    </div>
  );
}
