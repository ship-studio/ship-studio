import { Children, useState, type ReactNode } from 'react';
import { ChevronIcon, WarningIcon } from '@/components/icons';
import { FileTextIcon, TrashIcon } from '@/components/icons';
import { isMediaQueryComplete } from '../../lib/mediaQueries';
import { MediaQueryChips } from './MediaQueryChips';

function fileLabel(path: string): string {
  const [file, query] = path.split('?style=');
  const name = file.split('/').pop() ?? file;
  return query ? `${name} › style` : name;
}

interface Props {
  condition: string;
  file?: string;
  sourceFiles?: string[];
  inactive?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onRename?: (condition: string) => void;
  onDelete?: () => void;
  addSelector?: ReactNode;
  autoFocusQuery?: boolean;
  commitQueryOnAppend?: boolean;
  children: ReactNode;
}

/** A shared `@media` wrapper with its selector rules grouped beneath it. */
export function MediaQueryGroupCard({
  condition,
  file,
  sourceFiles = [],
  inactive = false,
  collapsed: controlledCollapsed,
  onToggleCollapse,
  onRename,
  onDelete,
  addSelector,
  autoFocusQuery = false,
  commitQueryOnAppend = false,
  children,
}: Props) {
  const [localCollapsed, setLocalCollapsed] = useState(false);
  const controlled = onToggleCollapse != null;
  const collapsed = controlled ? (controlledCollapsed ?? false) : localCollapsed;
  const toggleCollapse = () => {
    if (onToggleCollapse) onToggleCollapse();
    else setLocalCollapsed((value) => !value);
  };
  const sources = file ? [file] : [...new Set(sourceFiles)];
  const sourceTitle = sources.join('\n');
  const sourceLabel = sources.map(fileLabel).join(', ');
  const selectorCount = Children.count(children);
  const incomplete = onRename != null && !isMediaQueryComplete(condition);

  return (
    <section
      className={`ss-media-query-group${collapsed ? ' is-collapsed' : ''}${inactive ? ' is-inactive' : ''}${incomplete ? ' is-incomplete' : ''}`}
      data-testid="media-query-group"
    >
      <header className="ss-media-query-group__head">
        <div className="ss-media-query-group__source-row">
          {incomplete && (
            <span
              className="ss-media-query-group__incomplete"
              role="status"
              title="Complete the media query before its selectors are written to CSS"
            >
              <WarningIcon size={11} />
              Incomplete query
            </span>
          )}
          {sourceLabel && (
            <span
              className="ss-cascade-card__src-chip ss-media-query-group__source"
              title={sourceTitle}
            >
              <FileTextIcon size={11} />
              {sourceLabel}
            </span>
          )}
          {onDelete && (
            <button
              type="button"
              className="ss-cascade-card__trash ss-media-query-group__trash"
              title="Delete media query"
              aria-label="Delete media query"
              onClick={onDelete}
            >
              <TrashIcon size={12} />
            </button>
          )}
        </div>
        <div
          className="ss-media-query-group__query-row"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              event.currentTarget
                .querySelector<HTMLInputElement>('.ss-media-query__tail-input')
                ?.focus();
            }
          }}
        >
          <button
            type="button"
            className={`ss-media-query-group__collapse${collapsed ? ' is-collapsed' : ''}`}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand media query' : 'Collapse media query'}
            onClick={toggleCollapse}
          >
            <ChevronIcon size={12} />
          </button>
          <div
            className="ss-media-query-group__query-card"
            aria-invalid={incomplete || undefined}
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                event.currentTarget
                  .querySelector<HTMLInputElement>('.ss-media-query__tail-input')
                  ?.focus();
              }
            }}
          >
            <MediaQueryChips
              condition={condition}
              onCommit={onRename}
              autoFocusTail={autoFocusQuery}
              commitOnAppend={commitQueryOnAppend}
            />
          </div>
        </div>
        {collapsed && (
          <span className="ss-media-query-group__collapsed-summary">
            {selectorCount} {selectorCount === 1 ? 'class selector' : 'class selectors'}
          </span>
        )}
      </header>
      {!collapsed && (
        <div className="ss-media-query-group__body">
          <div className="ss-media-query-group__selectors">
            {children}
            {addSelector}
          </div>
        </div>
      )}
    </section>
  );
}
