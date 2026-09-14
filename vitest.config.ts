import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

/**
 * Vitest config for the test suite (run via `vp test`, the vite-plus toolchain).
 * Tests live in `tests/` as `*.spec.ts` and import helpers from `vite-plus/test`.
 *
 * Vitest runs on Node, so the Bun-native `"bun"` module (imported by a few
 * source files for `S3Client` / `serve`) is aliased to an inert stub — the
 * tests load those modules but never invoke the Bun runtime APIs.
 */
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { bun: resolve(here, "tests/_stubs/bun.ts"), "@": resolve(here, "ui/observability") },
  },
  test: {
    include: ["tests/**/*.spec.ts"],
    environment: "node",
    globals: false,
    // `@tikoci/centrs` ships raw TypeScript (Bun-native). Inline it so Vitest
    // transpiles the package instead of handing its `.ts` to Node, which can't
    // load it.
    server: { deps: { inline: [/@tikoci\/centrs/] } },
  },
});
