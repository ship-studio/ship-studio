/** Checked, frame-scoped bridge for element picking and saved comment pins. */
import { useCallback, useEffect, useState, type RefObject } from 'react';
import { isCommentTarget, type CanvasComment, type CommentTarget } from '../lib/canvasComments';
import { usePolling } from './usePolling';

interface Params {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  enabled: boolean;
  picking: boolean;
  notes: CanvasComment[];
  onSelect: (target: CommentTarget) => void;
  onOpen: (id: string) => void;
  onEscape: () => void;
}
export function useCommentBridge({
  iframeRef,
  enabled,
  picking,
  notes,
  onSelect,
  onOpen,
  onEscape,
}: Params) {
  const [ready, setReady] = useState(false);
  const [framePage, setFramePage] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const post = useCallback(
    (data: object) => {
      iframeRef.current?.contentWindow?.postMessage({ channel: 'ss:comments-host', ...data }, '*');
    },
    [iframeRef]
  );
  const sync = useCallback(() => {
    const styles = getComputedStyle(document.documentElement);
    post({
      type: 'sync',
      enabled,
      picking,
      notes: notes
        .filter((n) => n.status !== 'resolved')
        .map((n) => ({ id: n.id, target: n.target })),
      accent: styles.getPropertyValue('--accent-active').trim(),
      scrim: styles.getPropertyValue('--overlay-30').trim(),
      ink: styles.getPropertyValue('--bg-primary').trim(),
    });
  }, [post, enabled, picking, notes]);
  useEffect(() => {
    sync();
  }, [sync]);
  usePolling(
    () => {
      sync();
      return Promise.resolve();
    },
    { enabled: enabled && !ready, intervalMs: 1000, name: 'canvasComments' }
  );
  useEffect(() => {
    const frame = iframeRef.current;
    const onLoad = () => {
      setReady(false);
      setFramePage(null);
      sync();
    };
    const message = (e: MessageEvent) => {
      const d = e.data as {
        channel?: unknown;
        type?: unknown;
        target?: unknown;
        id?: unknown;
        missing?: unknown;
        page?: unknown;
      } | null;
      if (e.source !== frame?.contentWindow || !enabled || d?.channel !== 'ss:comments') return;
      if (d.type === 'ready') setReady(true);
      if ((d.type === 'ready' || d.type === 'locations') && typeof d.page === 'string')
        setFramePage(d.page);
      if (d.type === 'selected' && isCommentTarget(d.target)) onSelect(d.target);
      if (d.type === 'open' && typeof d.id === 'string') onOpen(d.id);
      if (d.type === 'escape') onEscape();
      if (d.type === 'locations' && Array.isArray(d.missing))
        setMissing(d.missing.filter((id: unknown) => typeof id === 'string'));
      if (d.type === 'missing' && typeof d.id === 'string') {
        const id = d.id;
        setMissing((ids) => [...ids, id]);
      }
    };
    frame?.addEventListener('load', onLoad);
    window.addEventListener('message', message);
    return () => {
      frame?.removeEventListener('load', onLoad);
      window.removeEventListener('message', message);
    };
  }, [iframeRef, enabled, sync, onSelect, onOpen, onEscape]);
  useEffect(() => () => post({ type: 'sync', enabled: false }), [post]);
  return { ready, framePage, missing, post };
}
