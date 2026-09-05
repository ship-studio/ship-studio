import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * Registered modal IDs. Add a string here when introducing a new modal so
 * callers get autocomplete and the context can warn on typos.
 */
export type ModalId =
  | 'envEditor'
  | 'i18n'
  | 'backups'
  | 'assetsPanel'
  | 'help'
  | 'skills'
  | 'mcp'
  | 'pluginManager'
  | 'devCommand'
  | 'projectSettings'
  | 'sidebarProjectSettings'
  | 'sidebarProjectRename'
  | 'notificationSettings'
  | 'settings'
  | 'attachedLibraries'
  | 'changelog'
  | 'submitReview'
  | 'newFolder'
  | 'moveFolder'
  | 'newProject'
  | 'importProject'
  | 'branchSelector'
  | 'unsavedChanges'
  | 'conflictResolution'
  | 'diff'
  | 'quitConfirm'
  | 'commandPalette'
  | 'shopifyStore'
  | 'worktreeCreate';

interface ModalContextValue {
  isOpen: (id: ModalId) => boolean;
  open: (id: ModalId) => void;
  close: (id: ModalId) => void;
  toggle: (id: ModalId) => void;
  /** Register a side-effect callback to fire whenever this modal closes (e.g. focus terminal). */
  registerOnClose: (id: ModalId, fn: () => void) => () => void;
}

const ModalContext = createContext<ModalContextValue | null>(null);

interface ProviderProps {
  children: ReactNode;
}

export function ModalProvider({ children }: ProviderProps) {
  const [openSet, setOpenSet] = useState<Set<ModalId>>(() => new Set());
  const callbacksRef = useRef(new Map<ModalId, Set<() => void>>());
  // Mirror of `openSet` for synchronous transition detection. We can't read
  // `openSet` directly from the useCallback below (closure would be stale)
  // and we don't want to rely on functional-updater side effects (timing
  // depends on React 18 internals). Mutating both this ref *and* the state
  // setter keeps the source of truth consistent.
  const openSetRef = useRef<Set<ModalId>>(new Set());

  const isOpen = useCallback((id: ModalId) => openSet.has(id), [openSet]);

  const open = useCallback((id: ModalId) => {
    if (openSetRef.current.has(id)) return;
    const next = new Set(openSetRef.current);
    next.add(id);
    openSetRef.current = next;
    setOpenSet(next);
  }, []);

  const close = useCallback((id: ModalId) => {
    if (!openSetRef.current.has(id)) return;
    const next = new Set(openSetRef.current);
    next.delete(id);
    openSetRef.current = next;
    setOpenSet(next);
    callbacksRef.current.get(id)?.forEach((fn) => fn());
  }, []);

  const toggle = useCallback(
    (id: ModalId) => {
      if (openSet.has(id)) close(id);
      else open(id);
    },
    [openSet, close, open]
  );

  const registerOnClose = useCallback((id: ModalId, fn: () => void) => {
    let bucket = callbacksRef.current.get(id);
    if (!bucket) {
      bucket = new Set();
      callbacksRef.current.set(id, bucket);
    }
    bucket.add(fn);
    return () => {
      bucket?.delete(fn);
    };
  }, []);

  const value = useMemo<ModalContextValue>(
    () => ({ isOpen, open, close, toggle, registerOnClose }),
    [isOpen, open, close, toggle, registerOnClose]
  );

  return <ModalContext.Provider value={value}>{children}</ModalContext.Provider>;
}

/**
 * Stable `open(id)` accessor — useful when you need to open modals from
 * inside a `useCommands` factory without tripping the deps array (the full
 * `useModal` result is not reference-stable across state changes, this is).
 */
export function useOpenModal(): (id: ModalId) => void {
  const ctx = useContext(ModalContext);
  if (!ctx) throw new Error('useOpenModal must be used inside a <ModalProvider>');
  return ctx.open;
}

/**
 * Per-modal hook. Returns scoped open/close/toggle/isOpen for `id`.
 * Replaces the `useState(false)` triples in `useWorkspaceModals` and the
 * matching `show*`/`open*`/`close*` props passed down through `WorkspaceModals`.
 */
export function useModal(id: ModalId) {
  const ctx = useContext(ModalContext);
  if (!ctx) {
    throw new Error('useModal must be used inside a <ModalProvider>');
  }
  const { isOpen, open, close, toggle, registerOnClose } = ctx;
  return useMemo(
    () => ({
      isOpen: isOpen(id),
      open: () => open(id),
      close: () => close(id),
      toggle: () => toggle(id),
      registerOnClose: (fn: () => void) => registerOnClose(id, fn),
    }),
    [id, isOpen, open, close, toggle, registerOnClose]
  );
}
