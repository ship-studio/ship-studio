import {
  Children,
  cloneElement,
  createContext,
  createElement,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type MouseEvent,
  type MouseEventHandler,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronRightIcon } from '@/components/icons';
import { useDropdownNestedMenuRegistration } from './Dropdown';

interface ContextMenuPosition {
  align?: 'left' | 'right';
  x: number;
  y: number;
}

interface ContextMenuState {
  close: (immediate?: boolean) => void;
  openAt: (position: ContextMenuPosition) => void;
  position: ContextMenuPosition | null;
  isOpen: boolean;
  submenu: { id: string; x: number; y: number; left: number; focusFirst: boolean } | null;
  openSubmenu: (
    id: string,
    position: { x: number; y: number; left: number },
    focusFirst?: boolean
  ) => void;
  closeSubmenu: (id?: string) => void;
  scheduleCloseSubmenu: (id: string) => void;
  cancelCloseSubmenu: () => void;
}

const ContextMenuContext = createContext<ContextMenuState | null>(null);

let activeContextMenu: { id: string; close: (immediate?: boolean) => void } | null = null;

const EDGE_GUTTER = 8;
const CONTEXT_MENU_EXIT_DURATION_MS = 150;
const SUBMENU_CLOSE_DELAY_MS = 120;

function useContextMenuContext(component: string): ContextMenuState {
  const context = useContext(ContextMenuContext);
  if (!context) {
    throw new Error(`${component} must be used inside ContextMenu`);
  }
  return context;
}

function clampPosition(value: number, size: number, viewportSize: number): number {
  return Math.max(EDGE_GUTTER, Math.min(value, viewportSize - size - EDGE_GUTTER));
}

export interface ContextMenuProps {
  children: ReactNode;
}

/** Native Ship Studio context-menu state and dismissal behavior. */
export function ContextMenu({ children }: ContextMenuProps) {
  const id = useId();
  const [menu, setMenu] = useState<{ position: ContextMenuPosition; isOpen: boolean } | null>(null);
  const [submenu, setSubmenu] = useState<ContextMenuState['submenu']>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const submenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const position = menu?.position ?? null;
  const isOpen = menu?.isOpen ?? false;

  const cancelCloseSubmenu = useCallback(() => {
    if (submenuCloseTimerRef.current !== null) {
      clearTimeout(submenuCloseTimerRef.current);
      submenuCloseTimerRef.current = null;
    }
  }, []);

  const openSubmenu = useCallback(
    (submenuId: string, anchor: { x: number; y: number; left: number }, focusFirst = false) => {
      cancelCloseSubmenu();
      setSubmenu({ id: submenuId, ...anchor, focusFirst });
    },
    [cancelCloseSubmenu]
  );

  const closeSubmenu = useCallback(
    (submenuId?: string) => {
      cancelCloseSubmenu();
      setSubmenu((current) => (submenuId && current?.id !== submenuId ? current : null));
    },
    [cancelCloseSubmenu]
  );

  const scheduleCloseSubmenu = useCallback(
    (submenuId: string) => {
      cancelCloseSubmenu();
      submenuCloseTimerRef.current = setTimeout(() => {
        setSubmenu((current) => (current?.id === submenuId ? null : current));
        submenuCloseTimerRef.current = null;
      }, SUBMENU_CLOSE_DELAY_MS);
    },
    [cancelCloseSubmenu]
  );

  const close = useCallback(
    (immediate = false) => {
      closeSubmenu();
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }

      if (immediate) {
        setMenu(null);
      } else if (menu) {
        setMenu((current) => (current ? { ...current, isOpen: false } : current));
        closeTimerRef.current = setTimeout(() => {
          setMenu(null);
          closeTimerRef.current = null;
        }, CONTEXT_MENU_EXIT_DURATION_MS);
      }

      if (activeContextMenu?.id === id) activeContextMenu = null;
    },
    [closeSubmenu, id, menu]
  );

  const openAt = useCallback(
    (nextPosition: ContextMenuPosition) => {
      activeContextMenu?.close(true);
      closeSubmenu();
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      activeContextMenu = { id, close };
      setMenu({ position: nextPosition, isOpen: true });
    },
    [close, closeSubmenu, id]
  );

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
      if (submenuCloseTimerRef.current !== null) clearTimeout(submenuCloseTimerRef.current);
      if (activeContextMenu?.id === id) activeContextMenu = null;
    },
    [id]
  );

  useEffect(() => {
    if (!isOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('[data-context-menu-content], [data-context-menu-trigger]')
      )
        return;
      close();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [close, isOpen]);

  return (
    <ContextMenuContext.Provider
      value={{
        close,
        openAt,
        position,
        isOpen,
        submenu,
        openSubmenu,
        closeSubmenu,
        scheduleCloseSubmenu,
        cancelCloseSubmenu,
      }}
    >
      {children}
    </ContextMenuContext.Provider>
  );
}

