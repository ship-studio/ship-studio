import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import { useClickOutside } from '../../hooks/useClickOutside';

const MENU_ITEM_SELECTOR = '[role="menuitem"]';
const TYPEAHEAD_TIMEOUT_MS = 500;
const HOVER_CLOSE_DELAY_MS = 120;

function getMenuItems(menu: HTMLDivElement | null): HTMLElement[] {
  return menu ? Array.from(menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)) : [];
}

function isEnabledMenuItem(item: HTMLElement): boolean {
  return !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true';
}

export interface DropdownTriggerProps {
  ref: Ref<HTMLButtonElement>;
  onClick: (e: MouseEvent) => void;
  'aria-expanded': boolean;
  'aria-haspopup': 'menu' | 'dialog';
}

interface DropdownBaseProps {
  /**
   * Render the trigger button. Spread the provided props onto it — they wire
   * up toggle-on-click, the anchor ref, and aria state. The trigger keeps its
   * own classes/content.
   */
  trigger: (props: DropdownTriggerProps) => ReactNode;
  /** Menu content: DropdownItem / DropdownDivider or arbitrary nodes. */
  children: ReactNode;
  /** Which edge of the trigger the menu aligns to. Default 'left'. */
  align?: 'left' | 'right';
  /** Which side of the trigger the menu opens on. Default 'bottom'. */
  side?: 'top' | 'bottom';
  /**
   * Render the menu in a body portal with fixed positioning. Use when an
   * ancestor has overflow:hidden that would clip an absolute menu (terminal
   * panes, editor panels). The menu re-anchors on scroll/resize.
   */
  portal?: boolean;
  /** Extra class on the menu container (for width/feature-specific tweaks). */
  menuClassName?: string;
  /** Notified after open state changes (e.g. to lazy-load menu data). */
  onOpenChange?: (open: boolean) => void;
  /** Optional controlled open state. */
  open?: boolean;
  /**
   * Adds a filter field at the top of the menu.
   *
   * The *caller* owns the query and does the filtering, because only the
   * caller knows how its options should match and sort. This just renders the
   * field, focuses it on open, and hands ArrowDown to the list — a menu with
   * more than a handful of options is unusable without it, and typeahead
   * (jump-to-first-letter) is not the same thing as search.
   */
  search?: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  };
  /** Open on pointer hover while retaining click and keyboard access. */
  openOnHover?: boolean;
  /** Extra class on the trigger/menu wrapper. */
  className?: string;
  /**
   * When a pointer opens the menu, focus the menu itself rather than its first
   * item, so nothing looks chosen before the user chooses — the way a native
   * popup menu opens. Arrow keys still reach the items, and a keyboard open
   * (Enter / Space on the trigger) focuses the first item as usual.
   */
  quietOpen?: boolean;
}

type DropdownProps = DropdownBaseProps &
  ({ presentation: 'popover'; ariaLabel: string } | { presentation?: 'menu'; ariaLabel?: string });

const DropdownContext = createContext<{ close: () => void } | null>(null);

/**
 * Canonical dropdown menu: open/close state, click-outside, ESC, alignment,
 * and (optionally) portal positioning for overflow-clipped ancestors — the
 * patterns previously re-implemented per feature.
 *
 * ```tsx
 * <Dropdown
 *   align="right"
 *   trigger={(p) => <MenuButton expanded={p['aria-expanded']} {...p}>•••</MenuButton>}
 * >
 *   <DropdownItem icon={<EditIcon size={14} />} onSelect={rename}>Rename</DropdownItem>
 *   <DropdownDivider />
 *   <DropdownItem variant="danger" onSelect={remove}>Delete</DropdownItem>
 * </Dropdown>
 * ```
 */
