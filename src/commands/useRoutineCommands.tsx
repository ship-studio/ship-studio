/**
 * Palette commands for Routines and the Inbox.
 *
 * PROTOTYPE. Navigation is real; "Run all routines now" fakes runs through the
 * in-memory store like the rest of the prototype.
 *
 * @module commands/useRoutineCommands
 */

import { useSyncExternalStore } from 'react';
import { BellIcon, PlayIcon, PlusIcon, ZapIcon } from '@/components/icons';
import { useCommands } from './useCommands';
import { getSnapshot, runRoutineNow, subscribe, unreadCount } from '../lib/routinesStore';
import type { AppView } from '../lib/types';

interface UseRoutineCommandsParams {
  setView: (view: AppView) => void;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

export function useRoutineCommands({ setView, showToast }: UseRoutineCommandsParams) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const unread = unreadCount(snapshot);

  useCommands(
    () => [
      {
        id: 'routines.open',
        title: 'Routines',
        icon: <ZapIcon size={14} />,
        category: 'navigation',
        keywords: ['schedule', 'automation', 'cron', 'agents', 'recurring'],
        run: () => setView('routines'),
      },
      {
        id: 'inbox.open',
        title: unread > 0 ? `Inbox (${unread} unread)` : 'Inbox',
        icon: <BellIcon size={14} />,
        category: 'navigation',
        keywords: ['findings', 'reports', 'notifications'],
        run: () => setView('inbox'),
      },
      {
        id: 'routines.create',
        title: 'New routine…',
        icon: <PlusIcon size={14} />,
        category: 'navigation',
        keywords: ['schedule', 'automation', 'recurring'],
        run: () => setView('routines'),
      },
      {
        id: 'routines.runAll',
        title: 'Run all routines now',
        icon: <PlayIcon size={14} />,
        category: 'navigation',
        keywords: ['trigger', 'sweep'],
        run: () => {
          const enabled = snapshot.routines.filter((routine) => routine.enabled);
          if (enabled.length === 0) {
            showToast('No routines are enabled', 'info');
            return;
          }
          for (const routine of enabled) runRoutineNow(routine.id);
          setView('routines');
          showToast(`Running ${enabled.length} routines…`, 'info');
        },
      },
    ],
    [setView, showToast, snapshot, unread]
  );
}
