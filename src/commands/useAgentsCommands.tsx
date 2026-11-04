/**
 * Palette commands for Agents. Registered app-wide, so "New agent…" works from
 * anywhere: it switches to Agents mode and opens the dialog there.
 *
 * @module commands/useAgentsCommands
 */

import { useEffect } from 'react';
import { AgentsIcon, DownloadIcon, PlusIcon, SearchIcon } from '@/components/icons';
import { useCommands } from './useCommands';
import type { AppView } from '../lib/types';

type AgentsIntent = 'new' | 'import' | 'search';
let pendingIntent: AgentsIntent | null = null;
const intentListeners = new Set<(intent: AgentsIntent) => void>();

/** Ask Agents mode to open a dialog, now if it's mounted or as soon as it is. */
export function requestAgentsIntent(intent: AgentsIntent) {
  if (intentListeners.size > 0) {
    intentListeners.forEach((listener) => listener(intent));
  } else {
    pendingIntent = intent;
  }
}

/** Agents mode consumes intents with this. */
export function useAgentsIntents(handlers: {
  onNewAgent: () => void;
  onImportAgents: () => void;
  onSearch: () => void;
}) {
  const { onNewAgent, onImportAgents, onSearch } = handlers;
  useEffect(() => {
    const listener = (intent: AgentsIntent) =>
      ({ new: onNewAgent, import: onImportAgents, search: onSearch })[intent]();
    intentListeners.add(listener);
    if (pendingIntent) {
      const intent = pendingIntent;
      pendingIntent = null;
      listener(intent);
    }
    return () => {
      intentListeners.delete(listener);
    };
  }, [onNewAgent, onImportAgents, onSearch]);
}

export function useAgentsNavCommands({ setView }: { setView: (view: AppView) => void }) {
  useCommands(
    () => [
      {
        id: 'agents.open',
        title: 'Agents',
        icon: <AgentsIcon size={14} />,
        category: 'navigation',
        keywords: ['chat', 'chief of staff', 'assistant', 'bots', 'team'],
        run: () => setView('agents'),
      },
      {
        id: 'agents.new',
        title: 'New agent…',
        icon: <PlusIcon size={14} />,
        category: 'navigation',
        keywords: ['agents', 'create', 'bot'],
        run: () => {
          requestAgentsIntent('new');
          setView('agents');
        },
      },
      {
        id: 'agents.search',
        title: 'Search agent conversations',
        icon: <SearchIcon size={14} />,
        category: 'navigation',
        keywords: ['agents', 'find', 'messages', 'chat', 'history'],
        run: () => {
          requestAgentsIntent('search');
          setView('agents');
        },
      },
      {
        id: 'agents.import',
        title: 'Import agents from Grok Bot…',
        icon: <DownloadIcon size={14} />,
        category: 'navigation',
        keywords: ['agents', 'migrate', 'grok', 'bring over', 'setup'],
        run: () => {
          requestAgentsIntent('import');
          setView('agents');
        },
      },
    ],
    [setView]
  );
}
