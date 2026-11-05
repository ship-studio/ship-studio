import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ApprovalCard } from './AgentChatItems';
import { ARM_MS } from './useCardGuard';
import type { AgentMessage } from '../../lib/agents';

const card: AgentMessage = {
  id: 'm1',
  agentId: 'acme',
  ts: Date.now(),
  kind: 'approval',
  text: '',
  approval: {
    requestId: 'r1',
    title: 'Run a command',
    detail: 'npm test',
    status: 'pending',
    tool: 'Bash',
    input: { command: 'npm test' },
  },
};

function renderCard() {
  const onAnswer = vi.fn().mockResolvedValue(undefined);
  render(<ApprovalCard message={card} agentName="Acme" paused={false} onAnswer={onAnswer} />);
  return { onAnswer, allow: screen.getByRole('button', { name: 'Allow' }) };
}

/** A pointer click: the browser reports how many clicks (1), unlike one from a key. */
const pointerClick = (el: HTMLElement) => fireEvent.click(el, { detail: 1 });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('approval cards resist accidental answers', () => {
  it('Allow is inert for a moment after the card appears', async () => {
    const { onAnswer, allow } = renderCard();
    pointerClick(allow);
    expect(onAnswer).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(ARM_MS);
    });
    await act(() => {
      pointerClick(allow);
      return Promise.resolve();
    });
    expect(onAnswer).toHaveBeenCalledWith('r1', true, false, undefined);
  });

  it('a key pressed elsewhere never answers it, its own key does', async () => {
    const { onAnswer, allow } = renderCard();
    act(() => {
      vi.advanceTimersByTime(ARM_MS);
    });
    // Space went down in the composer; focus moved to Allow before it came up.
    fireEvent.click(allow, { detail: 0 });
    expect(onAnswer).not.toHaveBeenCalled();
    // Enter pressed on Allow itself.
    fireEvent.keyDown(allow, { key: 'Enter' });
    await act(() => {
      fireEvent.click(allow, { detail: 0 });
      return Promise.resolve();
    });
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it('Deny is never held back', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Deny…' }));
    expect(screen.getByLabelText('What Acme should do instead (optional)')).toBeInTheDocument();
  });
});
