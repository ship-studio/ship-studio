/**
 * Inbox — what the workflows found.
 *
 * Same placement as Home and Workflows: the centred `dashboard-column` and the
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

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
import { trackEvent } from '../../lib/analytics';
import { formatAge, type InboxItem, type Severity } from '../../lib/workflows';
import { clearHandoff, peekHandoff, queueHandoff } from '../../lib/workflowHandoff';
import type { Project } from '../../lib/project';
import {
  getSnapshot,
  markAllRead,
  deleteItem,
  setItemArchived,
  setItemRead,
  subscribe,
} from '../../lib/workflowsStore';

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
  const listRef = useRef<HTMLDivElement | null>(null);

  const projects = useMemo(
    () => Array.from(new Set(inbox.map((item) => item.projectName))).sort(),
    [inbox]
  );

  const visible = useMemo(() => {
    const matches = inbox.filter((item) => {
      if (filter === 'archived' && !item.archived) return false;
      if (filter !== 'archived' && item.archived) return false;
      // The item being read stays listed even once it is no longer unread.
      // Without this, opening a finding under the Unread filter marks it read,
      // drops it out of the list mid-click, and the reader lands on a
      // different finding — which makes the default filter unusable for the
      // one thing it is for.
      if (filter === 'unread' && item.read && item.id !== selectedId) return false;
      if (project !== 'all' && item.projectName !== project) return false;
      return true;
    });
    return matches.sort((a, b) => {
      const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      return bySeverity !== 0 ? bySeverity : b.createdAt - a.createdAt;
    });
  }, [inbox, filter, project, selectedId]);

  const selected: InboxItem | null =
    visible.find((item) => item.id === selectedId) ?? visible[0] ?? null;

  const unread = inbox.filter((item) => !item.read && !item.archived).length;

  const handleSelect = useCallback((item: InboxItem) => {
    setSelectedId(item.id);
    if (!item.read) void setItemRead(item.id, true);
  }, []);

  /** The finding to land on once the current one leaves the list. */
  const neighbourOf = useCallback(
    (item: InboxItem): string | null => {
      const index = visible.findIndex((candidate) => candidate.id === item.id);
      if (index === -1) return null;
      return visible[index + 1]?.id ?? visible[index - 1]?.id ?? null;
    },
    [visible]
  );

  /** ↑/↓ through the list, Home/End to the ends. A reader is a reading tool. */
  const handleListKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      const index = visible.findIndex((item) => item.id === selected?.id);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? visible.length - 1
            : Math.min(
                visible.length - 1,
                Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1))
              );
      const target = visible[next];
      if (!target) return;
      handleSelect(target);
      listRef.current
        ?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(target.id)}"]`)
        ?.focus();
    },
    [visible, selected, handleSelect]
  );

  const handleArchive = useCallback(
    (item: InboxItem) => {
      setSelectedId(neighbourOf(item));
      void trackEvent('workflow_finding_action', {
        action: item.archived ? 'restore' : 'archive',
        severity: item.severity,
        occurrences: item.occurrences,
      });
      setItemArchived(item.id, !item.archived)
        .then(() =>
          showToast(item.archived ? 'Restored to inbox' : `Archived — "${item.title}"`, 'info')
        )
        .catch((err: unknown) => showToast(String(err), 'error'));
    },
    [showToast, neighbourOf]
  );

  const handleDelete = useCallback(
    (item: InboxItem) => {
      setSelectedId(neighbourOf(item));
      void trackEvent('workflow_finding_action', {
        action: 'delete',
        severity: item.severity,
        occurrences: item.occurrences,
      });
      deleteItem(item.id)
        .then(() => showToast(`Deleted — "${item.title}"`, 'info'))
        .catch((err: unknown) => showToast(String(err), 'error'));
    },
    [showToast, neighbourOf]
  );

  /**
   * Queue the prompt, then open the project. The queue survives the navigation
   * and is delivered by `useWorkflowHandoff` once a terminal actually exists —
   * opening a project is several seconds of mounting and spawning.
   */
  const handleFix = useCallback(
    (item: InboxItem, prompt: string) => {
      if (!onOpenProject) return;
      // The action the whole feature is pointed at: a finding becoming work.
      void trackEvent('workflow_finding_action', {
        action: 'fix',
        severity: item.severity,
        occurrences: item.occurrences,
      });
      queueHandoff(item.projectPath, prompt);
      // Says what is happening, not that it is done — the success toast comes
      // from the handoff itself, once an agent has actually started.
      showToast(`Opening ${item.projectName} and starting an agent…`, 'info');
      // If the project never opens, the prompt must not sit in the queue: it
      // stays valid for three minutes, and the next time that project is
      // opened by hand it would type an instruction from an action that
      // already failed.
      void Promise.resolve(
        onOpenProject({ name: item.projectName, path: item.projectPath, thumbnail: null })
      ).catch((err: unknown) => {
        if (peekHandoff(item.projectPath) === prompt) clearHandoff();
        showToast(`Could not open ${item.projectName}: ${String(err)}`, 'error');
      });
    },
    [onOpenProject, showToast]
  );

  return (
    <div className="dashboard-with-changelog">
      <div className="dashboard-scroll-container">
        <div className="dashboard-column">
          {!dashboardHeaderHidden && (
            <DashboardHeader title="What did your workflows find?" onHide={hideDashboardHeader} />
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
                      ? 'Your workflows have not found anything new.'
                      : 'No findings match this filter.'
                  }
                />
              </div>
            ) : (
              <div className="inbox-body">
                {/* A listbox, not a list of buttons: `role="listitem"` on a
                    button overrides the button role, so the row stops being
                    announced as something you can activate. Options in a
                    listbox are selectable by definition, which is exactly what
                    these are — each one drives the reader beside it. */}
                <div
                  className="inbox-list"
                  role="listbox"
                  aria-label="Findings"
                  aria-activedescendant={selected ? `inbox-item-${selected.id}` : undefined}
                  ref={listRef}
                  onKeyDown={handleListKeyDown}
                >
                  {visible.map((item) => (
                    <button
                      key={item.id}
                      id={`inbox-item-${item.id}`}
                      data-item-id={item.id}
                      type="button"
                      role="option"
                      aria-selected={item.id === selected?.id}
                      tabIndex={item.id === selected?.id ? 0 : -1}
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
                          <span className="inbox-item-workflow">{item.workflowName}</span>
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
