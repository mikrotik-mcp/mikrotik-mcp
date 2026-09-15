import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { REPORT_VIEW_TOOLS } from "../src/core/report-views";

/**
 * Build config for the MCP App views (run via `vp build -c ui/vite.config.ts`,
 * the vite-plus toolchain — no standalone Vite).
 *
 * Each view is built as a **separate single-entry build** (driven by the
 * `MCP_VIEW` env var) with `inlineDynamicImports: true`, so the entire view
 * — including the `@modelcontextprotocol/ext-apps` SDK — lands in one JS
 * chunk with no shared runtime chunk. `scripts/build-ui.ts` then inlines that
 * chunk into a single self-contained `dist/ui/<id>.html` (required because the
 * host renders MCP App views in a sandboxed iframe that can't fetch siblings).
 *
 * `base: "./"` keeps asset references relative so the inliner can resolve them;
 * a huge `assetsInlineLimit` + `cssCodeSplit: false` push as much as possible
 * inline already.
 */
const here = dirname(fileURLToPath(import.meta.url));

/** All MCP App view entries (must match directories under `ui/`). */
const ALL_VIEWS: Record<string, string> = {
  dashboard: resolve(here, "dashboard/index.html"),
  records: resolve(here, "records/index.html"),
  interfaces: resolve(here, "interfaces/index.html"),
  firewall: resolve(here, "firewall/index.html"),
  "firewall-audit": resolve(here, "firewall-audit/index.html"),
  "connected-devices": resolve(here, "connected-devices/index.html"),
  aaa: resolve(here, "aaa/index.html"),
  ...Object.fromEntries(
    Object.keys(REPORT_VIEW_TOOLS).map((id) => [id, resolve(here, `${id}/index.html`)]),
  ),
};

// When MCP_VIEW is set, build only that view as a single-entry build so
// `inlineDynamicImports` can be used. The build script sets this per view.
const singleView = process.env.MCP_VIEW;
const input = singleView
  ? { [singleView]: ALL_VIEWS[singleView] ?? resolve(here, `${singleView}/index.html`) }
  : ALL_VIEWS;

export default defineConfig({
  root: here,
  base: "./",
  build: {
    outDir: resolve(here, "../dist/ui-build"),
    // The build script manages cleanup — individual view builds must not wipe
    // each other's output.
    emptyOutDir: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input,
      output: singleView ? { codeSplitting: false } : {},
    },
  },
});
