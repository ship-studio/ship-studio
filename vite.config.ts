import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { readFileSync } from "fs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, "package.json"), "utf-8")
) as { version: string };

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  build: {
    chunkSizeWarningLimit: 1000,
    // Explicit transpile floor. Vite 7's implicit default is safari16, which
    // excludes macOS 12 (Safari 15) — a bundle its WebKit can't parse throws
    // before React mounts and the user sees a black window (issue #173).
    // safari15 keeps macOS 12 parseable for a few KB of extra transpilation.
    // Note esbuild only down-levels syntax, not runtime APIs — don't use
    // Safari-16+-only APIs at module scope. Raising this floor is a product
    // decision tied to the minimum supported macOS version, not a routine
    // dependency chore.
    target: ["chrome107", "edge107", "firefox104", "safari15"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1420,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