export function Dropdown({
  trigger,
  children,
  align = 'left',
  side = 'bottom',
  presentation = 'menu',
  ariaLabel,
  portal = false,
  menuClassName,
  onOpenChange,
  open: controlledOpen,
  search,
  openOnHover = false,
  className,
  quietOpen = false,
}: DropdownProps) {
  if (presentation === 'popover' && (typeof ariaLabel !== 'string' || !ariaLabel.trim())) {
    throw new Error('Dropdown presentation="popover" requires a non-empty ariaLabel.');
  }
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = controlledOpen ?? internalOpen;
  const [portalPos, setPortalPos] = useState<CSSProperties | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);
  const restoreFocusOnCloseRef = useRef(true);
  const hasSearch = search !== undefined;
  const openedByHoverRef = useRef(false);
  const openedByPointerRef = useRef(false);
  const typeaheadRef = useRef('');
  const typeaheadTimerRef = useRef<number | null>(null);
  const hoverCloseTimerRef = useRef<number | null>(null);

  const setOpen = useCallback(
    (open: boolean) => {
      if (controlledOpen === undefined) setInternalOpen(open);
      onOpenChange?.(open);
    },
    [controlledOpen, onOpenChange]
  );

  const cancelHoverClose = useCallback(() => {
    if (hoverCloseTimerRef.current !== null) {
      window.clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  }, []);

  const close = useCallback(() => {
    cancelHoverClose();
    setOpen(false);
  }, [cancelHoverClose, setOpen]);

  const scheduleHoverClose = useCallback(() => {
    cancelHoverClose();
    hoverCloseTimerRef.current = window.setTimeout(() => {
      // A pointer-driven close should not pull focus back to the trigger. The
      // user may already be interacting with another control by the time the
      // grace period expires.
      restoreFocusOnCloseRef.current = false;
      setOpen(false);
      hoverCloseTimerRef.current = null;
    }, HOVER_CLOSE_DELAY_MS);
  }, [cancelHoverClose, setOpen]);

  const openFromHover = useCallback(() => {
    cancelHoverClose();
    if (!isOpen) {
      openedByHoverRef.current = true;
      setOpen(true);
    }
  }, [cancelHoverClose, isOpen, setOpen]);

  const handleTriggerClick = useCallback(
    (e: MouseEvent) => {
      // Triggers often sit inside clickable cards — don't activate the card.
      e.stopPropagation();
      cancelHoverClose();
      openedByHoverRef.current = false;
      // A keyboard-activated click has no click count.
      openedByPointerRef.current = e.detail > 0;
      setOpen(!isOpen);
    },
    [cancelHoverClose, isOpen, setOpen]
  );

  // Dismissal by clicking elsewhere: the user has just put focus (or their
  // attention) on whatever they clicked — a terminal, another panel — so the
  // menu closes without dragging focus back to its trigger. Escape and menu
  // selection still restore it.
  const closeFromOutsidePointer = useCallback(() => {
    cancelHoverClose();
    restoreFocusOnCloseRef.current = false;
    setOpen(false);
  }, [cancelHoverClose, setOpen]);

  // The portaled menu isn't a DOM descendant of the container; exclude it so
  // clicks inside the menu don't count as "outside".
  useClickOutside(
    containerRef,
    closeFromOutsidePointer,
    isOpen,
    portal ? '.ss-dropdown__menu, .ss-context-menu' : '.ss-context-menu'
  );

  const focusMenuItem = useCallback((item: HTMLElement | null) => {
    const items = getMenuItems(menuRef.current);
    items.forEach((menuItem) => {
      menuItem.tabIndex = menuItem === item ? 0 : -1;
    });
    item?.focus({ preventScroll: true });
  }, []);

  const focusEnabledMenuItemAt = useCallback(
    (index: number) => {
      const enabledItems = getMenuItems(menuRef.current).filter(isEnabledMenuItem);
      if (enabledItems.length === 0) {
        menuRef.current?.focus({ preventScroll: true });
        return;
      }
      const normalizedIndex = (index + enabledItems.length) % enabledItems.length;
      focusMenuItem(enabledItems[normalizedIndex]);
    },
    [focusMenuItem]
  );

  useLayoutEffect(() => {
    if (!isOpen) {
      typeaheadRef.current = '';
      if (typeaheadTimerRef.current !== null) {
        window.clearTimeout(typeaheadTimerRef.current);
        typeaheadTimerRef.current = null;
      }
      if (wasOpenRef.current) {
        wasOpenRef.current = false;
        if (restoreFocusOnCloseRef.current) triggerRef.current?.focus({ preventScroll: true });
        restoreFocusOnCloseRef.current = true;
      }
      return;
    }

    // A portaled menu starts hidden until its trigger has been measured. Focus
    // only after the first visible position is committed so browsers don't drop
    // focus into a hidden portal on its first open.
    if (portal && portalPos === null) return;
    if (wasOpenRef.current) return;

    wasOpenRef.current = true;
    restoreFocusOnCloseRef.current = true;
    if (openedByHoverRef.current) {
      openedByHoverRef.current = false;
      return;
    }
    // With a filter field, focus belongs in the field — you opened the menu to
    // search it. ArrowDown from there hands focus to the list.
    if (hasSearch) return;
    if (presentation === 'menu') {
      if (quietOpen && openedByPointerRef.current) {
        menuRef.current?.focus({ preventScroll: true });
        return;
      }
      focusEnabledMenuItemAt(0);
      return;
    }
    const focusable = menuRef.current?.querySelector<HTMLElement>(
      'button:not(:disabled), summary, input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'
    );
    (focusable ?? menuRef.current)?.focus({ preventScroll: true });
  }, [focusEnabledMenuItemAt, hasSearch, isOpen, portal, portalPos, presentation, quietOpen]);

  useEffect(() => {
    return () => {
      if (typeaheadTimerRef.current !== null) {
        window.clearTimeout(typeaheadTimerRef.current);
      }
      if (hoverCloseTimerRef.current !== null) {
        window.clearTimeout(hoverCloseTimerRef.current);
      }
    };
  }, []);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const targetMenuItem = target.closest<HTMLElement>(MENU_ITEM_SELECTOR);
    // Arbitrary menu content can contain inputs (for example, the custom
    // folder path in Assets). Leave its editing keys untouched.
    if (target !== event.currentTarget && !targetMenuItem) return;

    const enabledItems = getMenuItems(menuRef.current).filter(isEnabledMenuItem);
    const currentIndex = targetMenuItem ? enabledItems.indexOf(targetMenuItem) : -1;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusEnabledMenuItemAt(currentIndex < 0 ? 0 : currentIndex + 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusEnabledMenuItemAt(currentIndex < 0 ? enabledItems.length - 1 : currentIndex - 1);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      focusEnabledMenuItemAt(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      focusEnabledMenuItemAt(enabledItems.length - 1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      if (!targetMenuItem || !isEnabledMenuItem(targetMenuItem)) return;
      event.preventDefault();
      targetMenuItem.click();
      return;
    }

    if (
      event.key.length !== 1 ||
      /\s/.test(event.key) ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    ) {
      return;
    }

    event.preventDefault();
    const character = event.key.toLocaleLowerCase();
    const nextBuffer = `${typeaheadRef.current}${character}`;
    const repeatedCharacter = [...nextBuffer].every((entry) => entry === character);
    const query = repeatedCharacter ? character : nextBuffer;
    typeaheadRef.current = nextBuffer;
    if (typeaheadTimerRef.current !== null) window.clearTimeout(typeaheadTimerRef.current);
    typeaheadTimerRef.current = window.setTimeout(() => {
      typeaheadRef.current = '';
      typeaheadTimerRef.current = null;
    }, TYPEAHEAD_TIMEOUT_MS);

    const startIndex = currentIndex < 0 ? 0 : currentIndex + 1;
    const match = enabledItems
      .map((_, index) => enabledItems[(startIndex + index) % enabledItems.length])
      .find((item) => {
        const label = item.textContent?.trim().toLocaleLowerCase() ?? '';
        return label.startsWith(query);
      });
    const fallbackMatch =
      match ??
      (query !== character
        ? enabledItems.find((item) =>
            item.textContent?.trim().toLocaleLowerCase().startsWith(character)
          )
        : null);
    if (fallbackMatch) focusMenuItem(fallbackMatch);
  };

  useLayoutEffect(() => {
    if (!isOpen) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Claim the key so an enclosing dialog doesn't also close on it.
        e.preventDefault();
        close();
        triggerRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);

    if (!portal) {
      return () => window.removeEventListener('keydown', handler);
    }

    // Fixed positioning escapes ancestor overflow:hidden; re-anchor on
    // scroll/resize so the menu tracks the trigger through layout changes.
    const anchor = () => {
      const btn = triggerRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      // Explicitly neutralize the class's `left: 0` / `margin-top` — with only
      // `right` set inline, the menu would stretch from the viewport's left
      // edge to the anchor. Inline styles must own both horizontal edges.
      const vertical =
        side === 'top'
          ? { top: 'auto', bottom: window.innerHeight - rect.top + 6 }
          : { top: rect.bottom + 6, bottom: 'auto' };
      setPortalPos({
        position: 'fixed',
        ...vertical,
        ...(align === 'right'
          ? { right: window.innerWidth - rect.right, left: 'auto' }
          : { left: rect.left, right: 'auto' }),
        marginTop: 0,
      });
    };
    anchor();
    window.addEventListener('scroll', anchor, true);
    window.addEventListener('resize', anchor);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('scroll', anchor, true);
      window.removeEventListener('resize', anchor);
    };
  }, [isOpen, portal, align, side, close]);

  const menu = isOpen ? (
    <div
      ref={menuRef}
      className={[
        'ss-dropdown__menu',
        align === 'right' && !portal ? 'ss-dropdown__menu--right' : null,
        menuClassName,
      ]
        .filter(Boolean)
        .join(' ')}
      style={portal ? (portalPos ?? { position: 'fixed', visibility: 'hidden' }) : undefined}
      role={presentation === 'menu' ? 'menu' : 'dialog'}
      aria-label={presentation === 'popover' ? ariaLabel : undefined}
      tabIndex={-1}
      onKeyDown={presentation === 'menu' ? handleMenuKeyDown : undefined}
      onMouseEnter={openOnHover ? cancelHoverClose : undefined}
      onMouseLeave={openOnHover ? scheduleHoverClose : undefined}
    >
      {search && (
        <div className="ss-dropdown__search">
          <input
            type="text"
            className="ss-dropdown__search-input"
            value={search.value}
            placeholder={search.placeholder ?? 'Search…'}
            spellCheck={false}
            autoComplete="off"
            aria-label={search.placeholder ?? 'Search'}
            // The menu just opened for the express purpose of searching it,
            // so focus belongs in the field.
            autoFocus
            onChange={(event) => search.onChange(event.target.value)}
            onKeyDown={(event) => {
              // Hand the list its keys back: typing filters, arrows navigate.
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                focusEnabledMenuItemAt(0);
              }
            }}
          />
        </div>
      )}
      <DropdownContext.Provider value={{ close }}>{children}</DropdownContext.Provider>
    </div>
  ) : null;

  return (
    <div
      className={['ss-dropdown', className, className && isOpen ? 'is-open' : null]
        .filter(Boolean)
        .join(' ')}
      ref={containerRef}
      onMouseEnter={openOnHover ? openFromHover : undefined}
      onMouseLeave={openOnHover ? scheduleHoverClose : undefined}
    >
      {trigger({
        ref: triggerRef,
        onClick: handleTriggerClick,
        'aria-expanded': isOpen,
        'aria-haspopup': presentation === 'menu' ? 'menu' : 'dialog',
      })}
      {portal ? menu && createPortal(menu, document.body) : menu}
    </div>
  );
}

interface DropdownItemProps {
  /** Called on click; the menu closes itself afterwards. */
  onSelect: () => void;
  children: ReactNode;
  /** Leading icon node (size 14 is the house convention). */
  icon?: ReactNode;
  variant?: 'default' | 'danger';
  /** Highlight as the currently-active choice. */
  active?: boolean;
  disabled?: boolean;
  /** Skip the automatic close after select (e.g. multi-toggle menus). */
  keepOpen?: boolean;
}

export function DropdownItem({
  onSelect,
  children,
  icon,
  variant = 'default',
  active,
  disabled,
  keepOpen,
}: DropdownItemProps) {
  const ctx = useContext(DropdownContext);

  const handleClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (!keepOpen) ctx?.close();
    onSelect();
  };

  return (
    <button
      type="button"
      role="menuitem"
      className={[
        'ss-dropdown__item',
        variant === 'danger' ? 'ss-dropdown__item--danger' : null,
        active ? 'ss-dropdown__item--active' : null,
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={handleClick}
      disabled={disabled}
      tabIndex={ctx ? -1 : undefined}
      aria-disabled={disabled || undefined}
    >
      {icon}
      {children}
    </button>
  );
}

export function DropdownDivider() {
  return <div className="ss-dropdown__divider" />;
}
