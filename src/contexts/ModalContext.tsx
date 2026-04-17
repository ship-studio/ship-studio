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
  | 'backups'
  | 'assetsPanel'
  | 'help'
  | 'skills'
  | 'mcp'
  | 'pluginManager'
  | 'devCommand'
  | 'projectSettings'
  | 'notificationSettings'
  | 'settings'
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
  | 'quitConfirm';

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

  const isOpen = useCallback((id: ModalId) => openSet.has(id), [openSet]);

  const open = useCallback((id: ModalId) => {
    setOpenSet((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const close = useCallback((id: ModalId) => {
    setOpenSet((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
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
