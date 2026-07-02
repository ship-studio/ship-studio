import { useMemo } from 'react';
import { HelpModal } from './HelpModal';
import { ChangelogModal } from './dashboard/ChangelogModal';
import { AttachedLibrariesModal } from './dashboard/AttachedLibrariesModal';
import { useModal } from '../contexts/ModalContext';
import { usePaletteContext } from './CommandPalette/paletteContext';
import { ToastContext } from '../contexts/ToastContext';
import { useToasts } from '../hooks/useToasts';
import { SuccessIcon, InfoIcon, CloseIcon } from './icons';

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
 * These modals render *outside* AppContents' per-view `ToastContext.Provider`,
 * so this layer owns its own toast state + container. Without it,
 * `useOptionalToast()` inside a global modal falls through to the no-op
 * fallback and add/remove/error feedback is silently dropped.
 */
export function AppGlobalModals() {
  const ctx = usePaletteContext();
  const changelog = useModal('changelog');
  const attachedLibraries = useModal('attachedLibraries');
  const { toasts, showToast, dismissToast } = useToasts();
  const toastsValue = useMemo(
    () => ({ toasts, showToast, dismissToast }),
    [toasts, showToast, dismissToast]
  );

  return (
    <ToastContext.Provider value={toastsValue}>
      <HelpModal projectPath={ctx.currentProjectPath ?? undefined} />
      <ChangelogModal isOpen={changelog.isOpen} onClose={changelog.close} />
      <AttachedLibrariesModal isOpen={attachedLibraries.isOpen} onClose={attachedLibraries.close} />
      {toasts.length > 0 && (
        <div className="toast-container">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.type}`}>
              <span className="toast-icon">
                {t.type === 'success' ? <SuccessIcon size={16} /> : <InfoIcon size={16} />}
              </span>
              <span className="toast-message">{t.message}</span>
              <button className="toast-close" onClick={() => dismissToast(t.id)}>
                <CloseIcon size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}
