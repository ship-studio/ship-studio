import { HelpModal } from './HelpModal';
import { ChangelogModal } from './dashboard/ChangelogModal';
import { AttachedLibrariesModal } from './dashboard/AttachedLibrariesModal';
import { SettingsModal } from './dashboard/SettingsModal';
import { ToastList } from './primitives/ToastList';
import { useModal } from '../contexts/ModalContext';
import { usePaletteContext } from './CommandPalette/paletteContext';
import { ToastProvider, useToast } from '../contexts/ToastContext';

/**
 * Globally-mounted modals that palette commands can open from any view.
 *
 * HelpModal and ChangelogModal were previously mounted inside view-specific
 * components (WorkspaceModals / ProjectList). That meant opening them via
 * `useModal('help').open()` from the home view (for example via the
 * command palette) was a no-op — the consumer wasn't in the tree. Mounting
 * them once at the app level fixes that while preserving each modal's
 * own state (via `useModal`).
 *
 * These modals render *outside* AppContents' per-view ToastProvider, so this
 * layer owns its own — without it, `useOptionalToast()` inside a global modal
 * falls through to the no-op fallback and add/remove/error feedback is
 * silently dropped.
 */
export function AppGlobalModals() {
  return (
    <ToastProvider>
      <GlobalModalsBody />
    </ToastProvider>
  );
}

function GlobalModalsBody() {
  const ctx = usePaletteContext();
  const changelog = useModal('changelog');
  const attachedLibraries = useModal('attachedLibraries');
  const settings = useModal('settings');
  const { toasts, dismissToast } = useToast();

  return (
    <>
      <HelpModal projectPath={ctx.currentProjectPath ?? undefined} />
      <ChangelogModal isOpen={changelog.isOpen} onClose={changelog.close} />
      <AttachedLibrariesModal isOpen={attachedLibraries.isOpen} onClose={attachedLibraries.close} />
      <SettingsModal isOpen={settings.isOpen} onClose={settings.close} />
      <ToastList toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
