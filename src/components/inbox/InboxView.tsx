/**
 * Inbox — what the routines found.
 *
 * Same placement as Home and Routines: the centred `dashboard-column` and the
 * `dashboard-panel` section card, with the reader living inside the card. The
 * two-pane layout is the only thing that differs, because reading a report is
 * the job.
 *
 * The action that matters is "Fix with agent", which opens the finding's
 * project and types the suggested prompt into its terminal — a finding is the
 * head of a work session, not a notification.
 *
 * @module components/inbox/InboxView
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { BellIcon, CheckIcon, ChevronIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { EmptyState } from '../primitives/EmptyState';
import { MenuButton } from '../primitives/MenuButton';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { DashboardHeader } from '../dashboard/DashboardHeader';
import { DashboardSearch } from '../dashboard/DashboardSearch';
import { InboxDetail } from './InboxDetail';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useDashboardVisibility } from '../../hooks/useDashboardVisibility';
import { formatAge, type InboxItem, type Severity } from '../../lib/routines';
import { queueHandoff } from '../../lib/routineHandoff';
import type { Project } from '../../lib/project';
import {
  getSnapshot,
  markAllRead,
  deleteItem,
  setItemArchived,
  setItemRead,
  subscribe,
} from '../../lib/routinesStore';

type InboxFilter = 'unread' | 'all' | 'archived';

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

interface InboxViewProps {
  /** Opens a project workspace. Absent in contexts that can't navigate. */
  onOpenProject?: (project: Project) => void | Promise<void>;
}

