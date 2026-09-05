/**
 * Palette commands for Workflows and the Inbox.
 *
 * There is deliberately no "Run all workflows" command. Every run spends the
 * user's own agent subscription, and a single keystroke that fans out N
 * concurrent agents across every project is the fastest way to burn someone's
 * quota on something they didn't picture. Running one is a per-row decision.
 *
 * @module commands/useWorkflowCommands
 */

import { useSyncExternalStore } from 'react';
import { BellIcon, CheckIcon, PlusIcon, ActivityIcon } from '@/components/icons';
import { useCommands } from './useCommands';
import { getSnapshot, markAllRead, subscribe, unreadCount } from '../lib/workflowsStore';
import type { AppView } from '../lib/types';

interface UseWorkflowCommandsParams {
  setView: (view: AppView) => void;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

export function useWorkflowCommands({ setView, showToast }: UseWorkflowCommandsParams) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const unread = unreadCount(snapshot);

  useCommands(
    () => [
      {
        id: 'workflows.open',
        title: 'Workflows',
        icon: <ActivityIcon size={14} />,
        category: 'navigation',
        keywords: ['schedule', 'automation', 'cron', 'recurring', 'checks'],
        run: () => setView('workflows'),
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
        id: 'workflows.create',
        title: 'New workflow…',
        icon: <PlusIcon size={14} />,
        category: 'navigation',
        keywords: ['schedule', 'automation', 'recurring'],
        run: () => setView('workflows'),
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
