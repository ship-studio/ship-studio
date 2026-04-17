import * as Sentry from '@sentry/react';

declare const __APP_VERSION__: string;

const DSN =
  'https://ca46a435b1b22d7b60f2a83817395fb6@o4511226863353856.ingest.us.sentry.io/4511226875412480';

// Paths, project names, and branch names appear in error messages, breadcrumbs,
// and `tracing` spans. Strip anything that looks like a home dir so we don't
// ship local filesystem layout (usernames, project folders) to Sentry.
function scrub<T>(value: T): T {
  if (typeof value === 'string') {
    return value
      .replace(/\/Users\/[^/\s"']+/g, '/Users/<redacted>')
      .replace(/\/home\/[^/\s"']+/g, '/home/<redacted>')
      .replace(/C:\\Users\\[^\\"'\s]+/g, 'C:\\Users\\<redacted>') as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map(scrub) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrub(v);
    }
    return out as unknown as T;
  }
  return value;
}

const forceEnabled = import.meta.env.VITE_SENTRY_FORCE === '1';

if (import.meta.env.PROD || forceEnabled) {
  Sentry.init({
    dsn: DSN,
    environment: import.meta.env.PROD ? 'production' : 'development',
    release: `ship-studio@${__APP_VERSION__}`,

    sendDefaultPii: false,

    integrations: [Sentry.browserTracingIntegration()],

    tracesSampleRate: 0.1,

    beforeSend(event) {
      return scrub(event);
    },
    beforeBreadcrumb(breadcrumb) {
      return scrub(breadcrumb);
    },
  });
}
