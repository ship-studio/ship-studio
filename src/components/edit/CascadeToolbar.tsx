import type { RefObject } from 'react';
import {
  ContractVerticalIcon,
  ExpandVerticalIcon,
  SearchIcon,
  SortVerticalDownIcon,
  SortVerticalUpIcon,
} from '@/components/icons';
import { useCommands } from '../../commands/useCommands';
import { IconButton } from '../primitives/IconButton';
import type { CascadeDisplayOrder } from '../../lib/cascadePresentation';

interface Props {
  kind?: 'rules' | 'animations';
  disabled?: boolean;
  searchOpen: boolean;
  searchButtonRef: RefObject<HTMLButtonElement | null>;
  searchFieldId: string;
  onSearchOpen: () => void;
  onSearchToggle: () => void;
  order: CascadeDisplayOrder;
  onOrderChange: (order: CascadeDisplayOrder) => void;
  allCollapsed: boolean;
  onCollapseAll: () => void;
  onExpandAll: () => void;
}

/** Search, display-order, and all-card controls for the CSS cascade. */
export function CascadeToolbar({
  kind = 'rules',
  disabled = false,
  searchOpen,
  searchButtonRef,
  searchFieldId,
  onSearchOpen,
  onSearchToggle,
  order,
  onOrderChange,
  allCollapsed,
  onCollapseAll,
  onExpandAll,
}: Props) {
  const isAnimationToolbar = kind === 'animations';
  const searchLabel = isAnimationToolbar ? 'Search CSS animations' : 'Search CSS rules';
  const orderLabel = isAnimationToolbar ? 'CSS animation order' : 'CSS rule order';
  const cardLabel = isAnimationToolbar ? 'CSS animation cards' : 'CSS selector cards';
  const unavailableTitle = 'Unavailable while Settings is open';
  const runSearchOpen = () => {
    if (!disabled) onSearchOpen();
  };
  const runSearchToggle = () => {
    if (!disabled) onSearchToggle();
  };
  const toggleOrder = () => {
    if (!disabled) onOrderChange(order === 'newest-top' ? 'newest-bottom' : 'newest-top');
  };
  const runCollapseAll = () => {
    if (!disabled) onCollapseAll();
  };
  const runExpandAll = () => {
    if (!disabled) onExpandAll();
  };

  useCommands(
    () => [
      {
        id: 'cssCascade.focusSearch',
        title: searchLabel,
        icon: <SearchIcon size={14} />,
        category: 'action',
        when: ({ kind }) => kind === 'project' && !disabled,
        keywords: ['selector', 'property', 'value', 'filter'],
        run: runSearchOpen,
      },
      {
        id: 'cssCascade.toggleOrder',
        title:
          order === 'newest-top'
            ? `Show newest ${isAnimationToolbar ? 'CSS animations' : 'CSS rules'} at the bottom`
            : `Show newest ${isAnimationToolbar ? 'CSS animations' : 'CSS rules'} at the top`,
        category: 'action',
        when: ({ kind }) => kind === 'project' && !disabled,
        keywords: ['reverse', 'sort', 'cascade', 'order'],
        run: toggleOrder,
      },
      {
        id: 'cssCascade.collapseAll',
        title: `Collapse all ${cardLabel}`,
        category: 'action',
        when: ({ kind }) => kind === 'project' && !disabled,
        keywords: ['rules', 'media query', 'minimize'],
        run: runCollapseAll,
      },
      {
        id: 'cssCascade.expandAll',
        title: `Expand all ${cardLabel}`,
        category: 'action',
        when: ({ kind }) => kind === 'project' && !disabled,
        keywords: ['rules', 'media query', 'show'],
        run: runExpandAll,
      },
    ],
    [
      cardLabel,
      disabled,
      isAnimationToolbar,
      onOrderChange,
      runCollapseAll,
      runExpandAll,
      runSearchOpen,
      order,
      searchLabel,
    ]
  );

  return (
    <div
      className="ss-cascade-toolbar"
      role="group"
      aria-label={isAnimationToolbar ? 'CSS animation controls' : 'CSS cascade controls'}
    >
      <IconButton
        ref={searchButtonRef}
        variant="ghost"
        size="compact"
        className="ss-cascade-toolbar__search-trigger"
        aria-label={searchOpen ? 'Close CSS search' : searchLabel}
        aria-controls={searchOpen ? searchFieldId : undefined}
        aria-expanded={searchOpen}
        disabled={disabled}
        title={disabled ? unavailableTitle : searchOpen ? 'Close CSS search' : searchLabel}
        icon={<SearchIcon size={11} />}
        onClick={runSearchToggle}
      />

      <IconButton
        variant="ghost"
        size="compact"
        className="button--icon-only ss-cascade-toolbar__order"
        disabled={disabled}
        aria-label={
          order === 'newest-top'
            ? `${orderLabel}: newest at top. Change to newest at bottom`
            : `${orderLabel}: newest at bottom. Change to newest at top`
        }
        title={
          disabled
            ? unavailableTitle
            : order === 'newest-top'
              ? `Newest ${isAnimationToolbar ? 'animations' : 'rules'} at top — change to newest at bottom`
              : `Newest ${isAnimationToolbar ? 'animations' : 'rules'} at bottom — change to newest at top`
        }
        icon={
          order === 'newest-top' ? (
            <SortVerticalUpIcon size={14} />
          ) : (
            <SortVerticalDownIcon size={14} />
          )
        }
        onClick={toggleOrder}
      />

      <IconButton
        variant="ghost"
        size="compact"
        className="button--icon-only ss-cascade-toolbar__collapse"
        disabled={disabled}
        aria-label={allCollapsed ? `Expand all ${cardLabel}` : `Collapse all ${cardLabel}`}
        title={
          disabled
            ? unavailableTitle
            : allCollapsed
              ? `Expand all ${cardLabel}`
              : `Collapse all ${cardLabel}`
        }
        icon={allCollapsed ? <ExpandVerticalIcon size={14} /> : <ContractVerticalIcon size={14} />}
        onClick={allCollapsed ? runExpandAll : runCollapseAll}
      />
    </div>
  );
}
