import { useCallback, useState } from 'react';

interface UseWorkspaceModalsParams {
  // Currently unused — kept for API compatibility while education-mode is the
  // only state still managed here. Will be removed when education-mode moves
  // into ModalContext too.
  focusActiveTerminal: () => void;
}

/**
 * Workspace-level UI state that hasn't (yet) moved into ModalContext.
 *
 * Was previously a 30+ field grab-bag of `show*`/`open*`/`close*` triples for every
 * workspace modal. The DX refactor (Block 6) migrated all of those to
 * `useModal('id')` from `ModalContext`. Only education-mode remains because it
 * isn't a modal — it's a full-screen overlay/tutor mode toggle.
 */
export function useWorkspaceModals(_: UseWorkspaceModalsParams) {
  const [isEducationMode, setIsEducationMode] = useState(false);
  const closeEducation = useCallback(() => setIsEducationMode(false), []);

  return {
    isEducationMode,
    setIsEducationMode,
    closeEducation,
  };
}
