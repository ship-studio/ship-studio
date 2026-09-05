import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { inspectStore, setInspectSource } from './inspectStore';

const ORIGIN = 'http://localhost:3000';

function previewFrame(): Window {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  return iframe.contentWindow as Window;
}

function postConsole(source: Window | null, text: string) {
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: ORIGIN,
      source,
      data: { source: 'shipstudio-inspect', type: 'console', level: 'log', args: [text] },
    })
  );
}

beforeEach(() => {
  setInspectSource(null);
  // A 'ready' message is the store's own reset path — use it to start clean.
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: ORIGIN,
      data: { source: 'shipstudio-inspect', type: 'ready' },
    })
  );
});

afterEach(() => {
  setInspectSource(null);
  document.body.innerHTML = '';
});

describe('inspectStore console capture', () => {
  it('accepts every preview frame when no source is pinned', () => {
    postConsole(previewFrame(), 'one');
    postConsole(previewFrame(), 'two');
    expect(inspectStore.getConsoleEntries().map((entry) => entry.args[0])).toEqual(['one', 'two']);
  });

  it('ignores non-preview origins', () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://evil.example',
        data: { source: 'shipstudio-inspect', type: 'console', level: 'log', args: ['spoofed'] },
      })
    );
    expect(inspectStore.getConsoleEntries()).toHaveLength(0);
  });

  it('collects only the pinned frame once several preview frames are live', () => {
    const active = previewFrame();
    const other = previewFrame();
    setInspectSource(active);

    postConsole(other, 'from the tablet frame');
    postConsole(active, 'from the active frame');

    expect(inspectStore.getConsoleEntries().map((entry) => entry.args[0])).toEqual([
      'from the active frame',
    ]);
  });

  it('clears captured entries when the pinned frame changes', () => {
    const first = previewFrame();
    setInspectSource(first);
    postConsole(first, 'desktop log');
    expect(inspectStore.getConsoleEntries()).toHaveLength(1);

    setInspectSource(previewFrame());
    expect(inspectStore.getConsoleEntries()).toHaveLength(0);
  });

  it('notifies subscribers when the pinned frame changes', () => {
    let notifications = 0;
    const unsubscribe = inspectStore.subscribe(() => {
      notifications += 1;
    });
    setInspectSource(previewFrame());
    expect(notifications).toBe(1);
    unsubscribe();
  });

  it('is a no-op when the same frame is pinned twice', () => {
    const frame = previewFrame();
    setInspectSource(frame);
    postConsole(frame, 'kept');
    setInspectSource(frame);
    expect(inspectStore.getConsoleEntries()).toHaveLength(1);
  });
});
