/**
 * Custom hook for managing environment variable editor state and operations.
 *
 * Extracted from EnvEditor component to reduce component complexity.
 * Handles all state management, file operations, sync status checking,
 * and CRUD operations for .env files and their variables.
 *
 * @module hooks/useEnvEditor
 */

import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { trackEvent, trackError } from '../lib/analytics';
import { logger } from '../lib/logger';

/** Represents an environment file in the project */
export interface EnvFile {
  /** File name (e.g., ".env.local") */
  name: string;
  /** Absolute path to the file */
  path: string;
}

/** A single environment variable key-value pair */
export interface EnvVar {
  /** Variable name (e.g., "DATABASE_URL") */
  key: string;
  /** Variable value */
  value: string;
}

/** Params for the useEnvEditor hook */
interface UseEnvEditorParams {
  /** Absolute path to the project directory */
  projectPath: string;
  /** Whether the editor modal is open */
  isOpen: boolean;
  /** Callback to close the editor */
  onClose: () => void;
  /** Optional callback to show toast notifications */
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

/** Sync status between .env.local and .env.example */
interface SyncStatus {
  missingInExample: string[];
  missingInLocal: string[];
}

/** Return type for useEnvEditor hook */
export interface UseEnvEditorReturn {
  envFiles: EnvFile[];
  selectedFile: EnvFile | null;
  setSelectedFile: React.Dispatch<React.SetStateAction<EnvFile | null>>;
  vars: EnvVar[];
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  showNewFileInput: boolean;
  setShowNewFileInput: React.Dispatch<React.SetStateAction<boolean>>;
  newFileName: string;
  setNewFileName: React.Dispatch<React.SetStateAction<string>>;
  editingKey: string | null;
  setEditingKey: React.Dispatch<React.SetStateAction<string | null>>;
  hasChanges: boolean;
  visibleValues: Set<number>;
  showPasteModal: boolean;
  setShowPasteModal: React.Dispatch<React.SetStateAction<boolean>>;
  pasteContent: string;
  setPasteContent: React.Dispatch<React.SetStateAction<string>>;
  syncStatus: SyncStatus | null;
  checkSyncStatus: (files: EnvFile[]) => Promise<void>;
  loadEnvFiles: () => Promise<void>;
  loadVars: () => Promise<void>;
  handleSave: () => Promise<void>;
  handleAddVar: () => void;
  parseEnvContent: (content: string) => EnvVar[];
  handlePasteEnv: () => void;
  handleUpdateVar: (index: number, field: 'key' | 'value', newValue: string) => void;
  handleDeleteVar: (index: number) => void;
  toggleValueVisibility: (index: number) => void;
  handleSyncToExample: () => Promise<void>;
  handleSyncToLocal: () => Promise<void>;
  handleCreateFile: () => Promise<void>;
  handleDeleteFile: () => Promise<void>;
}

/**
 * Hook for managing environment variable editor state and operations.
 *
 * Handles all CRUD operations for .env files and variables, sync status
 * between .env.local and .env.example, paste parsing, and visibility toggles.
 *
 * @param params - Hook configuration
 * @returns All state, setters, and handler functions for the env editor
 */
export function useEnvEditor({
  projectPath,
  isOpen,
  onToast,
}: UseEnvEditorParams): UseEnvEditorReturn {
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
  const [showPasteModal, setShowPasteModal] = useState(false);
  const [pasteContent, setPasteContent] = useState('');
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);

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
      logger.error('Failed to check sync status', {
        error: e instanceof Error ? e.message : String(e),
      });
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
      logger.error('Failed to load env files', {
        error: e instanceof Error ? e.message : String(e),
      });
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
      trackError('env_read', e, 'Workspace');
      setError(`Failed to read ${selectedFile.name}`);
      logger.error('Failed to read env file', {
        error: e instanceof Error ? e.message : String(e),
      });
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
      void trackEvent('env_saved', {
        file: selectedFile.name,
        var_count: vars.length,
        $screen_name: 'Workspace',
      });
      onToast?.(`Saved ${selectedFile.name}`, 'success');
    } catch (e) {
      trackError('env_save', e, 'Workspace');
      setError(`Failed to save ${selectedFile.name}`);
      onToast?.(`Failed to save ${selectedFile.name}`, 'error');
      logger.error('Failed to save env file', {
        error: e instanceof Error ? e.message : String(e),
      });
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

  /** Parse .env content string into key-value pairs */
  const parseEnvContent = (content: string): EnvVar[] => {
    const parsed: EnvVar[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Match KEY=value pattern (value can be empty)
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match) {
        let value = match[2];
        // Remove surrounding quotes if present
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        parsed.push({ key: match[1], value });
      }
    }
    return parsed;
  };

  /** Handle pasting .env content - merges with existing vars */
  const handlePasteEnv = () => {
    const parsed = parseEnvContent(pasteContent);
    if (parsed.length === 0) {
      setShowPasteModal(false);
      setPasteContent('');
      return;
    }

    // Merge with existing vars (update existing keys, add new ones)
    const existingKeys = new Map(vars.map((v, i) => [v.key, i]));
    const updatedVars = [...vars];

    for (const newVar of parsed) {
      const existingIndex = existingKeys.get(newVar.key);
      if (existingIndex !== undefined) {
        // Update existing variable
        updatedVars[existingIndex] = newVar;
      } else {
        // Add new variable
        updatedVars.push(newVar);
      }
    }

    setVars(updatedVars);
    setHasChanges(true);
    setShowPasteModal(false);
    setPasteContent('');
    void trackEvent('env_vars_pasted', { var_count: parsed.length, $screen_name: 'Workspace' });
    onToast?.(`Added ${parsed.length} variable${parsed.length > 1 ? 's' : ''}`, 'success');
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
      void trackEvent('env_synced', {
        target: '.env.example',
        key_count: syncStatus.missingInExample.length,
        $screen_name: 'Workspace',
      });
      onToast?.('Synced keys to .env.example', 'success');
    } catch (e) {
      trackError('env_sync_example', e, 'Workspace');
      setError('Failed to sync to .env.example');
      onToast?.('Failed to sync to .env.example', 'error');
      logger.error('Failed to sync to .env.example', {
        error: e instanceof Error ? e.message : String(e),
      });
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
      void trackEvent('env_synced', {
        target: '.env.local',
        key_count: syncStatus.missingInLocal.length,
        $screen_name: 'Workspace',
      });
      onToast?.('Added missing keys to .env.local', 'success');
    } catch (e) {
      trackError('env_sync_local', e, 'Workspace');
      setError('Failed to sync to .env.local');
      onToast?.('Failed to sync to .env.local', 'error');
      logger.error('Failed to sync to .env.local', {
        error: e instanceof Error ? e.message : String(e),
      });
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
      void trackEvent('env_file_created', { file: fileName, $screen_name: 'Workspace' });
      onToast?.(`Created ${fileName}`, 'success');
    } catch (e) {
      trackError('env_file_create', e, 'Workspace');
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
      void trackEvent('env_file_deleted', { file: fileName, $screen_name: 'Workspace' });
      onToast?.(`Deleted ${fileName}`, 'success');
    } catch (e) {
      trackError('env_file_delete', e, 'Workspace');
      setError(`Failed to delete ${fileName}`);
      onToast?.(`Failed to delete ${fileName}`, 'error');
    }
  };

  return {
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
    checkSyncStatus,
    loadEnvFiles,
    loadVars,
    handleSave,
    handleAddVar,
    parseEnvContent,
    handlePasteEnv,
    handleUpdateVar,
    handleDeleteVar,
    toggleValueVisibility,
    handleSyncToExample,
    handleSyncToLocal,
    handleCreateFile,
    handleDeleteFile,
  };
}
