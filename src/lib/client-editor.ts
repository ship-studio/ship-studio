import { invoke } from '@tauri-apps/api/core';

export async function detectClientEditor(projectPath: string): Promise<boolean> {
  return invoke<boolean>('detect_client_editor', { projectPath });
}
