import { spawn as nativeSpawn, type IPty, type IPtyForkOptions } from 'tauri-pty';

export type { IPty } from 'tauri-pty';
export type ShipPty = IPty & { _init?: Promise<void> };

interface Session {
  data: Set<(data: Uint8Array) => void>;
  exit: Set<(event: { exitCode: number; signal?: number }) => void>;
  resolve: (pid: number) => void;
  reject: (error: Error) => void;
}

const sessions = new Map<string, Session>();
let socket: WebSocket | null = null;
let opening: Promise<WebSocket> | null = null;

export function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

function connection(): Promise<WebSocket> {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket);
  if (opening) return opening;

  opening = new Promise((resolve, reject) => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/api/pty`);
    ws.onopen = () => {
      socket = ws;
      opening = null;
      resolve(ws);
    };
    ws.onerror = () => {
      opening = null;
      reject(new Error('PTY WebSocket connection failed'));
    };
    ws.onmessage = ({ data }) => dispatch(JSON.parse(String(data)) as ServerFrame);
    ws.onclose = () => {
      socket = null;
      opening = null;
      for (const session of sessions.values()) {
        session.reject(new Error('PTY WebSocket closed'));
        for (const listener of session.exit) listener({ exitCode: -1 });
      }
      sessions.clear();
    };
  });
  return opening;
}

type ServerFrame =
  | { type: 'spawned'; id: string; pid: number }
  | { type: 'data'; id: string; data: number[] }
  | { type: 'exit'; id: string; exitCode: number }
  | { type: 'error'; id?: string; message: string };

function dispatch(frame: ServerFrame): void {
  if (!frame.id) return;
  const session = sessions.get(frame.id);
  if (!session) return;
  if (frame.type === 'spawned') session.resolve(frame.pid);
  if (frame.type === 'data') {
    const bytes = new Uint8Array(frame.data);
    for (const listener of session.data) listener(bytes);
  }
  if (frame.type === 'exit') {
    for (const listener of session.exit) listener({ exitCode: frame.exitCode });
    sessions.delete(frame.id);
  }
  if (frame.type === 'error') {
    session.reject(new Error(frame.message));
    sessions.delete(frame.id);
  }
}

function send(frame: Record<string, unknown> & { id?: string }): void {
  void connection()
    .then((ws) => ws.send(JSON.stringify(frame)))
    .catch((error: unknown) => {
      if (!frame.id) return;
      sessions.get(frame.id)?.reject(error instanceof Error ? error : new Error(String(error)));
      sessions.delete(frame.id);
    });
}

export function spawn(file: string, args: string[] | string, options: IPtyForkOptions): ShipPty {
  if (isTauriRuntime()) return nativeSpawn(file, args, options) as ShipPty;

  const id = crypto.randomUUID();
  let pid = 0;
  let cols = options.cols ?? 80;
  let rows = options.rows ?? 24;
  const data = new Set<(chunk: Uint8Array) => void>();
  const exit = new Set<(event: { exitCode: number; signal?: number }) => void>();
  const init = new Promise<void>((resolve, reject) => {
    sessions.set(id, {
      data,
      exit,
      resolve: (value) => {
        pid = value;
        resolve();
      },
      reject,
    });
  });

  send({
    op: 'spawn',
    id,
    file,
    args: typeof args === 'string' ? [args] : args,
    cwd: options.cwd ?? null,
    env: options.env ?? {},
    cols,
    rows,
  });

  return {
    get pid() {
      return pid;
    },
    get cols() {
      return cols;
    },
    get rows() {
      return rows;
    },
    process: file,
    handleFlowControl: false,
    _init: init,
    onData: (listener) => {
      data.add(listener);
      return { dispose: () => data.delete(listener) };
    },
    onExit: (listener) => {
      exit.add(listener);
      return { dispose: () => exit.delete(listener) };
    },
    write: (value) => send({ op: 'write', id, data: Array.from(new TextEncoder().encode(value)) }),
    resize: (columns, newRows) => {
      cols = columns;
      rows = newRows;
      send({ op: 'resize', id, cols, rows });
    },
    kill: () => send({ op: 'kill', id }),
    clear: () => {},
    pause: () => {},
    resume: () => {},
  };
}
