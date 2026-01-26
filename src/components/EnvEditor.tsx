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
 * @module components/EnvEditor
 */

import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';

/** Represents an environment file in the project */
interface EnvFile {
  /** File name (e.g., ".env.local") */
  name: string;
  /** Absolute path to the file */
  path: string;
}

/** A single environment variable key-value pair */
interface EnvVar {
  /** Variable name (e.g., "DATABASE_URL") */
  key: string;
  /** Variable value */
  value: string;
}

/** Props for the EnvEditor component */
interface EnvEditorProps {
  /** Absolute path to the project directory */
  projectPath: string;
  /** Whether the editor modal is open */
  isOpen: boolean;
  /** Callback to close the editor */
  onClose: () => void;
  /** Optional callback to show toast notifications */
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

export function EnvEditor({ projectPath, isOpen, onClose, onToast }: EnvEditorProps) {
  const [envFiles, setEnvFiles] = useState<EnvFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<EnvFile | null>(null);
  const [vars, setVars] = useState<EnvVar[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNewFileInput, setShowNewFileInput] = useState(false);
  const [newFileName, setNewFileName] = useState('.env.local');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [visibleValues, setVisibleValues] = useState<Set<number>>(new Set());
  const [syncStatus, setSyncStatus] = useState<{
    missingInExample: string[];
    missingInLocal: string[];
  } | null>(null);

  // Check sync status between .env.local and .env.example
  const checkSyncStatus = useCallback(async (files: EnvFile[]) => {
    const envLocal = files.find((f) => f.name === '.env.local');
    const envExample = files.find((f) => f.name === '.env.example' || f.name === '.env');

    if (!envLocal || !envExample) {
      setSyncStatus(null);
      return;
    }

    try {
      const [localVars, exampleVars] = await Promise.all([
        invoke<EnvVar[]>('read_env_file', { filePath: envLocal.path }),
        invoke<EnvVar[]>('read_env_file', { filePath: envExample.path }),
      ]);

      const localKeys = new Set(localVars.map((v) => v.key));
      const exampleKeys = new Set(exampleVars.map((v) => v.key));

      const missingInExample = localVars.filter((v) => !exampleKeys.has(v.key)).map((v) => v.key);
      const missingInLocal = exampleVars.filter((v) => !localKeys.has(v.key)).map((v) => v.key);

      if (missingInExample.length > 0 || missingInLocal.length > 0) {
        setSyncStatus({ missingInExample, missingInLocal });
      } else {
        setSyncStatus(null);
      }
    } catch (e) {
      console.error('Failed to check sync status:', e);
      setSyncStatus(null);
    }
  }, []);

  // Load env files list
  const loadEnvFiles = useCallback(async () => {
    try {
      const files = await invoke<EnvFile[]>('list_env_files', { projectPath });
      setEnvFiles(files);

      // Auto-select first file or .env.local if available
      if (files.length > 0 && !selectedFile) {
        const envLocal = files.find((f) => f.name === '.env.local');
        setSelectedFile(envLocal || files[0]);
      }

      // Check sync status
      void checkSyncStatus(files);
    } catch (e) {
      console.error('Failed to load env files:', e);
    }
  }, [projectPath, selectedFile, checkSyncStatus]);

  // Load vars for selected file
  const loadVars = useCallback(async () => {
    if (!selectedFile) return;

    setIsLoading(true);
    setError(null);
    try {
      const fileVars = await invoke<EnvVar[]>('read_env_file', { filePath: selectedFile.path });
      setVars(fileVars);
      setHasChanges(false);
      setVisibleValues(new Set()); // Reset visibility when loading new file
    } catch (e) {
      setError(`Failed to read ${selectedFile.name}`);
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  }, [selectedFile]);

  useEffect(() => {
    if (isOpen) {
      void loadEnvFiles();
    }
  }, [isOpen, loadEnvFiles]);

  useEffect(() => {
    if (selectedFile) {
      void loadVars();
    }
  }, [selectedFile, loadVars]);

  const handleSave = async () => {
    if (!selectedFile) return;

    setIsSaving(true);
    setError(null);
    try {
      await invoke('write_env_file', { filePath: selectedFile.path, vars });
      setHasChanges(false);
      // Re-check sync status after saving
      void checkSyncStatus(envFiles);
      onToast?.(`Saved ${selectedFile.name}`, 'success');
    } catch (e) {
      setError(`Failed to save ${selectedFile.name}`);
      onToast?.(`Failed to save ${selectedFile.name}`, 'error');
      console.error(e);
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddVar = () => {
    const newKey = `NEW_VAR_${vars.length + 1}`;
    setVars([...vars, { key: newKey, value: '' }]);
    setEditingKey(newKey);
    setHasChanges(true);
  };

  const handleUpdateVar = (index: number, field: 'key' | 'value', newValue: string) => {
    const updated = [...vars];
    updated[index] = { ...updated[index], [field]: newValue };
    setVars(updated);
    setHasChanges(true);
  };

  const handleDeleteVar = (index: number) => {
    setVars(vars.filter((_, i) => i !== index));
    setHasChanges(true);
    // Update visible indices after deletion
    setVisibleValues((prev) => {
      const updated = new Set<number>();
      prev.forEach((i) => {
        if (i < index) updated.add(i);
        else if (i > index) updated.add(i - 1);
      });
      return updated;
    });
  };

  const toggleValueVisibility = (index: number) => {
    setVisibleValues((prev) => {
      const updated = new Set(prev);
      if (updated.has(index)) {
        updated.delete(index);
      } else {
        updated.add(index);
      }
      return updated;
    });
  };

  // Sync missing keys to .env.example (keys only, not values)
  const handleSyncToExample = async () => {
    if (!syncStatus?.missingInExample.length) return;

    const envExample = envFiles.find((f) => f.name === '.env.example' || f.name === '.env');
    const envLocal = envFiles.find((f) => f.name === '.env.local');

    if (!envExample || !envLocal) return;

    try {
      // Read current .env.example
      const exampleVars = await invoke<EnvVar[]>('read_env_file', { filePath: envExample.path });

      // Add missing keys with placeholder values
      const newVars = [...exampleVars];
      for (const key of syncStatus.missingInExample) {
        newVars.push({ key, value: '' });
      }

      // Write back to .env.example
      await invoke('write_env_file', { filePath: envExample.path, vars: newVars });
      // Refresh sync status
      void checkSyncStatus(envFiles);

      // If we're viewing .env.example, reload it
      if (selectedFile?.name === '.env.example' || selectedFile?.name === '.env') {
        void loadVars();
      }
      onToast?.('Synced keys to .env.example', 'success');
    } catch (e) {
      setError('Failed to sync to .env.example');
      onToast?.('Failed to sync to .env.example', 'error');
      console.error(e);
    }
  };

  // Add missing keys from .env.example to .env.local
  const handleSyncToLocal = async () => {
    if (!syncStatus?.missingInLocal.length) return;

    const envLocal = envFiles.find((f) => f.name === '.env.local');

    if (!envLocal) return;

    try {
      // Read current .env.local
      const localVars = await invoke<EnvVar[]>('read_env_file', { filePath: envLocal.path });

      // Add missing keys with empty values
      const newVars = [...localVars];
      for (const key of syncStatus.missingInLocal) {
        newVars.push({ key, value: '' });
      }

      // Write back to .env.local
      await invoke('write_env_file', { filePath: envLocal.path, vars: newVars });

      // Refresh sync status
      void checkSyncStatus(envFiles);

      // If we're viewing .env.local, reload it
      if (selectedFile?.name === '.env.local') {
        void loadVars();
      }
      onToast?.('Added missing keys to .env.local', 'success');
    } catch (e) {
      setError('Failed to sync to .env.local');
      onToast?.('Failed to sync to .env.local', 'error');
      console.error(e);
    }
  };

  const handleCreateFile = async () => {
    if (!newFileName.trim()) return;

    const fileName = newFileName.trim();
    try {
      const path = await invoke<string>('create_env_file', {
        projectPath,
        fileName,
      });
      setShowNewFileInput(false);
      setNewFileName('.env.local');
      const files = await invoke<EnvFile[]>('list_env_files', { projectPath });
      setEnvFiles(files);
      void checkSyncStatus(files);
      setSelectedFile({ name: fileName, path });
      onToast?.(`Created ${fileName}`, 'success');
    } catch (e) {
      setError(e as string);
      onToast?.(`Failed to create ${fileName}`, 'error');
    }
  };

  const handleDeleteFile = async () => {
    if (!selectedFile) return;

    if (!confirm(`Delete ${selectedFile.name}? This cannot be undone.`)) return;

    const fileName = selectedFile.name;
    try {
      await invoke('delete_env_file', { filePath: selectedFile.path });
      setSelectedFile(null);
      setVars([]);
      const files = await invoke<EnvFile[]>('list_env_files', { projectPath });
      setEnvFiles(files);
      void checkSyncStatus(files);
      onToast?.(`Deleted ${fileName}`, 'success');
    } catch {
      setError(`Failed to delete ${fileName}`);
      onToast?.(`Failed to delete ${fileName}`, 'error');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal env-editor-modal" onClick={(e) => e.stopPropagation()}>
        <div className="env-editor-header">
          <h3>Environment Variables</h3>
          <button className="env-close-btn" onClick={onClose}>
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
                        {syncStatus.missingInExample.length > 1 ? 's' : ''} in .env.local missing
                        from .env.example
                      </span>
                    </div>
                    <button className="env-sync-btn" onClick={() => void handleSyncToExample()}>
                      Sync to .env.example
                    </button>
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
                        {syncStatus.missingInLocal.length > 1 ? 's' : ''} in .env.example missing
                        from .env.local
                      </span>
                    </div>
                    <button className="env-sync-btn" onClick={() => void handleSyncToLocal()}>
                      Add to .env.local
                    </button>
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
                <button className="env-add-btn" onClick={handleAddVar}>
                  + Add Variable
                </button>
                <div className="env-actions-right">
                  {selectedFile && (
                    <button
                      className="env-delete-file-btn"
                      onClick={() => void handleDeleteFile()}
                      title="Delete this file"
                    >
                      Delete File
                    </button>
                  )}
                  <button
                    className="env-save-btn"
                    onClick={() => void handleSave()}
                    disabled={!hasChanges || isSaving || isLoading}
                  >
                    {isSaving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="env-empty-state">
              <div className="env-empty-icon">$</div>
              <h4>No environment files</h4>
              <p>Create an .env file to store your API keys and secrets.</p>
              <button className="env-create-btn" onClick={() => setShowNewFileInput(true)}>
                Create .env.local
              </button>
            </div>
          )}

          {error && <div className="env-error">{error}</div>}
        </div>
      </div>
    </div>
  );
}
