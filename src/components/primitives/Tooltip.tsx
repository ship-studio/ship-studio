import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

const TOOLTIP_ID = 'ss-tooltip';
const TOOLTIP_OFFSET = 8;
const TOOLTIP_MARGIN = 8;
const TOOLTIP_DEFAULT_DELAY_MS = 1000;
/** Window after hiding one tooltip during which the next anchor shows instantly. */
const TOOLTIP_CHAIN_MS = 250;
/** Matches --duration-standard (the exit transition) plus a small buffer. */
const TOOLTIP_EXIT_MS = 200;
const richTooltipContent = new Map<string, ReactNode>();

type TooltipPlacement = 'above' | 'below';

interface TooltipProps {
  /** Content shown when the trigger is hovered or focused. */
  content: ReactNode;
  /** Optional delay override for contexts that need a faster tooltip. */
  delayMs?: number;
  /** One DOM element. The shared data attribute is applied to that element. */
  children: ReactElement;
}

/**
 * Mark one element for the app-wide tooltip surface. Keeping the trigger as the
 * original element means this works for buttons, SVG groups, and compact labels
 * without adding a layout wrapper.
 */
export function Tooltip({ content, delayMs, children }: TooltipProps) {
  const contentId = useId();
  const isRichContent = typeof content !== 'string' && typeof content !== 'number';
  const textContent = tooltipText(content);

  useLayoutEffect(() => {
    if (!isRichContent) return;
    richTooltipContent.set(contentId, content);
    return () => {
      richTooltipContent.delete(contentId);
    };
  }, [content, contentId, isRichContent]);

  return cloneElement(children as ReactElement<Record<string, unknown>>, {
    'data-tooltip-content': textContent,
    'data-tooltip-content-id': isRichContent ? contentId : undefined,
    'data-tooltip-delay': delayMs,
    'aria-describedby': TOOLTIP_ID,
    title: undefined,
  });
}

function tooltipText(content: ReactNode): string {
  if (typeof content === 'string' || typeof content === 'number') return String(content);
  if (Array.isArray(content)) return content.map(tooltipText).join('');
  if (isValidElement<{ children?: ReactNode }>(content)) return tooltipText(content.props.children);
  return '';
}

interface TooltipPosition {
  top: number;
  left: number;
}

interface TooltipState {
  content: ReactNode;
  text: string;
}

interface TooltipContent {
  content: ReactNode;
  text: string;
}

function tooltipAnchor(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  if (target.closest('[data-tooltip-disabled]')) return null;
  const anchor = target.closest('[data-tooltip-content], [title]');
  return anchor?.closest(`#${TOOLTIP_ID}`) ? null : anchor;
}

function readTooltipContent(anchor: Element): TooltipContent | null {
  if (anchor.closest('[data-tooltip-disabled]')) {
    // This also prevents the browser's native title tooltip when an element
    // opts out of the shared React tooltip surface.
    anchor.removeAttribute('title');
    return null;
  }

  const explicit = anchor.getAttribute('data-tooltip-content');
  const title = anchor.getAttribute('title');
  // A promoted title that React has since changed ("Copy" → "Copied", a
  // label that loads late) is the new text, not a stale duplicate.
  if (explicit && title && title !== explicit && anchor.hasAttribute('data-tooltip-promoted')) {
    anchor.setAttribute('data-tooltip-content', title);
    anchor.removeAttribute('title');
    return { content: title, text: title };
  }
  if (explicit) {
    // React can restore a title attribute during a rerender after the custom
    // tooltip has already claimed this anchor. Always remove it, even when
    // the shared content attribute is already present.
    if (title) anchor.removeAttribute('title');
    const contentId = anchor.getAttribute('data-tooltip-content-id');
    return {
      text: explicit,
      content: (contentId && richTooltipContent.get(contentId)) ?? explicit,
    };
  }
  if (!title) return null;

  // Promote native title tooltips to the shared surface for every existing
  // title-based affordance. Removing the attribute prevents the OS tooltip from
  // competing with the app tooltip on the same hover.
  anchor.setAttribute('data-tooltip-content', title);
  anchor.setAttribute('data-tooltip-promoted', '');
  anchor.setAttribute('aria-describedby', TOOLTIP_ID);
  anchor.removeAttribute('title');
  return { content: title, text: title };
}

