import { createPortal } from 'react-dom';
import {
  createContext,
  useId,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { CloseIcon } from '@/components/icons';
import { IconButton } from './IconButton';

interface ModalFrameBaseProps {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  /** If false, disables overlay click + ESC dismissal (for in-flight destructive ops). */
  dismissable?: boolean;
  /** Optional class appended to the content container for width/tone overrides. */
  className?: string;
  /** Render a close "×" in the header. Ignored when no title is provided. */
  showCloseButton?: boolean;
  /** Focus this element when the dialog opens, before falling back to autoFocus/first control. */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export type ModalFrameProps = ModalFrameBaseProps &
  (
    | {
        /** Rendered title used as the dialog's accessible name. */
        title: ReactNode;
        ariaLabel?: string;
      }
    | {
        title?: never;
        /** Required when the dialog has no rendered title. */
        ariaLabel: string;
      }
  );

interface ModalRegistration {
  id: string;
  depth: number;
  overlayRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
}

interface BackgroundState {
  wasInert: boolean;
  previousMarker: string | null;
}

interface ScrollLockState {
  overflow: string;
  paddingRight: string;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const modalStack: ModalRegistration[] = [];
const ModalFrameDepthContext = createContext(0);
const backgroundStates = new Map<HTMLElement, BackgroundState>();
let modalRoot: HTMLDivElement | null = null;
let scrollLockState: ScrollLockState | null = null;

function isTopmost(id: string): boolean {
  return modalStack[modalStack.length - 1]?.id === id;
}

function ensureModalRoot(): HTMLDivElement | null {
  if (typeof document === 'undefined') return null;
  if (modalRoot?.isConnected) return modalRoot;

  const existing = document.querySelector<HTMLDivElement>('[data-modal-root]');
  if (existing) {
    modalRoot = existing;
    return existing;
  }

  modalRoot = document.createElement('div');
  modalRoot.dataset.modalRoot = 'true';
  document.body.appendChild(modalRoot);
  return modalRoot;
}

function lockBodyScroll() {
  if (scrollLockState || typeof document === 'undefined') return;
  const { body, documentElement } = document;
  const scrollbarWidth = documentElement.clientWidth
    ? Math.max(0, window.innerWidth - documentElement.clientWidth)
    : 0;

  scrollLockState = {
    overflow: body.style.overflow,
    paddingRight: body.style.paddingRight,
  };
  body.style.overflow = 'hidden';
  if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;
}

function unlockBodyScroll() {
  if (!scrollLockState || typeof document === 'undefined') return;
  document.body.style.overflow = scrollLockState.overflow;
  document.body.style.paddingRight = scrollLockState.paddingRight;
  scrollLockState = null;
}

function syncModalEnvironment() {
  if (typeof document === 'undefined') return;
  const root = ensureModalRoot();
  const hasOpenModal = modalStack.length > 0;

  if (hasOpenModal) {
    lockBodyScroll();
    for (const child of Array.from(document.body.children)) {
      if (child === root || child.hasAttribute('data-modal-root')) continue;
      const element = child as HTMLElement;
      if (!backgroundStates.has(element)) {
        backgroundStates.set(element, {
          wasInert: element.hasAttribute('inert'),
          previousMarker: element.getAttribute('data-modal-background-inert'),
        });
      }
      element.setAttribute('inert', '');
      element.setAttribute('data-modal-background-inert', 'true');
    }
  } else {
    for (const [element, state] of backgroundStates) {
      if (!element.isConnected) continue;
      if (state.wasInert) element.setAttribute('inert', '');
      else element.removeAttribute('inert');
      if (state.previousMarker === null) {
        element.removeAttribute('data-modal-background-inert');
      } else {
        element.setAttribute('data-modal-background-inert', state.previousMarker);
      }
    }
    backgroundStates.clear();
    unlockBodyScroll();
  }

  const topmostId = modalStack[modalStack.length - 1]?.id;
  modalStack.forEach((entry, index) => {
    const inactive = entry.id !== topmostId;
    const overlay = entry.overlayRef.current;
    const content = entry.contentRef.current;

    if (overlay) {
      overlay.dataset.modalStackIndex = String(index);
      overlay.dataset.modalInactive = inactive ? 'true' : 'false';
      if (inactive) overlay.setAttribute('inert', '');
      else overlay.removeAttribute('inert');
    }

    if (content) {
      content.setAttribute('aria-modal', inactive ? 'false' : 'true');
      if (inactive) content.setAttribute('aria-hidden', 'true');
      else content.removeAttribute('aria-hidden');
    }
  });
}

function registerModal(entry: ModalRegistration): () => void {
  const existingIndex = modalStack.findIndex((current) => current.id === entry.id);
  if (existingIndex >= 0) modalStack.splice(existingIndex, 1);
  const insertionIndex = modalStack.findIndex((current) => current.depth > entry.depth);
  if (insertionIndex >= 0) modalStack.splice(insertionIndex, 0, entry);
  else modalStack.push(entry);
  syncModalEnvironment();

  return () => {
    const index = modalStack.findIndex((current) => current.id === entry.id);
    if (index >= 0) modalStack.splice(index, 1);
    syncModalEnvironment();
  };
}

function isFocusable(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  if (element.hidden || element.hasAttribute('disabled')) return false;
  if (element.getAttribute('aria-hidden') === 'true') return false;
  if (element.closest('[inert]')) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    isFocusable
  );
}

function focusElement(element: HTMLElement | null) {
  if (!element || !isFocusable(element)) return false;
  element.focus({ preventScroll: true });
  return true;
}

function focusInitialElement(
  content: HTMLDivElement,
  initialFocusRef: RefObject<HTMLElement | null>
) {
  const requested = initialFocusRef.current;
  const autoFocus = content.querySelector<HTMLElement>('[autofocus]');
  const firstFocusable = getFocusableElements(content)[0] ?? null;
  if (focusElement(requested) || focusElement(autoFocus) || focusElement(firstFocusable)) return;
  content.focus({ preventScroll: true });
}

function restoreFocus(previous: HTMLElement | null, nextModal: ModalRegistration | undefined) {
  if (focusElement(previous)) return;
  const nextContent = nextModal?.contentRef.current;
  if (nextContent) {
    const nextFocusable = getFocusableElements(nextContent)[0] ?? null;
    if (focusElement(nextFocusable)) return;
    nextContent.focus({ preventScroll: true });
    return;
  }

  const fallback = typeof document === 'undefined' ? null : getFocusableElements(document.body)[0];
  focusElement(fallback);
}

export function ModalFrame({
  isOpen,
  onClose,
  title,
  children,
  dismissable = true,
  className,
  showCloseButton = true,
  ariaLabel,
  initialFocusRef,
}: ModalFrameProps) {
  const parentDepth = useContext(ModalFrameDepthContext);
  const modalId = useId();
  const titleId = useId();
  const modalDepth = parentDepth + 1;
  // The host is created idempotently before the portal is rendered so the
  // registration/focus effects run on the same commit as the dialog mount.
  const [portalRoot] = useState<HTMLDivElement | null>(() => ensureModalRoot());
  const overlayRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const pressBeganOnOverlay = useRef(false);
  const onCloseRef = useRef(onClose);
  const dismissableRef = useRef(dismissable);

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
    dismissableRef.current = dismissable;
  }, [dismissable, onClose]);

  useLayoutEffect(() => {
    if (!isOpen || !portalRoot || !overlayRef.current || !contentRef.current) return;

    const activeElement = document.activeElement;
    previousFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    const unregister = registerModal({
      id: modalId,
      depth: modalDepth,
      overlayRef,
      contentRef,
    });
    if (isTopmost(modalId)) {
      focusInitialElement(contentRef.current, initialFocusRef ?? { current: null });
    }

    return () => {
      const wasTopmost = isTopmost(modalId);
      unregister();
      if (wasTopmost) {
        restoreFocus(previousFocusRef.current, modalStack[modalStack.length - 1]);
      }
    };
  }, [initialFocusRef, isOpen, modalDepth, modalId, portalRoot]);

  useLayoutEffect(() => {
    if (!isOpen || !portalRoot || !contentRef.current) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopmost(modalId)) return;

      if (event.key === 'Escape') {
        if (dismissableRef.current) {
          event.preventDefault();
          event.stopPropagation();
          onCloseRef.current();
        }
        return;
      }

      if (event.key !== 'Tab') return;
      const focusable = getFocusableElements(contentRef.current!);
      if (focusable.length === 0) {
        event.preventDefault();
        contentRef.current!.focus({ preventScroll: true });
        return;
      }

      const active = document.activeElement as HTMLElement | null;
      const currentIndex = active ? focusable.indexOf(active) : -1;
      const nextIndex = event.shiftKey
        ? currentIndex <= 0
          ? focusable.length - 1
          : currentIndex - 1
        : currentIndex === focusable.length - 1
          ? 0
          : currentIndex + 1;

      if (currentIndex < 0 || nextIndex !== currentIndex + (event.shiftKey ? -1 : 1)) {
        event.preventDefault();
        focusable[nextIndex]?.focus({ preventScroll: true });
      }
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (!isTopmost(modalId)) return;
      const target = event.target;
      if (target instanceof Node && contentRef.current!.contains(target)) return;
      focusInitialElement(contentRef.current!, initialFocusRef ?? { current: null });
    };

    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('focusin', handleFocusIn, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('focusin', handleFocusIn, true);
    };
  }, [initialFocusRef, isOpen, modalId, portalRoot]);

  if (!isOpen || !portalRoot) return null;

  const hasTitle = title !== undefined && title !== null;
  const dialog = (
    <div
      ref={overlayRef}
      className="modal-frame-overlay"
      data-modal-id={modalId}
      onMouseDown={(event: MouseEvent) => {
        pressBeganOnOverlay.current = isTopmost(modalId) && event.target === event.currentTarget;
      }}
      onClick={(event: MouseEvent) => {
        if (
          dismissableRef.current &&
          isTopmost(modalId) &&
          pressBeganOnOverlay.current &&
          event.target === event.currentTarget
        ) {
          onCloseRef.current();
        }
        pressBeganOnOverlay.current = false;
      }}
    >
      <div
        ref={contentRef}
        className={`modal-frame-content${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={!ariaLabel && hasTitle ? titleId : undefined}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        {hasTitle && (
          <div className="modal-frame-header">
            <div id={titleId} className="modal-frame-title">
              {title}
            </div>
            {showCloseButton && (
              <IconButton
                variant="ghost"
                size="compact"
                onClick={() => onCloseRef.current()}
                title="Close dialog"
                aria-label="Close dialog"
                icon={<CloseIcon size={16} />}
              />
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );

  return (
    <ModalFrameDepthContext.Provider value={modalDepth}>
      {createPortal(dialog, portalRoot)}
    </ModalFrameDepthContext.Provider>
  );
}
