/**
 * Snapshots / Undo-Redo wrapper for the Tauri backend.
 *
 * Snapshots are per-turn captures of the working tree, taken automatically
 * by a debounced file watcher in the backend. The frontend just starts the
 * watcher, polls status, and triggers undo/redo. See
 * `src-tauri/src/commands/snapshots.rs` for the underlying mechanism.
 *
 * @module lib/snapshots
 */

import { invoke } from '@tauri-apps/api/core';

export interface SnapshotStatus {
  watching: boolean;
  can_undo: boolean;
  can_redo: boolean;
  history_size: number;
  cursor: number;
  /** Files changed between the prior cursor and the new one (empty for `getStatus`). */
  files_changed: string[];
}

export async function startWatching(projectPath: string): Promise<void> {
  await invoke<void>('snapshot_start_watching', { projectPath });
}

export async function stopWatching(projectPath: string): Promise<void> {
  await invoke<void>('snapshot_stop_watching', { projectPath });
}

export async function getStatus(projectPath: string): Promise<SnapshotStatus> {
  return invoke<SnapshotStatus>('snapshot_status', { projectPath });
}

export async function undo(projectPath: string): Promise<SnapshotStatus> {
  return invoke<SnapshotStatus>('snapshot_undo', { projectPath });
}

export async function redo(projectPath: string): Promise<SnapshotStatus> {
  return invoke<SnapshotStatus>('snapshot_redo', { projectPath });
}