function readTooltipDelay(anchor: Element): number {
  const rawDelay = anchor.getAttribute('data-tooltip-delay');
  if (!rawDelay) return TOOLTIP_DEFAULT_DELAY_MS;

  const delay = Number(rawDelay);
  return Number.isFinite(delay) && delay >= 0 ? delay : TOOLTIP_DEFAULT_DELAY_MS;
}

function promoteTitleAttributes(root: Element) {
  const anchors = [...(root.matches('[title]') ? [root] : []), ...root.querySelectorAll('[title]')];

  anchors.forEach((anchor) => {
    readTooltipContent(anchor);
  });
}

function samePosition(a: TooltipPosition | null, b: TooltipPosition) {
  return a?.top === b.top && a.left === b.left;
}

/**
 * App-level tooltip host. Existing `title` attributes are promoted to the
 * shared surface as soon as they enter the DOM, while new components can use
 * `<Tooltip content="…">` explicitly. A short delay prevents tooltips from
 * flashing during quick pointer passes.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TooltipState | null>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const [placement, setPlacement] = useState<TooltipPlacement>('below');
  const [shown, setShown] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<Element | null>(null);
  const pendingAnchorRef = useRef<Element | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const exitTimerRef = useRef<number | null>(null);
  const lastHiddenAtRef = useRef(0);

  useLayoutEffect(() => {
    promoteTitleAttributes(document.body);

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.target instanceof Element) {
          const content = readTooltipContent(mutation.target);
          if (
            mutation.attributeName === 'data-tooltip-content' &&
            mutation.target === anchorRef.current
          ) {
            setState(content ? { content: content.content, text: content.text } : null);
          }
          return;
        }

        mutation.addedNodes.forEach((node) => {
          if (node instanceof Element) promoteTitleAttributes(node);
        });
      });
    });

    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['title', 'data-tooltip-content'],
    });

    return () => observer.disconnect();
  }, []);

  const updatePosition = useCallback((): boolean => {
    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    if (!anchor || !popover) return false;
    // An anchor that left the DOM (a click that swapped the view) measures as
    // 0,0, which would park the tooltip in the window's top-left corner under
    // the traffic lights. Report it so the caller hides instead.
    if (!anchor.isConnected) return false;

    const anchorRect = anchor.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const belowTop = anchorRect.bottom + TOOLTIP_OFFSET;
    const aboveTop = anchorRect.top - TOOLTIP_OFFSET - popoverRect.height;
    const useBelow =
      belowTop + popoverRect.height <= window.innerHeight || aboveTop < TOOLTIP_MARGIN;
    const top = useBelow ? belowTop : aboveTop;
    const nextPlacement: TooltipPlacement = useBelow ? 'below' : 'above';
    setPlacement((current) => (current === nextPlacement ? current : nextPlacement));
    const left = Math.max(
      TOOLTIP_MARGIN,
      Math.min(
        anchorRect.left + (anchorRect.width - popoverRect.width) / 2,
        window.innerWidth - popoverRect.width - TOOLTIP_MARGIN
      )
    );
    const next = { top: Math.max(TOOLTIP_MARGIN, top), left };
    setPosition((current) => (samePosition(current, next) ? current : next));
    return true;
  }, []);

  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    pendingAnchorRef.current = null;
  }, []);

  const show = useCallback(
    (anchor: Element | null) => {
      clearShowTimer();
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      if (!anchor) return;
      const content = readTooltipContent(anchor);
      if (!content) return;

      pendingAnchorRef.current = anchor;
      // Moving straight from one tooltip anchor to another skips the delay so
      // chained hovers feel instant instead of re-waiting the full delay.
      const chained = Date.now() - lastHiddenAtRef.current < TOOLTIP_CHAIN_MS;
      showTimerRef.current = window.setTimeout(
        () => {
          if (pendingAnchorRef.current !== anchor) return;
          pendingAnchorRef.current = null;
          showTimerRef.current = null;
          if (!anchor.isConnected) return;
          const currentContent = readTooltipContent(anchor);
          if (!currentContent) return;
          anchorRef.current = anchor;
          setPosition(null);
          setShown(false);
          setState({ content: currentContent.content, text: currentContent.text });
        },
        chained ? 0 : readTooltipDelay(anchor)
      );
    },
    [clearShowTimer]
  );

  const hide = useCallback(() => {
    clearShowTimer();
    anchorRef.current = null;
    lastHiddenAtRef.current = Date.now();
    // Keep the surface mounted briefly so it can animate out toward its anchor.
    setShown(false);
    exitTimerRef.current = window.setTimeout(() => {
      exitTimerRef.current = null;
      setState(null);
      setPosition(null);
    }, TOOLTIP_EXIT_MS);
  }, [clearShowTimer]);

  useEffect(() => {
    const onPointerOver = (event: PointerEvent) => {
      const anchor = tooltipAnchor(event.target);
      if (anchor === anchorRef.current) return;
      show(anchor);
    };
    const onPointerOut = (event: PointerEvent) => {
      const anchor = anchorRef.current ?? pendingAnchorRef.current;
      if (!anchor) return;
      const related = event.relatedTarget;
      if (related instanceof Node && anchor.contains(related)) return;
      if (tooltipAnchor(related) === anchor) return;
      hide();
    };
    const onFocusIn = (event: FocusEvent) => show(tooltipAnchor(event.target));
    const onFocusOut = (event: FocusEvent) => {
      const anchor = anchorRef.current ?? pendingAnchorRef.current;
      if (
        !anchor ||
        (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget))
      ) {
        return;
      }
      hide();
    };
    const onClick = (event: MouseEvent) => {
      const anchor = tooltipAnchor(event.target);
      if (!anchor || anchor !== anchorRef.current) return;

      window.requestAnimationFrame(() => {
        if (anchorRef.current !== anchor) return;
        if (!anchor.isConnected) {
          hide();
          return;
        }
        const content = readTooltipContent(anchor);
        setState((current) => {
          if (!content) return null;
          return current?.text === content.text && current.content === content.content
            ? current
            : { content: content.content, text: content.text };
        });
      });
    };

    document.addEventListener('pointerover', onPointerOver, true);
    document.addEventListener('pointerout', onPointerOut, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('click', onClick, true);
    return () => {
      clearShowTimer();
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      document.removeEventListener('pointerover', onPointerOver, true);
      document.removeEventListener('pointerout', onPointerOut, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('click', onClick, true);
    };
  }, [clearShowTimer, hide, show]);

  useLayoutEffect(() => {
    if (!state) return;
    const popover = popoverRef.current;
    if (!popover) return;
    const frame = requestAnimationFrame(() => {
      if (!updatePosition()) {
        hide();
        return;
      }
      // Snap to the hidden styles with transitions disabled so a swapped-in
      // tooltip (quick anchor switching) starts its enter animation from the
      // fully hidden state instead of resuming a fade that had just begun.
      popover.style.transition = 'none';
      void popover.offsetHeight;
      popover.style.transition = '';
      setShown(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [state, updatePosition, hide]);

  useEffect(() => {
    if (!state) return;
    const onViewportChange = () => {
      if (!updatePosition()) hide();
    };
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [state, updatePosition, hide]);

  return (
    <>
      {children}
      {state &&
        createPortal(
          <div
            ref={popoverRef}
            id={TOOLTIP_ID}
            className="ss-tooltip"
            role="tooltip"
            data-placement={placement}
            data-shown={shown || undefined}
            style={position ? { top: position.top, left: position.left } : undefined}
          >
            {state.content}
          </div>,
          document.body
        )}
    </>
  );
}
