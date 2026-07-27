import { describe, it, expect } from 'vitest';
import {
  isLocalSite,
  localServerCommand,
  localSiteSetupPrompt,
  planLocalServer,
  normalizeSiteUrl,
  siteHost,
  siteIsTls,
  sitePort,
  wpSshCommand,
} from './wordpress';

describe('normalizeSiteUrl', () => {
  it('adds https when the user omits a scheme', () => {
    expect(normalizeSiteUrl('example.com')).toBe('https://example.com');
    expect(normalizeSiteUrl('  myinstall.wpenginepowered.com  ')).toBe(
      'https://myinstall.wpenginepowered.com'
    );
  });

  it('strips paths, queries and trailing slashes', () => {
    expect(normalizeSiteUrl('https://example.com/')).toBe('https://example.com');
    expect(normalizeSiteUrl('https://example.com/blog?x=1#top')).toBe('https://example.com');
  });

  it('preserves an explicit scheme and port', () => {
    expect(normalizeSiteUrl('http://example.com')).toBe('http://example.com');
    expect(normalizeSiteUrl('http://localhost:8888')).toBe('http://localhost:8888');
  });

  it('rejects input that is not a host', () => {
    expect(normalizeSiteUrl('')).toBeNull();
    expect(normalizeSiteUrl('   ')).toBeNull();
    expect(normalizeSiteUrl('notahost')).toBeNull();
    expect(normalizeSiteUrl('ftp://example.com')).toBeNull();
  });
});

describe('proxy target helpers', () => {
  it('derives host, scheme and port', () => {
    expect(siteHost('https://example.com')).toBe('example.com');
    expect(siteIsTls('https://example.com')).toBe(true);
    expect(siteIsTls('http://example.com')).toBe(false);
    expect(sitePort('https://example.com')).toBe(443);
    expect(sitePort('http://example.com')).toBe(80);
    expect(sitePort('http://localhost:8888')).toBe(8888);
  });
});

describe('wpSshCommand', () => {
  it('builds a runnable ssh+wp invocation', () => {
    expect(
      wpSshCommand({
        host: 'myinstall.ssh.wpengine.net',
        user: 'myinstall',
        keyPath: '~/.ssh/myinstall_wpengine',
        wpPath: '/sites/myinstall',
      })
    ).toBe(
      'ssh -i ~/.ssh/myinstall_wpengine myinstall@myinstall.ssh.wpengine.net "wp <command> --path=/sites/myinstall"'
    );
  });

  it('omits the key flag when no key is configured', () => {
    expect(wpSshCommand({ host: 'h', user: 'u', wpPath: '/p' })).toBe(
      'ssh u@h "wp <command> --path=/p"'
    );
  });

  it('returns null when the connection is incomplete', () => {
    expect(wpSshCommand(null)).toBeNull();
    expect(wpSshCommand({ host: 'h' })).toBeNull();
    expect(wpSshCommand({ host: 'h', user: 'u' })).toBeNull();
  });
});

describe('localSiteSetupPrompt', () => {
  it('names the project path and the port the preview will use', () => {
    const prompt = localSiteSetupPrompt('/tmp/mysite', 8888);
    expect(prompt).toContain('/tmp/mysite');
    expect(prompt).toContain('--url=http://localhost:8888');
    // The agent must NOT leave a server running — Ship Studio owns it, and a
    // shell-backgrounded server dies with the session (the preview then 502s).
    expect(prompt).toContain('Do not leave a server running');
    // SQLite, not Docker — the whole point of this path.
    expect(prompt).toContain('sqlite-database-integration');
  });
});

describe('local site serving', () => {
  it('detects sites Ship Studio must serve itself', () => {
    expect(isLocalSite('http://localhost:8888')).toBe(true);
    expect(isLocalSite('http://127.0.0.1:8888')).toBe(true);
    expect(isLocalSite('https://myinstall.wpenginepowered.com')).toBe(false);
    expect(isLocalSite(null)).toBe(false);
  });

  it('serves on the port the site was installed with', () => {
    expect(localServerCommand(8888)).toContain('wp server --port=8888 --path=wp');
  });
});

describe('planLocalServer', () => {
  const INSTALL = 'wp';

  it('serves a local site on the port baked into its database', () => {
    const plan = planLocalServer('http://localhost:3455', INSTALL);
    expect(plan.serve).toBe(true);
    expect(plan.port).toBe(3455);
    expect(plan.installDir).toBe('wp');
  });

  it('never serves a project that previews a live site', () => {
    const plan = planLocalServer('https://myinstall.wpenginepowered.com', null);
    expect(plan.serve).toBe(false);
    expect(plan.reason).toMatch(/live site/);
  });

  it('never serves when there is no install on disk', () => {
    // The regression: a stale localhost URL with an empty folder made the dev
    // server run `wp server --path=wp` and exit 1 ("Directory wp does not exist").
    const plan = planLocalServer('http://localhost:3455', null);
    expect(plan.serve).toBe(false);
    expect(plan.reason).toMatch(/no WordPress install/);
  });

  it('never serves when no site is connected', () => {
    expect(planLocalServer(null, INSTALL).serve).toBe(false);
    expect(planLocalServer(undefined, null).serve).toBe(false);
  });
});

describe('localServerCommand', () => {
  it('runs multiple PHP workers so assets do not serialize', () => {
    // php -S is single-threaded by default; one blocked request stalls the page.
    expect(localServerCommand(3455, 'wp')).toBe(
      'env PHP_CLI_SERVER_WORKERS=4 wp server --port=3455 --path=wp'
    );
  });

  it('serves an install that sits at the project root', () => {
    expect(localServerCommand(3455, '.')).toContain('--path=.');
  });
});
