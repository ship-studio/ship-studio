/**
 * Quote part of a reply into the composer: select text in an agent's message
 * and press ⌘L, or the button that appears above the selection.
 *
 * @module components/agents/useQuoteSelection
 */

import { useCallback, useEffect, useState, type RefObject } from 'react';

/** Where the button sits, relative to `container`. */
export interface QuoteAnchor {
  top: number;
  left: number;
}

/** Text that can be quoted: inside an agent's message, in this chat. */
function quotableSelection(scroll: HTMLElement | null): { text: string; range: Range } | null {
  const selection = window.getSelection();
  if (!scroll || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el = node instanceof Element ? node : node.parentElement;
  if (!el || !scroll.contains(el) || !el.closest('.agent-bubble--agent, .agent-peer__text')) {
    return null;
  }
  const text = selection.toString().trim();
  return text ? { text, range } : null;
}

export function useQuoteSelection(
  scrollRef: RefObject<HTMLElement | null>,
  containerRef: RefObject<HTMLElement | null>,
  onQuote: (text: string) => void
) {
  const [anchor, setAnchor] = useState<QuoteAnchor | null>(null);

  const quote = useCallback(() => {
    const found = quotableSelection(scrollRef.current);
    if (!found) return false;
    onQuote(found.text);
    window.getSelection()?.removeAllRanges();
    setAnchor(null);
    return true;
  }, [scrollRef, onQuote]);

  useEffect(() => {
    const place = () => {
      const found = quotableSelection(scrollRef.current);
      const box = containerRef.current?.getBoundingClientRect();
      if (!found || !box) return setAnchor(null);
      const rect = found.range.getBoundingClientRect();
      setAnchor({ top: rect.top - box.top, left: rect.left + rect.width / 2 - box.left });
    };
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'l') return;
      if (quote()) event.preventDefault();
    };
    // Hide while scrolling; it would otherwise float away from its text.
    const scroll = scrollRef.current;
    const hide = () => setAnchor(null);
    document.addEventListener('selectionchange', place);
    window.addEventListener('keydown', onKey);
    scroll?.addEventListener('scroll', hide, { passive: true });
    return () => {
      document.removeEventListener('selectionchange', place);
      window.removeEventListener('keydown', onKey);
      scroll?.removeEventListener('scroll', hide);
    };
  }, [scrollRef, containerRef, quote]);

  return { anchor, quote };
}
