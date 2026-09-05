/**
 * Modal for configuring project settings.
 *
 * Currently supports setting the dev server port.
 * The parent component handles persistence via Tauri commands.
 */

import { useEffect, useRef, useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { TextField } from '../primitives/TextField';
import { useModal, type ModalId } from '../../contexts/ModalContext';
import { getForceStaticServe, setForceStaticServe } from '../../lib/project';
import { logger } from '../../lib/logger';

interface ProjectSettingsModalProps {
  currentPort: number;
  onSave: (port: number) => void;
  /** Modal id used by the caller when more than one settings surface exists. */
  modalId?: ModalId;
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
  modalId = 'projectSettings',
  customDevCommand,
  onSaveDevCommand,
  isWebProject,
  projectPath,
}: ProjectSettingsModalProps) {
  const { isOpen, close: onClose } = useModal(modalId);
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
      className="project-settings-content settings-form-content"
    >
      <>
        <p className="project-settings-intro settings-form-intro">
          Configure settings for this project.
        </p>
        <div className="project-settings-body settings-form-body">
          <div className="project-settings-section settings-form-section">
            <div className="project-settings-field settings-form-field">
              <label
                className="project-settings-label settings-form-label"
                htmlFor="project-settings-port"
              >
                Dev Server Port
              </label>
              <TextField
                id="project-settings-port"
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
                min={1}
                max={65535}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && isValid) handleSave();
                }}
                invalid={!isValid}
                aria-invalid={!isValid}
              />
              {!isValid && (
                <span className="project-settings-error settings-form-error">
                  Port must be between 1 and 65535
                </span>
              )}
              <span className="project-settings-help settings-form-help">
                The port Ship Studio uses to connect to your dev server. Default is 3000.
              </span>
            </div>
          </div>
          {showDevCommand && (
            <div className="project-settings-section settings-form-section">
              <div className="project-settings-field settings-form-field">
                <label
                  className="project-settings-label settings-form-label"
                  htmlFor="project-settings-command"
                >
                  Dev Server Command
                </label>
                <TextField
                  id="project-settings-command"
                  type="text"
                  value={devCommand}
                  onChange={(e) => setDevCommand(e.target.value)}
                  placeholder="e.g., npm run dev, cargo run"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && isValid) handleSave();
                  }}
                  className="ss-text-field--code"
                />
                <span className="project-settings-help settings-form-help">
                  If set, this command will start automatically and can be restarted from the
                  toolbar. Leave blank to manage the dev server yourself in the terminal.
                </span>
              </div>
            </div>
          )}
          {showForceStatic && (
            <div className="project-settings-section settings-form-section">
              <label className="project-settings-checkbox settings-form-checkbox">
                <input
                  type="checkbox"
                  checked={forceStatic}
                  onChange={(e) => setForceStatic(e.target.checked)}
                />
                <span className="project-settings-checkbox-copy settings-form-checkbox-copy">
                  <span className="project-settings-checkbox-title settings-form-checkbox-title">
                    Serve as a static site
                  </span>
                  <span className="project-settings-checkbox-description settings-form-checkbox-description">
                    Serve files directly even though a <code>package.json</code> is present. Use
                    this for plain HTML/CSS sites that keep a <code>package.json</code> only for
                    build tooling. Reopen the project to apply.
                  </span>
                </span>
              </label>
            </div>
          )}
        </div>
        <div className="project-settings-footer settings-form-footer">
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
