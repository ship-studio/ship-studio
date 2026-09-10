import { describe, it, expect } from 'vitest';
import { classifyRejection, describeRejectionReason } from './globalErrorFilters';

describe('classifyRejection', () => {
  it('reports a genuine unhandled rejection from app code', () => {
    expect(classifyRejection(new Error('read of undefined'))).toBe('report');
  });

  it('suppresses rejections whose stack points at plugin blob code', () => {
    const err = new Error('boom');
    err.stack = 'at foo (blob:tauri://localhost/abc-123:1:1)';
    expect(classifyRejection(err)).toBe('plugin');
  });

  it("suppresses Tauri's post-unmount listener race", () => {
    expect(
      classifyRejection(new Error("undefined is not an object (evaluating 'listeners[eventId]')"))
    ).toBe('tauri-race');
  });

  /**
   * Issue #916: a `CommandError::Expected` that nobody caught. The backend
   * said it is a recognized environment state; the handler must not overrule
   * that and file a bug report.
   */
  it('does not report a backend-classified Expected CommandError', () => {
    const expectedError = {
      type: 'Other',
      expected: true,
      message:
        "The folder 'demo' no longer exists — it may have been moved, renamed, or deleted outside Harbr",
    };
    expect(classifyRejection(expectedError)).toBe('expected');
  });

  it('still reports an unflagged CommandError of the same shape', () => {
    expect(classifyRejection({ type: 'Other', message: 'something broke' })).toBe('report');
  });

  it('still reports a CommandError variant that carries no expected flag', () => {
    expect(classifyRejection({ type: 'Io', message: 'disk on fire' })).toBe('report');
  });

  it('reports rather than suppresses when expected is falsy', () => {
    expect(classifyRejection({ type: 'Other', message: 'nope', expected: false })).toBe('report');
  });

  it('classifies a plugin rejection before consulting the expected flag', () => {
    const err = new Error('at blob:tauri://localhost/x');
    err.stack = 'blob:tauri://localhost/x';
    expect(classifyRejection(err)).toBe('plugin');
  });
});

describe('describeRejectionReason', () => {
  it('passes strings through', () => {
    expect(describeRejectionReason('plain')).toBe('plain');
  });

  it('serializes plain objects rather than rendering [object Object] (issue #333)', () => {
    expect(describeRejectionReason({ type: 'Other', message: 'x' })).toBe(
      '{"type":"Other","message":"x"}'
    );
  });

  it('falls back to String() for values JSON cannot represent', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeRejectionReason(circular)).toBe('[object Object]');
    expect(describeRejectionReason(undefined)).toBe('undefined');
  });
});
