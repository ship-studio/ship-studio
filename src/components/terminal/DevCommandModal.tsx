/**
 * Modal for configuring a custom dev command for generic projects.
 *
 * Allows users to specify a command (e.g., "cargo run", "npm run dev")
 * that Ship Studio will auto-start/stop/restart.
 */

import { useState } from 'react';
import '../../styles/features/notifications.css';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
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
      className="notification-settings-content"
    >
      <div className="notification-settings-body">
        <div className="notification-setting-section">
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 12 }}>
            Set a command to auto-start when you open this project.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="e.g., npm run dev, cargo run"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave();
              }}
              style={{
                width: '100%',
                padding: '8px 12px',
                borderRadius: 'var(--radius)',
                border: '1px solid var(--border)',
                background: 'var(--bg-primary)',
                color: 'var(--text-primary)',
                fontSize: 13,
                fontFamily: 'var(--font-mono)',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
            <span style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>
              If set, this command will start automatically and can be restarted from the toolbar.
              Leave blank to manage the dev server yourself in the terminal.
            </span>
          </div>
        </div>
      </div>
      <div className="notification-settings-footer">
        {currentCommand && (
          <Button variant="secondary" onClick={handleClear} style={{ marginRight: 'auto' }}>
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
