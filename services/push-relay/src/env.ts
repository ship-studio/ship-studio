/** What the Worker is given. Secrets are optional so a missing one is a 503, not a crash. */
export interface Env {
  DB: D1Database;
  /** Cloudflare's own limiter, for the one unauthenticated route. */
  CREATE_LIMITER: RateLimit;
  /** The official app's bundle id. */
  APNS_TOPIC: string;
  /** The `.p8` file's contents (PKCS#8 PEM). */
  APNS_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  /** Android, optional: a Firebase service account JSON. */
  FCM_SERVICE_ACCOUNT?: string;
}
