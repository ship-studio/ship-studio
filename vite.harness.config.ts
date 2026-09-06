/**
 * Vite config for the browser harness.
 *
 * Extends the production config and swaps the modules that require a native
 * Tauri side for inert stubs — the browser equivalent of the `vi.mock` calls
 * in `src/test/setup.ts`. Kept as its own config so nothing here can leak into
 * a shipped build.
 */

import { defineConfig, mergeConfig, type UserConfig } from 'vite';
import path from 'path';
import base from './vite.config';

export default defineConfig(async (env) => {
  const resolved = (await (base as unknown as (e: typeof env) => Promise<UserConfig>)(
    env
  )) as UserConfig;

  return mergeConfig(resolved, {
    resolve: {
      alias: {
        'tauri-pty': path.resolve(__dirname, './src/harness/stubs/tauri-pty.ts'),
        'tauri-plugin-screenshots-api': path.resolve(
          __dirname,
          './src/harness/stubs/screenshots.ts'
        ),
        '@tauri-apps/plugin-updater': path.resolve(__dirname, './src/harness/stubs/updater.ts'),
      },
    },
    server: { port: 1425, strictPort: true, host: '127.0.0.1' },
  } satisfies UserConfig);
});
