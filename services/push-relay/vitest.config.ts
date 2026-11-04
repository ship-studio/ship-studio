import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // Test-only stand-ins. The APNs key is generated per test run.
          bindings: {
            TEST_MIGRATIONS: migrations,
            APNS_KEY_ID: 'ABC123DEFG',
            APNS_TEAM_ID: 'TEAM123456',
          },
        },
      }),
    ],
    test: { setupFiles: ['./test/setup.ts'] },
  };
});