export function InboxView({ onOpenProject }: InboxViewProps) {
  const { inbox } = useSyncExternalStore(subscribe, getSnapshot);
  const { showToast } = useOptionalToast();
  const { dashboardHeaderHidden, hideDashboardHeader } = useDashboardVisibility();

  const [filter, setFilter] = useState<InboxFilter>('unread');
  const [project, setProject] = useState<string>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const projects = useMemo(
    () => Array.from(new Set(inbox.map((item) => item.projectName))).sort(),
    [inbox]
  );

  const visible = useMemo(() => {
    const matches = inbox.filter((item) => {
      if (filter === 'archived' && !item.archived) return false;
      if (filter !== 'archived' && item.archived) return false;
      if (filter === 'unread' && item.read) return false;
      if (project !== 'all' && item.projectName !== project) return false;
      return true;
    });
    return matches.sort((a, b) => {
      const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      return bySeverity !== 0 ? bySeverity : b.createdAt - a.createdAt;
    });
  }, [inbox, filter, project]);

  const selected: InboxItem | null =
    visible.find((item) => item.id === selectedId) ?? visible[0] ?? null;

  const unread = inbox.filter((item) => !item.read && !item.archived).length;

  const handleSelect = useCallback((item: InboxItem) => {
    setSelectedId(item.id);
    if (!item.read) void setItemRead(item.id, true);
  }, []);

  const handleArchive = useCallback(
    (item: InboxItem) => {
      setItemArchived(item.id, !item.archived)
        .then(() =>
          showToast(item.archived ? 'Restored to inbox' : `Archived — "${item.title}"`, 'info')
        )
        .catch((err: unknown) => showToast(String(err), 'error'));
    },
    [showToast]
  );

  const handleDelete = useCallback(
    (item: InboxItem) => {
      deleteItem(item.id)
        .then(() => showToast(`Deleted — "${item.title}"`, 'info'))
        .catch((err: unknown) => showToast(String(err), 'error'));
    },
    [showToast]
  );

  /**
   * Queue the prompt, then open the project. The queue survives the navigation
   * and is delivered by `useRoutineHandoff` once a terminal actually exists —
   * opening a project is several seconds of mounting and spawning.
   */
  const handleFix = useCallback(
    (item: InboxItem, prompt: string) => {
      if (!onOpenProject) return;
      queueHandoff(item.projectPath, prompt);
      showToast(`Handing this to your agent in ${item.projectName}…`, 'info');
      void onOpenProject({ name: item.projectName, path: item.projectPath, thumbnail: null });
    },
    [onOpenProject, showToast]
  );

  return (
    <div className="dashboard-with-changelog">
      <div className="dashboard-scroll-container">
        <div className="dashboard-column">
          {!dashboardHeaderHidden && (
            <DashboardHeader title="What did your routines find?" onHide={hideDashboardHeader} />
          )}

          <DashboardSearch />

          <section className="dashboard-panel inbox-panel">
            <div className="dashboard-section-header">
              <div className="dashboard-section-heading">
                <div className="dashboard-section-heading-title">
                  <span className="dashboard-section-title text-style-h4">Inbox</span>
                  {unread > 0 && (
                    <span className="dashboard-section-count text-style-h4 font-weight-heading">
                      {unread}
                    </span>
                  )}
                </div>
              </div>
              <div className="dashboard-section-controls">
                <div className="dashboard-section-actions-left inbox-filters">
                  <SegmentedControl
                    aria-label="Filter inbox"
                    value={filter}
                    onValueChange={setFilter}
                    options={[
                      { value: 'unread', label: 'Unread' },
                      { value: 'all', label: 'All' },
                      { value: 'archived', label: 'Archived' },
                    ]}
                  />
                  <Dropdown
                    trigger={(props) => (
                      <MenuButton
                        variant="secondary"
                        size="compact"
                        className="inbox-project-filter"
                        expanded={props['aria-expanded']}
                        {...props}
                      >
                        {project === 'all' ? 'All projects' : project}
                        <ChevronIcon
                          size={10}
                          className={props['aria-expanded'] ? 'chevron-flipped' : undefined}
                        />
                      </MenuButton>
                    )}
                  >
                    <DropdownItem active={project === 'all'} onSelect={() => setProject('all')}>
                      All projects
                    </DropdownItem>
                    {projects.map((name) => (
                      <DropdownItem
                        key={name}
                        active={project === name}
                        onSelect={() => setProject(name)}
                      >
                        {name}
                      </DropdownItem>
                    ))}
                  </Dropdown>
                </div>
                <div className="dashboard-section-actions-right">
                  <Button
                    variant="ghost"
                    size="compact"
                    leftIcon={<CheckIcon size={12} />}
                    onClick={() => void markAllRead()}
                    disabled={unread === 0}
                  >
                    Mark all read
                  </Button>
                </div>
              </div>
            </div>

            {visible.length === 0 ? (
              <div className="inbox-empty">
                <EmptyState
                  icon={<BellIcon size={26} />}
                  title={filter === 'unread' ? 'You are all caught up' : 'Nothing here'}
                  description={
                    filter === 'unread'
                      ? 'Your routines have not found anything new.'
                      : 'No findings match this filter.'
                  }
                />
              </div>
            ) : (
              <div className="inbox-body">
                <div className="inbox-list" role="list" aria-label="Findings">
                  {visible.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="listitem"
                      className={`inbox-item${item.id === selected?.id ? ' is-selected' : ''}${item.read ? '' : ' is-unread'}`}
                      onClick={() => handleSelect(item)}
                    >
                      <span
                        className="inbox-item-severity"
                        data-severity={item.severity}
                        role="img"
                        aria-label={SEVERITY_LABEL[item.severity]}
                      />
                      <span className="inbox-item-body">
                        <span className="inbox-item-top">
                          <span className="inbox-item-title">{item.title}</span>
                          <span className="inbox-item-age">{formatAge(item.createdAt)}</span>
                        </span>
                        <span className="inbox-item-summary">{item.summary}</span>
                        <span className="inbox-item-meta">
                          <span className="inbox-chip">{item.projectName}</span>
                          <span className="inbox-item-routine">{item.routineName}</span>
                          {item.occurrences > 1 && (
                            <span className="inbox-item-repeat">seen {item.occurrences}×</span>
                          )}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>

                <div className="inbox-detail-pane">
                  {selected && (
                    <InboxDetail
                      item={selected}
                      onArchive={handleArchive}
                      onDelete={handleDelete}
                      onFix={onOpenProject ? handleFix : undefined}
                    />
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
