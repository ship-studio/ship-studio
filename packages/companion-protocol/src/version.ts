/**
 * Protocol version negotiation.
 *
 * One integer, bumped only for a breaking change (a field removed or retyped,
 * a method's meaning changed). Adding an optional field, a method or an event
 * is not breaking: both sides ignore what they don't know, and the phone
 * learns which methods the Mac has from `welcome.methods`.
 *
 * The Mac keeps answering the previous version for at least one release after
 * a bump, so an app that hasn't taken its OTA update yet keeps working.
 */

export const PROTOCOL_VERSION = 1;
export const MIN_PROTOCOL_VERSION = 1;

export interface ProtocolRange {
  min: number;
  max: number;
}

export const SUPPORTED: ProtocolRange = { min: MIN_PROTOCOL_VERSION, max: PROTOCOL_VERSION };

export type Negotiation =
  | { ok: true; version: number }
  /** Which side has to update, named so the message can say which. */
  | { ok: false; update: 'app' | 'mac' };

/** The highest version both speak; otherwise which side is behind. */
export function negotiate(phone: ProtocolRange, mac: ProtocolRange): Negotiation {
  if (phone.max < mac.min) return { ok: false, update: 'app' };
  if (mac.max < phone.min) return { ok: false, update: 'mac' };
  return { ok: true, version: Math.min(phone.max, mac.max) };
}
