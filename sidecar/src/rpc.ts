/**
 * JSON-RPC 2.0 protocol layer for stdio communication.
 *
 * Messages are newline-delimited JSON objects on stdin/stdout.
 * Stderr is reserved for debug logging (not part of the protocol).
 *
 * @module rpc
 */

// ============ Types ============

export interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: RpcError;
}

export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

// Standard JSON-RPC error codes
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

// Custom error codes
export const RPC_AGENT_ERROR = -32000;
export const RPC_CANCELLED = -32001;

// ============ Parsing ============

export function parseMessage(line: string): RpcRequest | null {
  try {
    const msg = JSON.parse(line);
    if (msg.jsonrpc !== "2.0" || typeof msg.id !== "number" || typeof msg.method !== "string") {
      return null;
    }
    return msg as RpcRequest;
  } catch {
    return null;
  }
}

// ============ Serialization ============

export function sendResponse(id: number, result: unknown): void {
  const response: RpcResponse = { jsonrpc: "2.0", id, result };
  process.stdout.write(JSON.stringify(response) + "\n");
}

export function sendError(id: number, code: number, message: string, data?: unknown): void {
  const response: RpcResponse = {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
  process.stdout.write(JSON.stringify(response) + "\n");
}

export function sendNotification(method: string, params: Record<string, unknown>): void {
  const notification: RpcNotification = { jsonrpc: "2.0", method, params };
  process.stdout.write(JSON.stringify(notification) + "\n");
}

// ============ Debug Logging (stderr only) ============

export function debug(message: string, data?: unknown): void {
  const entry = data !== undefined
    ? `[sidecar] ${message} ${JSON.stringify(data)}`
    : `[sidecar] ${message}`;
  process.stderr.write(entry + "\n");
}
