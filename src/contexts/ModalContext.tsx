import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
  | 'i18n'
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
  | 'commandPalette'
  | 'shopifyStore';

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
  // Mirror of `openSet` for synchronous transition detection. We can't read
  // `openSet` directly from the useCallback below (closure would be stale)
  // and we don't want to rely on functional-updater side effects (timing
  // depends on React 18 internals). Mutating both this ref *and* the state
  // setter keeps the source of truth consistent.
  const openSetRef = useRef<Set<ModalId>>(new Set());
  // Open-timestamps so `modal_closed` can carry a duration. Uses
  // `performance.now()` because it's monotonic — wall-clock changes (NTP,
  // DST) won't yield negative durations.
  const openedAtRef = useRef(new Map<ModalId, number>());

  const isOpen = useCallback((id: ModalId) => openSet.has(id), [openSet]);

  const open = useCallback((id: ModalId) => {
    if (openSetRef.current.has(id)) return;
    const next = new Set(openSetRef.current);
    next.add(id);
    openSetRef.current = next;
    setOpenSet(next);
    if (!MODAL_TRACKING_EXCLUDED.has(id)) {
      openedAtRef.current.set(id, performance.now());
      // Modal id is baked into the event name so PostHog's default events
      // list is self-describing — no column add required to know which
      // modal opened. `modal_id` stays in the payload too for filters.
      void trackEvent(`modal_${id}_opened`, { modal_id: id });
    }
  }, []);

  const close = useCallback((id: ModalId) => {
    if (!openSetRef.current.has(id)) return;
    const next = new Set(openSetRef.current);
    next.delete(id);
    openSetRef.current = next;
    setOpenSet(next);
    // Fire the analytics event *before* user-supplied close callbacks so
    // a slow/throwing callback doesn't inflate `duration_ms` or skip the
    // event entirely.
    if (!MODAL_TRACKING_EXCLUDED.has(id)) {
      const openedAt = openedAtRef.current.get(id);
      openedAtRef.current.delete(id);
      void trackEvent(`modal_${id}_closed`, {
        modal_id: id,
        // Explicit `undefined` check so a value of 0 (impossible in
        // practice with performance.now()) wouldn't be treated as missing.
        duration_ms: openedAt !== undefined ? Math.round(performance.now() - openedAt) : null,
      });
    }
    callbacksRef.current.get(id)?.forEach((fn) => fn());
  }, []);

  // Flush a `modal_closed` for any modals still open when the provider
  // unmounts (app quit, hard reload). Without this, the open event has no
  // close partner and duration is lost.
  useEffect(() => {
    // Snapshot the Map ref at mount-time so the cleanup doesn't read
    // `openedAtRef.current` directly (lint flags ref reads in cleanup).
    // The Map is mutated in place — never reassigned — so the captured
    // reference stays current through the provider's lifetime.
    const openedAtMap = openedAtRef.current;
    return () => {
      for (const id of openSetRef.current) {
        if (MODAL_TRACKING_EXCLUDED.has(id)) continue;
        const openedAt = openedAtMap.get(id);
        void trackEvent(`modal_${id}_closed`, {
          modal_id: id,
          duration_ms: openedAt !== undefined ? Math.round(performance.now() - openedAt) : null,
          reason: 'provider_unmount',
        });
      }
    };
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
