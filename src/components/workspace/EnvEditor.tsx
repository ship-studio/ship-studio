/**
 * EnvEditor component for managing environment variables.
 *
 * Provides a modal interface to:
 * - View and edit .env files (.env, .env.local, .env.example, etc.)
 * - Add, update, and delete environment variables
 * - Create new .env files
 * - Check sync status between .env.local and .env.example
 * - Toggle value visibility (show/hide sensitive values)
 *
 * State and logic are managed by the useEnvEditor hook.
 *
 * @module components/EnvEditor
 */

import { useEnvEditor } from '../../hooks/useEnvEditor';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useModal } from '../../contexts/ModalContext';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';

/** Props for the EnvEditor component */
interface EnvEditorProps {
  /** Absolute path to the project directory */
  projectPath: string;
}

export function EnvEditor({ projectPath }: EnvEditorProps) {
  const { isOpen, close: onClose } = useModal('envEditor');
  const { showToast } = useOptionalToast();
  const onToast = (message: string, type?: 'success' | 'error') => showToast(message, type);
  const {
    envFiles,
    selectedFile,
    setSelectedFile,
    vars,
    isLoading,
    isSaving,
    error,
    showNewFileInput,
    setShowNewFileInput,
    newFileName,
    setNewFileName,
    editingKey,
    setEditingKey,
    hasChanges,
    visibleValues,
    showPasteModal,
    setShowPasteModal,
    pasteContent,
    setPasteContent,
    syncStatus,
    handleSave,
    handleAddVar,
    handlePasteEnv,
    handleUpdateVar,
    handleDeleteVar,
    toggleValueVisibility,
    handleSyncToExample,
    handleSyncToLocal,
    handleCreateFile,
    handleDeleteFile,
  } = useEnvEditor({ projectPath, isOpen, onClose, onToast });

  if (!isOpen) return null;

  return (
    <ModalFrame
      isOpen={isOpen}
      onClose={onClose}
      title="Environment Variables"
      className="env-editor-modal"
      // While the nested paste mini-modal is open, ESC / overlay-click must not
      // tear down the whole editor (and the pasted content with it).
      dismissable={!showPasteModal}
    >
      <div className="env-editor-content">
        {/* File Tabs */}
        <div className="env-file-tabs">
          {envFiles.map((file) => (
            <button
              key={file.path}
              className={`env-file-tab ${selectedFile?.path === file.path ? 'active' : ''}`}
              onClick={() => setSelectedFile(file)}
            >
              {file.name}
            </button>
          ))}
          {showNewFileInput ? (
            <div className="env-new-file-input">
              <input
                type="text"
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreateFile();
                  if (e.key === 'Escape') setShowNewFileInput(false);
                }}
                placeholder=".env.local"
                autoFocus
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <button onClick={() => void handleCreateFile()} title="Create">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </button>
              <button onClick={() => setShowNewFileInput(false)} title="Cancel">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ) : (
            <button
              className="env-file-tab env-add-file"
              onClick={() => setShowNewFileInput(true)}
              title="Create new env file"
            >
              +
            </button>
          )}
        </div>

        {/* Sync Warning */}
        {syncStatus &&
          (syncStatus.missingInExample.length > 0 || syncStatus.missingInLocal.length > 0) && (
            <div className="env-sync-warning">
              {syncStatus.missingInExample.length > 0 && (
                <div className="env-sync-item">
                  <div className="env-sync-info">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    <span>
                      {syncStatus.missingInExample.length} key
                      {syncStatus.missingInExample.length > 1 ? 's' : ''} in .env.local missing from
                      .env.example
                    </span>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => void handleSyncToExample()}>
                    Sync to .env.example
                  </Button>
                </div>
              )}
              {syncStatus.missingInLocal.length > 0 && (
                <div className="env-sync-item">
                  <div className="env-sync-info">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    <span>
                      {syncStatus.missingInLocal.length} key
                      {syncStatus.missingInLocal.length > 1 ? 's' : ''} in .env.example missing from
                      .env.local
                    </span>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => void handleSyncToLocal()}>
                    Add to .env.local
                  </Button>
                </div>
              )}
            </div>
          )}

        {/* Variables List */}
        {isLoading ? (
          <div className="env-loading">Loading...</div>
        ) : selectedFile ? (
          <div className="env-vars-container">
            <div className="env-vars-list">
              {vars.length === 0 ? (
                <div className="env-empty">
                  No variables defined. Click "Add Variable" to get started.
                </div>
              ) : (
                vars.map((v, index) => (
                  <div key={index} className="env-var-row">
                    <input
                      type="text"
                      className="env-var-key"
                      value={v.key}
                      onChange={(e) => handleUpdateVar(index, 'key', e.target.value)}
                      placeholder="KEY"
                      autoFocus={editingKey === v.key}
                      onFocus={() => setEditingKey(v.key)}
                      onBlur={() => setEditingKey(null)}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                    />
                    <span className="env-var-equals">=</span>
                    <input
                      type={visibleValues.has(index) ? 'text' : 'password'}
                      className="env-var-value"
                      value={v.value}
                      onChange={(e) => handleUpdateVar(index, 'value', e.target.value)}
                      placeholder="value"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                    />
                    <button
                      className="env-var-visibility"
                      onClick={() => toggleValueVisibility(index)}
                      title={visibleValues.has(index) ? 'Hide value' : 'Show value'}
                    >
                      {visibleValues.has(index) ? (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                          <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                          <line x1="1" y1="1" x2="23" y2="23" />
                        </svg>
                      ) : (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      )}
                    </button>
                    <button
                      className="env-var-delete"
                      onClick={() => handleDeleteVar(index)}
                      title="Delete variable"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="env-actions">
              <div className="env-actions-left">
                <Button variant="secondary" onClick={handleAddVar}>
                  + Add Variable
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setShowPasteModal(true)}
                  leftIcon={
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                      <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
                    </svg>
                  }
                >
                  Paste .env
                </Button>
              </div>
              <div className="env-actions-right">
                {selectedFile && (
                  <Button
                    variant="danger"
                    onClick={() => void handleDeleteFile()}
                    title="Delete this file"
                  >
                    Delete File
                  </Button>
                )}
                <Button
                  variant="primary"
                  onClick={() => void handleSave()}
                  disabled={!hasChanges || isSaving || isLoading}
                >
                  {isSaving ? 'Saving...' : 'Save'}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="env-empty-state">
            <div className="env-empty-icon">$</div>
            <h4>No environment files</h4>
            <p>Create an .env file to store your API keys and secrets.</p>
            <Button variant="primary" onClick={() => setShowNewFileInput(true)}>
              Create .env.local
            </Button>
          </div>
        )}

        {error && <div className="env-error">{error}</div>}
      </div>

      {/* Paste Modal */}
      {showPasteModal && (
        <div className="env-paste-overlay" onMouseDown={() => setShowPasteModal(false)}>
          <div className="env-paste-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="env-paste-header">
              <h4>Paste .env Contents</h4>
              <button
                className="env-close-btn"
                onClick={() => {
                  setShowPasteModal(false);
                  setPasteContent('');
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <p className="env-paste-hint">
              Paste your .env file contents below. Variables will be merged with existing ones.
            </p>
            <textarea
              className="env-paste-textarea"
              value={pasteContent}
              onChange={(e) => setPasteContent(e.target.value)}
              placeholder={`DATABASE_URL=postgres://...\nAPI_KEY=sk-...\nNODE_ENV=development`}
              autoFocus
              spellCheck={false}
            />
            <div className="env-paste-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  setShowPasteModal(false);
                  setPasteContent('');
                }}
              >
                Cancel
              </Button>
              <Button variant="primary" onClick={handlePasteEnv} disabled={!pasteContent.trim()}>
                Add Variables
              </Button>
            </div>
          </div>
        </div>
      )}
    </ModalFrame>
  );
}
