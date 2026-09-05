import { listen } from '@tauri-apps/api/event';
import { useEffect, type RefObject } from 'react';
import type { PreviewHandle } from '../components/preview/Preview';
import { isMac } from '../lib/setup';
import type { WorkspaceTab } from '../components/workspace/workspaceViewState';

interface Params {
  previewRef: RefObject<PreviewHandle | null>;
  hasPreview: boolean;
  projectTypeResolved: boolean;
  setIsPreviewHidden: (hidden: boolean) => void;
  setIsAgentPanelHidden: (hidden: boolean) => void;
  setWorkspaceTab: (tab: WorkspaceTab) => void;
  togglePreviewLogs: () => void;
  onSelectPreview?: () => void;
}

const PANEL_BUTTON_SELECTOR = '.workspace-panel-group button[data-workspace-panel]';
const PANEL_SHORTCUT_ACTION_ATTR = 'data-workspace-panel-shortcut-action';
const PANEL_SHORTCUT_TRIGGERED_ATTR = 'data-workspace-panel-shortcut-triggered';

function isDigitKey(key: string): boolean {
  return key.length === 1 && key >= '1' && key <= '9';
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')
  );
}

function isInsideDialog(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('[role="dialog"]'));
}

function invokePanelButton(button: HTMLButtonElement): void {
  const shortcutAction = button.getAttribute(PANEL_SHORTCUT_ACTION_ATTR);
  if (shortcutAction) button.setAttribute(PANEL_SHORTCUT_TRIGGERED_ATTR, shortcutAction);
  button.click();
  if (shortcutAction) button.removeAttribute(PANEL_SHORTCUT_TRIGGERED_ATTR);
}

/**
 * Workspace-local keyboard controls.
 *
 * Plain number shortcuts intentionally only fire from the app chrome/canvas,
 * not from text fields or dialogs, so typing a number into a terminal or form
 * remains ordinary text entry. Panel order is read from the rendered toolbar
 * buttons, which keeps the mapping in sync when the toolbar is rearranged.
 */
export function useWorkspaceShortcutControls({
  previewRef,
  hasPreview,
  projectTypeResolved,
  setIsPreviewHidden,
  setIsAgentPanelHidden,
  setWorkspaceTab,
  togglePreviewLogs,
  onSelectPreview,
}: Params): void {
  useEffect(() => {
    const mac = isMac();

    const selectMode = (index: number) => {
      if (!Number.isInteger(index) || index < 0 || index > 2) return;

      if (index === 0) {
        if (!hasPreview && projectTypeResolved) return;
        setIsPreviewHidden(false);
        setWorkspaceTab('preview');
        onSelectPreview?.();
      } else if (index === 1) {
        setIsAgentPanelHidden(false);
        setIsPreviewHidden(true);
      } else {
        setIsPreviewHidden(false);
        setWorkspaceTab('code');
      }
    };

    const toggleEditMode = () => {
      previewRef.current?.toggleEditMode();
    };

    const toggleInspector = () => {
      if (!hasPreview && projectTypeResolved) return;
      togglePreviewLogs();
    };

    const primaryKey = (event: KeyboardEvent) =>
      mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return;

      // Plain 1–9 follows the rendered order of the main panel group.
      if (
        isDigitKey(event.key) &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        !isEditableTarget(event.target) &&
        !isInsideDialog(event.target)
      ) {
        const index = Number(event.key) - 1;
        const button = document.querySelectorAll<HTMLButtonElement>(PANEL_BUTTON_SELECTOR)[index];
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        invokePanelButton(button);
        return;
      }

      // Cmd+Ctrl+1–3 is deliberately macOS-only: on Windows/Linux the
      // primary modifier is already Ctrl, so there is no distinct Cmd+Ctrl
      // chord to bind without colliding with the workspace shortcut.
      if (
        mac &&
        event.metaKey &&
        event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        isDigitKey(event.key)
      ) {
        const index = Number(event.key) - 1;
        if (index > 2) return;
        // The native menu owns this accelerator on macOS so it works through
        // the preview iframe and does not toggle twice in the app frame.
        return;
      }

      if (
        !mac &&
        primaryKey(event) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'e'
      ) {
        event.preventDefault();
        event.stopPropagation();
        toggleEditMode();
        return;
      }

      if (
        !mac &&
        primaryKey(event) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'i'
      ) {
        event.preventDefault();
        event.stopPropagation();
        toggleInspector();
      }
      /*
       * Cmd+Ctrl+1–3 and Cmd+E are handled by native menu accelerators on
       * macOS. Their Tauri events call the same functions above.
       */
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    const unlistenMode = listen<number>('switch-workspace-mode-shortcut', ({ payload }) => {
      selectMode(payload - 1);
    });
    const unlistenEdit = listen('toggle-edit-mode-shortcut', toggleEditMode);
    const unlistenInspector = listen('toggle-inspector-shortcut', toggleInspector);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      void unlistenMode.then((fn) => fn());
      void unlistenEdit.then((fn) => fn());
      void unlistenInspector.then((fn) => fn());
    };
  }, [
    hasPreview,
    onSelectPreview,
    previewRef,
    projectTypeResolved,
    setIsAgentPanelHidden,
    setIsPreviewHidden,
    setWorkspaceTab,
    togglePreviewLogs,
  ]);
}
