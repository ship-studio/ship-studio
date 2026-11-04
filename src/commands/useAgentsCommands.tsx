/**
 * Palette commands for Agents. Registered app-wide, so "New agent…" works from
 * anywhere: it switches to Agents mode and opens the dialog there.
 *
 * @module commands/useAgentsCommands
 */

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { AgentsIcon, DownloadIcon, PlusIcon } from '@/components/icons';
import { useCommands } from './useCommands';
import type { AppView } from '../lib/types';
import { AGENT_EVENTS } from '../lib/agents';

type AgentsIntent = 'new' | 'import' | { open: string };
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
  onOpenAgent: (agentId: string) => void;
}) {
  const { onNewAgent, onImportAgents, onOpenAgent } = handlers;
  useEffect(() => {
    const listener = (intent: AgentsIntent) =>
      intent === 'new'
        ? onNewAgent()
        : intent === 'import'
          ? onImportAgents()
          : onOpenAgent(intent.open);
    intentListeners.add(listener);
    if (pendingIntent) {
      const intent = pendingIntent;
      pendingIntent = null;
      listener(intent);
    }
    return () => {
      intentListeners.delete(listener);
    };
  }, [onNewAgent, onImportAgents, onOpenAgent]);
}

export function useAgentsNavCommands({ setView }: { setView: (view: AppView) => void }) {
  // A clicked notification (the backend already focused this window): open that agent.
  useEffect(() => {
    const unlisten = listen<string>(AGENT_EVENTS.open, (e) => {
      requestAgentsIntent({ open: e.payload });
      setView('agents');
    });
    return () => void unlisten.then((off) => off());
  }, [setView]);

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
