import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import { useClickOutside } from '../../hooks/useClickOutside';

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
 *   trigger={(p) => <button className="toolbar-icon-btn" {...p}>•••</button>}
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
  portal = false,
  menuClassName,
  onOpenChange,
}: DropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [portalPos, setPortalPos] = useState<CSSProperties | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const setOpen = useCallback(
    (open: boolean) => {
      setIsOpen(open);
      onOpenChange?.(open);
    },
    [onOpenChange]
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

  useLayoutEffect(() => {
    if (!isOpen) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
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
      setPortalPos(
        align === 'right'
          ? {
              position: 'fixed',
              top: rect.bottom + 6,
              right: window.innerWidth - rect.right,
              left: 'auto',
              marginTop: 0,
            }
          : {
              position: 'fixed',
              top: rect.bottom + 6,
              left: rect.left,
              right: 'auto',
              marginTop: 0,
            }
      );
    };
    anchor();
    window.addEventListener('scroll', anchor, true);
    window.addEventListener('resize', anchor);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('scroll', anchor, true);
      window.removeEventListener('resize', anchor);
    };
  }, [isOpen, portal, align, close]);

  const menu = isOpen ? (
    <div
      className={[
        'ss-dropdown__menu',
        align === 'right' && !portal ? 'ss-dropdown__menu--right' : null,
        menuClassName,
      ]
        .filter(Boolean)
        .join(' ')}
      style={portal ? (portalPos ?? { position: 'fixed', visibility: 'hidden' }) : undefined}
      role="menu"
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
    >
      {icon}
      {children}
    </button>
  );
}

export function DropdownDivider() {
  return <div className="ss-dropdown__divider" />;
}
