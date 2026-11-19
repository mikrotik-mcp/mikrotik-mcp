/**
 * Git mirror for configuration snapshots: each snapshot is written as
 * `<device>.rsc` in a directory, committed, and optionally pushed. The result
 * is a version history of every router that any Git host can show and diff.
 *
 * The file is the *normalised* export (no timestamp header), so a snapshot of
 * an unchanged router changes nothing and makes no commit. With
 * `sortSections`, the menu sections are also put in a fixed order, so a
 * RouterOS version that prints sections in another order makes no false diff.
 * A sorted file is for reading and diffing only; do not import it.
 *
 * This module runs the host's `git` program. It is the project's only use of a
 * child process for something other than process management; the program is
 * started with an argument list (no shell), and no argument that reaches it
 * can be read as an option (see `safeName`, and the fixed argument order).
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger";
import { normalizeExport } from "./format";
import type { Snapshot } from "./store";

export interface GitMirrorConfig {
  /** The working directory of the mirror. It is created, and `git init` is run, when needed. */
  dir: string;
  /** Commit each change. Off writes the files only. Default true. */
  commit?: boolean;
  /** Run `git push` after a commit. The repository needs a remote and credentials. */
  push?: boolean;
  /** Put the menu sections in a fixed order. Default false. */
  sortSections?: boolean;
  /** `Name <email>` for the commits. */
  author?: string;
}

/** A file name for a device: letters, digits, `.`, `_` and `-`, never starting with `.` or `-`. */
export function safeName(device: string): string {
  const name = device.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[.-]+/, "");
  return name || "device";
}

/**
 * The normalised export with its menu sections in a fixed order. A section is
 * a line that starts with `/` and the lines under it. Lines keep their order
 * inside a section; comment lines before the first section stay first.
 */
export function canonicalExport(body: string, sortSections = false): string {
  const normal = normalizeExport(body);
  if (!sortSections) return `${normal}\n`;
  const head: string[] = [];
  const sections: { path: string; lines: string[] }[] = [];
  for (const line of normal.split("\n")) {
    if (line.startsWith("/")) sections.push({ path: line, lines: [line] });
    else if (sections.length > 0) sections.at(-1)!.lines.push(line);
    else head.push(line);
  }
  // Two blocks of the same menu keep their relative order (a stable sort).
  sections.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return `${[...head, ...sections.flatMap((s) => s.lines)].join("\n")}\n`;
}

type Runner = (args: string[], cwd: string) => Promise<string>;

const runGit: Runner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 60_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().split("\n")[0]));
      else resolve(stdout);
    });
  });

let runner: Runner = runGit;

/** Replace the `git` runner (tests only). Pass nothing to restore. */
export function setGitRunner(fn?: Runner): void {
  runner = fn ?? runGit;
}

/** Write one snapshot to the mirror. Returns what was done. */
export async function mirrorSnapshot(
  cfg: GitMirrorConfig,
  snapshot: Pick<Snapshot, "device" | "body" | "label" | "sha" | "rosVersion">,
): Promise<"unchanged" | "written" | "committed" | "pushed"> {
  mkdirSync(cfg.dir, { recursive: true });
  const file = `${safeName(snapshot.device)}.rsc`;
  writeFileSync(join(cfg.dir, file), canonicalExport(snapshot.body, cfg.sortSections));
  if (cfg.commit === false) return "written";

  if (!existsSync(join(cfg.dir, ".git"))) await runner(["init", "--quiet"], cfg.dir);
  // `--` ends the options: the file name cannot be read as one.
  await runner(["add", "--", file], cfg.dir);
  const changed = await runner(["status", "--porcelain", "--", file], cfg.dir);
  if (changed.trim() === "") return "unchanged";

  const author = cfg.author?.match(/^(.+?)\s*<([^<>\s]+)>$/);
  const message =
    `${snapshot.device}: ${snapshot.label ?? "snapshot"}` +
    `${snapshot.rosVersion ? ` (RouterOS ${snapshot.rosVersion})` : ""}\n\nsha ${snapshot.sha}`;
  await runner(
    [
      "-c",
      `user.name=${author?.[1] ?? "mikrotik-mcp"}`,
      "-c",
      `user.email=${author?.[2] ?? "mikrotik-mcp@localhost"}`,
      "commit",
      "--quiet",
      "-m",
      message,
      "--",
      file,
    ],
    cfg.dir,
  );
  if (!cfg.push) return "committed";
  await runner(["push", "--quiet"], cfg.dir);
  return "pushed";
}

let active: GitMirrorConfig | undefined;
/** One Git operation at a time: two snapshots must not race for the index. */
let chain: Promise<unknown> = Promise.resolve();

/** Turn the mirror on (or off, with nothing). Called once when the server starts. */
export function configureGitMirror(cfg?: GitMirrorConfig): void {
  active = cfg;
}

/** Called for every stored snapshot. Never throws and never delays the caller. */
export function noteSnapshot(snapshot: Snapshot): void {
  const cfg = active;
  if (!cfg) return;
  chain = chain
    .then(() => mirrorSnapshot(cfg, snapshot))
    .then((result) => {
      if (result !== "unchanged") logger.debug(`[git-mirror] ${snapshot.device}: ${result}`);
    })
    .catch((error: unknown) => {
      logger.error(
        `Git mirror failed for ${snapshot.device}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
}

/** Resolves when the queued mirror work is done (tests only). */
export function gitMirrorIdle(): Promise<unknown> {
  return chain;
}
