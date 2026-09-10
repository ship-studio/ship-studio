/**
 * Wires Team into an open project.
 *
 * Four jobs:
 *
 * 1. Point the store at the project that is actually open (`get_team_snapshot`).
 * 2. Re-read it on a timer, because with no server nobody can tell us something
 *    happened — the floor is however often we ask.
 * 3. Hold the panel's open state per project, so coming back to a workspace
 *    where you had it open finds it open.
 * 4. Announce work that arrives while you are looking.
 *
 * That last one is the whole feeling. Multiplayer is not a screen you visit; it
 * is something landing that you did not do.
 *
 * @module hooks/useTeamWorkspace
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CollaboratorsIcon, CommentIcon } from '@/components/icons';
import { useCommands } from '../commands/useCommands';
import { useOptionalToast } from '../contexts/ToastContext';
import { useLocalStorageFlag } from './useLocalStorageFlag';
import { usePolling } from './usePolling';
import { useWindowFocused } from './useWindowFocused';
import { migrateLegacyComments } from '../lib/commentMigration';
import { TeamPanel } from '../components/team/TeamPanel';
import { TeamPresence } from '../components/team/TeamPresence';
import {
  TEAM_SYNC_INTERVAL_MS,
  adopt,
  clearThreadSelection,
  getSnapshot,
  getUiSnapshot,
  refresh,
  setTeamTab,
  subscribe,
  sync,
  TEAM_SYNC_FLOOR_MS,
  unseenUpdates,
} from '../lib/teamStore';
import type { CommentAgent } from '../lib/canvasComments';
import { formatThreadsForAgent, type TeamThread } from '../lib/team';

/**
 * How often the shared clock advances.
 *
 * Every team surface renders relative times, and one clock for all of them
 * means two rows written in the same second cannot disagree about "now". Half
 * a minute is under the resolution anyone reads ("6m ago") while keeping the
 * re-render rate negligible.
 */
const CLOCK_TICK_MS = 30_000;

/**
 * Past this many arrivals at once, one summary toast replaces the stack.
 * Three fits on screen; a week away does not.
 */
const MAX_ARRIVAL_TOASTS = 3;

const STORAGE_PREFIX = 'shipstudio.team.panelOpen:';

/**
 * Whether the panel was left open for this project.
 *
 * A stored preference is a convenience, so every failure mode — a private
 * window, cleared site data, a browser that throws on access — resolves to
 * "closed" rather than to an error.
 */
