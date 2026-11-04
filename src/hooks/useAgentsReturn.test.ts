import { describe, expect, it } from 'vitest';
import { agentsReturnStep } from './useAgentsReturn';

describe('agentsReturnStep', () => {
  it('goes back to Agents only when the call found you there and you are still on its project', () => {
    let s = agentsReturnStep(new Map(), 'begin', '/p', 'agents', null);
    expect(s.borrowed.get('/p')).toBe(1);
    s = agentsReturnStep(s.borrowed, 'end', '/p', 'workspace', '/p');
    expect(s.goBack).toBe(true);
    expect(s.borrowed.size).toBe(0);
  });

  it('leaves you where you are when you were working in a project, or moved on since', () => {
    const fromProject = agentsReturnStep(new Map(), 'begin', '/p', 'workspace', '/p');
    expect(fromProject.borrowed.size).toBe(0);
    expect(agentsReturnStep(fromProject.borrowed, 'end', '/p', 'workspace', '/p').goBack).toBe(
      false
    );

    const begun = agentsReturnStep(new Map(), 'begin', '/p', 'agents', null).borrowed;
    expect(agentsReturnStep(begun, 'end', '/p', 'workspace', '/other').goBack).toBe(false);
    expect(agentsReturnStep(begun, 'end', '/p', 'projects', '/p').goBack).toBe(false);
  });

  it('waits for the last of overlapping calls', () => {
    let b = agentsReturnStep(new Map(), 'begin', '/p', 'agents', null).borrowed;
    // The window has switched by the time the second call begins.
    b = agentsReturnStep(b, 'begin', '/p', 'workspace', '/p').borrowed;
    const first = agentsReturnStep(b, 'end', '/p', 'workspace', '/p');
    expect(first.goBack).toBe(false);
    expect(agentsReturnStep(first.borrowed, 'end', '/p', 'workspace', '/p').goBack).toBe(true);
  });
});
