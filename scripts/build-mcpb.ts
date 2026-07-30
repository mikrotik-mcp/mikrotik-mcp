#!/usr/bin/env bun
/**
 * Builds MCP Bundles (`.mcpb`) — one per platform/arch.
 *
 * The server is Bun-native (`bun:sqlite`, `Bun.serve`, `Bun.S3Client`, and
 * `@tikoci/centrs`, which ships raw TypeScript), so it cannot run on the Node
 * runtime an MCPB host provides. Rather than gut those subsystems, each bundle
 * **vendors the Bun binary** it was built against and points `mcp_config.command`
 * at it:
 *
 *     runtime/bun  dist/cli.js  serve
 *
 * That keeps the normal on-disk layout, so `src/paths.ts` — which walks up from
 * the running module to the nearest `package.json` — still resolves `prompts/`
 * and `dist/ui/` exactly as it does in a published npm install. Nothing under
 * `src/` has to know it is running inside a bundle.
 *
 * Subprocesses go through `Bun.spawnSync` with an argv array (never a shell
 * string), so no argument is ever interpreted by a shell.
 *
 * Usage:
 *   bun run scripts/build-mcpb.ts                  # host platform
 *   bun run scripts/build-mcpb.ts --target linux-x64
 *   bun run scripts/build-mcpb.ts --all            # every target
 *   bun run scripts/build-mcpb.ts --skip-build     # reuse dist/ as-is
 *   bun run scripts/build-mcpb.ts --no-smoke       # skip the stdio smoke test
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_DIR = join(ROOT, ".mcpb-build");
const CACHE_DIR = join(ROOT, ".mcpb-cache");
const OUT_DIR = join(ROOT, "dist-mcpb");

/** A bundle target: which Bun release asset to vendor, under which MCPB platform. */
interface Target {
  /** MCPB `compatibility.platforms` value. */
  platform: "darwin" | "linux" | "win32";
  /** Bun release asset basename (no `.zip`). */
  asset: string;
  /** Executable name inside `runtime/`. */
  exe: string;
}

const TARGETS: Record<string, Target> = {
  "darwin-arm64": { platform: "darwin", asset: "bun-darwin-aarch64", exe: "bun" },
  "darwin-x64": { platform: "darwin", asset: "bun-darwin-x64", exe: "bun" },
  "linux-x64": { platform: "linux", asset: "bun-linux-x64", exe: "bun" },
  "linux-arm64": { platform: "linux", asset: "bun-linux-aarch64", exe: "bun" },
  "win32-x64": { platform: "win32", asset: "bun-windows-x64", exe: "bun.exe" },
};

/** Copied verbatim into the stage — everything the server reads from disk at runtime. */
// `policies/` ships too: the policy engine loads its starter pack from the
// package root, and a bundle without it starts with zero rules.
const COPY = [
  "dist",
  "prompts",
  "policies",
  "assets/icon.png",
  "assets/flags",
  "README.md",
  "LICENSE",
];

interface PkgJson {
  name: string;
  version: string;
  description: string;
  homepage: string;
  logoIcon: string;
  license: string;
  author: unknown;
  dependencies: Record<string, string>;
  packageManager: string;
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as PkgJson;

/** The Bun version to vendor — pinned by `packageManager`, so bundles are reproducible. */
const BUN_VERSION = (() => {
  const m = /^bun@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager ?? "");
  if (!m) throw new Error(`package.json "packageManager" must pin bun, got: ${pkg.packageManager}`);
  return m[1]!;
})();

/** This script always runs under Bun; alias the global so `no-undef` stays happy. */
const bun = globalThis.Bun;

const log = (msg: string): void => void process.stdout.write(`${msg}\n`);

