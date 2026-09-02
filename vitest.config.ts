import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";
import path from "path";
import { readFileSync } from "fs";

// Mirror vite.config.ts so code reading __APP_VERSION__ behaves under test.
const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, "package.json"), "utf-8")
) as { version: string };

export default defineConfig({
  plugins: [
    svgr({
      include: "**/*.svg?react",
      esbuildOptions: {
        jsx: "automatic",
      },
      svgrOptions: {
        plugins: ["@svgr/plugin-svgo", "@svgr/plugin-jsx"],
        jsxRuntime: "automatic",
        dimensions: false,
        expandProps: "end",
        ref: true,
        titleProp: true,
        replaceAttrValues: {
          "#979797": "currentColor",
        },
        svgProps: {
          focusable: "false",
        },
        svgoConfig: {
          plugins: ["prefixIds"],
        },
      },
    }),
    react(),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/",
        "src/test/",
        "src/**/*.d.ts",
        "src/main.tsx",
      ],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "tauri-pty": path.resolve(__dirname, "./src/test/mocks/tauri-pty.ts"),
      "tauri-plugin-screenshots-api": path.resolve(__dirname, "./src/test/mocks/tauri-plugin-screenshots-api.ts"),
    },
  },
});
