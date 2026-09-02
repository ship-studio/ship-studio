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
  'aria-haspopup': 'menu';
}

interface DropdownProps {
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
}

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
  portal = false,
  menuClassName,
  onOpenChange,
  open: controlledOpen,
}: DropdownProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = controlledOpen ?? internalOpen;
  const [portalPos, setPortalPos] = useState<CSSProperties | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);
  const typeaheadRef = useRef('');
  const typeaheadTimerRef = useRef<number | null>(null);

  const setOpen = useCallback(
    (open: boolean) => {
      if (controlledOpen === undefined) setInternalOpen(open);
      onOpenChange?.(open);
    },
    [controlledOpen, onOpenChange]
  );

  const close = useCallback(() => setOpen(false), [setOpen]);

  const handleTriggerClick = useCallback(
    (e: MouseEvent) => {
      // Triggers often sit inside clickable cards — don't activate the card.
      e.stopPropagation();
      setOpen(!isOpen);
    },
    [isOpen, setOpen]
  );

  // The portaled menu isn't a DOM descendant of the container; exclude it so
  // clicks inside the menu don't count as "outside".
  useClickOutside(containerRef, close, isOpen, portal ? '.ss-dropdown__menu' : undefined);

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
        triggerRef.current?.focus({ preventScroll: true });
      }
      return;
    }

    wasOpenRef.current = true;
    focusEnabledMenuItemAt(0);
  }, [focusEnabledMenuItemAt, isOpen]);

  useEffect(() => {
    return () => {
      if (typeaheadTimerRef.current !== null) {
        window.clearTimeout(typeaheadTimerRef.current);
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
      role="menu"
      tabIndex={-1}
      onKeyDown={handleMenuKeyDown}
    >
      <DropdownContext.Provider value={{ close }}>{children}</DropdownContext.Provider>
    </div>
  ) : null;

  return (
    <div className="ss-dropdown" ref={containerRef}>
      {trigger({
        ref: triggerRef,
        onClick: handleTriggerClick,
        'aria-expanded': isOpen,
        'aria-haspopup': 'menu',
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
