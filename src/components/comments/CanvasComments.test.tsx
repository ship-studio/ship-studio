import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, useState } from 'react';
import { CanvasComments } from './CanvasComments';
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
  scope: 'Desktop',
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
    return (
      <>
        <button onClick={() => setOpen(!open)}>Comments</button>
        <CanvasComments
          projectPath="/test"
          branch="main"
          iframeRef={ref}
          agents={[{ id: 1, label: 'Codex 1', send }]}
          activeAgentId={1}
          currentPage="/"
          navigate={vi.fn()}
          available
          editing={false}
          stopEditing={vi.fn()}
          open={open}
          onOpenChange={setOpen}
          onPendingCountChange={pending}
        />
      </>
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Comments' }));
  return {
    iframe,
    send,
    pending,
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
it('sends selected pending notes as one batch and leaves unchecked notes pending', async () => {
  saveComment(prefix, base);
  saveComment(prefix, { ...base, id: 'two', number: 2, body: 'Leave me for later' });
  const { send } = setup();
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

it('selects tablet and mobile together and restores them when editing', async () => {
  const { select, send } = setup();
  await select();
  fireEvent.change(screen.getByLabelText('What should change?'), {
    target: { value: 'Reduce heading size' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Tablet' }));
  fireEvent.click(screen.getByRole('button', { name: 'Mobile' }));
  expect(screen.getByRole('button', { name: 'Tablet' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Mobile' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Save comment' }));
  expect(readComments(prefix)[0].scope).toEqual(['Tablet', 'Mobile']);
  expect(screen.getByText(/Applies to Tablet \+ Mobile/)).toBeInTheDocument();
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(screen.getByRole('button', { name: 'Tablet' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Mobile' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'All sizes' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save comment' }));
  expect(readComments(prefix)[0].scope).toBe('All sizes');
});

it('deletes a comment permanently with the trash control and preserves other notes', async () => {
  saveComment(prefix, base);
  saveComment(prefix, { ...base, id: 'two', number: 2, body: 'Keep me', status: 'sent' });
  setup();
  expect(screen.queryByText('Resolve')).not.toBeInTheDocument();
  expect(screen.queryByText('Reattach')).not.toBeInTheDocument();
  expect(screen.queryByText('Return to backlog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Delete comment: Make it 80vh' }));
  await waitFor(() => expect(readComments(prefix)).toHaveLength(1));
  expect(localStorage.getItem(prefix + base.id)).toBeNull();
  expect(readComments(prefix)[0].body).toBe('Keep me');
});
it('keeps the comment visible if deletion fails', () => {
  saveComment(prefix, base);
  setup();
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
  const { send } = setup();
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
