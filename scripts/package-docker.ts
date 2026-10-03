/**
 * Assemble the Docker runtime without shipping the builder's node_modules.
 * Bun bundles ordinary dependencies (including SDK + Zod together); ssh2 and
 * figlet remain external because they resolve files relative to their package.
 * Required dependency versions come from the frozen installation, not a second
 * install/hand-maintained manifest. Optional native ssh2 accelerators are not
 * copied: install scripts are disabled and ssh2 supports pure-JS fallbacks.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

interface PackageInfo {
  name: string;
  version: string;
  license?: string;
  dependencies?: Record<string, string>;
}

const root = resolve(import.meta.dir, "..");
const output = process.argv[2];
if (!output || !isAbsolute(output) || existsSync(output)) {
  throw new Error("Pass a new absolute output directory; existing paths are never overwritten");
}
mkdirSync(output, { recursive: true });
for (const path of [
  "package.json",
  "LICENSE",
  "prompts",
  "schemas",
  "policies",
  "assets/flags",
  "dist/cli.js",
  "dist/ui",
]) {
  cpSync(join(root, path), join(output, path), { recursive: true });
}

/** Find a real package root without depending on package.json export access. */
function packageRoot(entry: string): string {
  let dir = dirname(realpathSync(entry));
  for (;;) {
    const metadata = join(dir, "package.json");
    // Nested ESM/CJS directories may contain only {"type": ...}.
    if (existsSync(metadata) && JSON.parse(readFileSync(metadata, "utf8")).name) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`No package metadata for ${entry}`);
    dir = parent;
  }
}

const copied = new Map<string, string>();
const licensed = new Set<string>();
const licenses: string[] = [];

/** Preserve notices for both bundled and external packages. */
function retainLicense(dir: string): void {
  if (licensed.has(dir)) return;
  licensed.add(dir);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageInfo;
  const notices = readdirSync(dir).filter((file) =>
    /^(licen[sc]e|copying|notice)(\.|$)/i.test(file),
  );
  licenses.push(`\n## ${pkg.name}@${pkg.version} (${pkg.license ?? "see package notices"})\n`);
  for (const file of notices) {
    if (statSync(join(dir, file)).isFile()) licenses.push(readFileSync(join(dir, file), "utf8"));
  }
}

/** Copy only required package dependencies, failing closed on version clashes. */
function copyPackage(name: string, from: string): void {
  const entry = createRequire(join(from, "package.json")).resolve(name);
  const dir = packageRoot(entry);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageInfo;
  if (copied.has(name)) {
    if (copied.get(name) !== dir) throw new Error(`Conflicting runtime package versions: ${name}`);
    return;
  }
  copied.set(name, dir);
  retainLicense(dir);
  cpSync(dir, join(output, "node_modules", name), {
    recursive: true,
    dereference: true,
    filter(source) {
      const path = relative(dir, source).replaceAll("\\", "/");
      const top = path.split("/")[0];
      if (["node_modules", "test", "tests", "examples", ".git"].includes(top)) return false;
      if (/\.(?:map|node)$|\.d\.(?:ts|cts|mts)$/.test(path)) return false;
      if (name === "figlet") {
        if (top === "importable-fonts") return false;
        if (top === "fonts" && path !== "fonts" && basename(path) !== "Small.flf") return false;
      }
      return true;
    },
  });
  for (const dependency of Object.keys(pkg.dependencies ?? {})) copyPackage(dependency, dir);
}

copyPackage("ssh2", root);
copyPackage("figlet", root);

// Bun's metafile identifies actual bundled package sources; retain their license
// notices even though no node_modules copy of those packages ships at runtime.
const meta = JSON.parse(readFileSync(join(root, "docker-build-meta.json"), "utf8")) as {
  inputs: Record<string, unknown>;
};
for (const path of Object.keys(meta.inputs)) {
  if (path.includes("node_modules/")) retainLicense(packageRoot(resolve(root, path)));
}
writeFileSync(join(output, "THIRD-PARTY-NOTICES.txt"), licenses.join("\n"));

const health = await globalThis.Bun.build({
  entrypoints: [join(root, "scripts/docker-healthcheck.ts")],
  outdir: join(output, "dist"),
  target: "bun",
  minify: true,
});
if (!health.success) throw new AggregateError(health.logs, "Healthcheck build failed");
process.stdout.write(
  `Docker runtime assembled with ${copied.size} file-backed packages; build tools excluded.\n`,
);
