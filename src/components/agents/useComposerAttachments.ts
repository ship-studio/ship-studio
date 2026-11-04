/**
 * Files staged in the composer before they are sent, and the three ways they
 * arrive: pasted, dropped on the chat, or picked with the paperclip.
 *
 * A picked or dropped file is sent by path and copied by the backend; a
 * pasted image only exists in memory, so it is sent as bytes.
 *
 * @module components/agents/useComposerAttachments
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type RefObject,
} from 'react';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import {
  formatBytes,
  inspectFiles,
  isImageMime,
  localFileUrl,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  type OutgoingAttachment,
} from '../../lib/agents';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { dropPointToLogical, isPointInRect, type DropPoint } from '../../lib/dropTarget';
import { isWindows } from '../../lib/setup';

export interface DraftAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** On disk: picked, or dropped from Finder. */
  path?: string;
  /** In memory: pasted, or dropped in a browser. */
  file?: File;
  /** For images: what the chip shows. */
  previewUrl?: string;
}

let nextId = 0;
const draftId = () => `draft-${++nextId}`;

const tooBig = (name: string, size: number) =>
  `${name} is ${formatBytes(size)}. Files can be up to ${formatBytes(MAX_ATTACHMENT_BYTES)}.`;
const tooMany = `You can attach up to ${MAX_ATTACHMENTS} files at a time.`;

/** A pasted screenshot arrives as "image.png"; give it a name worth keeping. */
function pastedName(file: File): string {
  if (file.name && file.name !== 'image.png') return file.name;
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' at ').replace(/:/g, '.');
  return `Pasted image ${stamp}.${file.type.split('/')[1] || 'png'}`;
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',', 2)[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error(`Couldn't read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

export function useComposerAttachments(onError: (message: string) => void) {
  const [items, setItems] = useState<DraftAttachment[]>([]);
  const itemsRef = useRef(items);
  useLayoutEffect(() => {
    itemsRef.current = items;
  }, [items]);
  const objectUrls = useRef<string[]>([]);

  useEffect(
    () => () => {
      objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
    },
    []
  );

  /** Adds what fits under the count limit and says what didn't. */
  const add = useCallback(
    (incoming: DraftAttachment[]) => {
      if (incoming.length === 0) return;
      const room = MAX_ATTACHMENTS - itemsRef.current.length;
      if (incoming.length > room) onError(tooMany);
      const accepted = incoming.slice(0, Math.max(room, 0));
      if (accepted.length) setItems((current) => [...current, ...accepted]);
    },
    [onError]
  );

  const addFiles = useCallback(
    (files: File[]) => {
      const fitting = files.filter((file) => {
        if (file.size <= MAX_ATTACHMENT_BYTES) return true;
        onError(tooBig(file.name || 'That file', file.size));
        return false;
      });
      add(
        fitting.map((file) => {
          const mime = file.type || 'application/octet-stream';
          const name = mime.startsWith('image/') ? pastedName(file) : file.name || 'file';
          let previewUrl: string | undefined;
          if (isImageMime(mime)) {
            previewUrl = URL.createObjectURL(file);
            objectUrls.current.push(previewUrl);
          }
          return { id: draftId(), name, mime, size: file.size, file, previewUrl };
        })
      );
    },
    [add, onError]
  );

  const addPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      if (itemsRef.current.length + paths.length > MAX_ATTACHMENTS) {
        onError(tooMany);
        paths = paths.slice(0, Math.max(MAX_ATTACHMENTS - itemsRef.current.length, 0));
      }
      try {
        const infos = await inspectFiles(paths);
        add(
          infos.map((info) => ({
            id: draftId(),
            ...info,
            previewUrl: isImageMime(info.mime) ? localFileUrl(info.path) : undefined,
          }))
        );
      } catch (error) {
        onError(formatCommandError(asCommandError(error)));
      }
    },
    [add, onError]
  );

  const pick = useCallback(async () => {
    const picked = await open({ multiple: true, title: 'Attach files' });
    if (picked) await addPaths(Array.isArray(picked) ? picked : [picked]);
  }, [addPaths]);

  const remove = useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  /** Clipboard images and files become attachments; plain text pastes as usual. */
  const onPaste = useCallback(
    (event: React.ClipboardEvent) => {
      const files = Array.from(event.clipboardData.files);
      if (files.length === 0) return;
      event.preventDefault();
      addFiles(files);
    },
    [addFiles]
  );

  return { items, setItems, addFiles, addPaths, pick, remove, onPaste };
}

/** What `agents_send` takes for the staged files. */
export function toOutgoing(items: DraftAttachment[]): Promise<OutgoingAttachment[]> {
  return Promise.all(
    items.map(async (item) =>
      item.path
        ? { name: item.name, path: item.path }
        : { name: item.name, data: await toBase64(item.file as File) }
    )
  );
}

const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');

/**
 * Whether files are being dragged over `target`, and the drop.
 *
 * In the app, Tauri owns file drags: the webview never sees them, and the
 * window-global `tauri://drag-*` events carry paths and a position, so the
 * drop is routed by hit-testing (see lib/dropTarget). In a plain browser (the
 * UI harness) the DOM's own drag events carry the files instead; the returned
 * handlers cover that case and are inert in the app.
 */
export function useFileDrop(
  target: RefObject<HTMLElement | null>,
  enabled: boolean,
  onPaths: (paths: string[]) => void,
  onFiles: (files: File[]) => void
) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const handlers = useRef({ onPaths, enabled });
  useLayoutEffect(() => {
    handlers.current = { onPaths, enabled };
  }, [onPaths, enabled]);

  useEffect(() => {
    const inside = (position: DropPoint) => {
      const el = target.current;
      if (!el || !handlers.current.enabled) return false;
      const point = dropPointToLogical(position, isWindows(), window.devicePixelRatio);
      return isPointInRect(point, el.getBoundingClientRect());
    };
    type Payload = { paths?: string[]; position: DropPoint };
    const subscriptions = [
      listen<Payload>('tauri://drag-enter', (e) => setOver(inside(e.payload.position))),
      listen<Payload>('tauri://drag-over', (e) => setOver(inside(e.payload.position))),
      listen('tauri://drag-leave', () => setOver(false)),
      listen<Payload>('tauri://drag-drop', (e) => {
        setOver(false);
        if (inside(e.payload.position) && e.payload.paths?.length) {
          handlers.current.onPaths(e.payload.paths);
        }
      }),
    ];
    return () => {
      subscriptions.forEach((p) => void p.then((unlisten) => unlisten()).catch(() => {}));
    };
  }, [target]);

  const dom = {
    onDragEnter: (e: DragEvent) => {
      if (!enabled || !hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!enabled || !hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: DragEvent) => {
      if (!enabled || !hasFiles(e)) return;
      depth.current = Math.max(depth.current - 1, 0);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (e: DragEvent) => {
      if (!enabled || !hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      onFiles(Array.from(e.dataTransfer.files));
    },
  };

  return { over, dom };
}
