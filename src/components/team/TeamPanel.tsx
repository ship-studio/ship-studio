/**
 * The team, inside the project you are working in.
 *
 * The home-level Team screen answers "what is everyone up to". This one
 * answers the question you actually have while working: *what changed under
 * me, and does any of it affect what I am about to do.* Same data, scoped to
 * this repo, one keystroke away without leaving the workspace.
 *
 * Opens on **What's new** — the updates that landed since you last looked —
 * because that is the only tab with a time limit on its usefulness. It empties
 * itself as you read it, which is the behaviour that keeps people opening it.
 *
 * A floating `DockablePanel` for the same reason canvas comments is one: it
 * sits over the preview you are already looking at instead of taking a pane
 * away from it, and it can be moved out of the way without being closed.
 *
 * @module components/team/TeamPanel
 */

import { useMemo, useSyncExternalStore } from 'react';
import {
  BranchIcon,
  CheckIcon,
  CloseIcon,
  CollaboratorsIcon,
  CommentIcon,
  HistoryIcon,
  InfoIcon,
  PinIcon,
} from '@/components/icons';
import { DockablePanel } from '../primitives/DockablePanel';
import { usePanelDockBinding } from '../../contexts/PanelDockContext';
import { EmptyState } from '../primitives/EmptyState';
import { IconButton } from '../primitives/IconButton';
import { ToggleButton } from '../primitives/ToggleButton';
import { Spinner } from '../primitives/Spinner';
import { Tabs, TabsList, TabsTab } from '../primitives/Tabs';
import { TeamCoverageNote } from './TeamCoverageNote';
import { TeamHowItWorks } from './TeamHowItWorks';
import { TeamSelfCoverageNote } from './TeamSelfCoverageNote';
import { TeamPeoplePanel } from './TeamPeoplePanel';
import { TeamThreadsPanel } from './TeamThreadsPanel';
import { TeamUpdateCard } from './TeamUpdateCard';
import { groupByDay, openThreads, type TeamThread } from '../../lib/team';
import {
  adoptedProject,
  currentActor,
  getSnapshot,
  refresh,
  setHowItWorksOpen,
  getUiSnapshot,
  markAllSeen,
  setTeamTab,
  subscribe,
  toggleExpanded,
  unseenUpdates,
  type TeamTab,
} from '../../lib/teamStore';

interface TeamPanelProps {
  hidden: boolean;
  onClose: () => void;
  now: number;
  /** Docked into the workspace's own column rather than floating. */
  pinned: boolean;
  onTogglePinned: () => void;
  /** Hand the ticked comment threads to an agent terminal. */
  onSendToAgent?: (threads: TeamThread[]) => void;
  agentLabel?: string | null;
  sending?: boolean;
  /** Why element picking is unavailable, when it is. */
  pickerHint?: string | null;
}

