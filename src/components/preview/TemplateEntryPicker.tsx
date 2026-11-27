/** Picks a concrete route returned by an Astro dynamic page's getStaticPaths. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useCommands } from '../../commands/useCommands';
import { listTemplatePageEntries } from '../../lib/project';
import { useAsyncState } from '../../hooks/useAsyncState';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { Button } from '../primitives/Button';
import { ChevronIcon } from '@/components/icons';

const identityRoute = (route: string) => route;

interface TemplateEntryPickerProps {
  projectPath: string;
  templateRoute: string | null;
  currentPage: string;
  canonicalizeRoute?: (route: string) => string;
  onNavigate: (route: string) => void;
}

export function TemplateEntryPicker({
  projectPath,
  templateRoute,
  currentPage,
  canonicalizeRoute = identityRoute,
  onNavigate,
}: TemplateEntryPickerProps) {
  const entries = useAsyncState(listTemplatePageEntries);
  const loadEntries = entries.execute;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const selectionRouteRef = useRef(currentPage);
  const navigationOccurredRef = useRef(false);
  const autoNavigationConsumedRef = useRef(false);

  useCommands(
    () => [
      {
        id: 'preview.chooseTemplateEntry',
        title: 'Choose dynamic page entry…',
        category: 'navigation',
        when: ({ kind }) => kind === 'project' && !!templateRoute,
        run: () => setOpen(true),
      },
    ],
    [templateRoute]
  );

  useEffect(() => {
    if (templateRoute) void loadEntries(projectPath, templateRoute);
  }, [loadEntries, projectPath, templateRoute]);

  useEffect(() => {
    if (currentPage !== selectionRouteRef.current) navigationOccurredRef.current = true;
  }, [currentPage]);

  useEffect(() => {
    if (!templateRoute || entries.isLoading || entries.error || !entries.data || entries.data.error)
      return;
    if (autoNavigationConsumedRef.current) return;
    autoNavigationConsumedRef.current = true;
    if (navigationOccurredRef.current || currentPage !== selectionRouteRef.current) return;
    const matchingEntry = entries.data.entries.find(
      (entry) => canonicalizeRoute(entry.route) === currentPage
    );
    const target = matchingEntry ?? entries.data.entries[0];
    if (target && canonicalizeRoute(target.route) !== currentPage) onNavigate(target.route);
  }, [
    canonicalizeRoute,
    currentPage,
    entries.data,
    entries.error,
    entries.isLoading,
    onNavigate,
    templateRoute,
  ]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (entries.data?.entries ?? []).filter(
      (entry) => !needle || `${entry.label} ${entry.route}`.toLocaleLowerCase().includes(needle)
    );
  }, [entries.data, query]);

  if (!templateRoute) return null;

  const current = entries.data?.entries.find(
    (entry) => canonicalizeRoute(entry.route) === currentPage
  );
  const segments = templateRoute.split('/').filter(Boolean);
  const heading = segments[segments.length - 1] ?? templateRoute;
  const entryLabel =
    current?.label ??
    (entries.isLoading
      ? 'Loading…'
      : entries.error || entries.data?.error
        ? 'Entries unavailable'
        : entries.data?.entries.length === 0
          ? 'No entries'
          : 'Choose entry');

  return (
    <Dropdown
      align="right"
      side="bottom"
      portal
      portalClampToViewport
      className="template-entry-picker"
      menuClassName="template-entry-picker__menu"
      ariaLabel={`Entries for ${heading}`}
      search={
        entries.data && entries.data.entries.length > 8
          ? { value: query, onChange: setQuery, placeholder: 'Filter entries…' }
          : undefined
      }
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && (!entries.data || entries.error || entries.data.error) && !entries.isLoading)
          void entries.execute(projectPath, templateRoute);
      }}
      trigger={(triggerProps) => (
        <Button
          {...triggerProps}
          variant="ghost"
          size="default"
          className="template-entry-picker__trigger"
          title={`Choose an entry for ${templateRoute}`}
        >
          <span className="template-entry-picker__template">{heading}</span>
          <span className="template-entry-picker__current">{entryLabel}</span>
          <ChevronIcon size={12} />
        </Button>
      )}
    >
      <div className="template-entry-picker__heading">
        <strong>{heading}</strong>
        <span>{templateRoute}</span>
      </div>
      {entries.isLoading && <div className="template-entry-picker__status">Loading entries…</div>}
      {(entries.error || entries.data?.error) && (
        <div className="template-entry-picker__status template-entry-picker__status--error">
          {entries.error?.message ?? entries.data?.error}
        </div>
      )}
      {!entries.isLoading &&
        !entries.error &&
        !entries.data?.error &&
        entries.data?.entries.length === 0 && (
          <div className="template-entry-picker__status">
            No entries were provided for this template.
          </div>
        )}
      {filtered.slice(0, 100).map((entry) => (
        <DropdownItem
          key={entry.route}
          onSelect={() => onNavigate(entry.route)}
          active={canonicalizeRoute(entry.route) === currentPage}
        >
          <span className="template-entry-picker__item-label">{entry.label}</span>
          <span className="template-entry-picker__item-route">{entry.route}</span>
        </DropdownItem>
      ))}
    </Dropdown>
  );
}
