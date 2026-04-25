import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { trackEvent } from '../lib/analytics';

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
  | 'quitConfirm'
  | 'commandPalette';

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

/**
 * Modal IDs whose open/close events are *not* fired centrally. The command
 * palette has its own `palette_opened`/`palette_closed` with richer payload
 * (context, dismissal reason, search query) — duplicating it here would
 * inflate counts.
 */
const MODAL_TRACKING_EXCLUDED: ReadonlySet<ModalId> = new Set(['commandPalette']);

export function ModalProvider({ children }: ProviderProps) {
  const [openSet, setOpenSet] = useState<Set<ModalId>>(() => new Set());
  const callbacksRef = useRef(new Map<ModalId, Set<() => void>>());
  // Open-timestamps so `modal_closed` can carry a duration. Keyed by ID;
  // overwriting on re-open is fine since open and close are paired.
  const openedAtRef = useRef(new Map<ModalId, number>());

  const isOpen = useCallback((id: ModalId) => openSet.has(id), [openSet]);

  const open = useCallback((id: ModalId) => {
    let wasNew = false;
    setOpenSet((prev) => {
      if (prev.has(id)) return prev;
      wasNew = true;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    if (wasNew && !MODAL_TRACKING_EXCLUDED.has(id)) {
      openedAtRef.current.set(id, Date.now());
      void trackEvent('modal_opened', { modal_id: id });
    }
  }, []);

  const close = useCallback((id: ModalId) => {
    let wasOpen = false;
    setOpenSet((prev) => {
      if (!prev.has(id)) return prev;
      wasOpen = true;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    callbacksRef.current.get(id)?.forEach((fn) => fn());
    if (wasOpen && !MODAL_TRACKING_EXCLUDED.has(id)) {
      const openedAt = openedAtRef.current.get(id);
      openedAtRef.current.delete(id);
      void trackEvent('modal_closed', {
        modal_id: id,
        duration_ms: openedAt ? Date.now() - openedAt : null,
      });
    }
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
