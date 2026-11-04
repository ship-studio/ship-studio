import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { ToastContext } from '../../contexts/ToastContext';
import { AgentMemory } from './AgentMemory';
import type { Agent, MemoryEntry } from '../../lib/agents';

const agent = { id: 'fin', name: 'Finance' } as Agent;
const ENTRIES: MemoryEntry[] = [
  { text: 'Accountant is Sam' },
  { text: 'Prefers EUR' },
  { text: 'Lives in Lisbon', group: 'Imported from Grok Bot' },
];

afterEach(() => clearMocks());

function setup() {
  let entries = [...ENTRIES];
  const changes: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd === 'agents_memory') return { entries };
    if (cmd === 'agents_memory_change') {
      const change = (args as { change: { op: string; index: number; text?: string } }).change;
      changes.push(change);
      if (change.op === 'delete') {
        entries = entries.filter((_, i) => i !== change.index);
        return { entries, removed: '- Prefers EUR\n' };
      }
      if (change.op === 'add') entries = [...entries, { text: change.text ?? '' }];
      return { entries };
    }
    return null;
  });
  const showToast = vi.fn();
  render(
    <ToastContext.Provider value={{ toasts: [], showToast, dismissToast: vi.fn() }}>
      <AgentMemory agent={agent} />
    </ToastContext.Provider>
  );
  return { changes, showToast };
}

describe('AgentMemory', () => {
  it('lists entries, with imported memory under its own heading', async () => {
    setup();
    expect(await screen.findByText('Accountant is Sam')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Imported from Grok Bot' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Imported from Grok Bot' })).toHaveTextContent(
      'Lives in Lisbon'
    );
  });

  it('forgets an entry by position and words, with Undo putting it back as it was', async () => {
    const { changes, showToast } = setup();
    await screen.findByText('Prefers EUR');
    await act(() => {
      fireEvent.click(screen.getByLabelText('Forget “Prefers EUR”'));
      return Promise.resolve();
    });
    expect(changes[0]).toEqual({ op: 'delete', index: 1, original: 'Prefers EUR' });
    await waitFor(() => expect(screen.queryByText('Prefers EUR')).not.toBeInTheDocument());
    const [message, , action] = showToast.mock.calls[0] as [
      string,
      unknown,
      { onClick: () => void },
    ];
    expect(message).toBe('Forgot “Prefers EUR”');
    await act(() => {
      action.onClick();
      return Promise.resolve();
    });
    expect(changes[1]).toEqual({
      op: 'add',
      text: 'Prefers EUR',
      group: undefined,
      after: 'Accountant is Sam',
      before: undefined,
      raw: '- Prefers EUR\n',
    });
  });

  it('adds with Return', async () => {
    const { changes } = setup();
    const field = await screen.findByLabelText("Add to Finance's memory");
    fireEvent.change(field, { target: { value: 'Pays by card' } });
    await act(() => {
      fireEvent.keyDown(field, { key: 'Enter' });
      return Promise.resolve();
    });
    expect(changes[0]).toEqual({ op: 'add', text: 'Pays by card' });
    expect(await screen.findByText('Pays by card')).toBeInTheDocument();
  });
});
