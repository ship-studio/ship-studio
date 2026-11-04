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
import { useOptionalToast } from '../contexts/ToastContext';
import { setStayOn, type StayOnChange } from '../lib/remoteAccess';
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

/** ⌘K switches for keeping agents going; the same settings as the first-run note. */
const STAY_ON_COMMANDS: { id: string; title: string; change: StayOnChange; done: string }[] = [
  {
    id: 'awakeOn',
    title: 'Keep this Mac awake for agents',
    change: { keepAwake: true },
    done: 'This Mac stays awake while Ship Studio is running',
  },
  {
    id: 'awakeOff',
    title: 'Let this Mac sleep again',
    change: { keepAwake: false },
    done: 'This Mac can sleep again; agents pause while it sleeps',
  },
  {
    id: 'runningOn',
    title: 'Keep agents running when the window closes',
    change: { keepRunning: true },
    done: 'Closing the window keeps agents going; ⌘Q still quits',
  },
  {
    id: 'runningOff',
    title: 'Quit when the window closes',
    change: { keepRunning: false },
    done: 'Closing the window quits Ship Studio again',
  },
  {
    id: 'loginOn',
    title: 'Open Ship Studio at login',
    change: { openAtLogin: true },
    done: 'Ship Studio opens when you log in',
  },
];

export function useAgentsNavCommands({ setView }: { setView: (view: AppView) => void }) {
  const { agents } = useAgents();
  const { showToast } = useOptionalToast();
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
      // Reachable any time, not only from the first-run screen: agents run on
      // this Mac, so they pause when it sleeps and stop when the app quits.
      ...STAY_ON_COMMANDS.map((c) => ({
        id: `agents.stayOn.${c.id}`,
        title: c.title,
        icon: <AgentsIcon size={14} />,
        category: 'navigation' as const,
        keywords: ['agents', 'awake', 'sleep', 'background', 'always on', 'login', 'close'],
        run: async () => {
          try {
            const result = await setStayOn(c.change);
            showToast(
              result.supported ? c.done : 'Only available on macOS',
              result.supported ? 'success' : 'info'
            );
          } catch (err) {
            showToast(`Couldn't change that setting: ${String(err)}`, 'error');
          }
        },
      })),
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
    [setView, agents, showToast]
  );
}
