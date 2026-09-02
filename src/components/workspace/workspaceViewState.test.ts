import { describe, expect, it } from 'vitest';
import {
  defaultWorkspaceTab,
  workspaceModeValue,
  workspacePreviewCapabilities,
} from './workspaceViewState';

describe('workspace view state', () => {
  it('switches the navigation value to focus while preview is hidden', () => {
    expect(workspaceModeValue(false, 'preview')).toBe('preview');
    expect(workspaceModeValue(false, 'branches')).toBe('branches');
    expect(workspaceModeValue(true, 'preview')).toBe('focus');
    expect(workspaceModeValue(true, 'prs')).toBe('focus');
  });

  it('keeps web projects on the preview surface', () => {
    expect(workspacePreviewCapabilities('nextjs', true)).toEqual({
      isMobileProject: false,
      mobilePreviewAvailable: false,
      isWebProject: true,
      hasPreview: true,
    });
  });

  it('exposes a generic project preview only when it has a custom dev command', () => {
    expect(workspacePreviewCapabilities('generic', true).hasPreview).toBe(false);
    expect(workspacePreviewCapabilities('generic', true, 'pnpm dev')).toMatchObject({
      isWebProject: true,
      hasPreview: true,
    });
  });

  it('only exposes mobile preview when the platform supports it', () => {
    expect(workspacePreviewCapabilities('reactnative', false)).toEqual({
      isMobileProject: true,
      mobilePreviewAvailable: false,
      isWebProject: false,
      hasPreview: false,
    });
    expect(workspacePreviewCapabilities('reactnative', true)).toEqual({
      isMobileProject: true,
      mobilePreviewAvailable: true,
      isWebProject: false,
      hasPreview: true,
    });
  });

  it('routes projects without a preview to code by default', () => {
    expect(defaultWorkspaceTab(true)).toBe('preview');
    expect(defaultWorkspaceTab(false)).toBe('code');
  });
});
