/** D1: installations (a Mac), the phones each registered, and rate counters. */

import { b64url } from './alert';
import type { RegisterBody } from './schema';

export interface DeviceRow {
  platform: 'ios' | 'android';
  token: string;
  environment: 'production' | 'development';
}

/** Phones per installation. A Mac has a handful at most. */
export const MAX_DEVICES = 10;

const encoder = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken(bytes: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createInstallation(
  db: D1Database,
  now: number
): Promise<{ installationId: string; secret: string }> {
  const installationId = `in_${randomToken(16)}`;
  const secret = randomToken(32);
  await db
    .prepare('INSERT INTO installations (id, secret_hash, created_at) VALUES (?1, ?2, ?3)')
    .bind(installationId, await sha256Hex(secret), now)
    .run();
  return { installationId, secret };
}

/** `Authorization: Bearer <installationId>.<secret>` → the installation id, or null. */
export async function authenticate(db: D1Database, header: string | null): Promise<string | null> {
  const match = /^Bearer (in_[A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{16,128})$/.exec(header ?? '');
  if (!match) return null;
  const [, id, secret] = match;
  const row = await db
    .prepare('SELECT secret_hash FROM installations WHERE id = ?1')
    .bind(id)
    .first<{ secret_hash: string }>();
  // Hash either way, so a missing id takes as long as a wrong secret.
  const hash = await sha256Hex(secret);
  return row && equalHex(row.secret_hash, hash) ? id : null;
}

export async function deleteInstallation(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM devices WHERE installation_id = ?1').bind(id),
    db.prepare('DELETE FROM installations WHERE id = ?1').bind(id),
    ...[`i:${id}:`, `d:${id}:`].map((prefix) =>
      db.prepare('DELETE FROM rate WHERE substr(key, 1, ?2) = ?1').bind(prefix, prefix.length)
    ),
  ]);
}

/** Upsert a phone. False when the installation already has its maximum. */
export async function putDevice(
  db: D1Database,
  installation: string,
  ref: string,
  body: RegisterBody,
  now: number
): Promise<boolean> {
  const exists = await db
    .prepare('SELECT 1 FROM devices WHERE installation_id = ?1 AND ref = ?2')
    .bind(installation, ref)
    .first();
  if (!exists) {
    const count = await db
      .prepare('SELECT COUNT(*) AS n FROM devices WHERE installation_id = ?1')
      .bind(installation)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_DEVICES) return false;
  }
  await db
    .prepare(
      `INSERT INTO devices (installation_id, ref, platform, token, environment, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (installation_id, ref) DO UPDATE SET
         platform = excluded.platform, token = excluded.token,
         environment = excluded.environment, updated_at = excluded.updated_at`
    )
    .bind(installation, ref, body.platform, body.token, body.environment, now)
    .run();
  return true;
}

export async function getDevice(
  db: D1Database,
  installation: string,
  ref: string
): Promise<DeviceRow | null> {
  return db
    .prepare(
      'SELECT platform, token, environment FROM devices WHERE installation_id = ?1 AND ref = ?2'
    )
    .bind(installation, ref)
    .first<DeviceRow>();
}

export async function deleteDevice(db: D1Database, installation: string, ref: string) {
  await db.batch([
    db
      .prepare('DELETE FROM devices WHERE installation_id = ?1 AND ref = ?2')
      .bind(installation, ref),
    db.prepare('DELETE FROM rate WHERE key = ?1').bind(`d:${installation}:${ref}`),
  ]);
}

/** A token the provider says is dead goes everywhere it was registered. */
export async function forgetToken(db: D1Database, token: string): Promise<void> {
  await db.prepare('DELETE FROM devices WHERE token = ?1').bind(token).run();
}

/**
 * One hit on a fixed-window counter. Returns whether it is within `limit`.
 * The SET clause reads the old `win`, so a new window starts back at 1.
 */
export async function hit(
  db: D1Database,
  key: string,
  limit: number,
  windowMs: number,
  now: number
): Promise<boolean> {
  const win = Math.floor(now / windowMs);
  const row = await db
    .prepare(
      `INSERT INTO rate (key, win, count) VALUES (?1, ?2, 1)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN win = ?2 THEN count + 1 ELSE 1 END, win = ?2
       RETURNING count`
    )
    .bind(key, win)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}
