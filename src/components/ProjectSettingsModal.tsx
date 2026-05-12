/**
 * Modal for configuring project settings.
 *
 * Currently supports setting the dev server port.
 * The parent component handles persistence via Tauri commands.
 */

import { useState } from 'react';
import '../styles/features/notifications.css';
import { ModalFrame } from './primitives/ModalFrame';
import { Button } from './primitives/Button';
import { useModal } from '../contexts/ModalContext';

interface ProjectSettingsModalProps {
  currentPort: number;
  onSave: (port: number) => void;
  /** Only shown for generic (non-web-framework) projects */
  customDevCommand?: string | null;
  onSaveDevCommand?: (command: string | null) => void;
  isWebProject?: boolean;
}

export function ProjectSettingsModal({
  currentPort,
  onSave,
  customDevCommand,
  onSaveDevCommand,
  isWebProject,
}: ProjectSettingsModalProps) {
  const { isOpen, close: onClose } = useModal('projectSettings');
  const [port, setPort] = useState(currentPort);
  const [devCommand, setDevCommand] = useState(customDevCommand ?? '');
  const showDevCommand = !isWebProject && onSaveDevCommand;

  const isValid = Number.isInteger(port) && port >= 1 && port <= 65535;

  const handleSave = () => {
    if (isValid) {
      onSave(port);
      if (showDevCommand) {
        const trimmed = devCommand.trim();
        onSaveDevCommand(trimmed || null);
      }
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <ModalFrame
      isOpen
      onClose={onClose}
      title="Project Settings"
      className="notification-settings-content"
    >
      <>
        <p
          style={{
            padding: 'var(--spacing-lg) var(--spacing-xl) var(--spacing-md)',
            color: 'var(--text-secondary)',
            fontSize: 13,
          }}
        >
          Configure settings for this project.
        </p>
        <div className="notification-settings-body">
          <div className="notification-setting-section">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                Dev Server Port
              </label>
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
                min={1}
                max={65535}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && isValid) handleSave();
                }}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: 'var(--bg-primary)',
                  color: 'var(--text-primary)',
                  fontSize: 13,
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
              {!isValid && (
                <span style={{ fontSize: 12, color: 'var(--error, #ef4444)' }}>
                  Port must be between 1 and 65535
                </span>
              )}
              <span style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                The port Ship Studio uses to connect to your dev server. Default is 3000.
              </span>
            </div>
          </div>
          {showDevCommand && (
            <div className="notification-setting-section">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                  Dev Server Command
                </label>
                <input
                  type="text"
                  value={devCommand}
                  onChange={(e) => setDevCommand(e.target.value)}
                  placeholder="e.g., npm run dev, cargo run"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && isValid) handleSave();
                  }}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    background: 'var(--bg-primary)',
                    color: 'var(--text-primary)',
                    fontSize: 13,
                    fontFamily: 'var(--font-mono, monospace)',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
                <span style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                  If set, this command will start automatically and can be restarted from the
                  toolbar. Leave blank to manage the dev server yourself in the terminal.
                </span>
              </div>
            </div>
          )}
        </div>
        <div className="notification-settings-footer">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={!isValid}>
            Save
          </Button>
        </div>
      </>
    </ModalFrame>
  );
}
