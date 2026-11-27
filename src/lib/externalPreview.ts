/** Tauri bridge wrappers for the isolated external preview child webview. */

import { invoke } from '@tauri-apps/api/core';

export interface ExternalPreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function createExternalPreviewWebview(
  url: string,
  bounds: ExternalPreviewBounds,
  ownerId: string
): Promise<void> {
  return invoke('create_external_preview_webview', { url, ...bounds, ownerId });
}

export function navigateExternalPreviewWebview(url: string, ownerId: string): Promise<void> {
  return invoke('navigate_external_preview_webview', { url, ownerId });
}

export function resizeExternalPreviewWebview(
  bounds: ExternalPreviewBounds,
  ownerId: string
): Promise<void> {
  return invoke('resize_external_preview_webview', { ...bounds, ownerId });
}

export function setExternalPreviewWebviewVisible(visible: boolean, ownerId: string): Promise<void> {
  return invoke('set_external_preview_webview_visible', { visible, ownerId });
}

export function destroyExternalPreviewWebview(ownerId: string): Promise<void> {
  return invoke('destroy_external_preview_webview', { ownerId });
}
