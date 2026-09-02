import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button';

type TabValue = string;

export type TabsMode = 'panel' | 'navigation';

interface RegisteredTab {
  element: HTMLButtonElement;
  disabled: boolean;
}

interface TabsContextValue {
  id: string;
  mode: TabsMode;
  value: TabValue;
  select: (value: TabValue) => void;
  size: ButtonSize;
  tabId: (value: TabValue) => string;
  panelId: (value: TabValue) => string;
  registerTab: (value: TabValue, element: HTMLButtonElement | null, disabled: boolean) => void;
  moveFocus: (value: TabValue, direction: 1 | -1) => void;
  moveFocusToEdge: (edge: 'first' | 'last') => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

/** Props for the controlled tabs state shared by tab lists, tabs, and panels. */
export interface TabsProps {
  value?: TabValue;
  defaultValue?: TabValue;
  onValueChange?: (value: TabValue) => void;
  size?: ButtonSize;
  /** Panel tabs link to a TabsPanel; navigation tabs intentionally omit aria-controls. */
  mode?: TabsMode;
  children: ReactNode;
  className?: string;
}

/** Provides controlled tab state and keyboard-navigation registration to descendants. */
export function Tabs({
  value: controlledValue,
  defaultValue,
  onValueChange,
  size = 'compact',
  mode = 'panel',
  children,
  className,
}: TabsProps) {
  const id = useId();
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue ?? '');
  const value = controlledValue ?? uncontrolledValue;
  const tabsRef = useRef(new Map<TabValue, RegisteredTab>());

  const select = useCallback(
    (next: TabValue) => {
      if (controlledValue === undefined) setUncontrolledValue(next);
      onValueChange?.(next);
    },
    [controlledValue, onValueChange]
  );

  const tabId = useCallback((tabValue: TabValue) => `${id}-tab-${encodeTabValue(tabValue)}`, [id]);
  const panelId = useCallback(
    (tabValue: TabValue) => `${id}-panel-${encodeTabValue(tabValue)}`,
    [id]
  );

  const registerTab = useCallback(
    (tabValue: TabValue, element: HTMLButtonElement | null, disabled: boolean) => {
      if (element) tabsRef.current.set(tabValue, { element, disabled });
      else tabsRef.current.delete(tabValue);
    },
    []
  );

  const focusValue = useCallback(
    (next: TabValue) => {
      select(next);
      tabsRef.current.get(next)?.element.focus();
    },
    [select]
  );

  const moveFocus = useCallback(
    (current: TabValue, direction: 1 | -1) => {
      const values = [...tabsRef.current.entries()]
        .filter(([, tab]) => !tab.disabled)
        .map(([tabValue]) => tabValue);
      const index = values.indexOf(current);
      if (values.length === 0) return;
      const nextIndex =
        index < 0
          ? direction === 1
            ? 0
            : values.length - 1
          : (index + direction + values.length) % values.length;
      focusValue(values[nextIndex]);
    },
    [focusValue]
  );

  const moveFocusToEdge = useCallback(
    (edge: 'first' | 'last') => {
      const values = [...tabsRef.current.entries()]
        .filter(([, tab]) => !tab.disabled)
        .map(([tabValue]) => tabValue);
      const next = edge === 'first' ? values[0] : values[values.length - 1];
      if (next) focusValue(next);
    },
    [focusValue]
  );

  const contextValue = useMemo(
    () => ({
      id,
      mode,
      value,
      select,
      size,
      tabId,
      panelId,
      registerTab,
      moveFocus,
      moveFocusToEdge,
    }),
    [id, mode, value, select, size, tabId, panelId, registerTab, moveFocus, moveFocusToEdge]
  );

  return (
    <TabsContext.Provider value={contextValue}>
      <div className={`tabs ${className ?? ''}`}>{children}</div>
    </TabsContext.Provider>
  );
}

function encodeTabValue(value: TabValue): string {
  return (
    Array.from(value)
      .map((character) => character.codePointAt(0)?.toString(16) ?? '0')
      .join('-') || 'empty'
  );
}

/** Props for the labelled container that owns a set of tab controls. */
export interface TabsListProps extends Omit<HTMLAttributes<HTMLDivElement>, 'aria-label'> {
  children: ReactNode;
  variant?: 'default' | 'stretch';
  appearance?: 'segmented' | 'underline';
  'aria-label': string;
}

