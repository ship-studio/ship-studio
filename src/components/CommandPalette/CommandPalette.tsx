import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { SearchIcon } from '../icons';
import { useConsumePendingTab, type PaletteContextKind } from './paletteContext';
import { useRankedCommands, type RankedCommand } from '../../commands/useRankedCommands';
import { recordRun } from '../../commands/frecency';
import type { CommandCategory } from '../../commands/types';
import { logger } from '../../lib/logger';
import { trackEvent, trackSearch, cancelTrackedSearch } from '../../lib/analytics';

type DismissReason = 'command_run' | 'manual';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  context: PaletteContextKind;
  currentProjectName: string | null;
}

type TabId = 'all' | CommandCategory;

const HOME_TABS: { id: TabId; label: string }[] = [
  { id: 'all', label: 'All results' },
  { id: 'project', label: 'Projects' },
  { id: 'action', label: 'Actions' },
  { id: 'settings', label: 'Settings' },
];

const PROJECT_TABS: { id: TabId; label: string }[] = [
  { id: 'all', label: 'All results' },
  { id: 'project', label: 'Projects' },
  { id: 'action', label: 'Actions' },
  { id: 'branch', label: 'Branches' },
  { id: 'plugin', label: 'Plugins' },
  { id: 'settings', label: 'Settings' },
];

const GROUP_ORDER: CommandCategory[] = [
  'navigation',
  'project',
  'action',
  'branch',
  'plugin',
  'settings',
];

const GROUP_LABEL: Record<CommandCategory, string> = {
  navigation: 'Navigate',
  project: 'Projects',
  action: 'Actions',
  branch: 'Branches',
  plugin: 'Plugins & extensions',
  settings: 'Settings',
};

function placeholderFor(ctx: PaletteContextKind, projectName: string | null) {
  if (ctx === 'project') {
    return projectName ? `Search actions in ${projectName}…` : 'Search actions…';
  }
  return 'Search projects, actions, settings…';
}

