/**
 * Palette commands for Agents. Registered app-wide, so "New agent…" and
 * "Open Finance" work from anywhere: they switch to Agents mode and act there.
 *
 * @module commands/useAgentsCommands
 */

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  AgentsIcon,
  CollaboratorsIcon,
  DownloadIcon,
  PlusIcon,
  SearchIcon,
} from '@/components/icons';
import { useCommands } from './useCommands';
import { useAgents } from '../lib/agentsStore';
import type { AppView } from '../lib/types';
import { AGENT_EVENTS, TEAM_ID } from '../lib/agents';

type AgentsIntent =
  | { kind: 'new' }
  | { kind: 'import' }
  | { kind: 'search' }
  | { kind: 'open'; agentId: string };
let pendingIntent: AgentsIntent | null = null;
const intentListeners = new Set<(intent: AgentsIntent) => void>();

/** Ask Agents mode to do something, now if it's mounted or as soon as it is. */
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
  onSearch: () => void;
}) {
  const { onNewAgent, onImportAgents, onOpenAgent, onSearch } = handlers;
  useEffect(() => {
    const listener = (intent: AgentsIntent) => {
      if (intent.kind === 'new') onNewAgent();
      else if (intent.kind === 'import') onImportAgents();
      else if (intent.kind === 'search') onSearch();
      else onOpenAgent(intent.agentId);
    };
    intentListeners.add(listener);
    if (pendingIntent) {
      const intent = pendingIntent;
      pendingIntent = null;
      listener(intent);
    }
    return () => {
      intentListeners.delete(listener);
    };
  }, [onNewAgent, onImportAgents, onOpenAgent, onSearch]);
}

export function useAgentsNavCommands({ setView }: { setView: (view: AppView) => void }) {
  const { agents } = useAgents();
  // A clicked notification (the backend already focused this window): open that agent.
  useEffect(() => {
    const unlisten = listen<string>(AGENT_EVENTS.open, (e) => {
      requestAgentsIntent({ kind: 'open', agentId: e.payload });
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
          requestAgentsIntent({ kind: 'new' });
          setView('agents');
        },
      },
      {
        id: 'agents.team',
        title: 'What’s in flight',
        icon: <CollaboratorsIcon size={14} />,
        category: 'navigation',
        keywords: [
          'agents',
          'team',
          'tasks',
          'working',
          'approvals',
          'scheduled',
          'overview',
          'status',
        ],
        run: () => {
          requestAgentsIntent({ kind: 'open', agentId: TEAM_ID });
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
          requestAgentsIntent({ kind: 'search' });
          setView('agents');
        },
      },
      {
        id: 'agents.import',
        title: 'Import agents…',
        icon: <DownloadIcon size={14} />,
        category: 'navigation',
        keywords: ['agents', 'migrate', 'grok', 'bring over', 'setup'],
        run: () => {
          requestAgentsIntent({ kind: 'import' });
          setView('agents');
        },
      },
      // One per agent, so typing its name in ⌘K opens it.
      ...agents.map((agent) => ({
        id: `agents.open.${agent.id}`,
        title: `Open ${agent.name}`,
        icon: <AgentsIcon size={14} />,
        category: 'navigation' as const,
        keywords: ['agent', 'chat', ...(agent.role ? [agent.role] : [])],
        run: () => {
          requestAgentsIntent({ kind: 'open', agentId: agent.id });
          setView('agents');
        },
      })),
    ],
    [setView, agents]
  );
}