/** Renders a tab list and coordinates directional keyboard navigation. */
export function TabsList({
  children,
  className,
  variant = 'default',
  appearance = 'segmented',
  ...props
}: TabsListProps) {
  const tabs = useContext(TabsContext);
  const listRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const activeValue = tabs?.value;

  useLayoutEffect(() => {
    if (!tabs || !listRef.current) return;
    const list = listRef.current;
    const measure = () => {
      const active = tabsRefElement(activeValue ?? '', list);
      if (!active) return;
      const listRect = list.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      const borderInset = list.clientLeft;
      setIndicator({
        left: activeRect.left - listRect.left - borderInset,
        top: activeRect.top - listRect.top - borderInset,
        width: activeRect.width,
        height: activeRect.height,
      });
    };

    measure();

    const resizeObserver =
      typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    resizeObserver?.observe(list);
    list
      .querySelectorAll<HTMLButtonElement>('[data-tab-value]')
      .forEach((tab) => resizeObserver?.observe(tab));
    window.addEventListener('resize', measure);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [activeValue, tabs]);

  return (
    <div
      ref={listRef}
      className={`tabs__list tabs__list--${variant} tabs__list--appearance-${appearance} ${className ?? ''}`}
      role="tablist"
      {...props}
    >
      {children}
      <span
        className="tabs__indicator"
        aria-hidden="true"
        style={{
          transform: `translate(${indicator.left}px, ${indicator.top}px)`,
          width: indicator.width,
          height: indicator.height,
        }}
      />
    </div>
  );
}

function tabsRefElement(value: TabValue, list: HTMLDivElement): HTMLButtonElement | null {
  return (
    [...list.querySelectorAll<HTMLButtonElement>('[data-tab-value]')].find(
      (element) => element.dataset.tabValue === value
    ) ?? null
  );
}

/** Props for a single value-bound tab control. */
export interface TabsTabProps extends Omit<ButtonProps, 'children' | 'value' | 'variant' | 'size'> {
  value: TabValue;
  children?: ReactNode;
  size?: ButtonSize;
  variant?: ButtonVariant;
}

/** Renders a button-family tab linked to its corresponding panel. */
export function TabsTab({
  value,
  children,
  variant = 'default',
  className,
  size,
  disabled = false,
  onClick,
  onKeyDown,
  ...props
}: TabsTabProps) {
  const tabs = useContext(TabsContext);
  if (!tabs) throw new Error('TabsTab must be used inside Tabs');
  const active = tabs.value === value;

  return (
    <Button
      {...props}
      variant={variant}
      size={size ?? tabs.size}
      className={`tabs__tab ${active ? 'is-active' : ''} ${className ?? ''}`}
      data-tab-value={value}
      id={tabs.tabId(value)}
      role="tab"
      aria-selected={active}
      aria-controls={tabs.mode === 'panel' ? tabs.panelId(value) : undefined}
      tabIndex={active ? 0 : -1}
      disabled={disabled}
      ref={(element) => tabs.registerTab(value, element, disabled)}
      onClick={(event) => {
        tabs.select(value);
        onClick?.(event);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault();
          tabs.moveFocus(value, 1);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault();
          tabs.moveFocus(value, -1);
        } else if (event.key === 'Home') {
          event.preventDefault();
          tabs.moveFocusToEdge('first');
        } else if (event.key === 'End') {
          event.preventDefault();
          tabs.moveFocusToEdge('last');
        }
      }}
    >
      {children}
    </Button>
  );
}

/** Props for tab content associated with a registered tab value. */
export interface TabsPanelProps extends HTMLAttributes<HTMLDivElement> {
  value: TabValue;
  children?: ReactNode;
  /** Keep stateful content mounted while making inactive content inert. */
  keepMounted?: boolean;
}

/** Renders the active tab panel and hides inactive panel content. */
export function TabsPanel({
  value,
  children,
  className,
  keepMounted = false,
  ...props
}: TabsPanelProps) {
  const tabs = useContext(TabsContext);
  if (!tabs) throw new Error('TabsPanel must be used inside Tabs');
  const active = tabs.value === value;

  return (
    <div
      {...props}
      id={tabs.panelId(value)}
      className={`tabs__panel ${className ?? ''}`}
      role="tabpanel"
      aria-hidden={!active}
      aria-labelledby={tabs.tabId(value)}
      hidden={keepMounted ? undefined : !active}
      inert={keepMounted && !active ? true : undefined}
      data-tabs-keep-mounted={keepMounted ? 'true' : undefined}
    >
      {children}
    </div>
  );
}
