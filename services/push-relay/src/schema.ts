/**
 * The relay's whole input surface, checked strictly. Anything not listed is
 * refused by name, so a field like `body`, `title` or `text` can never carry
 * a message to Apple or Google, whoever builds the Mac side.
 */

export const KINDS = ['needs_you', 'finished', 'message'] as const;
export type Kind = (typeof KINDS)[number];

export interface SendBody {
  /** The Mac's handle for the phone, as registered. */
  device: string;
  kind: Kind;
  /** An opaque agent id, so tapping opens that chat. Never a name. */
  agent?: string;
  badge?: number;
}

export interface RegisterBody {
  platform: 'ios' | 'android';
  token: string;
  /** Which APNs the token belongs to (TestFlight and the App Store are production). */
  environment: 'production' | 'development';
}

/** Bodies are tiny; anything bigger is not ours. */
export const MAX_BODY_BYTES = 1024;

/** Device handles and agent ids: opaque, short, URL-safe. */
const OPAQUE = /^[A-Za-z0-9_-]{1,64}$/;
const APNS_TOKEN = /^[0-9a-f]{64,200}$/;
const FCM_TOKEN = /^[A-Za-z0-9_:-]{20,1024}$/;

export class Invalid extends Error {
  constructor(
    readonly code: 'bad_json' | 'unknown_field' | 'bad_field' | 'too_large',
    readonly field?: string
  ) {
    super(field ? `${code}: ${field}` : code);
  }
}

export function isOpaque(value: string): boolean {
  return OPAQUE.test(value);
}

/** A JSON object with exactly the allowed keys, or `Invalid`. */
export async function readObject(
  request: Request,
  allowed: readonly string[]
): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) throw new Invalid('too_large');
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) throw new Invalid('too_large');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Invalid('bad_json');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Invalid('bad_json');
  }
  const extra = Object.keys(value).find((k) => !allowed.includes(k));
  if (extra !== undefined) throw new Invalid('unknown_field', extra);
  return value as Record<string, unknown>;
}

export async function parseSend(request: Request): Promise<SendBody> {
  const o = await readObject(request, ['device', 'kind', 'agent', 'badge']);
  if (typeof o.device !== 'string' || !isOpaque(o.device)) throw new Invalid('bad_field', 'device');
  if (typeof o.kind !== 'string' || !(KINDS as readonly string[]).includes(o.kind)) {
    throw new Invalid('bad_field', 'kind');
  }
  if (o.agent !== undefined && (typeof o.agent !== 'string' || !isOpaque(o.agent))) {
    throw new Invalid('bad_field', 'agent');
  }
  if (
    o.badge !== undefined &&
    (typeof o.badge !== 'number' || !Number.isInteger(o.badge) || o.badge < 0 || o.badge > 9999)
  ) {
    throw new Invalid('bad_field', 'badge');
  }
  return {
    device: o.device,
    kind: o.kind as Kind,
    agent: o.agent as string | undefined,
    badge: o.badge as number | undefined,
  };
}

export async function parseRegister(request: Request): Promise<RegisterBody> {
  const o = await readObject(request, ['platform', 'token', 'environment']);
  if (o.platform !== 'ios' && o.platform !== 'android') throw new Invalid('bad_field', 'platform');
  const pattern = o.platform === 'ios' ? APNS_TOKEN : FCM_TOKEN;
  if (typeof o.token !== 'string' || !pattern.test(o.token))
    throw new Invalid('bad_field', 'token');
  const environment = o.environment ?? 'production';
  if (environment !== 'production' && environment !== 'development') {
    throw new Invalid('bad_field', 'environment');
  }
  return { platform: o.platform, token: o.token, environment };
}
