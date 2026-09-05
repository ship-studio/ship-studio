import { hasWebPreview, isMobileProjectType, type ProjectType } from '../../lib/static-server';

export type WorkspaceTab = 'preview' | 'code' | 'branches' | 'prs';

/** Resolves the visible mode value, mapping a hidden preview to focus mode. */
export function workspaceModeValue(
  isPreviewHidden: boolean,
  workspaceTab: WorkspaceTab
): WorkspaceTab | 'focus' {
  return isPreviewHidden ? 'focus' : workspaceTab;
}

/** Derives web and mobile preview availability from project type, platform, and dev command. */
export function workspacePreviewCapabilities(
  projectType: ProjectType,
  supportsMobilePreview: boolean,
  customDevCommand: string | null = null
): {
  isMobileProject: boolean;
  mobilePreviewAvailable: boolean;
  isWebProject: boolean;
  hasPreview: boolean;
} {
  const isMobileProject = isMobileProjectType(projectType);
  const mobilePreviewAvailable = isMobileProject && supportsMobilePreview;
  const isWebProject = hasWebPreview(projectType, customDevCommand);
  return {
    isMobileProject,
    mobilePreviewAvailable,
    isWebProject,
    hasPreview: isWebProject || mobilePreviewAvailable,
  };
}

/** Returns the initial workspace tab for a project with or without preview support. */
export function defaultWorkspaceTab(
  hasPreview: boolean,
  projectTypeResolved = true
): 'preview' | 'code' {
  return hasPreview || !projectTypeResolved ? 'preview' : 'code';
}
