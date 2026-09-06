/** Persistent comment backlog, isolated by project path and actual git branch. */
import { useCallback, useSyncExternalStore } from 'react';
import {
  commentsPrefix,
  readComments,
  saveComment,
  type CanvasComment,
  type CommentTarget,
} from '../lib/canvasComments';
import { useOptionalToast } from '../contexts/ToastContext';

const snapshots = new Map<
  string,
  { json: string; comments: CanvasComment[]; error: string | null }
>();
function snapshot(prefix: string) {
  let comments: CanvasComment[] = [],
    error: string | null = null;
  try {
    comments = readComments(prefix);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const json = JSON.stringify({ comments, error });
  if (snapshots.get(prefix)?.json !== json) snapshots.set(prefix, { json, comments, error });
  return snapshots.get(prefix)!;
}
function subscribe(refresh: () => void) {
  window.addEventListener('storage', refresh);
  window.addEventListener('shipstudio:comments-changed', refresh);
  return () => {
    window.removeEventListener('storage', refresh);
    window.removeEventListener('shipstudio:comments-changed', refresh);
  };
}
export function useCanvasComments(project: string, branch: string) {
  const prefix = commentsPrefix(project, branch);
  const getSnapshot = useCallback(() => snapshot(prefix), [prefix]);
  const { comments, error } = useSyncExternalStore(subscribe, getSnapshot);
  const { showToast } = useOptionalToast();
  const save = (make: () => CanvasComment | undefined) => {
    try {
      const comment = make();
      if (!comment) return false;
      saveComment(prefix, comment);
      return true;
    } catch {
      showToast(
        'Could not save this comment. Existing notes have been kept. Check local storage and try again.',
        'error'
      );
      return false;
    }
  };
  const add = (target: CommentTarget, body: string) => {
    if (error || !body.trim()) return false;
    return save(() => ({
      id: crypto.randomUUID(),
      number: Math.max(0, ...readComments(prefix).map((c) => c.number)) + 1,
      target,
      body,
      status: 'pending',
      createdAt: new Date().toISOString(),
    }));
  };
  const update = (id: string, patch: Partial<CanvasComment>) =>
    save(() => {
      const latest = readComments(prefix).find((c) => c.id === id);
      return latest ? { ...latest, ...patch, id } : undefined;
    });
  const remove = (id: string) => {
    try {
      localStorage.removeItem(prefix + id);
      window.dispatchEvent(new Event('shipstudio:comments-changed'));
      return true;
    } catch {
      showToast('Could not delete this comment. Please try again.', 'error');
      return false;
    }
  };
  return { comments, error, add, update, remove, prefix };
}
