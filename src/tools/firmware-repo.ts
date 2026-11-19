/**
 * Local firmware repository — RouterOS packages kept on the MCP host.
 *
 * `firmware_stage` lets each router download from MikroTik itself. That needs
 * internet on the router, and every router picks its own moment and mirror.
 * With a repository on the host, a version is downloaded once, its checksum is
 * recorded, and the same files go to every router over SFTP. A router needs no
 * internet, and a canary and the rest of the fleet get identical packages.
 *
 * The upgrade is the standard RouterOS one: packages in the root of the file
 * system are installed at the next reboot.
 *
 * `firmware_post_upgrade` is the step after that reboot: check the version,
 * bring RouterBOOT to the version the NEW RouterOS carries, and run commands.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { executeMikrotikCommand, uploadFileToDevice } from "../core/connector";
import { READ, WRITE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { looksLikeError, quoted } from "../core/routeros";
import { parseKeyValues, parseRecords } from "../core/routeros-parse";
import { resolveDeviceName } from "../core/runtime";
import { checkSyntax, describeProblem } from "../core/syntax-check";

/** The repository directory: `MIKROTIK_FIRMWARE_DIR`, or `~/.mikrotik-mcp/firmware`. */
export function firmwareDir(): string {
  return process.env.MIKROTIK_FIRMWARE_DIR || join(homedir(), ".mikrotik-mcp", "firmware");
}

const VERSION = /^\d+\.\d+(?:\.\d+)?(?:(?:beta|rc)\d+)?$/;
const PACKAGE = /^[a-z][a-z0-9-]{0,40}$/;
const ARCHITECTURES = ["arm", "arm64", "mipsbe", "mmips", "smips", "ppc", "tile", "x86"] as const;
type Architecture = (typeof ARCHITECTURES)[number];
/** A package of this size is not a RouterOS package. */
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;

/** `routeros-7.25.1-arm64.npk`; an x86 package has no architecture in its name. */
export function packageFile(name: string, version: string, architecture: Architecture): string {
  return `${name}-${version}${architecture === "x86" ? "" : `-${architecture}`}.npk`;
}

/** The `architecture-name` of `/system resource` as a download architecture. */
export function architectureOf(resource: string): Architecture | undefined {
  const name = resource.toLowerCase();
  if (name === "x86_64" || name === "x86" || name === "i386") return "x86";
  return (ARCHITECTURES as readonly string[]).includes(name) ? (name as Architecture) : undefined;
}

export interface RepoFile {
  file: string;
  bytes: number;
  sha256: string;
}

export function listRepo(dir = firmwareDir()): RepoFile[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".npk"));
  } catch {
    return [];
  }
  return names.sort().map((file) => {
    const data = readFileSync(join(dir, file));
    return {
      file,
      bytes: statSync(join(dir, file)).size,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  });
}

const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

