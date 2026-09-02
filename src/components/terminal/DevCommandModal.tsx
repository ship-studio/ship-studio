/**
 * Modal for configuring a custom dev command for generic projects.
 *
 * Allows users to specify a command (e.g., "cargo run", "npm run dev")
 * that Ship Studio will auto-start/stop/restart.
 */

import { useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { TextField } from '../primitives/TextField';
import { useModal } from '../../contexts/ModalContext';

interface DevCommandModalProps {
  currentCommand: string | null;
  onSave: (command: string | null) => void;
}

export function DevCommandModal({ currentCommand, onSave }: DevCommandModalProps) {
  const { isOpen, close: onClose } = useModal('devCommand');
  const [command, setCommand] = useState(currentCommand ?? '');

  if (!isOpen) return null;

  const handleSave = () => {
    const trimmed = command.trim();
    onSave(trimmed || null);
  };

  const handleClear = () => {
    onSave(null);
  };

  return (
    <ModalFrame
      isOpen
      onClose={onClose}
      title="Dev Server Command"
      className="dev-command-content settings-form-content"
    >
      <p className="dev-command-intro settings-form-intro">
        Set a command to auto-start when you open this project.
      </p>
      <div className="dev-command-body settings-form-body">
        <div className="dev-command-section settings-form-section">
          <div className="dev-command-field settings-form-field">
            <TextField
              id="dev-command-input"
              type="text"
              aria-label="Dev server command"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="e.g., npm run dev, cargo run"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave();
              }}
              className="ss-text-field--code"
            />
            <span className="dev-command-help settings-form-help">
              If set, this command will start automatically and can be restarted from the toolbar.
              Leave blank to manage the dev server yourself in the terminal.
            </span>
          </div>
        </div>
      </div>
      <div className="dev-command-footer settings-form-footer">
        {currentCommand && (
          <Button variant="secondary" onClick={handleClear} className="dev-command-clear">
            Clear
          </Button>
        )}
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleSave}>
          Save
        </Button>
      </div>
    </ModalFrame>
  );
}