interface ContextMenuTriggerProps extends HTMLAttributes<HTMLElement> {
  asChild?: boolean;
  children: ReactElement;
  openOnClick?: boolean;
  onContextMenu?: MouseEventHandler<HTMLElement>;
}

/** Attaches the context-menu gesture to the child without adding a wrapper node. */
export function ContextMenuTrigger({
  asChild = false,
  children,
  openOnClick = false,
  onClick,
  onContextMenu,
  ...props
}: ContextMenuTriggerProps) {
  const { openAt } = useContextMenuContext('ContextMenuTrigger');

  const openFromClick = (event: MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented || !openOnClick) return;
    const rect = event.currentTarget.getBoundingClientRect();
    openAt({ align: 'right', x: rect.right, y: rect.bottom });
  };

  const handleContextMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onContextMenu?.(event);
    openAt({ x: event.clientX, y: event.clientY });
  };

  if (asChild) {
    type TriggerChildProps = {
      onClick?: MouseEventHandler<HTMLElement>;
      onContextMenu?: MouseEventHandler<HTMLElement>;
      [key: string]: unknown;
    };
    const child = Children.only(children) as ReactElement<TriggerChildProps>;
    if (!isValidElement(child)) {
      throw new Error('ContextMenuTrigger with asChild requires a valid React element');
    }
    const childOnContextMenu = child.props.onContextMenu;
    const childOnClick = child.props.onClick;
    return cloneElement(child, {
      ...props,
      'data-context-menu-trigger': true,
      onClick: (event: MouseEvent<HTMLElement>) => {
        childOnClick?.(event);
        onClick?.(event);
        openFromClick(event);
      },
      onContextMenu: (event: MouseEvent<HTMLElement>) => {
        childOnContextMenu?.(event);
        handleContextMenu(event);
      },
    });
  }

  return createElement(
    'div',
    {
      ...props,
      'data-context-menu-trigger': true,
      onClick: (event: MouseEvent<HTMLElement>) => {
        onClick?.(event);
        openFromClick(event);
      },
      onContextMenu: handleContextMenu,
    },
    children
  );
}

export interface ContextMenuContentProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

/** Portaled menu surface with keyboard navigation and viewport-aware placement. */
export function ContextMenuContent({
  children,
  className,
  style,
  ...props
}: ContextMenuContentProps) {
  const { close, isOpen, position } = useContextMenuContext('ContextMenuContent');
  const menuRef = useRef<HTMLDivElement>(null);
  const registerNestedMenu = useDropdownNestedMenuRegistration();
  const [menuPosition, setMenuPosition] = useState<ContextMenuPosition | null>(null);

  useEffect(() => {
    if (!position || !registerNestedMenu || !menuRef.current) return;
    return registerNestedMenu(menuRef);
  }, [position, registerNestedMenu]);

  const reposition = useCallback(() => {
    if (!position || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const x = position.align === 'right' ? position.x - rect.width : position.x;
    setMenuPosition({
      x: clampPosition(x, rect.width, window.innerWidth),
      y: clampPosition(position.y, rect.height, window.innerHeight),
    });
  }, [position]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    reposition();
  }, [isOpen, reposition]);

  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener('resize', reposition);
    return () => window.removeEventListener('resize', reposition);
  }, [isOpen, reposition]);

  useEffect(() => {
    if (!isOpen) return;
    menuRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')
      ?.focus();
  }, [isOpen]);

  if (!position) return null;

  const menuItems = () =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([aria-disabled="true"])'
      ) ?? []
    );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }

    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = menuItems();
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  const positionStyle: CSSProperties = {
    left: menuPosition?.x ?? position.x,
    top: menuPosition?.y ?? position.y,
  };

  return createPortal(
    <div
      {...props}
      ref={menuRef}
      className={['ss-context-menu', className].filter(Boolean).join(' ')}
      data-context-menu-content
      data-state={isOpen ? 'open' : 'closed'}
      role="menu"
      style={{ ...positionStyle, ...style }}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>,
    document.body
  );
}

export interface ContextMenuItemProps extends Omit<HTMLAttributes<HTMLButtonElement>, 'onSelect'> {
  children: ReactNode;
  disabled?: boolean;
  inset?: boolean;
  onSelect?: () => void;
  variant?: 'default' | 'destructive';
}

