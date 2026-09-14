/**
 * Build the MCP App views into single self-contained HTML files.
 *
 * Each MCP App view is built as a **separate single-entry** Vite build (via the
 * `MCP_VIEW` env var) with `inlineDynamicImports: true`, so the entire view
 * — including the `@modelcontextprotocol/ext-apps` SDK — lands in one JS chunk
 * with no shared runtime chunk. A multi-entry build would extract common code
 * (the ext-apps SDK) into a sibling chunk file that the sandboxed iframe can't
 * fetch, breaking every view.
 *
 * After each build, we inline the JS/CSS assets into the HTML and write
 * `dist/ui/<id>.html`. The intermediate `dist/ui-build` is removed afterwards
 * so only the final views ship.
 *
 * Run via `bun run build:ui`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PROJECT_ROOT } from "../src/paths";

const log = (msg: string): void => void process.stdout.write(`${msg}\n`);

const BUILD_DIR = join(PROJECT_ROOT, "dist", "ui-build");
const OUT_DIR = join(PROJECT_ROOT, "dist", "ui");

/** All MCP App view ids (must match `ALL_VIEWS` in `ui/vite.config.ts`). */
const MCP_VIEWS = [
  "dashboard",
  "records",
  "interfaces",
  "firewall",
  "firewall-audit",
  "connected-devices",
  "aaa",
];

/** Inline `<script src>` / `<link rel=stylesheet>` referenced by an HTML file. */
function inline(htmlPath: string): string {
  const htmlDir = dirname(htmlPath);
  let html = readFileSync(htmlPath, "utf8");

  html = html.replace(
    /<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g,
    (_m: string, src: string) => {
      // Escape any literal `</script>` in the bundle so it can't close the tag.
      const js = readFileSync(resolve(htmlDir, src), "utf8").replace(/<\/script>/gi, "<\\/script>");
      return `<script type="module">\n${js}\n</script>`;
    },
  );

  html = html.replace(
    /<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g,
    (_m: string, href: string) => {
      const css = readFileSync(resolve(htmlDir, href), "utf8");
      return `<style>\n${css}\n</style>`;
    },
  );

  // Remove modulepreload links — these reference sibling chunks that don't
  // exist in the sandboxed iframe. With single-entry + inlineDynamicImports
  // there should be none, but strip any that slip through.
  html = html.replace(/<link\b[^>]*\brel="modulepreload"[^>]*>/g, "");

  return html;
}

/** Run a single `vp build` for one config; abort on failure. */
function build(configPath: string, label: string, env?: Record<string, string>): void {
  log(`• Building ${label} (vp build)…`);
  const res = spawnSync("bunx", ["vp", "build", "-c", configPath, "--logLevel", "warn"], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    env: env ? { ...process.env, ...env } : undefined,
  });
  if (res.status !== 0) {
    console.error(`✗ vp build failed (${label})`);
    process.exit(res.status ?? 1);
  }
}

function main(): void {
  // Clean the intermediate build directory so individual per-view builds don't
  // accumulate stale output from previous runs.
  rmSync(BUILD_DIR, { recursive: true, force: true });
  mkdirSync(BUILD_DIR, { recursive: true });

  // Build each MCP App view as a separate single-entry build so
  // inlineDynamicImports can be used — no shared runtime chunk.
  for (const view of MCP_VIEWS) {
    build("ui/vite.config.ts", `MCP App view: ${view}`, { MCP_VIEW: view });
  }

  // The React observability dashboard is already a single-entry build.
  build("ui/vite.observability.config.ts", "React observability dashboard");

  if (!existsSync(BUILD_DIR)) {
    console.error(`✗ expected build output at ${BUILD_DIR}`);
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  let count = 0;
  for (const entry of readdirSync(BUILD_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue; // skip the `assets/` siblings handled via inline
    const htmlPath = join(BUILD_DIR, entry.name, "index.html");
    if (!existsSync(htmlPath)) continue;
    const out = join(OUT_DIR, `${entry.name}.html`);
    // The dashboard ships as a single HTML file; keep vendored UI attribution
    // inside that artifact even when the source tree is absent from the bundle.
    const attribution =
      entry.name === "observability"
        ? `<!-- beUI\n${readFileSync(join(PROJECT_ROOT, "ui/observability/components/beui/LICENSE"), "utf8")}\n-->\n`
        : "";
    writeFileSync(out, attribution + inline(htmlPath));
    const kb = (readFileSync(out).byteLength / 1024).toFixed(1);
    log(`  ✓ dist/ui/${entry.name}.html (${kb} kB, self-contained)`);
    count++;
  }

  rmSync(BUILD_DIR, { recursive: true, force: true });
  log(`✓ Built ${count} MCP App view${count === 1 ? "" : "s"}.`);
}

main();
