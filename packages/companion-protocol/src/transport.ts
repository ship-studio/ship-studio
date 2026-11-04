/**
 * The seam the future relay plugs into.
 *
 * The app's screens talk to a `Transport`, never to a socket. Today there is
 * one implementation, `DirectTransport` (WebSocket + HTTP to a route); a relay
 * becomes a second one carrying the same frames, end-to-end encrypted with the
 * keys exchanged at pairing. Nothing above this interface changes.
 */

import type { CompanionEvent } from './events';
import type { Cursor } from './frames';
import type { MethodName, Params, Result, BlobRef } from './methods';
import type { RouteKind } from './model';

export type LinkState =
  /** Trying routes in order. */
  | { kind: 'connecting'; attempt: number }
  | { kind: 'connected'; route: RouteKind | 'relay'; since: number }
  /** Was connected; retrying with backoff. `lastSeenAt` is the last frame from the Mac. */
  | { kind: 'reconnecting'; lastSeenAt: number; nextTryAt: number }
  /** The Mac said no for good: re-pair (revoked) or update a side. */
  | { kind: 'refused'; reason: 'revoked' | 'unauthorized' | 'update_app' | 'update_mac' };

export interface Transport {
  request<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>>;
  /** Every event in order. Returns an unsubscribe. */
  onEvent(listener: (event: CompanionEvent, cursor?: Cursor) => void): () => void;
  onState(listener: (state: LinkState) => void): () => void;
  upload(file: { uri: string; name: string; mime: string }): Promise<BlobRef>;
  /** A local file URI for a blob or attachment, downloaded (and cached) on demand. */
  download(source: { blobId: string } | { agentId: string; path: string }): Promise<string>;
  setForeground(foreground: boolean): void;
  close(): void;
}
