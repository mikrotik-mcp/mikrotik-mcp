#!/usr/bin/env bun
/**
 * `bun run start:dev`: the server in watch mode, with a current dashboard.
 *
 * The server serves the built page (`dist/ui/observability.html`), and watch
 * mode reloads only the server's own source. So before the server starts, the
 * UI is rebuilt when a file under `ui/` is newer than the built page. A fresh
 * build costs nothing here.
 *
 * For live UI work (no rebuild, hot reload) use `bun run dev:all`.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** The newest modification time of the files under `dir`. */
function newest(dir: string): number {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs);
  }
  return latest;
}

/** True when the built page is missing, or older than a file of the UI source. */
export function uiIsStale(sourceDir: string, builtPage: string): boolean {
  try {
    return newest(sourceDir) > statSync(builtPage).mtimeMs;
  } catch {
    return true;
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "..");
  const run = (args: string[]): number =>
    spawnSync("bun", args, { cwd: root, stdio: "inherit" }).status ?? 1;

  if (uiIsStale(join(root, "ui"), join(root, "dist", "ui", "observability.html"))) {
    console.error("The dashboard UI changed since its last build. Building it…");
    // A failed build must not stop the server: it then serves the previous page.
    if (run(["run", "build:ui"]) !== 0)
      console.error("The UI build failed. The server starts with the previous page.");
  }
  process.exit(run(["run", "--watch", "--bun", "src/cli.ts", "serve", ...process.argv.slice(2)]));
}