export const firmwareRepoTools: ToolModule = [
  defineTool({
    name: "firmware_repo_list",
    title: "List the Local Firmware Repository",
    annotations: READ,
    noDevice: true,
    description:
      "Lists the RouterOS package files (`.npk`) kept on the MCP host, with size and SHA-256. " +
      "These are the files `firmware_stage_from_repo` uploads to routers. Use it to see which " +
      "versions and architectures are ready, or to compare a checksum. It contacts no router. " +
      "Fill the repository with `firmware_repo_fetch`. Returns the directory and one line per file.",
    inputSchema: {},
    handler() {
      const files = listRepo();
      if (files.length === 0)
        return `The firmware repository is empty (${firmwareDir()}). Add a version with firmware_repo_fetch.`;
      return [
        `Firmware repository: ${firmwareDir()}`,
        ...files.map((f) => `  ${f.file}  ${mib(f.bytes)}  sha256 ${f.sha256}`),
      ].join("\n");
    },
  }),

  defineTool({
    name: "firmware_repo_fetch",
    title: "Download RouterOS Packages to the Local Repository",
    annotations: WRITE,
    noDevice: true,
    description:
      "Downloads RouterOS packages for one version and architecture from MikroTik " +
      "(download.mikrotik.com, HTTPS only) into the firmware repository on the MCP host, and " +
      "records their SHA-256. It changes no router. Use it once for each version, then " +
      "`firmware_stage_from_repo` sends the same files to every router, so routers need no " +
      "internet and all get identical packages. `packages` defaults to the main `routeros` " +
      "package; add the extra packages your routers use (for example `wireless`, `container`, " +
      "`user-manager`). A file that is already in the repository is kept, not downloaded again. " +
      "Returns each file with its size and checksum, or the reason a download failed.",
    inputSchema: {
      version: z.string().regex(VERSION).describe("RouterOS version, for example '7.25.1'"),
      architecture: z
        .enum(ARCHITECTURES)
        .describe("Package architecture. Use x86 for CHR and x86_64 routers."),
      packages: z
        .array(z.string().regex(PACKAGE))
        .min(1)
        .max(20)
        .default(["routeros"])
        .describe("Package names without version, for example ['routeros','wireless']"),
    },
    async handler(a, ctx) {
      const dir = firmwareDir();
      mkdirSync(dir, { recursive: true });
      const have = new Set(listRepo(dir).map((f) => f.file));
      const lines: string[] = [];
      for (const name of a.packages) {
        const file = packageFile(name, a.version, a.architecture);
        if (have.has(file)) {
          lines.push(`  ${file}  already in the repository`);
          continue;
        }
        // The host and path are fixed; only checked name parts go into the URL.
        const url = `https://download.mikrotik.com/routeros/${a.version}/${file}`;
        ctx.info(`Downloading ${url}`);
        try {
          const response = await fetch(url, { redirect: "error" });
          if (!response.ok) {
            lines.push(`  ${file}  NOT downloaded: HTTP ${response.status}`);
            continue;
          }
          const data = Buffer.from(await response.arrayBuffer());
          if (data.length === 0 || data.length > MAX_PACKAGE_BYTES) {
            lines.push(`  ${file}  NOT kept: ${data.length} bytes is not a package size`);
            continue;
          }
          writeFileSync(join(dir, file), data);
          lines.push(
            `  ${file}  ${mib(data.length)}  sha256 ${createHash("sha256").update(data).digest("hex")}`,
          );
        } catch (error) {
          lines.push(
            `  ${file}  NOT downloaded: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return [`Firmware repository: ${dir}`, ...lines].join("\n");
    },
  }),

  defineTool({
    name: "firmware_stage_from_repo",
    title: "Stage an Upgrade From the Local Repository",
    annotations: WRITE,
    description:
      "Uploads the RouterOS packages of one version from the firmware repository on the MCP host " +
      "to a router, ready to install at its next reboot. The router needs no internet. The tool " +
      "reads the router's architecture and its installed packages, picks the matching files, " +
      "checks free storage, uploads over SFTP and verifies each file arrived. It does NOT reboot: " +
      "the router keeps running its current version until you reboot it (`reboot_system`), and " +
      "RouterOS installs the packages during that reboot. DEFAULTS TO A DRY RUN (`apply=false`) " +
      "that shows what would be uploaded and what is missing from the repository. Every installed " +
      "package must be staged at the same version, so a missing file stops the upload; get it " +
      "with `firmware_repo_fetch`. After the reboot, run `firmware_post_upgrade`. Not available " +
      "for a MAC-Telnet device (no file transfer).",
    inputSchema: {
      version: z.string().regex(VERSION).describe("The version to stage, for example '7.25.1'"),
      apply: z.boolean().default(false).describe("false = show the plan (default); true = upload"),
    },
    async handler(a, ctx) {
      const device = resolveDeviceName(ctx.device);
      const resource = parseKeyValues(
        await executeMikrotikCommand("/system resource print", { ...ctx, risk: "READ" }),
      );
      const architecture = architectureOf(resource["architecture-name"] ?? "");
      if (!architecture)
        return `Cannot stage: the architecture of '${device}' (${resource["architecture-name"] ?? "unknown"}) is not known.`;
      const current = (resource.version ?? "").split(" ")[0];
      if (current === a.version)
        return `'${device}' already runs RouterOS ${a.version}. Nothing to stage.`;

      const installed = parseRecords(
        await executeMikrotikCommand("/system package print detail", { ...ctx, risk: "READ" }),
      )
        .rows.filter((row) => row.disabled !== "true" && row.disabled !== "yes" && row.name)
        .map((row) => row.name!)
        .filter((name) => PACKAGE.test(name));
      const names = installed.length > 0 ? Array.from(new Set(installed)) : ["routeros"];

      const repo = new Map(listRepo().map((f) => [f.file, f]));
      const wanted = names.map((name) => ({
        name,
        file: packageFile(name, a.version, architecture),
      }));
      const missing = wanted.filter((w) => !repo.has(w.file));
      const total = wanted.reduce((sum, w) => sum + (repo.get(w.file)?.bytes ?? 0), 0);
      const free = Number(resource["free-hdd-space"]?.replace(/\D/g, "")) || undefined;
      const plan = [
        `Stage RouterOS ${a.version} (${architecture}) on '${device}', which runs ${current || "?"}:`,
        ...wanted.map((w) =>
          repo.has(w.file)
            ? `  ${w.file}  ${mib(repo.get(w.file)!.bytes)}`
            : `  ${w.file}  MISSING from the repository`,
        ),
      ];
      if (missing.length > 0)
        return [
          ...plan,
          "",
          "Not staged: every installed package must be upgraded together. Get the missing files:",
          `  firmware_repo_fetch version=${a.version} architecture=${architecture} packages=${JSON.stringify(missing.map((m) => m.name))}`,
        ].join("\n");
      if (!a.apply)
        return [
          ...plan,
          "",
          `DRY RUN: ${mib(total)} would be uploaded. Set apply=true to upload.`,
        ].join("\n");
      // RouterOS reports sizes as "12.3MiB"; the comparison is only made when it is plain bytes.
      if (
        free !== undefined &&
        /^\d+$/.test(resource["free-hdd-space"] ?? "") &&
        free < total * 1.1
      )
        return [
          ...plan,
          "",
          `Not staged: ${mib(total)} is needed and '${device}' has ${mib(free)} free.`,
        ].join("\n");

      const done: string[] = [];
      for (const w of wanted) {
        ctx.info(`Uploading ${w.file}`);
        try {
          await uploadFileToDevice(ctx.device, w.file, readFileSync(join(firmwareDir(), w.file)));
          const seen = await executeMikrotikCommand(
            `/file print count-only where name=${quoted(w.file)}`,
            { ...ctx, risk: "READ" },
          );
          if (seen.trim() !== "1")
            throw new Error("the file is not on the router after the upload");
          done.push(w.file);
        } catch (error) {
          return [
            ...plan,
            "",
            `Uploaded ${done.length} of ${wanted.length}, then FAILED at ${w.file}: ${error instanceof Error ? error.message : String(error)}`,
            "Do not reboot: a partial set of packages must not be installed. Remove the uploaded",
            `files (remove_file) or run this again. Uploaded so far: ${done.join(", ") || "none"}`,
          ].join("\n");
        }
      }
      return [
        ...plan,
        "",
        `Staged ${done.length} package(s), ${mib(total)}. '${device}' still runs ${current || "its current version"}.`,
        "RouterOS installs them at the next reboot. Take a backup first, then reboot_system,",
        `then run firmware_post_upgrade expected_version=${a.version}.`,
      ].join("\n");
    },
  }),

  defineTool({
    name: "firmware_post_upgrade",
    title: "Finish an Upgrade After the Reboot",
    annotations: WRITE,
    description:
      "The step after a RouterOS upgrade reboot. It (1) checks that the router now runs the " +
      "expected version, (2) compares the RouterBOOT (bootloader) version with the one the NEW " +
      "RouterOS carries and, with `upgrade_routerboard=true`, queues the bootloader upgrade, and " +
      "(3) runs the commands you give, in order. RouterBOOT must be upgraded AFTER RouterOS: the " +
      "new bootloader comes inside the new RouterOS, so upgrading it before the reboot installs " +
      "the old one. A queued bootloader takes effect at one more reboot, which this tool does NOT " +
      "do. Each command is first parsed on the router; if one is not valid, none runs. Running " +
      "stops at the first command that fails. Use it after `firmware_upgrade` or after a reboot " +
      "that followed `firmware_stage_from_repo`. Returns what was checked, queued and run.",
    inputSchema: {
      expected_version: z
        .string()
        .regex(VERSION)
        .optional()
        .describe("Stop when the router does not run this version, for example '7.25.1'"),
      upgrade_routerboard: z
        .boolean()
        .default(false)
        .describe("Queue the RouterBOOT upgrade when its version differs"),
      commands: z
        .array(z.string().min(1))
        .max(50)
        .default([])
        .describe("RouterOS commands to run after the checks, in order"),
    },
    async handler(a, ctx) {
      const device = resolveDeviceName(ctx.device);
      const read = { ...ctx, risk: "READ" as const };
      const resource = parseKeyValues(await executeMikrotikCommand("/system resource print", read));
      const version = (resource.version ?? "").split(" ")[0] || "unknown";
      const lines = [`'${device}' runs RouterOS ${version}.`];
      if (a.expected_version && version !== a.expected_version)
        return {
          text:
            `${lines[0]} Expected ${a.expected_version}: the upgrade did not take effect. Nothing ` +
            "was run. Check /log for the package installer, and that every installed package was " +
            "staged at the same version.",
          isError: true,
        };

      const boardOut = await executeMikrotikCommand("/system routerboard print", read).catch(
        () => "",
      );
      const board = looksLikeError(boardOut) ? {} : parseKeyValues(boardOut);
      const currentBoot = board["current-firmware"];
      const newBoot = board["upgrade-firmware"];
      if (!currentBoot || !newBoot)
        lines.push("RouterBOOT: not a RouterBOARD (nothing to upgrade).");
      else if (currentBoot === newBoot) lines.push(`RouterBOOT: ${currentBoot}, up to date.`);
      else if (!a.upgrade_routerboard)
        lines.push(
          `RouterBOOT: ${currentBoot}; ${newBoot} is available. Pass upgrade_routerboard=true to queue it.`,
        );
      else {
        const result = await executeMikrotikCommand("/system routerboard upgrade", ctx);
        lines.push(
          looksLikeError(result)
            ? `RouterBOOT: upgrade ${currentBoot} to ${newBoot} FAILED: ${result.trim()}`
            : `RouterBOOT: ${currentBoot} to ${newBoot} queued. It takes effect at the next reboot.`,
        );
      }

      if (a.commands.length === 0) return lines.join("\n");
      for (const command of a.commands) {
        const problem = await checkSyntax(command, ctx);
        if (problem)
          return {
            text: [
              ...lines,
              `No command was run: "${command}" is not valid on this router: ${describeProblem(problem)}.`,
            ].join("\n"),
            isError: true,
          };
      }
      let ran = 0;
      for (const command of a.commands) {
        const result = await executeMikrotikCommand(command, ctx);
        if (looksLikeError(result))
          return {
            text: [
              ...lines,
              `Ran ${ran} of ${a.commands.length} command(s), then FAILED at "${command}": ${result.trim()}`,
            ].join("\n"),
            isError: true,
          };
        ran += 1;
      }
      lines.push(`Ran ${ran} command(s).`);
      return lines.join("\n");
    },
  }),
];