export function TeamPanel({
  hidden,
  onClose,
  now,
  pinned,
  onTogglePinned,
  onSendToAgent,
  agentLabel,
  sending,
  pickerHint,
}: TeamPanelProps) {
  // Docked width, the resize handle for it, and the column it occupies are all
  // the rail's now — see `WorkspaceDock`. The panel keeps only what is its own:
  // whether it is docked at all, and what it shows.
  const dock = usePanelDockBinding('team');
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const { tab, expandedId, loading, howItWorksOpen } = useSyncExternalStore(
    subscribe,
    getUiSnapshot
  );

  const unseen = useMemo(() => unseenUpdates(snapshot), [snapshot]);
  const unseenIds = useMemo(() => new Set(unseen.map((update) => update.id)), [unseen]);
  const groups = useMemo(() => groupByDay(snapshot.updates, now), [snapshot.updates, now]);
  const unresolved = openThreads(snapshot.threads).length;

  return (
    <>
      <DockablePanel
        dock={dock}
        /* Closed is never docked: `visible` releases the rail slot, so a docked
         panel that was closed does not leave an empty band of workspace. */
        docked={pinned && !hidden}
        visible={!hidden}
        ariaLabel="Team"
        positionKey="team.panel.position"
        sizeKey="team.panel.size"
        keepWithinViewport
        floatingSize={{ width: 420, height: Math.min(620, window.innerHeight - 140) }}
        minFloatingSize={{ width: 340, height: 320 }}
        initialPosition={() => ({ left: Math.max(16, window.innerWidth - 452), top: 96 })}
        surfaceClassName="team-panel-float"
      >
        {/* One wrapper child, deliberately. `.dockable-panel__surface > *` sets
          `height: 100%` on every direct child, so a header/tabs/body trio ends
          up as three full-height boxes sharing the panel by shrinkage — the
          header's content lands halfway down and the body has nowhere to go.
          Giving the surface a single child lets that rule do what it is for. */}
        <div className="team-float-inner">
          <header className="team-float-header" data-dockable-drag-handle>
            <span className="team-float-title">
              Team
              {unseen.length > 0 && <span className="team-float-count">{unseen.length} new</span>}
              {/* Said out loud, because the honest answer to "where does this
                  live" is "your repository" — there is no service behind it,
                  and nothing here was invented. Git rather than any one host:
                  the same panel works on GitLab, a self-managed remote, and a
                  repo with no remote at all. */}
              <span className="team-float-origin">
                <BranchIcon size={11} aria-hidden />
                Powered by Git
              </span>
            </span>
            <div className="team-float-header-actions">
              {/* The disclosure panel — what gets written into the repository and
                who can read it. It lived on the home screen, which is gone, and
                it is the one thing there that was not a duplicate of this one:
                a feature that writes to someone's repo owes them a plain
                account of what it writes, reachable from where it happens. */}
              <IconButton
                variant="ghost"
                size="compact"
                icon={<InfoIcon size={12} />}
                onClick={() => setHowItWorksOpen(true)}
                title="How this works"
                aria-label="How team sync works"
              />
              <ToggleButton
                variant="ghost"
                size="compact"
                className="button--icon-only panel-pin-toggle"
                onClick={onTogglePinned}
                title={pinned ? 'Unpin — float over the workspace' : 'Pin to the window'}
                aria-label={pinned ? 'Unpin Team panel' : 'Pin Team panel to the window'}
                pressed={pinned}
                leftIcon={<PinIcon size={13} />}
              />
              {unseen.length > 0 && (
                <IconButton
                  variant="ghost"
                  size="compact"
                  icon={<CheckIcon size={12} />}
                  onClick={() => markAllSeen()}
                  title="Mark everything as seen"
                  aria-label="Mark everything as seen"
                />
              )}
              <IconButton
                variant="ghost"
                size="compact"
                icon={<CloseIcon size={12} />}
                onClick={onClose}
                title="Close"
                aria-label="Close"
              />
            </div>
          </header>

          <div className="team-float-tabs">
            <Tabs
              value={tab}
              onValueChange={(next) => setTeamTab(next as TeamTab)}
              mode="navigation"
            >
              <TabsList aria-label="Team">
                <TabsTab value="updates" leftIcon={<HistoryIcon size={11} />}>
                  What&rsquo;s new
                </TabsTab>
                <TabsTab value="people" leftIcon={<CollaboratorsIcon size={11} />}>
                  People
                </TabsTab>
                <TabsTab value="comments" leftIcon={<CommentIcon size={11} />}>
                  {unresolved > 0 ? `Comments (${unresolved})` : 'Comments'}
                </TabsTab>
              </TabsList>
            </Tabs>
          </div>

          <div className="team-float-body">
            {tab === 'updates' &&
              (snapshot.updates.length === 0 ? (
                loading ? (
                  <EmptyState
                    icon={<Spinner size="lg" />}
                    title="Reading this repository"
                    description="Walking the history and asking GitHub about open pull requests."
                  />
                ) : snapshot.sync.error ? (
                  <EmptyState
                    icon={<HistoryIcon size={24} />}
                    title="Couldn't read the history"
                    description={snapshot.sync.error}
                  />
                ) : snapshot.sync.repo === null ? (
                  // Not a repository, or no remote. Not a failure and not a
                  // degraded mode — comments work in full here, and saying which
                  // half is missing beats an empty box that looks broken.
                  <EmptyState
                    icon={<HistoryIcon size={24} />}
                    title="Nothing to read yet"
                    description="This half of Team is built from what gets pushed, so it fills in once this project is on GitHub. Comments work now either way."
                  />
                ) : (
                  <EmptyState
                    icon={<HistoryIcon size={24} />}
                    title="Nothing yet"
                    description="When someone pushes work to this repository, what they did shows up here."
                  />
                )
              ) : (
                groups.map((group) => (
                  <section className="team-float-day" key={group.key}>
                    <h3 className="team-float-day-heading">{group.label}</h3>
                    {group.updates.map((update) => (
                      <TeamUpdateCard
                        key={update.id}
                        update={update}
                        expanded={expandedId === update.id}
                        onToggleExpanded={toggleExpanded}
                        isNew={unseenIds.has(update.id)}
                        now={now}
                      />
                    ))}
                  </section>
                ))
              ))}

            {/* Sits at the foot of the feed, after the thing it is about, rather
              than at the top where it would be a banner in front of the work. */}
            {tab === 'updates' && snapshot.updates.length > 0 && (
              <>
                <TeamSelfCoverageNote
                  updates={snapshot.updates}
                  me={currentActor()}
                  projectPath={adoptedProject() ?? ''}
                  installed={snapshot.commitGuidanceInstalled}
                  onInstalled={() => void refresh()}
                />
                <TeamCoverageNote members={snapshot.members} repo={snapshot.sync.repo} />
              </>
            )}

            {tab === 'people' && (
              <TeamPeoplePanel
                members={snapshot.members}
                now={now}
                compact
                hasRepo={snapshot.sync.repo !== null}
              />
            )}

            {tab === 'comments' && (
              <TeamThreadsPanel
                threads={snapshot.threads}
                now={now}
                compact
                onSendToAgent={onSendToAgent}
                agentLabel={agentLabel}
                sending={sending}
                pickerHint={pickerHint}
              />
            )}
          </div>

          {howItWorksOpen && <TeamHowItWorks onClose={() => setHowItWorksOpen(false)} />}
        </div>
      </DockablePanel>
    </>
  );
}
