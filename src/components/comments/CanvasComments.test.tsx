import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, useState } from 'react';
import { useCanvasCommentsLayer } from './CanvasComments';
import {
  commentsPrefix,
  readComments,
  saveComment,
  type CanvasComment,
} from '../../lib/canvasComments';
vi.mock('../../commands/useCommands', () => ({ useCommands: () => undefined }));
vi.mock('../../contexts/ToastContext', () => ({
  useOptionalToast: () => ({ showToast: vi.fn() }),
}));
const target = {
  page: '/',
  selector: '#hero',
  tag: 'section',
  text: 'Hero',
  heading: 'Hero',
  classes: 'hero',
  ancestors: ['main'],
  viewport: { width: 1440, height: 900 },
  rect: { x: 0, y: 0, width: 1440, height: 900 },
};
const base: CanvasComment = {
  id: 'one',
  number: 1,
  target,
  body: 'Make it 80vh',
  status: 'pending',
  createdAt: '2026-09-06',
};
const prefix = commentsPrefix('/test', 'main');
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
  );
});
function setup(send = vi.fn().mockResolvedValue(undefined)) {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  const ref = createRef<HTMLIFrameElement>();
  ref.current = iframe;
  const pending = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(false);
    // The layer mounts in two places in the real app: the batch bar in the
    // workspace, the pins over the preview frame.
    const layer = useCanvasCommentsLayer({
      projectPath: '/test',
      branch: 'main',
      iframeRef: ref,
      agents: [{ id: 1, label: 'Codex 1', send }],
      activeAgentId: 1,
      currentPage: '/',
      navigate: vi.fn(),
      available: true,
      editing: false,
      stopEditing: vi.fn(),
      open,
      onOpenChange: setOpen,
      onPendingCountChange: pending,
    });
    return (
      <>
        <button onClick={() => setOpen(!open)}>Comments</button>
        {layer.bar}
        {layer.pins(1, { w: 1440, h: 900 })}
      </>
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Comments' }));
  return {
    iframe,
    send,
    pending,
    /** The frame reporting where each saved note's element currently sits. */
    locate: (notes: { id: string; x: number; y: number }[]) =>
      act(() =>
        window.dispatchEvent(
          new MessageEvent('message', {
            source: iframe.contentWindow,
            data: {
              channel: 'ss:comments',
              type: 'locations',
              missing: [],
              page: '/',
              at: notes.map((n) => ({ ...n, width: 100, height: 40 })),
            },
          })
        )
      ),
    select: () =>
      act(() =>
        window.dispatchEvent(
          new MessageEvent('message', {
            source: iframe.contentWindow,
            data: { channel: 'ss:comments', type: 'selected', target },
          })
        )
      ),
  };
}
it('adds a note to persistent backlog without calling the agent', async () => {
  const { send, select, pending } = setup();
  await select();
  fireEvent.change(screen.getByLabelText('What should change?'), {
    target: { value: 'Please make this 80vh instead of 100vh.' },
  });
  fireEvent.click(screen.getByText('Save comment'));
  expect(screen.queryByText('Screenshot')).not.toBeInTheDocument();
  expect(send).not.toHaveBeenCalled();
  await waitFor(() => expect(readComments(prefix)).toHaveLength(1));
  expect(readComments(prefix)[0].body).toBe('Please make this 80vh instead of 100vh.');
  // The header toggle badges this count, so it must reach the workspace.
  await waitFor(() => expect(pending).toHaveBeenLastCalledWith(1));
});
/** Report placements, then open the pin for a note by its number. */
async function openPin(
  locate: (n: { id: string; x: number; y: number }[]) => Promise<unknown>,
  notes: { id: string; number: number }[],
  number: number
) {
  await locate(notes.map((n, i) => ({ id: n.id, x: 10, y: 20 + i * 50 })));
  const note = notes.find((n) => n.number === number)!;
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Comment ${note.number}:`) }));
}

it('sends selected pending notes as one batch and leaves unchecked notes pending', async () => {
  saveComment(prefix, base);
  saveComment(prefix, { ...base, id: 'two', number: 2, body: 'Leave me for later' });
  const { send, locate } = setup();
  await openPin(locate, [base, { ...base, id: 'two', number: 2 }], 2);
  fireEvent.click(screen.getByLabelText('Include comment: Leave me for later'));
  fireEvent.click(screen.getByText('Send comments to agent'));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(send.mock.calls[0][0]).toContain('Make it 80vh');
  expect(send.mock.calls[0][0]).not.toContain('Leave me for later');
  await waitFor(() => expect(readComments(prefix)[0].status).toBe('sent'));
  expect(readComments(prefix)[1].status).toBe('pending');
});
it('keeps comments pending when the terminal rejects the handoff', async () => {
  saveComment(prefix, base);
  const { send } = setup(vi.fn().mockRejectedValue(new Error('Terminal unavailable')));
  fireEvent.click(screen.getByText('Send comments to agent'));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  await screen.findByText('Terminal unavailable');
  expect(readComments(prefix)[0].status).toBe('pending');
});

it('switches targets without losing the note and keeps the composer compact', async () => {
  const { select, iframe } = setup();
  await select();
  fireEvent.change(screen.getByLabelText('What should change?'), {
    target: { value: 'Keep this draft' },
  });
  expect(screen.queryByText('Select parent')).not.toBeInTheDocument();
  expect(screen.queryByText('Send 0 comments to agent')).not.toBeInTheDocument();
  await act(() =>
    window.dispatchEvent(
      new MessageEvent('message', {
        source: iframe.contentWindow,
        data: { channel: 'ss:comments', type: 'escape' },
      })
    )
  );
  await act(() =>
    window.dispatchEvent(
      new MessageEvent('message', {
        source: iframe.contentWindow,
        data: {
          channel: 'ss:comments',
          type: 'selected',
          target: { ...target, selector: '#next', tag: 'section' },
        },
      })
    )
  );
  expect(screen.getByLabelText('What should change?')).toHaveValue('Keep this draft');
  expect(screen.getByTitle('#next')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save comment' }));
  await waitFor(() => expect(readComments(prefix)).toHaveLength(1));
  expect(readComments(prefix)[0].target.selector).toBe('#next');
  expect(readComments(prefix)[0].body).toBe('Keep this draft');
});

it('asks only for the note, and carries the viewport it was written at', async () => {
  const { select, send, locate } = setup();
  await select();
  // No size picker: the viewport the user was on is the context.
  expect(screen.queryByRole('button', { name: 'Tablet' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'All sizes' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Apply to/)).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('What should change?'), {
    target: { value: 'Reduce heading size' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save comment' }));
  await waitFor(() => expect(readComments(prefix)).toHaveLength(1));
  const saved = readComments(prefix)[0];
  expect(saved.scope).toBeUndefined();
  expect(saved.target.viewport).toEqual({ width: 1440, height: 900 });
  expect(send).not.toHaveBeenCalled();
  await openPin(locate, [saved], saved.number);
  expect(screen.getByText(/Seen at 1440 × 900/)).toBeInTheDocument();
});

it('deletes a comment permanently with the trash control and preserves other notes', async () => {
  saveComment(prefix, base);
  saveComment(prefix, { ...base, id: 'two', number: 2, body: 'Keep me', status: 'sent' });
  const { locate } = setup();
  expect(screen.queryByText('Resolve')).not.toBeInTheDocument();
  expect(screen.queryByText('Reattach')).not.toBeInTheDocument();
  expect(screen.queryByText('Return to backlog')).not.toBeInTheDocument();
  await openPin(locate, [base, { ...base, id: 'two', number: 2 }], 1);
  fireEvent.click(screen.getByRole('button', { name: 'Delete comment: Make it 80vh' }));
  await waitFor(() => expect(readComments(prefix)).toHaveLength(1));
  expect(localStorage.getItem(prefix + base.id)).toBeNull();
  expect(readComments(prefix)[0].body).toBe('Keep me');
});
it('keeps the comment visible if deletion fails', async () => {
  saveComment(prefix, base);
  const { locate } = setup();
  await openPin(locate, [base], 1);
  const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new Error('Storage unavailable');
  });
  fireEvent.click(screen.getByRole('button', { name: 'Delete comment: Make it 80vh' }));
  expect(screen.getByText('Make it 80vh')).toBeInTheDocument();
  remove.mockRestore();
});

it('edits a sent comment into a ready-to-send update without a separate backlog action', async () => {
  saveComment(prefix, {
    ...base,
    status: 'sent',
    sentTo: 'Codex 1',
    sentAt: '2026-09-06',
    batchId: 'old',
  });
  const { send, locate } = setup();
  await openPin(locate, [base], 1);
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('What should change?'), {
    target: { value: 'Make it 70vh instead' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save comment' }));
  await waitFor(() => expect(readComments(prefix)[0].status).toBe('pending'));
  expect(readComments(prefix)[0].sentTo).toBeUndefined();
  expect(send).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Send comments to agent' })).toBeEnabled();
});

it('opens the panel when the preview is not running, and says so', async () => {
  // The regression that shipped: the panel rendered below Preview's early
  // return for the dev-server status card, so the header toggle was enabled and
  // did nothing whenever the server was starting, stopped or errored. This
  // message could never be seen by the state it was written for.
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  const ref = createRef<HTMLIFrameElement>();
  ref.current = iframe;
  function Harness() {
    const [open, setOpen] = useState(true);
    const layer = useCanvasCommentsLayer({
      projectPath: '/test',
      branch: 'main',
      iframeRef: ref,
      agents: [],
      currentPage: '/',
      navigate: vi.fn(),
      available: false, // the preview is not up
      editing: false,
      stopEditing: vi.fn(),
      open,
      onOpenChange: setOpen,
    });
    return <>{layer.bar}</>;
  }
  render(<Harness />);
  expect(await screen.findByText(/Start the preview to place comments/)).toBeInTheDocument();
  expect(screen.getByText('No comments yet')).toBeInTheDocument();
});
