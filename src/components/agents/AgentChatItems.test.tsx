import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ApprovalCard, ErrorLine } from './AgentChatItems';
import type { AgentMessage } from '../../lib/agents';

const approvalMessage: AgentMessage = {
  id: 'm1',
  agentId: 'acme',
  ts: Date.now(),
  kind: 'approval',
  text: '',
  approval: { requestId: 'r1', title: 'Run a command', detail: 'npm test', status: 'pending' },
};

describe('ApprovalCard', () => {
  it('has one Deny, and an empty note denies plainly', async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(
      <ApprovalCard message={approvalMessage} agentName="Acme" paused={false} onAnswer={onAnswer} />
    );
    expect(screen.getAllByRole('button', { name: /deny/i })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /deny/i }));
    expect(onAnswer).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
      await Promise.resolve();
    });
    expect(onAnswer).toHaveBeenCalledWith('r1', false, false, undefined);
  });

  it('gives focus back to Deny when the note is cancelled', () => {
    render(
      <ApprovalCard message={approvalMessage} agentName="Acme" paused={false} onAnswer={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button', { name: /deny/i }));
    const field = screen.getByRole('textbox');
    expect(field).toHaveFocus();
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.getByRole('button', { name: /deny/i })).toHaveFocus();
  });
});

describe('ErrorLine', () => {
  it('schedules one retry at the reset however fast the second click comes', async () => {
    let finish = () => {};
    const onRetryAt = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const message: AgentMessage = {
      id: 'e1',
      agentId: 'acme',
      ts: Date.now(),
      kind: 'error',
      text: 'Usage limit reached',
      failure: { kind: 'usage_limit', resetsAt: Date.now() + 3_600_000 },
    };
    render(<ErrorLine message={message} onRetry={vi.fn()} onRetryAt={onRetryAt} />);
    const button = screen.getByRole('button', { name: /retry at/i });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onRetryAt).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Scheduling…' })).toBeDisabled();
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: /retry at/i })).toBeEnabled();
  });
});