function readStoredOpen(projectPath: string): boolean {
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}${projectPath}`) === '1';
  } catch {
    return false;
  }
}

/**
 * @param project the open project — its path is what the snapshot is read for
 */
export function useTeamWorkspace(
  project: { path: string; name: string },
  handoff?: {
    agents: CommentAgent[];
    activeAgentId?: number | null;
    /** Why element picking is unavailable right now, if it is. */
    pickerHint?: string | null;
  }
) {
  const { path: projectPath } = project;
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const { tab } = useSyncExternalStore(subscribe, getUiSnapshot);
  const { showToast } = useOptionalToast();

  const [open, setOpen] = useState(() => readStoredOpen(projectPath));

  // Read this project. `adopt` is idempotent per path, so a re-render or a
  // returning visit does not re-announce the backlog or drop a pending reply.
  //
  // Notes written before comments became records are moved first, so a returning
  // user finds their own backlog rather than an empty list. It runs once per
  // project and is a no-op for everyone who never used the old feature.
  useEffect(() => {
    void (async () => {
      const moved = await migrateLegacyComments(projectPath);
      adopt(projectPath);
      if (moved > 0) {
        showToast(
          moved === 1
            ? 'Moved 1 earlier comment into this project\u2019s shared comments.'
            : `Moved ${moved} earlier comments into this project\u2019s shared comments.`,
          'info'
        );
      }
    })();
  }, [projectPath, showToast]);

  // Every timer below is gated on this window being the one in front of the
  // user. Harbr opens a window per project and people leave them open
  // for days; ungated, each of those windows walked git history, ran
  // `gh pr list` and called the GitHub API once a minute, for the whole time
  // nobody was looking at it. `usePolling` fires immediately on start, so
  // coming back to a window refreshes it there and then rather than showing
  // what it held when it lost focus.
  const focused = useWindowFocused();

  // Re-read on a timer. `usePolling` rather than a raw interval, per the repo's
  // own rule — it owns teardown and backs off when a read fails, which matters
  // here because the read shells out to git and `gh`.
  usePolling(
    useCallback(() => refresh(projectPath), [projectPath]),
    {
      intervalMs: TEAM_SYNC_INTERVAL_MS,
      enabled: focused,
      name: 'team-snapshot',
    }
  );

  // The backstop under the event triggers. `sync` enforces its own ten-minute
  // floor, so this tick is cheap and mostly a no-op — it exists for the session
  // where somebody leaves a workspace open all afternoon and touches nothing.
  // Which is also the session where the window is not in front of them, so the
  // gate does not weaken it: the tick that matters is the one on the way back.
  usePolling(
    useCallback(() => sync(), []),
    {
      intervalMs: TEAM_SYNC_FLOOR_MS,
      enabled: focused,
      name: 'team-remote-sync',
    }
  );

  // Re-read the preference when the project changes, using React's documented
  // "adjust state during render" pattern rather than an effect. An effect here
  // would render one frame with the previous project's panel state — and would
  // be a `set-state-in-effect` lint violation for exactly that reason.
  const [pathOfOpen, setPathOfOpen] = useState(projectPath);
  if (pathOfOpen !== projectPath) {
    setPathOfOpen(projectPath);
    setOpen(readStoredOpen(projectPath));
  }

  const setOpenPersisted = useCallback(
    (next: boolean) => {
      setOpen(next);
      try {
        localStorage.setItem(`${STORAGE_PREFIX}${projectPath}`, next ? '1' : '0');
      } catch {
        // A rejected write costs the preference, never the interaction.
      }
    },
    [projectPath]
  );

  const toggle = useCallback(() => setOpenPersisted(!open), [open, setOpenPersisted]);

  const me = snapshot.members.find((member) => member.isSelf)?.actor ?? null;

  // Announce anything that arrives after the first *read* of this project.
  //
  // The baseline has to be the first loaded snapshot, not the first render.
  // Reading the repo is asynchronous, so the first render is an empty feed —
  // baselining on that makes every existing row look like news and greets you
  // with seven toasts the moment a project opens. That is not an arrival, it is
  // an ambush, and it is exactly what happened the first time this ran against
  // real data. `lastSyncedAt` is the signal that a read actually landed.
  const knownIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    knownIds.current = null;
  }, [projectPath]);

  const loaded = snapshot.sync.lastSyncedAt !== null;
  useEffect(() => {
    if (!loaded) return;
    const ids = new Set(snapshot.updates.map((update) => update.id));
    if (knownIds.current === null) {
      knownIds.current = ids;
      return;
    }
    const arrived = snapshot.updates.filter(
      (update) =>
        !knownIds.current!.has(update.id) &&
        // Your own push is not news to you. It is also the most common arrival
        // by far, so without this the feature mostly announces you to yourself.
        !(update.actor.login && update.actor.login === me?.login)
    );
    knownIds.current = ids;

    // Coming back after a week is a burst, not an arrival. Past a handful,
    // one line saying how much you missed beats a stack of them saying what.
    if (arrived.length > MAX_ARRIVAL_TOASTS) {
      const people = new Set(arrived.map((update) => update.actor.name));
      showToast(
        `${arrived.length} updates from ${people.size} ${people.size === 1 ? 'person' : 'people'} while you were away`,
        'info'
      );
      return;
    }
    for (const update of arrived) {
      showToast(`${update.actor.name}: ${update.headline}`, 'info');
    }
  }, [loaded, snapshot.updates, me, showToast]);

  // The shared clock. `usePolling` rather than a raw interval, per the repo's
  // own rule — it owns teardown and backoff in one place.
  const [now, setNow] = useState(() => Date.now());
  usePolling(
    useCallback(() => {
      setNow(Date.now());
      return Promise.resolve();
    }, []),
    { intervalMs: CLOCK_TICK_MS, enabled: focused, name: 'team-clock' }
  );

  const close = useCallback(() => setOpenPersisted(false), [setOpenPersisted]);

  // Team is a per-project surface, so these are the only registrations of these
  // ids. There was briefly a home-screen Team reading across every project at
  // once; what it could answer from outside a project was worth less than the
  // hundreds of git processes it took to answer it.
  useCommands(
    () => [
      {
        id: 'team.open',
        title: 'Team',
        icon: <CollaboratorsIcon size={14} />,
        category: 'navigation',
        when: 'project',
        keywords: ['collaborators', 'multiplayer', 'who', 'together', 'shared'],
        run: () => {
          setTeamTab('updates');
          setOpenPersisted(true);
        },
      },
      {
        id: 'team.comments',
        title: 'Team comments',
        icon: <CommentIcon size={14} />,
        category: 'navigation',
        when: 'project',
        keywords: ['feedback', 'threads', 'replies', 'review', 'notes'],
        run: () => {
          setTeamTab('comments');
          setOpenPersisted(true);
        },
      },
      {
        id: 'team.syncComments',
        title: 'Sync comments with the repository',
        icon: <CollaboratorsIcon size={14} />,
        category: 'action',
        when: 'project',
        keywords: ['fetch', 'push', 'share', 'pull', 'refresh'],
        // Explicitly asked for, so it ignores the floor.
        run: () => void sync(true),
      },
    ],
    [setOpenPersisted]
  );

  // Pinned like the Agent panel, and remembered the same way. Working through a
  // list of comments is a thing you do *beside* the preview rather than on top
  // of it, so this is worth having — but it stays off by default, because the
  // panel takes real width from the preview it is about.
  const [pinned, , togglePinned] = useLocalStorageFlag('teamPanelPinned', false);

  // Handing threads to an agent.
  //
  // The prompt is built from the same formatter the pins used, so what an agent
  // receives did not change when the panel did. Selection is cleared only on a
  // paste that actually landed — a terminal that rejected it leaves the ticks
  // alone so the person can pick another one and try again.
  const [sending, setSending] = useState(false);
  const agents = handoff?.agents ?? [];
  const agent = agents.find((candidate) => candidate.id === handoff?.activeAgentId) ?? agents[0];

  const sendToAgent = useCallback(
    async (threads: TeamThread[]) => {
      if (!agent || threads.length === 0) return;
      setSending(true);
      try {
        const prompt = formatThreadsForAgent(projectPath, threads);
        await agent.send(prompt);
        clearThreadSelection();
        showToast(
          threads.length === 1
            ? 'Comment pasted. Press Enter in the agent terminal to start.'
            : `${threads.length} comments pasted. Press Enter in the agent terminal to start.`,
          'success'
        );
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : 'Could not reach that terminal.',
          'error'
        );
      } finally {
        setSending(false);
      }
    },
    [agent, projectPath, showToast]
  );

  // Returns the nodes rather than the state behind them, so the workspace has
  // one integration point instead of reassembling this at the call site.
  return {
    /**
     * Whether the Comments tab is showing.
     *
     * This is what arms clicking an element in the preview — there is no
     * separate comments mode any more, so the tab being open *is* the mode.
     */
    commentsActive: open && tab === 'comments',
    /** Goes in the workspace header's tool cluster. */
    presence: (
      <TeamPresence
        members={snapshot.members}
        unseenCount={unseenUpdates(snapshot).length}
        openComments={snapshot.threads.filter((thread) => !thread.resolved).length}
        panelOpen={open}
        onTogglePanel={toggle}
        now={now}
      />
    ),
    /** Floats over the preview. Kept mounted so scroll position survives a toggle. */
    panel: (
      <TeamPanel
        hidden={!open}
        onClose={close}
        now={now}
        pinned={pinned}
        onTogglePinned={togglePinned}
        onSendToAgent={agent ? (threads) => void sendToAgent(threads) : undefined}
        agentLabel={agent?.label ?? null}
        sending={sending}
        pickerHint={handoff?.pickerHint ?? null}
      />
    ),
  };
}
