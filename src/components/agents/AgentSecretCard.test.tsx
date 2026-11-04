import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { ApprovalCard } from './AgentChatItems';
import type { AgentMessage } from '../../lib/agents';

const card = (status: 'pending' | 'allowed' | 'denied'): AgentMessage => ({
  id: 'm1',
  agentId: 'fin',
  ts: Date.now(),
  kind: 'approval',
  text: '',
  approval: {
    requestId: 'r1',
    title: 'Secure input · stripe_key',
    detail: 'Pull payouts',
    status,
    secret: {
      name: 'stripe_key',
      purpose: 'Pull payouts',
      kind: 'api_key',
      fields: [{ label: 'API key', env: 'STRIPE_KEY' }],
      reference: 'secret:finance/stripe_key',
    },
  },
});

afterEach(() => clearMocks());

describe('SecretCard', () => {
  it('takes the value in a masked field and sends it only to the save command', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      return { id: 's1' };
    });
    const onAnswer = vi.fn();
    render(
      <ApprovalCard
        message={card('pending')}
        agentName="Finance"
        paused={false}
        onAnswer={onAnswer}
      />
    );
    const field = screen.getByLabelText('API key');
    expect(field).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(field, { target: { value: 'sk_live_abc123456789' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await Promise.resolve();
    });
    expect(calls).toEqual([
      ['agents_save_secret', { agentId: 'fin', requestId: 'r1', values: ['sk_live_abc123456789'] }],
    ]);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('Deny declines without a value', async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(
      <ApprovalCard
        message={card('pending')}
        agentName="Finance"
        paused={false}
        onAnswer={onAnswer}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
      await Promise.resolve();
    });
    expect(onAnswer).toHaveBeenCalledWith('r1', false);
  });

  it('says what happened once answered', () => {
    const { rerender } = render(
      <ApprovalCard
        message={card('allowed')}
        agentName="Finance"
        paused={false}
        onAnswer={vi.fn()}
      />
    );
    expect(
      screen.getByText(/Saved to your Keychain · Finance uses \$STRIPE_KEY/)
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('API key')).toBeNull();
    rerender(
      <ApprovalCard
        message={card('denied')}
        agentName="Finance"
        paused={false}
        onAnswer={vi.fn()}
      />
    );
    expect(screen.getByText('Declined · Finance was told')).toBeInTheDocument();
  });
});
