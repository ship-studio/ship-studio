import { useEffect } from 'react';
import { useModal } from '../../contexts/ModalContext';
import { CommandPalette } from './CommandPalette';
import { useOpenPalette, usePaletteContext } from './paletteContext';

/**
 * App-level host: owns global palette shortcuts and renders the palette.
 * Rendered inside <ModalProvider> + <PaletteContextProvider> so every view
 * (loading, onboarding, projects, workspace) can open it and the palette
 * sees the current app context without prop drilling.
 *
 * Shortcuts owned here:
 *  - Cmd/Ctrl+K → toggle palette (All tab)
 *  - Cmd/Ctrl+O → open palette on the Projects tab (former project picker)
 */
export function CommandPaletteHost() {
  const palette = useModal('commandPalette');
  const ctx = usePaletteContext();
  const openPalette = useOpenPalette();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      // Capture-phase + stopPropagation so view-local listeners
      // (e.g. the dashboard's Cmd+K) don't also fire.
      if (e.key === 'k') {
        e.preventDefault();
        e.stopPropagation();
        palette.toggle();
      } else if (e.key === 'o') {
        e.preventDefault();
        e.stopPropagation();
        openPalette({ tab: 'project' });
      }
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [palette, openPalette]);

  // Don't surface the palette in pre-app states (loading / onboarding). The
  // toggle above still flips the shared modal state, so an armed-but-unrendered
  // palette would spring open on the next screen that *can* render it — close
  // it instead of leaving that trap set.
  useEffect(() => {
    if (ctx.kind === 'other' && palette.isOpen) palette.close();
  }, [ctx.kind, palette]);

  if (ctx.kind === 'other') return null;

  return (
    <CommandPalette
      isOpen={palette.isOpen}
      onClose={palette.close}
      context={ctx.kind}
      currentProjectName={ctx.currentProjectName}
    />
  );
}
