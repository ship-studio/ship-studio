/**
 * Name-collision prompt for file-tree moves and OS imports.
 *
 * Shown when relocating/importing an entry whose name already exists in the
 * target folder. Offers the three non-destructive-by-default choices —
 * Keep both (rename), Replace, Skip — and, when more conflicts follow in the
 * same batch, an "apply to the rest" toggle. Reuses {@link ModalFrame} +
 * {@link Button}; never silently overwrites.
 */

import { useEffect, useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import type { ConflictResolution } from '../../lib/code';

/**
 * What the user chose for a colliding entry: the resolvable backend policies
 * (`replace`/`rename`) plus the UI-only `skip`. Derived from the backend
 * {@link ConflictResolution} so the shared literals live in one place;
 * `'error'` (the backend default) is never emitted by the modal.
 */
export type ConflictChoice = Exclude<ConflictResolution, 'error'> | 'skip';

interface ConflictPromptModalProps {
  isOpen: boolean;
  /** The colliding entry's name (e.g. `logo.png`). */
  name: string;
  /** Name of the destination folder, for context (`''` / omitted = root). */
  targetLabel?: string;
  /** Count of further conflicts in this batch — enables "apply to the rest". */
  remaining?: number;
  /** Resolve this conflict; `applyToAll` is meaningful only when `remaining > 0`. */
  onResolve: (choice: ConflictChoice, applyToAll: boolean) => void;
  /** Dismissal (ESC / overlay / close). The caller decides what that means. */
  onClose: () => void;
}

export function ConflictPromptModal({
  isOpen,
  name,
  targetLabel,
  remaining = 0,
  onResolve,
  onClose,
}: ConflictPromptModalProps) {
  const [applyToAll, setApplyToAll] = useState(false);
  // Reset the sticky "apply to the rest" toggle when the modal closes, so a
  // dismissal (ESC / overlay) can't carry a stale choice into the next batch.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: reset transient UI state on close
    if (!isOpen) setApplyToAll(false);
  }, [isOpen]);
  const where = targetLabel ? `"${targetLabel}"` : 'this folder';

  const resolve = (choice: ConflictChoice) => {
    onResolve(choice, applyToAll);
    setApplyToAll(false);
  };

  return (
    <ModalFrame isOpen={isOpen} onClose={onClose} title="Name already in use">
      <div className="conflict-prompt">
        <p className="conflict-prompt-text">
          <strong>{name}</strong> already exists in {where}. What would you like to do?
        </p>

        {remaining > 0 && (
          <label className="conflict-prompt-applyall">
            <input
              type="checkbox"
              checked={applyToAll}
              onChange={(e) => setApplyToAll(e.target.checked)}
            />
            Apply to the next {remaining} conflict{remaining === 1 ? '' : 's'}
          </label>
        )}

        <div className="conflict-prompt-actions">
          <Button variant="ghost" onClick={() => resolve('skip')}>
            Skip
          </Button>
          <Button variant="danger" onClick={() => resolve('replace')}>
            Replace
          </Button>
          <Button variant="primary" onClick={() => resolve('rename')}>
            Keep both
          </Button>
        </div>
      </div>
    </ModalFrame>
  );
}