export function ContextMenuItem({
  children,
  className,
  disabled = false,
  inset = false,
  onClick,
  onSelect,
  variant = 'default',
  ...props
}: ContextMenuItemProps) {
  const { close } = useContextMenuContext('ContextMenuItem');

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (disabled) return;
    onClick?.(event);
    if (event.defaultPrevented) return;
    onSelect?.();
    close();
  };

  return (
    <button
      {...props}
      type="button"
      role="menuitem"
      aria-disabled={disabled || undefined}
      className={[
        'ss-context-menu__item',
        variant === 'destructive' ? 'is-destructive' : '',
        inset ? 'is-inset' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      disabled={disabled}
      onClick={handleClick}
      tabIndex={-1}
    >
      {children}
    </button>
  );
}

export function ContextMenuSeparator({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={['ss-context-menu__separator', className].filter(Boolean).join(' ')}
      role="separator"
    />
  );
}

export function ContextMenuGroup({ children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props}>{children}</div>;
}

export function ContextMenuLabel({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={['ss-context-menu__label', className].filter(Boolean).join(' ')}>
      {children}
    </div>
  );
}

export function ContextMenuShortcut({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span {...props} className={['ss-context-menu__shortcut', className].filter(Boolean).join(' ')}>
      {children}
    </span>
  );
}

/** Hoverable, keyboard-accessible side menu that shares its parent context menu layer. */
export function ContextMenuSubmenu({
  label,
  icon,
  children,
  disabled = false,
}: {
  label: string;
  icon?: ReactNode;
  children: ReactNode;
  disabled?: boolean;
}) {
  const { submenu, openSubmenu, closeSubmenu, scheduleCloseSubmenu, cancelCloseSubmenu } =
    useContextMenuContext('ContextMenuSubmenu');
  const registerNestedMenu = useDropdownNestedMenuRegistration();
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isOpen = submenu?.id === id;
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);

  const open = (focusFirst = false) => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    openSubmenu(id, { x: rect.right, y: rect.top, left: rect.left }, focusFirst);
  };

  const reposition = useCallback(() => {
    if (!isOpen || !submenu || !contentRef.current) return;
    const rect = contentRef.current.getBoundingClientRect();
    const right = submenu.x + 6;
    const left =
      right + rect.width <= window.innerWidth - EDGE_GUTTER ? right : submenu.left - rect.width - 6;
    setMenuPosition({
      x: clampPosition(left, rect.width, window.innerWidth),
      y: clampPosition(submenu.y, rect.height, window.innerHeight),
    });
  }, [isOpen, submenu]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    reposition();
    if (submenu?.focusFirst) {
      contentRef.current
        ?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')
        ?.focus({ preventScroll: true });
    }
  }, [isOpen, reposition, submenu?.focusFirst]);

  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener('resize', reposition);
    return () => window.removeEventListener('resize', reposition);
  }, [isOpen, reposition]);

  useEffect(() => {
    if (!isOpen || !registerNestedMenu || !contentRef.current) return;
    return registerNestedMenu(contentRef);
  }, [isOpen, registerNestedMenu]);

  const scheduleCloseUnlessKeyboardFocused = () => {
    if (contentRef.current?.contains(document.activeElement)) return;
    scheduleCloseSubmenu(id);
  };

  const getItems = () =>
    Array.from(
      contentRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([aria-disabled="true"])'
      ) ?? []
    );

  const handleSubmenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' || event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      closeSubmenu(id);
      triggerRef.current?.focus({ preventScroll: true });
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const item = target.closest<HTMLElement>('[role="menuitem"]');
      if (!item || item.getAttribute('aria-disabled') === 'true') return;
      event.preventDefault();
      event.stopPropagation();
      item.click();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = getItems();
    if (items.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        className="ss-context-menu__item ss-context-menu__submenu-trigger"
        disabled={disabled}
        aria-disabled={disabled || undefined}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={`${id}-menu`}
        onMouseEnter={() => !disabled && open()}
        onMouseLeave={scheduleCloseUnlessKeyboardFocused}
        onClick={(event) => (isOpen ? closeSubmenu(id) : open(event.detail === 0))}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowRight' || disabled) return;
          event.preventDefault();
          event.stopPropagation();
          open(true);
        }}
      >
        {icon}
        <span>{label}</span>
        <ChevronRightIcon size={14} aria-hidden="true" />
      </button>
      {isOpen &&
        submenu &&
        createPortal(
          <div
            id={`${id}-menu`}
            ref={contentRef}
            className="ss-context-menu ss-context-menu__submenu"
            data-context-menu-content
            data-state="open"
            role="menu"
            aria-label={`${label} destinations`}
            tabIndex={-1}
            style={{
              left: menuPosition?.x ?? submenu.x,
              top: menuPosition?.y ?? submenu.y,
            }}
            onMouseEnter={cancelCloseSubmenu}
            onMouseLeave={scheduleCloseUnlessKeyboardFocused}
            onKeyDown={handleSubmenuKeyDown}
          >
            {children}
          </div>,
          document.body
        )}
    </>
  );
}
