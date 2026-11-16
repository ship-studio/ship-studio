import { Children, useState, type ReactNode } from 'react';
import { ChevronIcon, WarningIcon } from '@/components/icons';
import { FileTextIcon, TrashIcon } from '@/components/icons';
import { cascadeSourceFileLabel } from '../../lib/cascadePresentation';
import { isMediaQueryComplete } from '../../lib/mediaQueries';
import { MediaQueryChips } from './MediaQueryChips';
import { Button } from '../primitives/Button';
import { ModalFrame } from '../primitives/ModalFrame';

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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const controlled = onToggleCollapse != null;
  const collapsed = controlled ? (controlledCollapsed ?? false) : localCollapsed;
  const toggleCollapse = () => {
    if (onToggleCollapse) onToggleCollapse();
    else setLocalCollapsed((value) => !value);
  };
  const sources = file ? [file] : [...new Set(sourceFiles)];
  const sourceTitle = sources.join('\n');
  const sourceLabel = sources.map(cascadeSourceFileLabel).join(', ');
  const selectorCount = Children.count(children);
  const incomplete = onRename != null && !isMediaQueryComplete(condition);

  return (
    <section
      className={`ss-media-query-group${collapsed ? ' is-collapsed' : ''}${inactive ? ' is-inactive' : ''}${incomplete ? ' is-incomplete' : ''}`}
      data-testid="media-query-group"
    >
      <header className="ss-media-query-group__head">
        {incomplete && (
          <div className="ss-media-query-group__warning-row">
            <span
              className="ss-media-query-group__incomplete"
              role="status"
              title="Complete the media query before its selectors are written to CSS"
            >
              <WarningIcon size={11} />
              Incomplete query
            </span>
          </div>
        )}
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
            className={`ss-cascade-card__collapse ss-media-query-group__collapse${collapsed ? ' is-collapsed' : ''}`}
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
            {(sourceLabel || onDelete) && (
              <div
                className={`ss-media-query-group__source-row${sourceLabel ? ' has-source' : ''}`}
              >
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
                    onClick={() => setConfirmDelete(true)}
                  >
                    <TrashIcon size={12} />
                  </button>
                )}
              </div>
            )}
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
      <ModalFrame
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete rules in this media group?"
        showCloseButton
        className="ss-media-query-delete-modal"
      >
        <div className="ss-cascade-shared-delete-modal__body">
          <p>
            This removes the editable rules shown in <code>@media {condition}</code>. Any shared
            selector-list rule is deleted for all of its members.
          </p>
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmDelete(false);
                onDelete?.();
              }}
            >
              Delete rules
            </Button>
          </div>
        </div>
      </ModalFrame>
    </section>
  );
}
