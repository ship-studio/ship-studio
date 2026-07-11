/**
 * NewFolderModal component for creating new folders.
 *
 * Provides a simple form with folder name input and create/cancel buttons.
 *
 * @module components/NewFolderModal
 */

import { useState, useRef, useEffect } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { asCommandError, formatCommandError } from '../../lib/errors';

/** Props for the NewFolderModal component */
interface NewFolderModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback to close the modal */
  onClose: () => void;
  /** Callback when folder is created (receives folder name) */
  onCreate: (name: string) => Promise<void>;
  /** Initial name value (for rename mode) */
  initialName?: string;
  /** Title for the modal */
  title?: string;
  /** Button label */
  buttonLabel?: string;
}

export function NewFolderModal({
  isOpen,
  onClose,
  onCreate,
  initialName = '',
  title = 'New Folder',
  buttonLabel = 'Create',
}: NewFolderModalProps) {
  const [name, setName] = useState(initialName);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setName(initialName);
      setError(null);
      setLoading(false);
      // Focus input after a short delay to ensure modal is rendered
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, initialName]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Folder name is required');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await onCreate(trimmedName);
      onClose();
    } catch (err) {
      setError(formatCommandError(asCommandError(err)));
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalFrame isOpen={isOpen} onClose={onClose} title={title} dismissable={!loading}>
      <form onSubmit={(e) => void handleSubmit(e)} style={{ padding: 'var(--spacing-xl)' }}>
        <div className="form-group">
          <label htmlFor="folder-name">Folder name</label>
          <input
            ref={inputRef}
            id="folder-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Projects"
            disabled={loading}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <Button variant="secondary" type="button" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={loading || !name.trim()}>
            {loading ? 'Creating...' : buttonLabel}
          </Button>
        </div>
      </form>
    </ModalFrame>
  );
}
