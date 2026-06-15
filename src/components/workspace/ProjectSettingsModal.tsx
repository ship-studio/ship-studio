/**
 * Modal for configuring project settings.
 *
 * Currently supports setting the dev server port.
 * The parent component handles persistence via Tauri commands.
 */

import { useEffect, useRef, useState } from 'react';
import '../../styles/features/notifications.css';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { useModal } from '../../contexts/ModalContext';
import { getForceStaticServe, setForceStaticServe } from '../../lib/project';
import { logger } from '../../lib/logger';

interface ProjectSettingsModalProps {
  currentPort: number;
  onSave: (port: number) => void;
  /** Only shown for generic (non-web-framework) projects */
  customDevCommand?: string | null;
  onSaveDevCommand?: (command: string | null) => void;
  isWebProject?: boolean;
  /** Absolute project path — enables the "serve as static site" override. */
  projectPath?: string;
}

export function ProjectSettingsModal({
  currentPort,
  onSave,
  customDevCommand,
  onSaveDevCommand,
  isWebProject,
  projectPath,
}: ProjectSettingsModalProps) {
  const { isOpen, close: onClose } = useModal('projectSettings');
  const [port, setPort] = useState(currentPort);
  const [devCommand, setDevCommand] = useState(customDevCommand ?? '');
  const showDevCommand = !isWebProject && onSaveDevCommand;
  // The static-serve override is only meaningful for non-web (generic) projects
  // — a detected framework already serves itself.
  const showForceStatic = !isWebProject && !!projectPath;
  const [forceStatic, setForceStatic] = useState(false);
  // The on-disk value once loaded for the current project, or null while the
  // load is still in flight. Persisting is gated on this so a Save before the
  // load resolves (or right after switching projects) can't clobber the real
  // value with the stale default. A ref (not state) — it's only read at save
  // time and must not trigger a render.
  const loadedForceStatic = useRef<boolean | null>(null);

  // Load the persisted override whenever the modal opens (or the project changes).
  useEffect(() => {
    if (!isOpen || !showForceStatic || !projectPath) return;
    let cancelled = false;
    loadedForceStatic.current = null;
    getForceStaticServe(projectPath)
      .then((value) => {
        if (cancelled) return;
        setForceStatic(value);
        loadedForceStatic.current = value;
      })
      .catch((err) => {
        logger.warn('[ProjectSettings] Failed to load force_static_serve', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, showForceStatic, projectPath]);

  const isValid = Number.isInteger(port) && port >= 1 && port <= 65535;

  const handleSave = () => {
    if (isValid) {
      onSave(port);
      if (showDevCommand) {
        const trimmed = devCommand.trim();
        onSaveDevCommand(trimmed || null);
      }
      // Only persist when the current value has loaded and the user actually
      // changed it — never write the stale default over an unread value.
      if (
        showForceStatic &&
        projectPath &&
        loadedForceStatic.current !== null &&
        forceStatic !== loadedForceStatic.current
      ) {
        void setForceStaticServe(projectPath, forceStatic).catch((err) => {
          logger.error('[ProjectSettings] Failed to save force_static_serve', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
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
          {showForceStatic && (
            <div className="notification-setting-section">
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 'var(--spacing-sm)',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={forceStatic}
                  onChange={(e) => setForceStatic(e.target.checked)}
                  style={{ marginTop: 2 }}
                />
                <span
                  style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-xs)' }}
                >
                  <span
                    style={{
                      fontSize: 'var(--font-size-sm)',
                      fontWeight: 500,
                      color: 'var(--text-primary)',
                    }}
                  >
                    Serve as a static site
                  </span>
                  <span
                    style={{
                      fontSize: 'var(--font-size-xs)',
                      color: 'var(--text-muted)',
                      lineHeight: 1.4,
                    }}
                  >
                    Serve files directly even though a <code>package.json</code> is present. Use
                    this for plain HTML/CSS sites that keep a <code>package.json</code> only for
                    build tooling. Reopen the project to apply.
                  </span>
                </span>
              </label>
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
