import { describe, expect, it } from 'vitest';
import { describeAgentsAttention } from './ModeToggle';

describe('describeAgentsAttention', () => {
  it('is null when nobody wants you', () => {
    expect(describeAgentsAttention({ waiting: [], unread: 0 })).toBeNull();
  });

  it('names who is waiting, then counts the unread', () => {
    expect(describeAgentsAttention({ waiting: ['Lead Gen'], unread: 1 })).toBe(
      'Lead Gen needs your OK · 1 unread'
    );
    expect(describeAgentsAttention({ waiting: ['Lead Gen', 'Finance'], unread: 0 })).toBe(
      'Lead Gen and Finance need your OK'
    );
    expect(describeAgentsAttention({ waiting: ['Lead Gen', 'Finance', 'Hiring'], unread: 2 })).toBe(
      'Lead Gen and 2 others need your OK · 2 unread'
    );
    expect(describeAgentsAttention({ waiting: [], unread: 3 })).toBe('3 unread');
  });
});