/** Run a command from an argv array. No shell, so no argument is ever re-parsed. */
function run(cmd: string[], cwd = ROOT): void {
  const res = bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (res.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (exit ${res.exitCode})`);
}

/** Download the pinned Bun release for `target`, caching the archive between builds. */
async function fetchBun(target: Target): Promise<string> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const zip = join(CACHE_DIR, `${target.asset}-${BUN_VERSION}.zip`);
  const dir = join(CACHE_DIR, `${target.asset}-${BUN_VERSION}`);
  const exe = join(dir, target.asset, target.exe);
  if (existsSync(exe)) return exe;

  if (!existsSync(zip)) {
    const url = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${target.asset}.zip`;
    log(`  ↓ ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
    // Buffer the body before writing: `Bun.write(path, response)` streams the
    // redirected release asset at a crawl (minutes for ~23MB), `arrayBuffer()` does not.
    await bun.write(zip, await res.arrayBuffer());
  }
  // `unzip` preserves the executable bit; Bun ships no archive API of its own.
  run(["unzip", "-o", "-q", zip, "-d", dir]);
  if (!existsSync(exe)) throw new Error(`Bun executable missing in archive: ${exe}`);
  return exe;
}

/**
 * Tool names, read from the catalog `src/tools/index.ts` declares as the single
 * source of truth — so the manifest's tool list can never drift from the real one.
 */
async function toolNames(): Promise<string[]> {
  const { moduleCatalog } = (await import("../src/tools/index")) as {
    moduleCatalog: { tools: { name: string }[] }[];
  };
  return moduleCatalog.flatMap((m) => m.tools.map((t) => t.name)).sort();
}

/** Drive the staged server over stdio and assert it answers `initialize` + `tools/list`. */
function smokeTest(stage: string, target: Target, expected: number): void {
  const requests = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcpb-smoke","version":"1"}}}',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
    "",
  ].join("\n");

  const res = bun.spawnSync(
    [join(stage, "runtime", target.exe), join(stage, "dist", "cli.js"), "serve"],
    {
      stdin: new TextEncoder().encode(requests),
      stdout: "pipe",
      stderr: "pipe",
      // The smoke test never opens a connection — it exercises only the MCP
      // handshake and the static tool catalog — so the address need not resolve.
      env: { ...process.env, MIKROTIK_HOST: "192.0.2.1", MIKROTIK_DISABLE_UPDATE_CHECK: "1" },
    },
  );

  const stderr = res.stderr.toString();
  const messages = res.stdout
    .toString()
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => JSON.parse(l) as { id?: number; result?: Record<string, unknown> });

  if (!messages.find((m) => m.id === 1)?.result) {
    throw new Error(`smoke test: no initialize response.\n${stderr}`);
  }
  const tools = messages.find((m) => m.id === 2)?.result?.tools as
    | { name: string; inputSchema?: unknown }[]
    | undefined;
  if (!tools?.length) throw new Error(`smoke test: no tools/list response.\n${stderr}`);
  if (tools.length !== expected) {
    throw new Error(
      `smoke test: server listed ${tools.length} tools, manifest declares ${expected}`,
    );
  }
  const untyped = tools.filter((t) => !t.inputSchema);
  if (untyped.length) throw new Error(`smoke test: ${untyped.length} tools have no inputSchema`);

  log(`  ✓ smoke: initialize + ${tools.length} tools, each with an inputSchema`);
}

function hostSlug(): string {
  return `${platform()}-${arch()}`;
}

async function buildTarget(slug: string, target: Target, opts: { smoke: boolean }): Promise<void> {
  log(`\n▸ ${slug}`);
  const stage = join(BUILD_DIR, slug);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, "runtime"), { recursive: true });

  // 1) A minimal package.json. It is both the root marker `src/paths.ts` walks up to
  // and the file `src/version.ts` reads for VERSION. It deliberately drops
  // devDependencies/overrides, which use Bun's `catalog:` protocol that npm cannot parse.
  writeFileSync(
    join(stage, "package.json"),
    `${JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        description: pkg.description,
        homepage: pkg.homepage,
        logoIcon: pkg.logoIcon,
        license: pkg.license,
        author: pkg.author,
        private: true,
        type: "module",
        dependencies: pkg.dependencies,
      },
      null,
      2,
    )}\n`,
  );

  // 2) Production dependencies, installed flat by npm so the archive holds real
  // directories — Bun's isolated linker leaves symlinks that may not survive a zip.
  log("  • installing production dependencies");
  run(
    [
      "npm",
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
    ],
    stage,
  );

  // 3) Runtime assets, at the paths the server already expects.
  for (const rel of COPY) {
    const src = join(ROOT, rel);
    if (!existsSync(src)) throw new Error(`Missing bundle input: ${rel} (did the build run?)`);
    cpSync(src, join(stage, rel), { recursive: true });
  }

  // 4) The vendored Bun runtime.
  const staged = join(stage, "runtime", target.exe);
  cpSync(await fetchBun(target), staged);
  chmodSync(staged, 0o755);

  // 5) A manifest specialised for this target: one platform, no overrides, and the
  // real tool list pulled from the catalog.
  const names = await toolNames();
  const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8")) as Record<
    string,
    any
  >;
  if (manifest.version !== pkg.version) {
    throw new Error(
      `manifest.json version ${manifest.version} != package.json ${pkg.version}. Bump both.`,
    );
  }
  manifest.server.entry_point = `runtime/${target.exe}`;
  manifest.server.mcp_config.command = `\${__dirname}/runtime/${target.exe}`;
  delete manifest.server.mcp_config.platform_overrides;
  manifest.compatibility.platforms = [target.platform];
  manifest.tools = names.map((name) => ({ name }));
  writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // 6) Validate, smoke-test, pack.
  run(["bunx", "mcpb", "validate", join(stage, "manifest.json")]);
  if (!opts.smoke) {
    // nothing to do
  } else if (slug !== hostSlug()) {
    log(`  • smoke test skipped (cannot execute ${slug} on ${hostSlug()})`);
  } else {
    smokeTest(stage, target, names.length);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  run([
    "bunx",
    "mcpb",
    "pack",
    stage,
    join(OUT_DIR, `${manifest.name}-${pkg.version}-${slug}.mcpb`),
  ]);
}

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(`--${n}`);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? undefined : argv[i + 1];
};

const slugs = flag("all") ? Object.keys(TARGETS) : [opt("target") ?? hostSlug()];
for (const slug of slugs) {
  if (!TARGETS[slug])
    throw new Error(`Unknown target "${slug}". Known: ${Object.keys(TARGETS).join(", ")}`);
}

if (!flag("skip-build")) {
  log("▸ building dist/ (server + UI views)");
  run(["bun", "run", "build"]);
}

for (const slug of slugs) await buildTarget(slug, TARGETS[slug]!, { smoke: !flag("no-smoke") });

log(`\n✓ bundles written to ${OUT_DIR}`);
