/**
 * RenameProjectModal — rename a project's folder on disk.
 *
 * Mirrors NewFolderModal: self-contained input + loading + inline error.
 * The actual backend call lives in the `onRename` callback supplied by the
 * parent, which should throw on failure so the error renders inline.
 *
 * @module components/RenameProjectModal
 */

import { useState, useRef, useEffect } from 'react';
import { ModalFrame } from './primitives/ModalFrame';
import { Button } from './primitives/Button';
import { asCommandError, formatCommandError } from '../lib/errors';

interface RenameProjectModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback to close the modal */
  onClose: () => void;
  /** Current project (folder) name. Seeds the input and disables submit while
   *  the value is unchanged. */
  currentName: string;
  /** Performs the rename. Should throw on failure so the error renders inline. */
  onRename: (newName: string) => Promise<void>;
}

export function RenameProjectModal({
  isOpen,
  onClose,
  currentName,
  onRename,
}: RenameProjectModalProps) {
  const [name, setName] = useState(currentName);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset to the current name and select it whenever the modal (re)opens.
  useEffect(() => {
    if (isOpen) {
      setName(currentName);
      setError(null);
      setLoading(false);
      setTimeout(() => inputRef.current?.select(), 50);
    }
  }, [isOpen, currentName]);

  const trimmed = name.trim();
  const unchanged = trimmed === currentName;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmed || unchanged) return;
    setLoading(true);
    setError(null);
    try {
      await onRename(trimmed);
      onClose();
    } catch (err) {
      setError(formatCommandError(asCommandError(err)));
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalFrame isOpen={isOpen} onClose={onClose} title="Rename project" dismissable={!loading}>
      <form onSubmit={(e) => void handleSubmit(e)} style={{ padding: 'var(--spacing-xl)' }}>
        <div className="form-group">
          <label htmlFor="rename-project-name">Project name</label>
          <input
            ref={inputRef}
            id="rename-project-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={loading}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </div>
        <p className="hint">
          This renames the folder on disk. Git history, deployments, and project settings are
          preserved. If the project is running in the background, it will be stopped first.
        </p>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <Button variant="secondary" type="button" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={loading || !trimmed || unchanged}>
            {loading ? 'Renaming…' : 'Rename'}
          </Button>
        </div>
      </form>
    </ModalFrame>
  );
}
