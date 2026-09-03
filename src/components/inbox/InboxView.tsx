/**
 * Inbox — what the routines found.
 *
 * PROTOTYPE. Items come from the in-memory store in `lib/routinesStore`. In the
 * real feature each item is a markdown file under `.shipstudio/inbox/`, written
 * by the agent through one MCP tool — see `docs/routines-inbox.md`.
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
import { InboxDetail } from './InboxDetail';
import { useOptionalToast } from '../../contexts/ToastContext';
import { formatAge, type InboxItem, type Severity } from '../../lib/routines';
import {
  getSnapshot,
  markAllRead,
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

export function InboxView() {
  const { inbox } = useSyncExternalStore(subscribe, getSnapshot);
  const { showToast } = useOptionalToast();

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
    if (!item.read) setItemRead(item.id, true);
  }, []);

  const handleArchive = useCallback(
    (item: InboxItem) => {
      setItemArchived(item.id, !item.archived);
      showToast(item.archived ? 'Restored to inbox' : `Archived — "${item.title}"`, 'info');
    },
    [showToast]
  );

  return (
    <div className="inbox-page">
      <header className="inbox-header">
        <div className="inbox-header-heading">
          <h1 className="inbox-title">Inbox</h1>
          <p className="inbox-subtitle">
            {unread > 0
              ? `${unread} unread from ${new Set(inbox.filter((i) => !i.read && !i.archived).map((i) => i.routineName)).size} routines`
              : 'Nothing unread.'}
          </p>
        </div>

        <div className="inbox-header-controls">
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
            align="right"
            trigger={(props) => (
              <MenuButton
                variant="secondary"
                size="compact"
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
              <DropdownItem key={name} active={project === name} onSelect={() => setProject(name)}>
                {name}
              </DropdownItem>
            ))}
          </Dropdown>
          <Button
            variant="ghost"
            size="compact"
            leftIcon={<CheckIcon size={12} />}
            onClick={markAllRead}
            disabled={unread === 0}
          >
            Mark all read
          </Button>
        </div>
      </header>

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
            {selected && <InboxDetail item={selected} onArchive={handleArchive} />}
          </div>
        </div>
      )}
    </div>
  );
}
