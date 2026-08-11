/**
 * "New worktree" modal — a UI over `git worktree add`.
 *
 * Two modes: create a new branch (name + base ref) or check out an existing
 * local branch that isn't already checked out in another worktree (git refuses
 * that, faithfully surfaced here by omitting those branches from the picker).
 * Shows the exact destination folder it will create and offers to copy the
 * parent's untracked `.env*` files (gitignored, so a fresh worktree lacks
 * them and the dev server would break without this).
 */

import { useMemo, useState, type FormEvent } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { useModal } from '../../contexts/ModalContext';
import { sanitizeBranchName, type BranchInfo } from '../../lib/branches';
import { addWorktree, worktreeFolderName, type WorktreeInfo } from '../../lib/worktrees';
import { humanizeGitError } from '../../lib/errors';
import { trackEvent, trackError } from '../../lib/analytics';
import { basename } from '../../lib/paths';

interface Props {
  projectPath: string;
  currentBranch: string;
  /** Local + remote branches (from useBranchManagement). */
  branches: BranchInfo[];
  /** Current `git worktree list` — used to exclude checked-out branches. */
  worktrees: WorktreeInfo[];
  /** Called with the new worktree's path after a successful add. */
  onCreated: (path: string) => void;
}

type Mode = 'new' | 'existing';

export function WorktreeCreateModal(props: Props) {
  const modal = useModal('worktreeCreate');
  // The form mounts fresh on every open (isOpen gates it below), so its
  // useState initials are the per-open reset — no effect needed.
  if (!modal.isOpen) return null;
  return <WorktreeCreateForm {...props} onClose={modal.close} />;
}

function WorktreeCreateForm({
  projectPath,
  currentBranch,
  branches,
  worktrees,
  onCreated,
  onClose,
}: Props & { onClose: () => void }) {
  const [mode, setMode] = useState<Mode>('new');
  const [branchName, setBranchName] = useState('');
  const [baseRef, setBaseRef] = useState(currentBranch);
  const [existingBranch, setExistingBranch] = useState('');
  const [copyEnv, setCopyEnv] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkedOutBranches = useMemo(
    () => new Set(worktrees.map((w) => w.branch).filter(Boolean) as string[]),
    [worktrees]
  );
  const localBranches = useMemo(() => branches.filter((b) => !b.isRemote), [branches]);
  // Git refuses to check out a branch that's already checked out in another
  // worktree — don't offer those.
  const availableExisting = useMemo(
    () => localBranches.filter((b) => !checkedOutBranches.has(b.name)),
    [localBranches, checkedOutBranches]
  );

  const effectiveBranch = mode === 'new' ? sanitizeBranchName(branchName) : existingBranch;
  const destinationHint = effectiveBranch
    ? `~/ShipStudio/.worktrees/${basename(projectPath)}/${worktreeFolderName(effectiveBranch)}`
    : null;
  const canSubmit = !isCreating && effectiveBranch.length > 0;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setIsCreating(true);
    setError(null);
    try {
      const result = await addWorktree(projectPath, {
        branch: effectiveBranch,
        createBranch: mode === 'new',
        baseRef: mode === 'new' && baseRef ? baseRef : undefined,
        copyEnv,
      });
      void trackEvent('worktree_created', {
        created_branch: mode === 'new',
        copied_env: copyEnv,
      });
      onClose();
      onCreated(result.path);
    } catch (err) {
      void trackError('worktree_create_failed', err);
      // Humanize known git refusals — most importantly "already used by
      // worktree"/"already checked out", which slips past the stale-list
      // guard above when the branch got checked out elsewhere after the
      // worktree list was loaded (issue #635, same condition as #406).
      // Falls back to the formatted raw error when nothing matches.
      setError(humanizeGitError(err, { branch: effectiveBranch }));
      setIsCreating(false);
    }
  };

  return (
    <ModalFrame
      isOpen
      onClose={onClose}
      title="New worktree"
      dismissable={!isCreating}
      className="worktree-create-modal"
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="worktree-create-form">
        <p className="worktree-create-intro">
          A worktree is a second working folder of this repository, so another branch can run side
          by side — its own terminal, dev server, and preview.
        </p>

        <div className="worktree-mode-toggle" role="tablist" aria-label="Branch source">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'new'}
            className={`worktree-mode-btn ${mode === 'new' ? 'is-active' : ''}`}
            onClick={() => setMode('new')}
          >
            New branch
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'existing'}
            className={`worktree-mode-btn ${mode === 'existing' ? 'is-active' : ''}`}
            onClick={() => setMode('existing')}
          >
            Existing branch
          </button>
        </div>

        {mode === 'new' ? (
          <>
            <label className="worktree-field">
              <span className="worktree-field-label">Branch name</span>
              <input
                type="text"
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                placeholder="feature-x"
                autoFocus
                autoCorrect="off"
                autoCapitalize="off"
                autoComplete="off"
                spellCheck={false}
                disabled={isCreating}
              />
              {branchName && sanitizeBranchName(branchName) !== branchName.trim() && (
                <span className="worktree-field-hint">
                  Will be created as “{sanitizeBranchName(branchName)}”
                </span>
              )}
            </label>
            <label className="worktree-field">
              <span className="worktree-field-label">Based on</span>
              <select
                value={baseRef}
                onChange={(e) => setBaseRef(e.target.value)}
                disabled={isCreating}
              >
                {localBranches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <label className="worktree-field">
            <span className="worktree-field-label">Branch</span>
            <select
              value={existingBranch}
              onChange={(e) => setExistingBranch(e.target.value)}
              disabled={isCreating}
            >
              <option value="" disabled>
                Choose a branch…
              </option>
              {availableExisting.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
            {availableExisting.length === 0 && (
              <span className="worktree-field-hint">
                Every local branch is already checked out in a worktree.
              </span>
            )}
          </label>
        )}

        <label className="worktree-checkbox">
          <input
            type="checkbox"
            checked={copyEnv}
            onChange={(e) => setCopyEnv(e.target.checked)}
            disabled={isCreating}
          />
          <span>
            Copy <code>.env</code> files
            <span className="worktree-checkbox-hint">
              They're not in git, so the new worktree won't have them otherwise
            </span>
          </span>
        </label>

        {destinationHint && (
          <div className="worktree-destination">
            Creates <code>{destinationHint}</code>
          </div>
        )}

        {error && <div className="worktree-create-error">{error}</div>}

        <div className="worktree-create-actions">
          <Button variant="secondary" onClick={onClose} disabled={isCreating}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!canSubmit}>
            {isCreating ? (
              <>
                <Spinner size="sm" /> Creating…
              </>
            ) : (
              'Create worktree'
            )}
          </Button>
        </div>
      </form>
    </ModalFrame>
  );
}
