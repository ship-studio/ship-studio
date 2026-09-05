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

interface ContextMenuPosition {
  x: number;
  y: number;
}

interface ContextMenuState {
  close: (immediate?: boolean) => void;
  openAt: (position: ContextMenuPosition) => void;
  position: ContextMenuPosition | null;
  isOpen: boolean;
}

const ContextMenuContext = createContext<ContextMenuState | null>(null);

let activeContextMenu: { id: string; close: (immediate?: boolean) => void } | null = null;

const EDGE_GUTTER = 8;
const CONTEXT_MENU_EXIT_DURATION_MS = 150;

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
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const position = menu?.position ?? null;
  const isOpen = menu?.isOpen ?? false;

  const close = useCallback(
    (immediate = false) => {
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
    [id, menu]
  );

  const openAt = useCallback(
    (nextPosition: ContextMenuPosition) => {
      activeContextMenu?.close(true);
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      activeContextMenu = { id, close };
      setMenu({ position: nextPosition, isOpen: true });
    },
    [close, id]
  );

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
      if (activeContextMenu?.id === id) activeContextMenu = null;
    },
    [id]
  );

  useEffect(() => {
    if (!isOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-context-menu-content]')) return;
      close();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [close, isOpen]);

  return (
    <ContextMenuContext.Provider value={{ close, openAt, position, isOpen }}>
      {children}
    </ContextMenuContext.Provider>
  );
}

interface ContextMenuTriggerProps extends HTMLAttributes<HTMLElement> {
  asChild?: boolean;
  children: ReactElement;
  onContextMenu?: MouseEventHandler<HTMLElement>;
}

/** Attaches the context-menu gesture to the child without adding a wrapper node. */
export function ContextMenuTrigger({
  asChild = false,
  children,
  onContextMenu,
  ...props
}: ContextMenuTriggerProps) {
  const { openAt } = useContextMenuContext('ContextMenuTrigger');

  const handleContextMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onContextMenu?.(event);
    openAt({ x: event.clientX, y: event.clientY });
  };

  if (asChild) {
    type TriggerChildProps = {
      onContextMenu?: MouseEventHandler<HTMLElement>;
      [key: string]: unknown;
    };
    const child = Children.only(children) as ReactElement<TriggerChildProps>;
    if (!isValidElement(child)) {
      throw new Error('ContextMenuTrigger with asChild requires a valid React element');
    }
    const childOnContextMenu = child.props.onContextMenu;
    return cloneElement(child, {
      ...props,
      onContextMenu: (event: MouseEvent<HTMLElement>) => {
        childOnContextMenu?.(event);
        handleContextMenu(event);
      },
    });
  }

  return createElement(
    'div',
    { ...props, 'data-context-menu-trigger': true, onContextMenu: handleContextMenu },
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
  const [menuPosition, setMenuPosition] = useState<ContextMenuPosition | null>(null);

  const reposition = useCallback(() => {
    if (!position || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    setMenuPosition({
      x: clampPosition(position.x, rect.width, window.innerWidth),
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
