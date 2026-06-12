import { HelpModal } from './HelpModal';
import { ChangelogModal } from './dashboard/ChangelogModal';
import { useModal } from '../contexts/ModalContext';
import { usePaletteContext } from './CommandPalette/paletteContext';

/**
 * Globally-mounted modals that palette commands can open from any view.
 *
 * HelpModal and ChangelogModal were previously mounted inside view-specific
 * components (WorkspaceModals / ProjectList). That meant opening them via
 * `useModal('help').open()` from the home view (for example via the
 * command palette) was a no-op — the consumer wasn't in the tree. Mounting
 * them once at the app level fixes that while preserving each modal's
 * own state (via `useModal`).
 */
export function AppGlobalModals() {
  const ctx = usePaletteContext();
  const changelog = useModal('changelog');
  return (
    <>
      <HelpModal projectPath={ctx.currentProjectPath ?? undefined} />
      <ChangelogModal isOpen={changelog.isOpen} onClose={changelog.close} />
    </>
  );
}
