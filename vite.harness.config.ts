/**
 * Vite config for the browser harness.
 *
 * Extends the production config and swaps the modules that require a native
 * Tauri side for inert stubs — the browser equivalent of the `vi.mock` calls
 * in `src/test/setup.ts`. Kept as its own config so nothing here can leak into
 * a shipped build.
 */

import { defineConfig, mergeConfig, type Plugin, type UserConfig } from 'vite';
import { execSync } from 'child_process';
import path from 'path';
import base from './vite.config';

/**
 * The harness announces which checkout it is serving.
 *
 * Without this, `harness-capture.mjs` could only ask "is something listening on
 * the harness port". On a machine running several worktrees that is a different
 * question from "is *my* harness listening", and answering the easy one meant a
 * capture could attach to another worktree's server and write a full set of
 * confidently-labelled screenshots of a tree it was never pointed at. Every
 * other failure in the capture path is loud; that one wrote green checkmarks.
 */
function identityPlugin(): Plugin {
  const root = process.cwd();
  let head = 'unknown';
  try {
    head = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf-8' }).trim();
  } catch {
    // Not a git checkout, or git is unavailable. The root comparison is the
    // load-bearing half; HEAD is only there to make a mismatch legible.
  }

  return {
    name: 'shipstudio-harness-identity',
    configureServer(server) {
      server.middlewares.use('/__harness/identity', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ root, head }));
      });
    },
  };
}

/**
 * Worktrees would otherwise serialise on one port — `strictPort` means the
 * second harness fails to start, and with four sessions live that is a real
 * cost. Overriding the port lets them run side by side.
 */
const PORT = Number(process.env.SHIPSTUDIO_HARNESS_PORT ?? 1425);

export default defineConfig(async (env) => {
  const resolved = (await (base as unknown as (e: typeof env) => Promise<UserConfig>)(
    env
  )) as UserConfig;

  return mergeConfig(resolved, {
    plugins: [identityPlugin()],
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
    server: { port: PORT, strictPort: true, host: '127.0.0.1' },
  } satisfies UserConfig);
});
