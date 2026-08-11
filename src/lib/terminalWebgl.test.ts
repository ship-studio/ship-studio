/**
 * Tests for the guarded WebGL renderer loader (issue #383).
 *
 * The addon must only be loaded while the container has non-zero layout —
 * a zero-size/hidden pane makes the addon's glyph atlas throw an uncaught
 * InvalidStateError from getImageData, which telemetry auto-reports.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Terminal } from '@xterm/xterm';

const { addonInstances } = vi.hoisted(() => ({
  addonInstances: [] as Array<{
    dispose: ReturnType<typeof vi.fn>;
    onContextLoss: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    dispose = vi.fn();
    onContextLoss = vi.fn();
    constructor() {
      addonInstances.push(this as unknown as (typeof addonInstances)[number]);
    }
  },
}));

import { attachWebglRenderer } from './terminalWebgl';

/** Minimal ResizeObserver stub that lets tests fire the callback manually. */
let fireResize: () => void = () => {};
const observeSpy = vi.fn();
const disconnectSpy = vi.fn();

class ResizeObserverStub {
  constructor(cb: ResizeObserverCallback) {
    fireResize = () => cb([], this as unknown as ResizeObserver);
  }
  observe = observeSpy;
  disconnect = disconnectSpy;
}

interface FakeContainer {
  offsetWidth: number;
  offsetHeight: number;
}

function makeFixture(width: number, height: number) {
  const container: FakeContainer = { offsetWidth: width, offsetHeight: height };
  const term = { loadAddon: vi.fn() };
  const dispose = attachWebglRenderer(
    term as unknown as Terminal,
    container as unknown as HTMLElement
  );
  return { container, term, dispose };
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  addonInstances.length = 0;
});

describe('attachWebglRenderer', () => {
  it('loads the addon immediately when the container has layout', () => {
    const { term } = makeFixture(800, 600);
    expect(term.loadAddon).toHaveBeenCalledTimes(1);
    expect(addonInstances).toHaveLength(1);
  });

  it('defers loading while the container is zero-size, then loads when layout arrives', () => {
    const { container, term } = makeFixture(0, 0);
    expect(term.loadAddon).not.toHaveBeenCalled();

    container.offsetWidth = 800;
    container.offsetHeight = 600;
    fireResize();
    expect(term.loadAddon).toHaveBeenCalledTimes(1);
  });

  it('disposes the addon when the pane collapses to zero and reloads when it returns', () => {
    const { container, term } = makeFixture(800, 600);
    expect(addonInstances).toHaveLength(1);

    container.offsetWidth = 0;
    fireResize();
    expect(addonInstances[0].dispose).toHaveBeenCalledTimes(1);

    container.offsetWidth = 800;
    fireResize();
    // A fresh addon instance is loaded — the disposed one is never reused.
    expect(addonInstances).toHaveLength(2);
    expect(term.loadAddon).toHaveBeenCalledTimes(2);
  });

  it('does not reload after a GPU context loss (permanent canvas fallback)', () => {
    const { container } = makeFixture(800, 600);
    const [addon] = addonInstances;
    // Simulate xterm firing the context-loss callback the loader registered.
    const onLoss = addon.onContextLoss.mock.calls[0][0] as () => void;
    onLoss();
    expect(addon.dispose).toHaveBeenCalled();
    expect(disconnectSpy).toHaveBeenCalled();

    container.offsetWidth = 1000;
    fireResize();
    expect(addonInstances).toHaveLength(1);
  });

  it('cleanup disconnects the observer and disposes the loaded addon', () => {
    const { dispose } = makeFixture(800, 600);
    dispose();
    expect(disconnectSpy).toHaveBeenCalled();
    expect(addonInstances[0].dispose).toHaveBeenCalledTimes(1);

    // Post-cleanup resize events are inert.
    fireResize();
    expect(addonInstances).toHaveLength(1);
  });
});
