import { describe, expect, it, vi } from 'vitest';
import { scrollToBottomIfLive } from './DevServerLogs';

/**
 * Regression tests for issue #676: xterm `write()` completion callbacks fire
 * asynchronously and used to call `term.scrollToBottom()` unconditionally.
 * If the terminal had been disposed in the interim (unmount or isReady
 * re-run), that call threw from inside xterm's RenderService
 * ("undefined is not an object (evaluating 'this._renderer.value.dimensions')").
 * The guard only scrolls while the instance is still the live one in the ref.
 */
describe('scrollToBottomIfLive', () => {
  const makeTerm = () => ({ scrollToBottom: vi.fn() });

  it('scrolls when the terminal is still the live instance', () => {
    const term = makeTerm();
    scrollToBottomIfLive({ current: term }, term);
    expect(term.scrollToBottom).toHaveBeenCalledOnce();
  });

  it('does not touch a disposed terminal (ref already nulled by cleanup)', () => {
    const term = makeTerm();
    // The cleanup effect disposes the terminal and nulls the ref in the same
    // tick; the in-flight write callback then fires against the stale `term`.
    scrollToBottomIfLive({ current: null }, term);
    expect(term.scrollToBottom).not.toHaveBeenCalled();
  });

  it('does not touch a stale terminal after a recreate swapped the ref', () => {
    const oldTerm = makeTerm();
    const newTerm = makeTerm();
    scrollToBottomIfLive({ current: newTerm }, oldTerm);
    expect(oldTerm.scrollToBottom).not.toHaveBeenCalled();
    expect(newTerm.scrollToBottom).not.toHaveBeenCalled();
  });
});
