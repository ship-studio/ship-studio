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
import type { ToastType } from '../../hooks/useToasts';
import { IconButton } from '../primitives/IconButton';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../primitives/Tabs';
import {
  CheckIcon,
  CloseIcon,
  EyeIcon,
  EyeOffIcon,
  InfoIcon,
  PasteIcon,
  SaveIcon,
  TrashIcon,
} from '@/components/icons';

/** Props for the EnvEditor component */
interface EnvEditorProps {
  /** Absolute path to the project directory */
  projectPath: string;
}

export function EnvEditor({ projectPath }: EnvEditorProps) {
  const { isOpen, close: onClose } = useModal('envEditor');
  const { showToast } = useOptionalToast();
  const onToast = (message: string, type?: ToastType) => showToast(message, type);
  const {
    envFiles,
    selectedFile,
    setSelectedFile,
    vars,
    isLoading,
    isSaving,
    error,
    keyNotice,
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
        <Tabs
          value={selectedFile?.path ?? ''}
          onValueChange={(path) => {
            const file = envFiles.find((candidate) => candidate.path === path);
            if (file) setSelectedFile(file);
          }}
        >
          {/* File Tabs */}
          <div className="env-file-tabs">
            <TabsList className="env-file-tabs-list" aria-label="Environment files">
              {envFiles.map((file) => (
                <TabsTab key={file.path} value={file.path} className="env-file-tab">
                  {file.name}
                </TabsTab>
              ))}
            </TabsList>
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
                <IconButton
                  variant="default"
                  size="compact"
                  onClick={() => void handleCreateFile()}
                  title="Create"
                  aria-label="Create"
                  icon={<CheckIcon size={14} />}
                />
                <IconButton
                  variant="default"
                  size="compact"
                  onClick={() => setShowNewFileInput(false)}
                  title="Cancel"
                  aria-label="Cancel"
                  icon={<CloseIcon size={14} />}
                />
              </div>
            ) : (
              <IconButton
                variant="default"
                size="compact"
                className="env-add-file"
                onClick={() => setShowNewFileInput(true)}
                title="Create new env file"
                aria-label="Create new env file"
                icon="+"
              />
            )}
          </div>

          {envFiles.map((file) => (
            <TabsPanel key={file.path} value={file.path} className="env-file-panel">
              {selectedFile?.path === file.path && (
                <>
                  {/* Sync Warning */}
                  {syncStatus &&
                    (syncStatus.missingInExample.length > 0 ||
                      syncStatus.missingInLocal.length > 0) && (
                      <div className="env-sync-warning">
                        {syncStatus.missingInExample.length > 0 && (
                          <div className="env-sync-item">
                            <div className="env-sync-info">
                              <InfoIcon size={14} />
                              <span>
                                {syncStatus.missingInExample.length} key
                                {syncStatus.missingInExample.length > 1 ? 's' : ''} in .env.local
                                missing from .env.example
                              </span>
                            </div>
                            <Button
                              variant="secondary"
                              size="compact"
                              onClick={() => void handleSyncToExample()}
                            >
                              Sync to .env.example
                            </Button>
                          </div>
                        )}
                        {syncStatus.missingInLocal.length > 0 && (
                          <div className="env-sync-item">
                            <div className="env-sync-info">
                              <InfoIcon size={14} />
                              <span>
                                {syncStatus.missingInLocal.length} key
                                {syncStatus.missingInLocal.length > 1 ? 's' : ''} in .env.example
                                missing from .env.local
                              </span>
                            </div>
                            <Button
                              variant="secondary"
                              size="compact"
                              onClick={() => void handleSyncToLocal()}
                            >
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
                                  <EyeOffIcon size={14} />
                                ) : (
                                  <EyeIcon size={14} />
                                )}
                              </button>
                              <button
                                className="env-var-delete"
                                onClick={() => handleDeleteVar(index)}
                                title="Delete variable"
                              >
                                <TrashIcon size={14} />
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
                            leftIcon={<PasteIcon />}
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
                            leftIcon={!isSaving ? <SaveIcon size={14} /> : undefined}
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

                  {keyNotice && <div className="env-key-notice">{keyNotice}</div>}
                  {error && <div className="env-error">{error}</div>}
                </>
              )}
            </TabsPanel>
          ))}

          {envFiles.length === 0 && (
            <div className="env-empty-state">
              <div className="env-empty-icon">$</div>
              <h4>No environment files</h4>
              <p>Create an .env file to store your API keys and secrets.</p>
              <Button variant="primary" onClick={() => setShowNewFileInput(true)}>
                Create .env.local
              </Button>
            </div>
          )}
        </Tabs>
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
                <CloseIcon size={16} />
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
