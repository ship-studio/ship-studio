import { Fragment } from 'react';
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../primitives/Breadcrumb';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';
import { getElementIcon } from '../edit/element-icons';
import type { ElementPathItem } from '../../lib/edit';

interface PreviewBreadcrumbProps {
  path: readonly ElementPathItem[];
  onSelect: (item: ElementPathItem) => void;
}

const MAX_VISIBLE_PATH_ITEMS = 4;

type BreadcrumbEntry =
  | { kind: 'element'; item: ElementPathItem; pathIndex: number }
  | { kind: 'ellipsis'; items: readonly ElementPathItem[] };

function firstClass(className: string) {
  return className.split(/\s+/).find(Boolean);
}

function itemLabel(item: ElementPathItem) {
  const className = firstClass(item.className);
  return `<${item.tagName}>${className ? ` .${className}` : ''}`;
}

function breadcrumbEntries(path: readonly ElementPathItem[]): BreadcrumbEntry[] {
  if (path.length <= MAX_VISIBLE_PATH_ITEMS) {
    return path.map((item, pathIndex) => ({ kind: 'element', item, pathIndex }));
  }

  return [
    { kind: 'element', item: path[0], pathIndex: 0 },
    { kind: 'ellipsis', items: path.slice(1, -2) },
    ...path.slice(-2).map((item, index) => ({
      kind: 'element' as const,
      item,
      pathIndex: path.length - 2 + index,
    })),
  ];
}

function ElementLabel({ item }: { item: ElementPathItem }) {
  const tagName = item.tagName.toLowerCase();
  const className = firstClass(item.className);
  const icon = getElementIcon(tagName);
  return (
    <span className="preview-breadcrumb__label">
      {icon && (
        <span className="preview-breadcrumb__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="preview-breadcrumb__tag">&lt;{tagName}&gt;</span>
      {className && <span className="preview-breadcrumb__class">.{className}</span>}
    </span>
  );
}

function BreadcrumbEntryContent({
  entry,
  pathLength,
  onSelect,
}: {
  entry: BreadcrumbEntry;
  pathLength: number;
  onSelect: (item: ElementPathItem) => void;
}) {
  if (entry.kind === 'ellipsis') {
    return (
      <Dropdown
        align="left"
        side="top"
        portal
        menuClassName="preview-breadcrumb__menu"
        trigger={(triggerProps) => (
          <MenuButton
            {...triggerProps}
            expanded={triggerProps['aria-expanded']}
            variant="ghost"
            size="compact"
            className="breadcrumb__ellipsis-trigger"
            aria-label="Show hidden elements"
          >
            <BreadcrumbEllipsis />
          </MenuButton>
        )}
      >
        {entry.items.map((item) => (
          <DropdownItem key={item.domPath} onSelect={() => onSelect(item)}>
            <ElementLabel item={item} />
          </DropdownItem>
        ))}
      </Dropdown>
    );
  }

  const label = itemLabel(entry.item);
  const current = entry.pathIndex === pathLength - 1;
  return current ? (
    <BreadcrumbPage aria-current="page" aria-label={`Current element ${label}`}>
      <ElementLabel item={entry.item} />
    </BreadcrumbPage>
  ) : (
    <BreadcrumbLink aria-label={`Select parent ${label}`} onClick={() => onSelect(entry.item)}>
      <ElementLabel item={entry.item} />
    </BreadcrumbLink>
  );
}

/** Shows the selected element and its authored DOM ancestors at the bottom of the preview. */
export function PreviewBreadcrumb({ path, onSelect }: PreviewBreadcrumbProps) {
  if (path.length === 0) return null;

  const entries = breadcrumbEntries(path);

  return (
    <Breadcrumb className="preview-breadcrumb">
      <BreadcrumbList>
        {entries.map((entry, index) => {
          const key = entry.kind === 'ellipsis' ? 'ellipsis' : entry.item.domPath || index;
          return (
            <Fragment key={`${key}-${index}`}>
              {index > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem>
                <BreadcrumbEntryContent
                  entry={entry}
                  pathLength={path.length}
                  onSelect={onSelect}
                />
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
