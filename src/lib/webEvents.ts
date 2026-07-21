export type UnlistenFn = () => void;
export interface Event<T> {
  event: string;
  id: number;
  payload: T;
}

interface TauriInternals {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  transformCallback(callback: (event: unknown) => void): number;
  metadata: { currentWindow: { label: string } };
}

const handlers = new Map<string, Set<(event: Event<unknown>) => void>>();
let socket: WebSocket | null = null;
let labelPromise: Promise<string> | null = null;

export function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

function native(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

function connect(): Promise<string> {
  if (labelPromise) return labelPromise;
  labelPromise = new Promise((resolve, reject) => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}/api/events`);
    socket.onerror = () => reject(new Error('Event WebSocket connection failed'));
    socket.onclose = () => {
      socket = null;
      labelPromise = null;
    };
    socket.onmessage = ({ data }) => {
      const frame = JSON.parse(String(data)) as { event: string; payload: unknown };
      if (frame.event === 'ship-window-ready') {
        resolve((frame.payload as { windowLabel: string }).windowLabel);
        return;
      }
      const event = { ...frame, id: 0 };
      for (const handler of handlers.get(frame.event) ?? []) handler(event);
    };
  });
  return labelPromise;
}

export async function getWindowLabel(): Promise<string> {
  if (isTauriRuntime()) return native().metadata.currentWindow.label;
  return connect();
}

export async function listen<T>(
  event: string,
  handler: (event: Event<T>) => void
): Promise<UnlistenFn> {
  if (isTauriRuntime()) {
    const callback = native().transformCallback(handler as (event: unknown) => void);
    const eventId = await native().invoke<number>('plugin:event|listen', {
      event,
      target: { kind: 'Any' },
      handler: callback,
    });
    return () => {
      const internals = (
        window as unknown as {
          __TAURI_EVENT_PLUGIN_INTERNALS__: {
            unregisterListener(event: string, eventId: number): void;
          };
        }
      ).__TAURI_EVENT_PLUGIN_INTERNALS__;
      internals.unregisterListener(event, eventId);
      void native().invoke('plugin:event|unlisten', { event, eventId });
    };
  }

  const wrapped = handler as (event: Event<unknown>) => void;
  const listeners = handlers.get(event) ?? new Set();
  listeners.add(wrapped);
  handlers.set(event, listeners);
  await connect();
  return () => {
    listeners.delete(wrapped);
    if (listeners.size === 0) handlers.delete(event);
  };
}
