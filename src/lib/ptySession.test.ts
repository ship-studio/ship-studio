/**
 * Tests for the attach gate — the de-duplication half of the
 * subscribe-first PTY attach protocol (issue #156).
 *
 * The backend guarantees a data chunk never straddles an attach snapshot's
 * `endOffset` (append + offset increment are atomic under the ring-buffer
 * mutex), so the gate's filter can be a plain `offset >= endOffset`.
 */

import { describe, it, expect, vi } from 'vitest';
import { createAttachGate } from './ptySession';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

function gateWithLog() {
  const delivered: string[] = [];
  const gate = createAttachGate((b) => delivered.push(text(b)));
  return { gate, delivered };
}

describe('createAttachGate', () => {
  it('queues events while the snapshot end is unknown', () => {
    const deliver = vi.fn();
    const gate = createAttachGate(deliver);
    gate.push(0, bytes('early'));
    gate.push(5, bytes('also early'));
    expect(deliver).not.toHaveBeenCalled();
  });

  it('flush drops chunks the snapshot covers and keeps the rest, in order', () => {
    const { gate, delivered } = gateWithLog();
    // Chunks at offsets 0..5, 5..10 are inside the snapshot (endOffset 10);
    // 10..14 and 14..15 arrived while attaching but are NOT in the snapshot.
    gate.push(0, bytes('AAAAA'));
    gate.push(5, bytes('BBBBB'));
    gate.push(10, bytes('CCCC'));
    gate.push(14, bytes('D'));
    gate.open(10);
    expect(delivered).toEqual(['CCCC', 'D']);
  });

  it('a chunk starting exactly at endOffset is delivered (no-straddle boundary)', () => {
    const { gate, delivered } = gateWithLog();
    gate.push(10, bytes('at-boundary'));
    gate.open(10);
    expect(delivered).toEqual(['at-boundary']);
  });

  it('delivers everything when the snapshot is empty (fresh spawn, endOffset 0)', () => {
    const { gate, delivered } = gateWithLog();
    gate.push(0, bytes('first paint'));
    gate.open(0);
    gate.push(11, bytes('more'));
    expect(delivered).toEqual(['first paint', 'more']);
  });

  it('applies the same filter to live events after opening', () => {
    const { gate, delivered } = gateWithLog();
    gate.open(20);
    // A straggler event for snapshot-covered bytes (e.g. delayed IPC
    // delivery) must not double-write.
    gate.push(0, bytes('stale'));
    gate.push(20, bytes('live-1'));
    gate.push(26, bytes('live-2'));
    expect(delivered).toEqual(['live-1', 'live-2']);
  });

  it('preserves arrival order across the flush boundary', () => {
    const { gate, delivered } = gateWithLog();
    gate.push(3, bytes('queued-1'));
    gate.push(11, bytes('queued-2'));
    gate.open(3); // nothing covered — both queued chunks pass
    gate.push(19, bytes('live'));
    expect(delivered).toEqual(['queued-1', 'queued-2', 'live']);
  });

  it('ignores a second open (already-open gate keeps its snapshot end)', () => {
    const { gate, delivered } = gateWithLog();
    gate.push(0, bytes('covered'));
    gate.open(5);
    gate.open(0); // must not re-flush or move the boundary
    gate.push(5, bytes('after'));
    expect(delivered).toEqual(['after']);
  });

  it('does not re-deliver queued chunks on later pushes', () => {
    const { gate, delivered } = gateWithLog();
    gate.push(0, bytes('a'));
    gate.open(0);
    expect(delivered).toEqual(['a']);
    gate.push(1, bytes('b'));
    expect(delivered).toEqual(['a', 'b']);
  });
});
