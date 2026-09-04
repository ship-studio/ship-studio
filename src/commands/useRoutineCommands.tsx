/**
 * Palette commands for Routines and the Inbox.
 *
 * There is deliberately no "Run all routines" command. Every run spends the
 * user's own agent subscription, and a single keystroke that fans out N
 * concurrent agents across every project is the fastest way to burn someone's
 * quota on something they didn't picture. Running one is a per-row decision.
 *
 * @module commands/useRoutineCommands
 */

import { useSyncExternalStore } from 'react';
import { BellIcon, CheckIcon, PlusIcon, ZapIcon } from '@/components/icons';
import { useCommands } from './useCommands';
import { getSnapshot, markAllRead, subscribe, unreadCount } from '../lib/routinesStore';
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
        keywords: ['schedule', 'automation', 'cron', 'recurring', 'checks'],
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
        id: 'inbox.markAllRead',
        title: 'Mark all findings read',
        icon: <CheckIcon size={14} />,
        category: 'navigation',
        keywords: ['inbox', 'clear', 'unread'],
        when: () => unread > 0,
        run: () => {
          markAllRead()
            .then(() => showToast('Inbox marked read', 'success'))
            .catch((err: unknown) => showToast(String(err), 'error'));
        },
      },
    ],
    [setView, showToast, unread]
  );
}