export function CommandPalette({
  isOpen,
  onClose,
  context,
  currentProjectName,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTabRaw] = useState<TabId>('all');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const consumePendingTab = useConsumePendingTab();

  // Analytics: track open duration and dismissal reason. The reason ref is set
  // by runSelected before it calls onClose so the close-side effect knows the
  // user invoked a command vs. dismissed via esc / click-outside.
  const openedAtRef = useRef<number | null>(null);
  const dismissReasonRef = useRef<DismissReason>('manual');

  const ranked = useRankedCommands({ kind: context, currentProjectName }, query);

  const filtered = useMemo(
    () => (activeTab === 'all' ? ranked : ranked.filter((c) => c.category === activeTab)),
    [ranked, activeTab]
  );

  // Grouped layout for the "All" tab; flat list for every other tab.
  const grouped = useMemo(() => {
    if (activeTab !== 'all') return null;
    const buckets = new Map<CommandCategory, RankedCommand[]>();
    for (const cmd of filtered) {
      const list = buckets.get(cmd.category) ?? [];
      list.push(cmd);
      buckets.set(cmd.category, list);
    }
    return GROUP_ORDER.filter((cat) => (buckets.get(cat)?.length ?? 0) > 0).map((cat) => ({
      category: cat,
      rows: buckets.get(cat)!,
    }));
  }, [activeTab, filtered]);

  useEffect(() => {
    if (isOpen) {
      const pending = consumePendingTab();
      setActiveTabRaw(pending ?? 'all');
      inputRef.current?.focus();
      openedAtRef.current = Date.now();
      dismissReasonRef.current = 'manual';
      void trackEvent('palette_opened', {
        context,
        initial_tab: pending ?? 'all',
      });
    } else {
      // Drop any pending debounced search — otherwise it fires *after* the
      // palette is gone, attributing a search to a closed surface.
      cancelTrackedSearch('palette');
      // Fire close event before resetting state so we have the active tab.
      if (openedAtRef.current !== null) {
        void trackEvent('palette_closed', {
          context,
          dismissed_with: dismissReasonRef.current,
          duration_ms: Date.now() - openedAtRef.current,
        });
        openedAtRef.current = null;
      }
      setQuery('');
      setActiveTabRaw('all');
      setSelectedIdx(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- consumePendingTab is stable, context is captured in handlers
  }, [isOpen]);

  // Clamp selection when the filtered list changes length.
  useEffect(() => {
    setSelectedIdx((i) => Math.min(i, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [query, activeTab, context]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-selected="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  const tabs = context === 'project' ? PROJECT_TABS : HOME_TABS;

  // Tab-switch tracking. `cause` distinguishes between explicit clicks and
  // keyboard navigation so we can tell whether power users prefer arrows.
  const setActiveTab = (next: TabId, cause: 'click' | 'keyboard') => {
    if (next !== activeTab) {
      void trackEvent('palette_tab_switched', {
        from_tab: activeTab,
        to_tab: next,
        cause,
        context,
      });
    }
    setActiveTabRaw(next);
  };

  const runSelected = (cmd: RankedCommand, position: number) => {
    // Mark dismissal reason before close so the open/close effect tags the
    // resulting palette_closed event correctly.
    dismissReasonRef.current = 'command_run';
    const trimmedQuery = query.trim();
    void trackEvent('palette_command_run', {
      command_id: cmd.id,
      category: cmd.category,
      // `position` is the index in the *currently filtered* list; pair it
      // with `total_results` so the metric is interpretable across queries.
      position,
      total_results: filtered.length,
      query: trimmedQuery.slice(0, 100),
      query_length: trimmedQuery.length,
      had_query: trimmedQuery.length > 0,
      tab: activeTab,
      context,
    });
    // Close first so the UI doesn't block on long-running handlers.
    onClose();
    recordRun(cmd.id);
    try {
      const result = cmd.run();
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).catch((err) =>
          logger.error('[CommandPalette] command failed', { id: cmd.id, error: String(err) })
        );
      }
    } catch (err) {
      logger.error('[CommandPalette] command threw', { id: cmd.id, error: String(err) });
    }
  };

  const cycleTab = (direction: 1 | -1) => {
    const currentIdx = tabs.findIndex((t) => t.id === activeTab);
    const nextIdx = (currentIdx + direction + tabs.length) % tabs.length;
    setActiveTab(tabs[nextIdx].id, 'keyboard');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      cycleTab(1);
    } else if (e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      cycleTab(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = filtered[selectedIdx];
      if (cmd) runSelected(cmd, selectedIdx);
    }
  };

  let flatIdx = 0; // running index across groups so arrow-nav maps to flat order.

  return (
    <ModalFrame
      isOpen={isOpen}
      onClose={onClose}
      className="command-palette"
      ariaLabel="Command palette"
    >
      <div className="command-palette-search">
        <span className="command-palette-search-icon" aria-hidden="true">
          <SearchIcon size={16} />
        </span>
        <input
          ref={inputRef}
          type="text"
          className="command-palette-input"
          placeholder={placeholderFor(context, currentProjectName)}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            // Debounced (1s) — only the final query lands in PostHog.
            trackSearch('palette', e.target.value);
          }}
          onKeyDown={handleKeyDown}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label="Search commands"
        />
      </div>

      {context === 'project' && currentProjectName && (
        <div className="command-palette-scope">
          <span className="command-palette-scope-label">In project</span>
          <span className="command-palette-scope-value">{currentProjectName}</span>
        </div>
      )}

      <div className="command-palette-tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`command-palette-tab ${activeTab === tab.id ? 'is-active' : ''}`}
            onClick={() => setActiveTab(tab.id, 'click')}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="command-palette-list" role="listbox" ref={listRef}>
        {filtered.length === 0 ? (
          <div className="command-palette-empty">
            {query ? `No matches for "${query}"` : 'No commands available here yet'}
          </div>
        ) : grouped ? (
          grouped.map((group) => (
            <div key={group.category} className="command-palette-group">
              <div className="command-palette-group-header">{GROUP_LABEL[group.category]}</div>
              {group.rows.map((cmd) => {
                const idx = flatIdx++;
                return (
                  <CommandRow
                    key={cmd.id}
                    cmd={cmd}
                    selected={idx === selectedIdx}
                    onMouseEnter={() => setSelectedIdx(idx)}
                    onClick={() => runSelected(cmd, idx)}
                  />
                );
              })}
            </div>
          ))
        ) : (
          filtered.map((cmd, idx) => (
            <CommandRow
              key={cmd.id}
              cmd={cmd}
              selected={idx === selectedIdx}
              onMouseEnter={() => setSelectedIdx(idx)}
              onClick={() => runSelected(cmd, idx)}
            />
          ))
        )}
      </div>

      <div className="command-palette-footer">
        <span className="command-palette-hint">
          <kbd className="command-palette-kbd">↑</kbd>
          <kbd className="command-palette-kbd">↓</kbd>
          <span>navigate</span>
        </span>
        <span className="command-palette-hint">
          <kbd className="command-palette-kbd">←</kbd>
          <kbd className="command-palette-kbd">→</kbd>
          <span>tabs</span>
        </span>
        <span className="command-palette-hint">
          <kbd className="command-palette-kbd">↵</kbd>
          <span>select</span>
        </span>
        <span className="command-palette-hint">
          <kbd className="command-palette-kbd">esc</kbd>
          <span>close</span>
        </span>
      </div>
    </ModalFrame>
  );
}

interface RowProps {
  cmd: RankedCommand;
  selected: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}

function CommandRow({ cmd, selected, onMouseEnter, onClick }: RowProps) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-selected={selected}
      className={`command-palette-row ${selected ? 'is-selected' : ''}`}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
    >
      <span className="command-palette-row-icon" aria-hidden="true">
        {cmd.icon ?? <DefaultIcon />}
      </span>
      <span className="command-palette-row-text">
        <span className="command-palette-row-title">{cmd.title}</span>
        {cmd.subtitle && <span className="command-palette-row-subtitle">{cmd.subtitle}</span>}
      </span>
      {cmd.shortcut && (
        <span className="command-palette-row-meta">
          <kbd className="command-palette-kbd">{cmd.shortcut}</kbd>
        </span>
      )}
    </button>
  );
}

function DefaultIcon(): ReactNode {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
