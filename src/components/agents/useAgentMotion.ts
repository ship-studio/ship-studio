/**
 * The small amount of JavaScript Agents mode's motion needs. Everything that
 * can be CSS is CSS (features/agents-motion.css); these hooks only decide
 * *when* something animates, and handle the two things CSS can't: height to
 * and from `auto`, and an element moving because the list order changed.
 *
 * Every hook does nothing under prefers-reduced-motion.
 *
 * @module components/agents/useAgentMotion
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Which items arrived while this chat was open. The ids present when the
 * conversation first loads are the baseline and never animate, so opening or
 * switching to an agent shows its history still; anything after that is new.
 * The chat is keyed by agent, so switching resets the baseline.
 */
export function useArrivals(ids: readonly string[] | undefined): (id: string) => boolean {
  const [baseline, setBaseline] = useState<ReadonlySet<string> | null>(null);
  if (ids && baseline === null) setBaseline(new Set(ids));
  return useCallback((id: string) => baseline !== null && !baseline.has(id), [baseline]);
}

type Phase = 'static' | 'entering' | 'leaving' | 'hidden';

/**
 * Keep something mounted long enough to animate out. `entering` is only true
 * when it appeared after mount (so a chat opened mid-turn shows the indicator
 * still); `leaving` holds it on screen until its exit animation ends.
 */
export function usePresence(visible: boolean) {
  const [phase, setPhase] = useState<Phase>(visible ? 'static' : 'hidden');
  if (visible && (phase === 'hidden' || phase === 'leaving')) setPhase('entering');
  if (!visible && (phase === 'static' || phase === 'entering')) {
    setPhase(prefersReducedMotion() ? 'hidden' : 'leaving');
  }

  // A backstop: if the exit animation never reports (a hidden window, a
  // stylesheet without it), the element still goes.
  useEffect(() => {
    if (phase !== 'leaving') return;
    const timer = window.setTimeout(() => setPhase((p) => (p === 'leaving' ? 'hidden' : p)), 600);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const onExited = useCallback(() => setPhase((p) => (p === 'leaving' ? 'hidden' : p)), []);
  return {
    mounted: phase !== 'hidden',
    entering: phase === 'entering',
    leaving: phase === 'leaving',
    onExited,
  };
}

/**
 * Follow the bottom of a chat while the reader is there.
 *
 * A ResizeObserver on the content keeps the bottom pinned while anything
 * grows or shrinks gradually (the working indicator opening, a thread
 * expanding), which is what turns those height animations into a smooth
 * scroll. A discrete arrival glides there instead with `follow(true)`. While
 * that glide runs, `isGliding()` tells the scroll handler to ignore the
 * intermediate positions, so the chat doesn't decide halfway that the reader
 * scrolled away; any wheel, touch or key from the reader ends it at once.
 */
export function useFollowBottom(
  scrollRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  atBottomRef: RefObject<boolean>
) {
  const glideUntil = useRef(0);

  const follow = useCallback(
    (smooth: boolean) => {
      const el = scrollRef.current;
      if (!el) return;
      const top = el.scrollHeight - el.clientHeight;
      if (smooth && !prefersReducedMotion() && top > el.scrollTop + 1) {
        glideUntil.current = performance.now() + 500;
        el.scrollTo({ top, behavior: 'smooth' });
      } else if (performance.now() >= glideUntil.current) {
        el.scrollTop = el.scrollHeight;
      } else {
        el.scrollTo({ top, behavior: 'smooth' });
      }
    },
    [scrollRef]
  );

  const isGliding = useCallback(() => performance.now() < glideUntil.current, []);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const stop = () => {
      glideUntil.current = 0;
    };
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) follow(false);
    });
    observer.observe(content);
    el.addEventListener('wheel', stop, { passive: true });
    el.addEventListener('touchstart', stop, { passive: true });
    el.addEventListener('keydown', stop);
    return () => {
      observer.disconnect();
      el.removeEventListener('wheel', stop);
      el.removeEventListener('touchstart', stop);
      el.removeEventListener('keydown', stop);
    };
  }, [scrollRef, contentRef, atBottomRef, follow]);

  return { follow, isGliding };
}

/**
 * Open and close an element's height between 0 and its natural size. CSS
 * can't transition to `auto`, so this measures, then lets a CSS transition on
 * the element (height, padding, margin, opacity) do the movement. Returns
 * whether to render it; `ref` goes on the element.
 */
export function useHeightReveal(ref: RefObject<HTMLElement | null>, open: boolean): boolean {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  if (!open && mounted && prefersReducedMotion()) setMounted(false);
  const lastOpen = useRef(open);

  useLayoutEffect(() => {
    const el = ref.current;
    const was = lastOpen.current;
    lastOpen.current = open;
    if (!el || was === open || prefersReducedMotion()) return;

    const collapsed = { height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px' };
    // Start from wherever it is drawn now: fully open, or caught mid-way
    // through the opposite animation. A fresh mount starts from nothing.
    const from = getComputedStyle(el);
    const start =
      was || el.style.height !== ''
        ? {
            height: `${el.getBoundingClientRect().height}px`,
            paddingTop: from.paddingTop,
            paddingBottom: from.paddingBottom,
            marginTop: from.marginTop,
            opacity: from.opacity,
          }
        : { ...collapsed, opacity: '0' };

    el.style.transition = 'none';
    // Natural size, measured with nothing inline.
    Object.assign(el.style, {
      height: '',
      paddingTop: '',
      paddingBottom: '',
      marginTop: '',
      opacity: '',
    });
    const natural = `${el.getBoundingClientRect().height}px`;
    Object.assign(el.style, start);
    void el.offsetHeight;
    el.style.transition = '';

    if (open) {
      Object.assign(el.style, {
        height: natural,
        paddingTop: '',
        paddingBottom: '',
        marginTop: '',
        opacity: '',
      });
    } else {
      Object.assign(el.style, collapsed, { opacity: '0' });
    }

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (open) el.style.height = '';
      else setMounted(false);
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target === el && event.propertyName === 'height') finish();
    };
    el.addEventListener('transitionend', onEnd);
    const timer = window.setTimeout(finish, 700);
    return () => {
      el.removeEventListener('transitionend', onEnd);
      window.clearTimeout(timer);
    };
  }, [ref, open]);

  return mounted || open;
}

/**
 * Animate a list's rows to their new places when its order changes (FLIP):
 * measure where each row was, let React move it, then start it from the old
 * place and let the row's CSS transform transition carry it home.
 */
export function useFlipReorder(
  containerRef: RefObject<HTMLElement | null>,
  selector: string,
  orderKey: string
) {
  const positions = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const rows = Array.from(container.querySelectorAll<HTMLElement>(selector));
    const previous = positions.current;
    const next = new Map<string, number>();
    const reduced = prefersReducedMotion();
    const moved: HTMLElement[] = [];
    for (const row of rows) {
      const id = row.dataset.agentId ?? '';
      // offsetTop ignores transforms, so a row caught mid-flight measures
      // where it is going, not where it is drawn.
      next.set(id, row.offsetTop);
      const before = previous.get(id);
      if (reduced || before === undefined || before === row.offsetTop) continue;
      row.style.transition = 'none';
      row.style.transform = `translateY(${before - row.offsetTop}px)`;
      moved.push(row);
    }
    positions.current = next;
    if (moved.length === 0) return;
    void container.offsetHeight;
    for (const row of moved) {
      row.style.transition = '';
      row.style.transform = '';
    }
  }, [containerRef, selector, orderKey]);
}
