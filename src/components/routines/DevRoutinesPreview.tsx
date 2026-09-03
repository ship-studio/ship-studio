/**
 * Development-only preview of the Routines and Inbox prototype.
 *
 * Append `?routinesPreview=1` to the Vite dev URL to render both screens
 * without booting a project or a Tauri backend. Same gate style as the
 * primitive lab (`?designSystemLab=1`): DEV-only, lazily mounted, never part of
 * a production bundle.
 *
 * It exists so the prototype can be reviewed in a browser — the screens
 * themselves are the real components, not copies.
 *
 * @module components/routines/DevRoutinesPreview
 */

import { useState } from 'react';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { ToastList } from '../primitives/ToastList';
import { ToastProvider, useToast } from '../../contexts/ToastContext';
import { TooltipProvider } from '../primitives/Tooltip';
import { RoutinesView } from './RoutinesView';
import { InboxView } from '../inbox/InboxView';

/** Whether the current development URL explicitly requests the prototype preview. */
export function isDevRoutinesPreviewRequested(search: string): boolean {
  return import.meta.env.DEV && new URLSearchParams(search).get('routinesPreview') === '1';
}

/**
 * Standalone host used by `main.tsx` when the gate is on. It replaces `App`
 * rather than mounting beside it: the prototype has no Tauri dependency, so it
 * renders in a plain browser where the real app cannot boot.
 */
export function DevRoutinesPreviewRoot() {
  return (
    <TooltipProvider>
      <ToastProvider>
        <DevRoutinesPreview />
      </ToastProvider>
    </TooltipProvider>
  );
}

function DevRoutinesPreview() {
  const [screen, setScreen] = useState<'routines' | 'inbox'>('routines');
  const { toasts, dismissToast } = useToast();

  return (
    <section className="dev-routines-preview" aria-label="Routines and Inbox prototype preview">
      <header className="dev-routines-preview__header">
        <p className="dev-routines-preview__eyebrow text-style-hint">Development only</p>
        <SegmentedControl
          aria-label="Prototype screen"
          value={screen}
          onValueChange={setScreen}
          options={[
            { value: 'routines', label: 'Routines' },
            { value: 'inbox', label: 'Inbox' },
          ]}
        />
      </header>
      <div className="dev-routines-preview__body">
        {screen === 'routines' ? <RoutinesView /> : <InboxView />}
      </div>
      <ToastList toasts={toasts} onDismiss={dismissToast} />
    </section>
  );
}
