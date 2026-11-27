#!/usr/bin/env bun
import { spawnSync } from "bun";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schemaStoreConfig, sameConfigSchema } from "./schemastore-schema";

const upstream = "SchemaStore/schemastore";
const schemaPath = "src/schemas/json/mikrotik-mcp.json";
const prefix = "alimaster/update-mikrotik-mcp-";

function run(cmd: string[], cwd?: string): string {
  const result = spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0)
    throw new Error(
      `${cmd[0]} ${cmd[1]} failed: ${result.stderr.toString().trim() || result.stdout.toString().trim()}`,
    );
  return result.stdout.toString().trimEnd();
}

function report(message: string) {
  process.stdout.write(`${message}\n`);
}

function remoteSchema(repo: string, ref: string) {
  return JSON.parse(
    run([
      "gh",
      "api",
      "-H",
      "Accept: application/vnd.github.raw+json",
      `repos/${repo}/contents/${schemaPath}?ref=${encodeURIComponent(ref)}`,
    ]),
  );
}

type Pending = {
  number: number;
  url: string;
  headRefName: string;
  headRefOid: string;
  headRepositoryOwner: { login: string };
  headRepository: { name: string } | null;
};
function sync() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const version = args.find((a) => a !== "--check");
  const root = join(import.meta.dir, "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!version || args.length !== (check ? 2 : 1) || version !== pkg.version)
    throw new Error("Usage: bun run schemastore:sync <checked-out release version> [--check]");
  const git = (...args: string[]) => run(["git", ...args], root);
  const tags = git("tag", "--points-at", "HEAD").split("\n");
  if (!tags.includes(version) && !tags.includes(`v${version}`))
    throw new Error("Check out the release tag before syncing.");
  git("diff", "--exit-code", "--quiet", "HEAD", "--", "src");
  const revision = git("rev-parse", "HEAD");
  const schema = schemaStoreConfig(revision);
  if (sameConfigSchema(schema, remoteSchema(upstream, "master"))) {
    report("SchemaStore already matches this release.");
    return;
  }

  const actor = run(["gh", "api", "user", "--jq", ".login"]);
  const fork = `${actor}/schemastore`;
  const listPending = (): Pending[] =>
    JSON.parse(
      run([
        "gh",
        "pr",
        "list",
        "--repo",
        upstream,
        "--base",
        "master",
        "--state",
        "open",
        "--author",
        actor,
        "--limit",
        "100",
        "--json",
        "number,url,headRefName,headRefOid,headRepositoryOwner,headRepository",
      ]),
    );
  const pending = listPending().find(
    (pr) =>
      pr.headRepositoryOwner.login === actor &&
      pr.headRepository?.name === "schemastore" &&
      pr.headRefName.startsWith(prefix),
  );
  if (pending && sameConfigSchema(schema, remoteSchema(fork, pending.headRefOid))) {
    report(`Matching schema already proposed: ${pending.url}`);
    return;
  }
  const branch = pending?.headRefName ?? `${prefix}${version}`;
  if (check) {
    report(
      `Schema differs. Would ${pending ? `update ${pending.url}` : "open a SchemaStore pull request"} using ${branch}.`,
    );
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "mikrotik-schemastore-"));
  try {
    const work = (...args: string[]) => run(["git", ...args], dir);
    run([
      "git",
      "clone",
      "--quiet",
      "--depth=1",
      "--branch",
      "master",
      `https://github.com/${upstream}.git`,
      dir,
    ]);
    const file = join(dir, schemaPath);
    writeFileSync(file, `${JSON.stringify(schema, null, 2)}\n`);
    // Execute only the upstream validator and its locked dependencies.
    run(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], dir);
    run(["node", "node_modules/prettier/bin/prettier.cjs", "--write", schemaPath], dir);
    run(["node", "cli.js", "check", "--schema-name=mikrotik-mcp.json"], dir);
    const blob = work("hash-object", "-w", "--", schemaPath);
    run(["gh", "repo", "fork", upstream, "--clone=false", "--remote=false"], dir);
    if (
      run(["gh", "api", `repos/${fork}`, "--jq", ".parent.full_name"]).toLowerCase() !==
      upstream.toLowerCase()
    )
      throw new Error(`Expected ${fork} to be a fork of ${upstream}.`);
    work("remote", "add", "fork", `https://github.com/${fork}.git`);
    // gh supplies credentials through the helper, including on hosts using SSH for origin.
    const forkGit = (...args: string[]) =>
      work("-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", ...args);
    const ref = `refs/heads/${branch}`;
    if (forkGit("ls-remote", "--heads", "fork", ref)) {
      forkGit("fetch", "--depth=1", "fork", ref);
      if (pending && work("rev-parse", "FETCH_HEAD") !== pending.headRefOid)
        throw new Error("SchemaStore PR changed during sync. Rerun the sync to compare again.");
      // Keep the validated upstream checkout. Use only the fork tree as the commit parent/index.
      work("reset", "--soft", "FETCH_HEAD");
      work("read-tree", "HEAD");
    } else if (pending) throw new Error("The open SchemaStore PR lost its head branch.");
    work("update-index", "--add", "--cacheinfo", `100644,${blob},${schemaPath}`);
    if (work("diff", "--cached", "--name-only")) {
      work("diff", "--cached", "--check");
      work("commit", "-m", `feat: update MikroTik MCP config schema for ${version}`);
    }
    forkGit("push", "fork", `HEAD:${ref}`);
    const title = `Update MikroTik MCP configuration schema for ${version}`;
    const body = `Sync the editor schema with the [MikroTik MCP ${version} configuration](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/${revision}/src/config.ts). Both structured configuration files and legacy device maps use the updated device definition.\n\nValidated with SchemaStore's \`node cli.js check --schema-name=mikrotik-mcp.json\`.\n`;
    if (pending) {
      // Preserve review discussion and the contributor's original PR description.
      run(["gh", "pr", "edit", String(pending.number), "--repo", upstream, "--title", title]);
      report(`Updated ${pending.url}`);
    } else {
      const notes = join(dir, ".git", "schemastore-pr.md");
      writeFileSync(notes, body);
      report(
        run([
          "gh",
          "pr",
          "create",
          "--repo",
          upstream,
          "--base",
          "master",
          "--head",
          `${actor}:${branch}`,
          "--title",
          title,
          "--body-file",
          notes,
        ]),
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

sync();
