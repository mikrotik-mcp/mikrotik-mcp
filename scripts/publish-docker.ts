#!/usr/bin/env bun
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { spawn, which } from "bun";
import { ensureAccount, PublishError } from "./docker-publish/auth.ts";
import type { CommandResult } from "./docker-publish/auth.ts";
import {
  assertTagAvailable,
  publishRelease,
  validRepository,
  validVersion,
} from "./docker-publish/workflow.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HELP = `MikroTik MCP · Docker Hub publisher

Usage: bun run docker:publish [--dry-run] [--no-color]

  --dry-run   Preview commands; no auth reads, login, network, build or push.
  --no-color  Plain terminal output (also respects NO_COLOR).
  --help      Show this help without accessing Docker or credentials.

Interactive only. Reads DOCKER_CONFIG (or ~/.docker), uses Docker's credential
helper, validates the stored account with Docker Hub, and waits for docker login
when needed. Choose repository, builder and platforms before confirming a push.
Version comes from package.json; existing version tags are never overwritten.
latest promotion requires a separate confirmation. Ctrl+C cancels.
No credentials are saved by this script. Docker itself owns login storage.
`;

class Terminal {
  private color: boolean;
  constructor(
    noColor: boolean,
    private signal: AbortSignal,
  ) {
    this.color = !noColor && process.env.NO_COLOR === undefined && process.stdout.isTTY === true;
  }
  paint(code: number, text: string): string {
    const escape = String.fromCharCode(27);
    return this.color ? `${escape}[${code}m${text}${escape}[0m` : text;
  }
  note(text: string): void {
    process.stdout.write(`${this.paint(36, `  │ ${text.split("\n").join("\n  │ ")}`)}\n`);
  }
  step(text: string): void {
    process.stdout.write(`\n${this.paint(35, "  ◆")} ${this.paint(1, text)}\n`);
  }
  async ask(label: string, initial = ""): Promise<string> {
    // Own stdin only while prompting; docker login must get the real, unconsumed TTY.
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const cancelled = new AbortController();
    rl.once("SIGINT", () => cancelled.abort());
    rl.once("close", () => cancelled.abort());
    try {
      const answer = await rl.question(
        `  ${this.paint(36, "›")} ${label}${initial ? this.paint(2, ` [${initial}]`) : ""}: `,
        { signal: AbortSignal.any([cancelled.signal, this.signal]) },
      );
      return answer.trim() || initial;
    } finally {
      rl.close();
    }
  }
  async confirm(label: string, initial = false): Promise<boolean> {
    for (;;) {
      const answer = (await this.ask(`${label} (y/n)`, initial ? "y" : "n")).toLowerCase();
      if (["y", "yes"].includes(answer)) return true;
      if (["n", "no"].includes(answer)) return false;
      this.note("Please enter y or n.");
    }
  }
  async input(
    label: string,
    initial: string,
    valid: (value: string) => boolean,
    hint: string,
  ): Promise<string> {
    for (;;) {
      const value = await this.ask(label, initial);
      if (valid(value)) return value;
      this.note(hint);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (args.some((arg) => !["--dry-run", "--no-color"].includes(arg)))
    throw new PublishError("Unknown option. Run with --help.");
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new PublishError(
      "An interactive terminal is required. Open a terminal and run 'bun run docker:publish'. Use --help for usage.",
    );
  const cancelled = new AbortController();
  const terminal = new Terminal(args.includes("--no-color"), cancelled.signal);
  const dockerConfigDir = process.env.DOCKER_CONFIG
    ? resolve(process.env.DOCKER_CONFIG)
    : join(homedir(), ".docker");
  const commandEnv = { ...process.env, DOCKER_CONFIG: dockerConfigDir };
  const interrupt = (): void => cancelled.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let scratch: string | undefined;
  const run = async (
    cmd: string[],
    interactive = false,
    stdin?: string,
  ): Promise<CommandResult> => {
    cancelled.signal.throwIfAborted();
    try {
      const child = spawn(cmd, {
        cwd: ROOT,
        env: commandEnv,
        stdin: stdin === undefined ? (interactive ? "inherit" : "ignore") : new Blob([stdin]),
        stdout: interactive ? "inherit" : "pipe",
        stderr: interactive ? "inherit" : "pipe",
        signal: interactive
          ? cancelled.signal
          : AbortSignal.any([cancelled.signal, AbortSignal.timeout(60_000)]),
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        typeof child.stdout === "object" ? new Response(child.stdout).text() : "",
        typeof child.stderr === "object" ? new Response(child.stderr).text() : "",
      ]);
      cancelled.signal.throwIfAborted();
      return { code, stdout, stderr };
    } catch {
      cancelled.signal.throwIfAborted();
      throw new PublishError(
        `Could not run ${cmd[0]} (missing executable, timeout or process failure). Check Docker/PATH and retry.`,
      );
    }
  };
  const checked = async (cmd: string[], interactive = false): Promise<CommandResult> => {
    const result = await run(cmd, interactive);
    if (result.code !== 0)
      throw new PublishError(
        `Command failed (exit ${result.code}): ${cmd.join(" ")}. Fix it before retrying.`,
      );
    return result;
  };
  try {
    process.stdout.write(
      `${terminal.paint(
        36,
        "\n  ╭──────────────────────────────────────────────╮\n  │  MIKROTIK MCP  /  DOCKER HUB                 │\n  │  Authenticate → Review → Publish → Verify    │\n  ╰──────────────────────────────────────────────╯",
      )}\n`,
    );
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
    const manifest = JSON.parse(await readFile(join(ROOT, "manifest.json"), "utf8"));
    if (!validVersion(pkg.version) || pkg.version !== manifest.version)
      throw new PublishError(
        "package.json and manifest.json must contain the same release version.",
      );
    const bunVersion = /^bun@([\d.]+)$/.exec(pkg.packageManager)?.[1];
    if (!bunVersion) throw new PublishError("packageManager must pin Bun's version.");
    const dryRun = args.includes("--dry-run");
    let username = "your-namespace";
    let builder = "default";
    let nativePlatform = `linux/${process.arch === "arm64" ? "arm64" : "amd64"}`;
    if (!dryRun) {
      // Version-dependent env auth can override file/keychain credentials; never guess which account wins.
      if (process.env.DOCKER_AUTH_CONFIG)
        throw new PublishError(
          "Unset DOCKER_AUTH_CONFIG for this interactive workflow; it can override Docker's saved login.",
        );
      terminal.step("01 · Docker & authentication");
      await checked(["docker", "version", "--format", "{{.Server.Version}}"]);
      await checked(["docker", "buildx", "version"]);
      const info = await checked(["docker", "info", "--format", "{{.OSType}}/{{.Architecture}}"]);
      nativePlatform = info.stdout.trim().replace("aarch64", "arm64").replace("x86_64", "amd64");
      username = await ensureAccount({
        configDir: dockerConfigDir,
        platform: process.platform,
        which: (name) => !!which(name),
        read: async (path) => {
          try {
            return await readFile(path, "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw new PublishError(
              "Cannot read Docker config.json. Check file permissions; no file was changed.",
            );
          }
        },
        helper: (name, server) => run([name, "get"], false, server),
        request: (url, init) =>
          fetch(url, {
            ...init,
            signal: AbortSignal.any([cancelled.signal, AbortSignal.timeout(20_000)]),
          }),
        login: async () => {
          await checked(["docker", "login"], true);
        },
        note: (message) => terminal.note(message),
      });
      terminal.note(`Authenticated as ${username}. Passwords/tokens stay out of terminal output.`);
      const selected = await checked(["docker", "buildx", "inspect"]);
      builder = /^Name:\s+(.+)$/m.exec(selected.stdout)?.[1]?.trim() ?? "default";
      terminal.note(
        `Current builder: ${builder}. View alternatives with 'docker buildx ls' in another terminal.`,
      );
    } else
      terminal.note(
        "DRY RUN · No credentials read, no login, no Docker/network calls, no publication.",
      );
    terminal.step("02 · Release destination");
    const repository = await terminal.input(
      "Repository (account or organization/name)",
      `${username}/${pkg.name.split("/").at(-1)}`,
      validRepository,
      "Use a lowercase Docker Hub namespace/repository, without a registry host or tag.",
    );
    builder = await terminal.input(
      "Buildx builder",
      builder,
      (value) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value),
      "Enter an existing Buildx builder name.",
    );
    terminal.note("Platforms: 1 = amd64 + arm64 (recommended) · 2 = amd64 · 3 = arm64");
    const choice = await terminal.input(
      "Platforms",
      "1",
      (value) => ["1", "2", "3"].includes(value),
      "Choose 1, 2 or 3.",
    );
    const platforms =
      choice === "1"
        ? ["linux/amd64", "linux/arm64"]
        : [choice === "2" ? "linux/amd64" : "linux/arm64"];
    terminal.step("03 · Review");
    terminal.note(
      `Image       ${repository}:${pkg.version}\nBun         ${bunVersion}\nPlatforms   ${platforms.join(", ")}\nBuilder     ${builder}\nContext     repository root\nlatest      separate confirmation after verification`,
    );
    if (dryRun) {
      terminal.note(
        `docker buildx build --builder ${builder} --pull --provenance=mode=min --platform ${platforms.join(",")} --tag ${repository}:${pkg.version} --metadata-file <temporary-file> --push .\nThen: registry digest/platform checks → native smoke → optional latest promotion.`,
      );
      return;
    }
    const git = await checked(["git", "status", "--porcelain"]);
    if (git.stdout.trim()) {
      terminal.note(
        "This checkout has uncommitted/untracked files. Docker builds the working tree, not just HEAD.",
      );
      if (
        !(await terminal.confirm(
          "Have you reviewed these local changes and want to include the allowed Docker context?",
        ))
      )
        throw new PublishError("Cancelled. Review or commit changes before publishing.");
    }
    await checked(["docker", "buildx", "inspect", "--builder", builder]);
    await assertTagAvailable({ run }, `${repository}:${pkg.version}`);
    if (await terminal.confirm("Run types, offline tests and lint before publishing?", true)) {
      for (const script of ["test:types", "test", "lint"])
        await checked([process.execPath, "--no-env-file", "run", script], true);
    } else if (
      !(await terminal.confirm(
        "Skip the release checks? Only continue if they already passed for this source.",
      ))
    )
      throw new PublishError("Cancelled. Run release checks first.");
    scratch = await mkdtemp(join(tmpdir(), "mikrotik-docker-publish-"));
    const metadataPath = join(scratch, "build.json");
    const digest = await publishRelease(
      { repository, version: pkg.version, platforms, builder, bunVersion, nativePlatform },
      {
        run,
        metadataPath,
        metadata: () => readFile(metadataPath, "utf8"),
        confirm: (question, initial) => terminal.confirm(question, initial),
        step: (message) => terminal.step(message),
        note: (message) => terminal.note(message),
      },
    );
    terminal.step("✓ Publication complete");
    terminal.note(
      `https://hub.docker.com/r/${repository}/tags\nPinned image: ${repository}@${digest}\nNo service was restarted. Pulled image/build cache retained; no global prune was run.`,
    );
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const aborted = error instanceof Error && error.name === "AbortError";
    console.error(
      `\n  ${aborted ? "Cancelled. Check the registry before retrying an interrupted push." : error instanceof PublishError ? error.message : "Publisher stopped unexpectedly. No raw diagnostic data is printed to protect credentials."}\n`,
    );
    process.exitCode = aborted ? 130 : 1;
  });
}
