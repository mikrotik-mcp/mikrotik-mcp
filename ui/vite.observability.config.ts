import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";
import { DASHBOARD_API_PATH } from "./observability/dev-routing";

/**
 * Dedicated build for the React observability dashboard.
 *
 * It is a *single-input* build with `inlineDynamicImports: true`, so the whole
 * app (React + components) emits as one JS chunk with no shared runtime chunk —
 * which `scripts/build-ui.ts` can then inline into a single self-contained
 * `dist/ui/observability.html`. (The MCP App views are built separately in
 * `ui/vite.config.ts`; a multi-entry build would split out a runtime chunk that
 * can't be inlined.)
 *
 * `emptyOutDir: false` so this build appends to `dist/ui-build` alongside the
 * MCP-view output rather than wiping it.
 */
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ command }) => ({
  // Serve the actual SPA, including its hash routes, instead of a mock fixture.
  root: command === "serve" ? resolve(here, "observability") : here,
  base: "./",
  plugins: [tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 9191,
    strictPort: true,
    open: false,
    proxy: {
      // Do not proxy the frontend module /api.ts along with backend /api/*.
      [DASHBOARD_API_PATH]: { target: "http://127.0.0.1:9091", ws: true, changeOrigin: true },
    },
  },
  // `@/*` → the dashboard's own directory, matching the shadcn aliases in
  // components.json and the `paths` entry in the root tsconfig.
  resolve: {
    alias: { "@": resolve(here, "observability") },
  },
  build: {
    outDir: resolve(here, "../dist/ui-build"),
    emptyOutDir: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: { observability: resolve(here, "observability/index.html") },
      output: { codeSplitting: false },
    },
  },
}));
