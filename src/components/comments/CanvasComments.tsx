/**
 * Canvas comment mode, pinned notes, and the explicit batch handoff.
 *
 * Exposed as a layer rather than one component because its two halves mount in
 * different places: the pins belong over the preview frame (and on a breakpoint
 * canvas, over the ACTIVE frame, in the unscaled overlay layer), while the send
 * bar belongs in the workspace. This is the same arrangement `useElementStructure`
 * has with `ElementToolbar`.
 */
import { useState, useRef, useEffect, type ReactNode, type RefObject } from 'react';
import { CommentPins } from './CommentPins';
import { CommentsPanel } from './CommentsPanel';
import { CommentComposer } from './CommentComposer';
import { useCanvasComments } from '../../hooks/useCanvasComments';
import { useCommentBridge } from '../../hooks/useCommentBridge';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useAsyncState } from '../../hooks/useAsyncState';
import { useCommands } from '../../commands/useCommands';
import {
  formatCommentBatch,
  readComments,
  type CanvasComment,
  type CommentTarget,
  type CommentAgent,
  type CommentDetail,
} from '../../lib/canvasComments';
import '../../styles/features/canvas-comments.css';

export interface CanvasCommentsProps {
  projectPath: string;
  branch: string | null;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  agents: CommentAgent[];
  activeAgentId?: number;
  currentPage: string;
  navigate: (page: string) => void;
  available: boolean;
  editing: boolean;
  stopEditing: () => void;
  /** Open state is owned by the workspace header, which renders the toggle. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Reports the pending backlog size so the header toggle can badge it. */
  onPendingCountChange?: (count: number) => void;
}
export function useCanvasCommentsLayer(props: CanvasCommentsProps): {
  bar: ReactNode;
  /** Pins for one frame: its canvas scale, and its on-screen box. */
  pins: (scale: number, bounds: { w: number; h: number } | null) => ReactNode;
} {
  const { open, onOpenChange, onPendingCountChange } = props;
  const setOpen = onOpenChange;
  const [draft, setDraft] = useState<CommentTarget | null>(null);
  const [editingNote, setEditingNote] = useState<CanvasComment>();
  const [excluded, setExcluded] = useState(new Set<string>());
  const [agentId, setAgentId] = useState<number | null>(props.activeAgentId ?? null);
  const [locating, setLocating] = useState<CanvasComment>();
  const [batchId, setBatchId] = useState(() => crypto.randomUUID());
  const [detail, setDetail] = useState<CommentDetail>('standard');
  const [openId, setOpenId] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const { showToast } = useOptionalToast();
  const store = useCanvasComments(props.projectPath, props.branch ?? '');
  const selected = store.comments.filter((c) => c.status === 'pending' && !excluded.has(c.id));
  const agent = props.agents.find((a) => a.id === agentId);
  const prompt = selected.length
    ? formatCommentBatch(props.projectPath, props.branch ?? '', selected, batchId, detail)
    : '';
  const { copy } = useCopyToClipboard({
    onCopy: () => showToast('Comment batch copied', 'success'),
  });
  const enabled = open && props.available && !props.editing;
  const cancelDraft = () => {
    setDraft(null);
    setEditingNote(undefined);
    bridge.post({ type: 'clear' });
  };
  const locate = (note: CanvasComment) => {
    setLocating(note);
    if (props.currentPage !== note.target.page) props.navigate(note.target.page);
    else bridge.post({ type: 'locate', id: note.id, target: note.target });
  };
  const bridge = useCommentBridge({
    iframeRef: props.iframeRef,
    enabled,
    picking: true,
    notes: store.comments,
    onSelect: setDraft,
    onOpen: (id) => {
      const note = store.comments.find((c) => c.id === id);
      if (note && !draft) {
        setEditingNote(note);
        setDraft(note.target);
      }
    },
    onEscape: () => {
      if (!draft) setOpen(false);
      else bridge.post({ type: 'clear' });
    },
  });
  const { ready, post, framePage } = bridge;
  const { editing, stopEditing } = props;
  useEffect(() => {
    if (open && editing) stopEditing();
  }, [open, editing, stopEditing]);
  const pendingCount = store.comments.filter((c) => c.status === 'pending').length;
  useEffect(() => {
    onPendingCountChange?.(pendingCount);
  }, [pendingCount, onPendingCountChange]);
  useEffect(() => () => onPendingCountChange?.(0), [onPendingCountChange]);
  useEffect(() => {
    if (locating && ready && locating.target.page === framePage) {
      post({ type: 'locate', id: locating.id, target: locating.target });
      setLocating(undefined);
    }
  }, [locating, ready, post, framePage]);
  const send = useAsyncState(
    async () => {
      if (sendingRef.current) return;
      if (!agent || !props.branch) throw new Error('Choose an available agent terminal first.');
      sendingRef.current = true;
      try {
        // Re-read storage before handing off: another window may have edited a note.
        const batch = readComments(store.prefix).filter(
          (c) => c.status === 'pending' && !excluded.has(c.id)
        );
        const text = formatCommentBatch(props.projectPath, props.branch, batch, batchId, detail);
        await agent.send(text);
        const sentAt = new Date().toISOString();
        const saved = batch.map((c) =>
          store.update(c.id, { status: 'sent', sentAt, sentTo: agent.label, batchId })
        );
        if (saved.some((ok) => !ok))
          throw new Error(
            'Batch was pasted, but its sent status could not be saved. Check the terminal before retrying.'
          );
        setBatchId(crypto.randomUUID());
        showToast('Batch pasted. Press Enter in the agent terminal to start.', 'success');
      } finally {
        sendingRef.current = false;
      }
    },
    { onError: (e) => showToast(e.message, 'error') }
  );
  useCommands(
    () => [
      {
        id: 'comments.open',
        title: 'Open canvas comments',
        category: 'action',
        when: 'project',
        keywords: ['feedback', 'notes', 'backlog'],
        run: () => {
          setOpen(true);
        },
      },
      {
        id: 'comments.review',
        title: 'Review comments before sending',
        category: 'action',
        when: 'project',
        run: () => setOpen(true),
      },
    ],
    [setOpen]
  );
  const composer = draft ? (
    <CommentComposer
      key={editingNote?.id ?? 'new'}
      target={draft}
      existing={editingNote}
      onCancel={cancelDraft}
      onSave={(body, scope) => {
        if (!props.branch) return false;
        const ok = editingNote
          ? store.update(editingNote.id, {
              body,
              scope,
              target: draft,
              status: 'pending',
              sentAt: undefined,
              sentTo: undefined,
              batchId: undefined,
            })
          : store.add(draft, body, scope);
        if (ok) {
          cancelDraft();
          bridge.post({ type: 'clear' });
        }
        return ok;
      }}
    />
  ) : null;

  const toggleExcluded = (id: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const removeNote = (c: CanvasComment) => {
    if (!store.remove(c.id)) return;
    if (locating?.id === c.id) setLocating(undefined);
    if (openId === c.id) setOpenId(null);
    bridge.post({ type: 'clear' });
    showToast('Comment deleted', 'success');
  };

  const editNote = (c: CanvasComment) => {
    if (draft) {
      showToast('Save or cancel your current draft first.', 'info');
      return;
    }
    setOpenId(null);
    setEditingNote(c);
    setDraft(c.target);
    locate(c);
  };

  return {
    bar: open ? (
      <CommentsPanel
        comments={store.comments}
        agents={props.agents}
        agentId={agent ? agentId : null}
        setAgentId={setAgentId}
        excluded={excluded}
        selectAll={() => setExcluded(new Set())}
        clearSelection={() =>
          setExcluded(
            new Set(store.comments.filter((c) => c.status === 'pending').map((c) => c.id))
          )
        }
        selectedCount={selected.length}
        onClose={() => setOpen(false)}
        onLocate={(c) => {
          setOpenId(c.id);
          locate(c);
        }}
        detail={detail}
        setDetail={setDetail}
        onSend={() => void send.execute()}
        onCopy={() => void copy(prompt)}
        sending={send.isLoading}
        disabled={!!store.error || !props.branch || !!draft}
        error={store.error ?? send.error?.message}
        prompt={prompt}
        message={
          !props.branch
            ? 'Waiting for the current branch.'
            : props.editing
              ? 'Close the visual editor to place comments.'
              : !props.available
                ? 'Start the preview to place comments. Your comments are saved.'
                : !bridge.ready
                  ? 'Connecting to the preview…'
                  : draft
                    ? 'Write the note, then Save comment.'
                    : 'Click any element in the preview to leave a comment.'
        }
      />
    ) : null,
    pins: (scale, bounds) =>
      open ? (
        <CommentPins
          comments={store.comments}
          placements={bridge.placements}
          missing={bridge.missing}
          scale={scale}
          bounds={bounds}
          openId={openId}
          onOpen={setOpenId}
          excluded={excluded}
          toggle={toggleExcluded}
          onEdit={editNote}
          onDelete={removeNote}
          onHover={(c) =>
            c
              ? bridge.post({ type: 'locate', id: c.id, target: c.target, quiet: true })
              : bridge.post({ type: 'clear' })
          }
          composer={composer}
          composerAt={draft ? { x: draft.rect.x, y: draft.rect.y } : null}
        />
      ) : null,
  };
}
