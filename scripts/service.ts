#!/usr/bin/env bun
import { sleep, spawn } from "bun";
import { chmod, lstat, mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Buffer } from "node:buffer";

const PACKAGE = "@usex/mikrotik-mcp";
const LABEL = "dev.usestrict.mikrotik-mcp";
const UNIT = "mikrotik-mcp.service";
const TASK = "MikroTik MCP";
export type Platform = "darwin" | "linux" | "win32";
export interface ServiceState {
  format: 1;
  platform: Platform;
  bun: string;
  cli: string;
  installRoot: string;
  config: string;
  cwd: string;
  args: string[];
  port: number;
  dashboardPort: number;
}

export interface UpgradeIO {
  install: () => Promise<void>;
  installedVersion: () => Promise<string>;
  restart: () => Promise<void>;
  ready: (version: string) => Promise<boolean>;
  wait: () => Promise<void>;
}

/** Restart only a verified installation, and require the running MCP to report that version. */
export async function upgrade(io: UpgradeIO): Promise<string> {
  await io.install();
  const version = await io.installedVersion();
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
    throw new Error("Installed CLI did not return a valid version; service was not restarted.");
  await io.restart();
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await io.ready(version)) return version;
    await io.wait();
  }
  throw new Error(
    "Service did not become ready. Check the service logs listed by mikrotik-mcp-service status.",
  );
}

/** Run host service-management commands as argv arrays, never through a shell. */
async function command(
  args: string[],
  env = process.env,
  visible = false,
  /** Discard the child's stderr: for probes whose failure is an answer, not an error. */
  quiet = false,
): Promise<string> {
  const child = spawn(args, {
    cwd: homedir(),
    env,
    stdout: visible ? "inherit" : "pipe",
    stderr: quiet ? "ignore" : "inherit",
  });
  const output = visible ? "" : await new Response(child.stdout as ReadableStream).text();
  if ((await child.exited) !== 0) throw new Error(`Command failed: ${args[0]} ${args[1] ?? ""}`);
  return output.trim();
}

/** Run a noisy command silently; show what it printed only when it fails. */
async function captured(args: string[], env = process.env): Promise<void> {
  const child = spawn(args, { cwd: homedir(), env, stdout: "pipe", stderr: "pipe" });
  const read = (stream: unknown): Promise<string> =>
    stream ? new Response(stream as ReadableStream).text() : Promise.resolve("");
  const [stdout, stderr] = await Promise.all([read(child.stdout), read(child.stderr)]);
  if ((await child.exited) === 0) return;
  const printed = `${stdout}${stderr}`.trim();
  if (printed) console.warn(printed);
  throw new Error(`Command failed: ${args[0]} ${args[1] ?? ""}`);
}

/** What a running server says about itself over MCP. Empty when it does not answer. */
export interface ServerProbe {
  version?: string;
  /** Number of tools in `tools/list`; requested only with `tools: true`. */
  tools?: number;
}

/** One JSON-RPC message from a plain-JSON or event-stream MCP response. */
async function rpcPayload(response: Response): Promise<any> {
  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim()
    : text;
  return JSON.parse(payload ?? "null");
}

/** Ask the HTTP MCP server who it is — its real version, not just a listening port. */
export async function probe(
  endpoint: string,
  opts: { tools?: boolean } = {},
): Promise<ServerProbe> {
  let session: string | null = null;
  const post = (body: unknown, extra: Record<string, string> = {}): Promise<Response> =>
    fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...extra,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
  try {
    const response = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "mikrotik-mcp-upgrade", version: "1.0.0" },
      },
    });
    session = response.headers.get("mcp-session-id");
    if (!response.ok) return {};
    const version = (await rpcPayload(response))?.result?.serverInfo?.version;
    const found: ServerProbe = typeof version === "string" ? { version } : {};
    if (opts.tools && session) {
      const withSession = { "mcp-session-id": session };
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }, withSession);
      const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, withSession);
      const tools = listed.ok ? (await rpcPayload(listed))?.result?.tools : undefined;
      if (Array.isArray(tools)) found.tools = tools.length;
    }
    return found;
  } catch {
    return {};
  } finally {
    if (session)
      await fetch(endpoint, {
        method: "DELETE",
        headers: { "mcp-session-id": session },
        signal: AbortSignal.timeout(2000),
      }).catch(() => {});
  }
}

/** Confirm the actual HTTP MCP server version, not just a listening port. */
export async function ready(endpoint: string, version: string): Promise<boolean> {
  return (await probe(endpoint)).version === version;
}

/** Accept only supported OSes and bounded, distinct local listener ports. */
export function validatePorts(mcp: number, dashboard: number): void {
  if (
    ![mcp, dashboard].every((port) => Number.isInteger(port) && port >= 1024 && port <= 65535) ||
    mcp === dashboard
  )
    throw new Error("Use distinct MCP/dashboard ports between 1024 and 65535.");
}

/** Escape systemd specifiers and variable expansion without invoking a shell. */
export function systemdQuote(value: string, commandLine = false): string {
  if (/[\r\n\0]/.test(value)) throw new Error("Paths must not contain control characters.");
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return `"${commandLine ? escaped.replaceAll("$", () => "$$") : escaped}"`;
}

/** Quote a Windows argv element using the CommandLineToArgvW backslash rules. */
export function windowsQuote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("Paths must not contain control characters.");
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

/** Preserve literal data in PowerShell single-quoted strings. */
export function psQuote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("Paths must not contain control characters.");
  return `'${value.replaceAll("'", "''")}'`;
}

/** Render a per-user Linux unit with loopback listeners and restart supervision. */
export function linuxUnit(state: ServiceState): string {
  return `[Unit]\nDescription=MikroTik MCP shared service\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${systemdQuote(state.cwd)}\nExecStart=${[state.bun, state.cli, ...state.args].map((arg) => systemdQuote(arg, true)).join(" ")}\nRestart=always\nRestartSec=5\nTimeoutStopSec=30\nUMask=0077\nEnvironment=MIKROTIK_LOG_LEVEL=warn\n\n[Install]\nWantedBy=default.target\n`;
}

/** Create a password-free, current-user Windows logon task with bounded restart retries. */
export function windowsInstall(state: ServiceState): string {
  return `$ErrorActionPreference='Stop'
$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action=New-ScheduledTaskAction -Execute ${psQuote(state.bun)} -Argument ${psQuote([state.cli, ...state.args].map(windowsQuote).join(" "))} -WorkingDirectory ${psQuote(state.cwd)}
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName ${psQuote(TASK)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'MikroTik MCP per-user shared service' | Out-Null
Start-ScheduledTask -TaskName ${psQuote(TASK)}`;
}

/** Use encoded PowerShell so user paths are not interpreted by a command shell. */
async function powershell(script: string): Promise<string> {
  return command([
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(`$ErrorActionPreference='Stop'\n${script}`, "utf16le").toString("base64"),
  ]);
}

/** Locate only this tool's per-user native service registration. */
function nativeFile(platform: Platform): string {
  return platform === "darwin"
    ? join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`)
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", UNIT);
}

/** Read optional files without masking permission or filesystem errors. */
async function optionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Persist complete metadata privately before exposing it to subsequent commands. */
async function save(path: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, content, { mode });
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, mode);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

// ── Terminal output ─────────────────────────────────────────────────────────

/**
 * figlet "Small" rendering of "MikroTik MCP" — the banner `src/cli-logo.ts`
 * draws when the server starts. It is embedded as text because this file is
 * also copied to `~/.mikrotik-mcp/service/manager.ts` and run from there with
 * no `node_modules`, so it cannot import figlet. A test keeps it identical to
 * figlet's output.
 */
export const BANNER: readonly string[] = [
  "  __  __ _ _          _____ _ _     __  __  ___ ___ ",
  " |  \\/  (_) |___ _ __|_   _(_) |__ |  \\/  |/ __| _ \\",
  " | |\\/| | | / / '_/ _ \\| | | | / / | |\\/| | (__|  _/",
  " |_|  |_|_|_\\_\\_| \\___/|_| |_|_\\_\\ |_|  |_|\\___|_|  ",
];
/** Brand gradient: violet → sky → teal, as in the server banner and dashboard. */
const BRAND: readonly (readonly [number, number, number])[] = [
  [157, 123, 255],
  [50, 145, 255],
  [45, 212, 191],
];
const ESC = "\x1B[";
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
/** Printed width of a string, without colour codes. */
const width = (text: string): number => text.replace(ANSI, "").length;

/** Colour helpers that turn into plain text when colour is off. */
function palette(on: boolean) {
  const wrap =
    (code: string) =>
    (text: string): string =>
      on ? `${ESC}${code}m${text}${ESC}0m` : text;
  return {
    on,
    bold: wrap("1"),
    dim: wrap("90"),
    ok: wrap("38;2;45;212;191"),
    bad: wrap("38;2;255;107;107"),
    warn: wrap("38;2;245;166;35"),
    sky: wrap("38;2;50;145;255"),
    violet: wrap("38;2;157;123;255"),
  };
}

/** Colour only for a person at a terminal; `NO_COLOR` always wins. */
const useColor = (): boolean => process.stderr.isTTY === true && !process.env.NO_COLOR;

/** One line coloured left to right across the brand gradient. */
function gradient(line: string): string {
  const last = Math.max(1, line.length - 1);
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const at = (i / last) * (BRAND.length - 1);
    const from = BRAND[Math.floor(at)];
    const to = BRAND[Math.min(BRAND.length - 1, Math.floor(at) + 1)];
    const mix = at - Math.floor(at);
    const [r, g, b] = from.map((channel, k) => Math.round(channel + (to[k] - channel) * mix));
    out += line[i] === " " ? " " : `${ESC}38;2;${r};${g};${b}m${line[i]}`;
  }
  return `${out}${ESC}0m`;
}

/** The banner with a one-line caption under it. */
export function banner(caption: string, on: boolean): string {
  const c = palette(on);
  const art = BANNER.map((line) => (on ? gradient(line) : line)).join("\n");
  return `\n${art}\n\n  ${c.dim("Shared service")} ${c.dim("·")} ${c.bold(caption)}`;
}

type Rows = [label: string, value: string][];

/** The rows of a panel as aligned `label  value` lines. */
function panelLines(rows: Rows, c: ReturnType<typeof palette>): string[] {
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${c.dim(label.padEnd(labelWidth))}  ${value}`);
}

/** Inner width a panel needs for its title and rows. */
function panelWidth(title: string, rows: Rows): number {
  return Math.max(title.length + 2, ...panelLines(rows, palette(false)).map(width));
}

/** A titled box of `label  value` rows, at least `min` wide so stacked panels line up. */
export function panel(title: string, rows: Rows, on: boolean, min = 0): string {
  const c = palette(on);
  const lines = panelLines(rows, c);
  const inner = Math.max(min, panelWidth(title, rows));
  const top = `${c.dim("╭─")} ${c.bold(title)} ${c.dim(`${"─".repeat(inner - title.length - 1)}╮`)}`;
  const body = lines.map(
    (line) => `${c.dim("│")} ${line}${" ".repeat(inner - width(line))} ${c.dim("│")}`,
  );
  return [top, ...body, c.dim(`╰${"─".repeat(inner + 2)}╯`)].map((l) => `  ${l}`).join("\n");
}

/** `ps` elapsed time (`[[dd-]hh:]mm:ss`) as "1d 2h", "2h 3m" or "3m 4s". */
export function uptime(etime: string): string | undefined {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!match) return undefined;
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0));
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

/** `state` and `pid` from `launchctl print gui/<uid>/<label>`. */
export function parseLaunchctl(text: string): { running: boolean; pid?: number } {
  const pid = /^\s*pid = (\d+)/m.exec(text);
  return { running: /^\s*state = running/m.test(text), ...(pid ? { pid: Number(pid[1]) } : {}) };
}

/** `ActiveState` and `MainPID` from `systemctl --user show`. */
export function parseSystemd(text: string): { running: boolean; pid?: number } {
  const pid = Number(/^MainPID=(\d+)/m.exec(text)?.[1] ?? 0);
  return { running: /^ActiveState=active$/m.test(text), ...(pid ? { pid } : {}) };
}

/** Everything `status` shows. A missing field means "could not find out". */
export interface ServiceReport {
  platform: Platform;
  running: boolean;
  pid?: number;
  uptime?: string;
  /** Version of the files on disk. */
  installed?: string;
  /** Version the running server reports over MCP. */
  serving?: string;
  /** Newest version on the npm registry. */
  latest?: string;
  tools?: number;
  mcp: string;
  dashboard: string;
  dashboardUp: boolean;
  config: string;
  devices?: { total: number; enabled: number };
  data: string;
  logs: string;
  commands: string;
  bun: string;
}

const SUPERVISOR: Record<Platform, string> = {
  darwin: "launchd LaunchAgent · starts at login · restarts if it stops",
  linux: "systemd user unit · restarts after exit",
  win32: "Task Scheduler task · starts at login",
};

/** Collect the facts for `status`. Every probe is bounded and may come back empty. */
async function inspect(state: ServiceState): Promise<ServiceReport> {
  const quietly = <T>(work: Promise<T>): Promise<T | undefined> => work.catch(() => undefined);
  const mcp = `http://127.0.0.1:${state.port}/mcp`;
  const dashboard = `http://127.0.0.1:${state.dashboardPort}`;
  const native = async (): Promise<{ running: boolean; pid?: number }> => {
    if (state.platform === "darwin")
      return parseLaunchctl(
        await command(
          ["/bin/launchctl", "print", `gui/${process.getuid!()}/${LABEL}`],
          process.env,
          false,
          true,
        ),
      );
    if (state.platform === "linux")
      return parseSystemd(
        await command(
          ["systemctl", "--user", "show", UNIT, "-p", "ActiveState", "-p", "MainPID"],
          process.env,
          false,
          true,
        ),
      );
    return {
      running: (await powershell(`(Get-ScheduledTask -TaskName ${psQuote(TASK)}).State`)).includes(
        "Running",
      ),
    };
  };
  const logs = async (): Promise<string> => {
    if (state.platform === "linux") return `journalctl --user -u ${UNIT}`;
    if (state.platform === "win32") return "Task Scheduler › MikroTik MCP › Last Run Result";
    const plist = (await optionalFile(nativeFile("darwin"))) ?? "";
    return (
      /<key>StandardErrorPath<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ??
      "LaunchAgent StandardErrorPath / StandardOutPath"
    );
  };
  const devices = async (): Promise<{ total: number; enabled: number } | undefined> => {
    const all = Object.values(
      (JSON.parse((await optionalFile(state.config)) ?? "{}").devices ?? {}) as Record<
        string,
        { disabled?: boolean }
      >,
    );
    return { total: all.length, enabled: all.filter((device) => !device?.disabled).length };
  };
  const latest = async (): Promise<string | undefined> => {
    const response = await fetch(
      `https://registry.npmjs.org/${PACKAGE.replace("/", "%2f")}/latest`,
      {
        signal: AbortSignal.timeout(2500),
      },
    );
    const version = response.ok
      ? ((await response.json()) as { version?: unknown })?.version
      : undefined;
    return typeof version === "string" ? version : undefined;
  };

  const [process_, installed, served, dashboardUp, newest, deviceCount, logPath] =
    await Promise.all([
      quietly(native()),
      quietly(command([state.bun, state.cli, "--version"], process.env, false, true)),
      probe(mcp, { tools: true }),
      quietly(
        (async () =>
          (await fetch(dashboard, { signal: AbortSignal.timeout(2000) })).status < 500)(),
      ),
      quietly(latest()),
      quietly(devices()),
      quietly(logs()),
    ]);
  const pid = process_?.pid;
  const elapsed =
    pid && state.platform !== "win32"
      ? await quietly(
          command(["/bin/ps", "-o", "etime=", "-p", String(pid)], process.env, false, true),
        )
      : undefined;
  return {
    platform: state.platform,
    running: process_?.running ?? false,
    pid,
    uptime: elapsed ? uptime(elapsed) : undefined,
    installed: installed || undefined,
    serving: served.version,
    latest: newest,
    tools: served.tools,
    mcp,
    dashboard,
    dashboardUp: dashboardUp === true,
    config: state.config,
    devices: deviceCount,
    data: state.cwd,
    logs: logPath ?? "",
    commands: join(state.installRoot, "bin"),
    bun: `${process.versions.bun ?? "?"}  ${state.bun}`,
  };
}

/** Compare dotted versions numerically: negative when `a` is older than `b`. */
function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] =>
    v.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** The `status` screen: what runs, which version, where it answers, where things live. */
export function renderStatus(report: ServiceReport, on: boolean): string {
  const c = palette(on);
  const home = homedir();
  const tidy = (path: string): string =>
    home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  const answering = report.serving !== undefined;
  const advice: string[] = [];

  const stateLine = report.running
    ? `${c.ok("●")} ${c.bold("running")}${
        report.pid
          ? c.dim(`  pid ${report.pid}${report.uptime ? ` · up ${report.uptime}` : ""}`)
          : ""
      }`
    : `${c.bad("○")} ${c.bold("stopped")}`;
  if (!report.running)
    advice.push(`${c.bad("✗")} The service is not running. Start it: mikrotik-mcp-service restart`);
  else if (!answering)
    advice.push(
      `${c.warn("!")} The process runs but MCP does not answer yet. Check the logs below.`,
    );

  let versionLine = report.installed ? `${c.bold(report.installed)} installed` : c.dim("unknown");
  if (answering) {
    versionLine =
      report.serving === report.installed
        ? `${c.bold(report.serving!)} ${c.dim("running and installed")}`
        : `${c.warn(report.serving!)} running ${c.dim("·")} ${c.bold(report.installed ?? "?")} installed`;
    if (report.installed && report.serving !== report.installed)
      advice.push(
        `${c.warn("!")} Version ${report.installed} is installed but ${report.serving} is still running. Apply it: mikrotik-mcp-service restart`,
      );
  }
  let latestLine = c.dim("could not reach the npm registry");
  if (report.latest) {
    const behind = report.installed ? compareVersions(report.installed, report.latest) < 0 : false;
    latestLine = behind
      ? `${c.warn(report.latest)} ${c.dim("available")}`
      : `${report.latest} ${c.dim("· up to date")}`;
    if (behind)
      advice.push(
        `${c.sky("↑")} Update available: ${report.installed} → ${report.latest}. Run: mikrotik-mcp-upgrade`,
      );
  }

  const mark = (up: boolean): string => (up ? c.ok("✓ answering") : c.bad("✗ no answer"));
  const service: Rows = [
    ["State", stateLine],
    ["Supervisor", SUPERVISOR[report.platform]],
    ["Version", versionLine],
    ["Latest", latestLine],
  ];
  if (report.tools !== undefined)
    service.push(["Tools", `${report.tools} ${c.dim("in tools/list")}`]);
  const deviceNote = report.devices
    ? c.dim(
        `  ${report.devices.total} device${report.devices.total === 1 ? "" : "s"}, ${report.devices.enabled} enabled`,
      )
    : "";

  const urlWidth = Math.max(report.mcp.length, report.dashboard.length);
  const endpoints: Rows = [
    ["MCP", `${c.sky(report.mcp.padEnd(urlWidth))}  ${mark(answering)}`],
    ["Dashboard", `${c.sky(report.dashboard.padEnd(urlWidth))}  ${mark(report.dashboardUp)}`],
  ];
  const files: Rows = [
    ["Config", `${tidy(report.config)}${deviceNote}`],
    ["Data", tidy(report.data)],
    ["Logs", tidy(report.logs)],
    ["Commands", tidy(report.commands)],
    ["Bun", tidy(report.bun)],
  ];
  // One width for all three, so the boxes stack as a single column.
  const min = Math.max(
    panelWidth("Service", service),
    panelWidth("Endpoints", endpoints),
    panelWidth("Files", files),
  );

  return [
    banner("status", on),
    panel("Service", service, on, min),
    panel("Endpoints", endpoints, on, min),
    panel("Files", files, on, min),
    advice.length
      ? advice.map((line) => `  ${line}`).join("\n")
      : `  ${c.ok("✓")} ${c.dim("Everything is in order.")}`,
    `  ${c.dim("Commands: mikrotik-mcp-upgrade · mikrotik-mcp-service restart | status | uninstall")}\n`,
  ].join("\n\n");
}

/** Adopt the existing macOS helper's LaunchAgent without replacing its environment or flags. */
async function adoptMac(): Promise<ServiceState | undefined> {
  if (!(await optionalFile(nativeFile("darwin")))) return;
  const agent = JSON.parse(
    await command(["/usr/bin/plutil", "-convert", "json", "-o", "-", nativeFile("darwin")]),
  );
  const [bun, cli, ...args] = agent.ProgramArguments ?? [];
  const suffix = `/install/global/node_modules/${PACKAGE}/dist/cli.js`;
  const option = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
  if (
    agent.Label !== LABEL ||
    typeof cli !== "string" ||
    !cli.endsWith(suffix) ||
    !bun?.startsWith("/") ||
    option("--transport") !== "streamable-http" ||
    !["localhost", "127.0.0.1"].includes(option("--mcp-host"))
  )
    throw new Error(
      "Existing LaunchAgent is not a supported Bun loopback service; it was left unchanged.",
    );
  const config = option("--config");
  if (!config) throw new Error("Existing LaunchAgent has no explicit config path.");
  const configuration = JSON.parse(await readFile(config, "utf8"));
  const port = Number(option("--mcp-port"));
  const dashboardPort = Number(option("--dashboard-port") ?? configuration.dashboard?.port ?? 9090);
  validatePorts(port, dashboardPort);
  return {
    format: 1,
    platform: "darwin",
    bun,
    cli,
    installRoot: cli.slice(0, -suffix.length),
    config,
    cwd: agent.WorkingDirectory || homedir(),
    args,
    port,
    dashboardPort,
  };
}

/** Control only the saved OS service; router configuration is never involved. */
async function control(
  state: ServiceState,
  action: "restart" | "status" | "remove",
): Promise<void> {
  if (state.platform === "darwin") {
    const target = `gui/${process.getuid!()}/${LABEL}`;
    await command(
      action === "restart"
        ? ["/bin/launchctl", "kickstart", "-k", target]
        : action === "status"
          ? ["/bin/launchctl", "print", target]
          : ["/bin/launchctl", "bootout", target],
      process.env,
      action === "status",
    );
  } else if (state.platform === "linux") {
    await command(
      [
        "systemctl",
        "--user",
        ...(action === "remove" ? ["disable", "--now"] : [action]),
        UNIT,
        ...(action === "status" ? ["--no-pager"] : []),
      ],
      process.env,
      action === "status",
    );
  } else {
    const name = psQuote(TASK);
    const stop = `Stop-ScheduledTask -TaskName ${name}\nfor($i=0;$i -lt 30;$i++){if((Get-ScheduledTask -TaskName ${name}).State -ne 'Running'){break};Start-Sleep -Seconds 1}\nif((Get-ScheduledTask -TaskName ${name}).State -eq 'Running'){throw 'Task did not stop; refusing to start another process.'}`;
    console.warn(
      await powershell(
        action === "status"
          ? `Get-ScheduledTask -TaskName ${name} | Select-Object TaskName,State | ConvertTo-Json`
          : action === "restart"
            ? `${stop}\nStart-ScheduledTask -TaskName ${name}`
            : `${stop}\nUnregister-ScheduledTask -TaskName ${name} -Confirm:$false`,
      ),
    );
  }
}

/** Install the native registration after conflict checks and package verification. */
async function register(state: ServiceState): Promise<void> {
  if (state.platform === "darwin") {
    const file = nativeFile(state.platform);
    await save(
      file,
      JSON.stringify({
        Label: LABEL,
        ProgramArguments: [state.bun, state.cli, ...state.args],
        WorkingDirectory: state.cwd,
        RunAtLoad: true,
        KeepAlive: true,
        ExitTimeOut: 30,
        ThrottleInterval: 10,
        Umask: 63,
        EnvironmentVariables: { MIKROTIK_LOG_LEVEL: "warn" },
        StandardOutPath: join(state.cwd, "service.stdout.log"),
        StandardErrorPath: join(state.cwd, "service.stderr.log"),
      }),
    );
    await command(["/usr/bin/plutil", "-convert", "xml1", file]);
    await command(["/bin/launchctl", "bootstrap", `gui/${process.getuid!()}`, file]);
  } else if (state.platform === "linux") {
    await save(nativeFile(state.platform), linuxUnit(state));
    await command(["systemctl", "--user", "daemon-reload"]);
    await command(["systemctl", "--user", "enable", "--now", UNIT]);
  } else await powershell(windowsInstall(state));
}

/** Recover an interrupted installation and start an existing registration without duplicating it. */
async function ensureStarted(state: ServiceState): Promise<void> {
  if (state.platform === "darwin") {
    if (!(await optionalFile(nativeFile("darwin")))) return register(state);
    try {
      await command(["/bin/launchctl", "print", `gui/${process.getuid!()}/${LABEL}`]);
    } catch {
      await command([
        "/bin/launchctl",
        "bootstrap",
        `gui/${process.getuid!()}`,
        nativeFile("darwin"),
      ]);
    }
  } else if (state.platform === "linux") {
    if (!(await optionalFile(nativeFile("linux")))) return register(state);
    await command(["systemctl", "--user", "daemon-reload"]);
    await command(["systemctl", "--user", "enable", "--now", UNIT]);
  } else {
    if (
      !(
        await powershell(
          `if(Get-ScheduledTask -TaskName ${psQuote(TASK)} -ErrorAction SilentlyContinue){'exists'}`,
        )
      ).includes("exists")
    )
      return register(state);
    await powershell(`Start-ScheduledTask -TaskName ${psQuote(TASK)}`);
  }
}

const COMMANDS: [name: string, action: string][] = [
  ["mikrotik-mcp-service", ""],
  ["mikrotik-mcp-upgrade", "upgrade"],
];
/** First line of the POSIX wrapper; also how one of ours is recognised. */
const WRAPPER_HEAD = "#!/bin/sh\nexec ";

/**
 * Remove the POSIX command wrappers this installer wrote into Bun's global bin
 * directory, before `bun add --global` runs.
 *
 * The package declares bins with the same two names. Bun links them as
 * symlinks and fails the whole install with `EEXIST` when a regular file is in
 * the way — which left the new version on disk but the service not restarted.
 * Only our own wrappers are removed: a symlink is Bun's link, and any other
 * file is not ours to delete.
 */
export async function removeCommandWrappers(bin: string): Promise<void> {
  if (process.platform === "win32") return; // `.cmd` wrappers do not collide with Bun's shims
  for (const [name] of COMMANDS) {
    const file = join(bin, name);
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile()) continue;
    const text = await readFile(file, "utf8").catch(() => "");
    if (text.startsWith(WRAPPER_HEAD) && text.includes("manager.ts")) await unlink(file);
  }
}

/** Expose the same two commands on every OS, independent of the source checkout. */
export async function installCommands(
  directory: string,
  bun: string,
  /** Skip the PATH reminder: for upgrade, which only repairs existing commands. */
  quiet = false,
): Promise<void> {
  const manager = join(directory, "manager.ts");
  if (resolve(fileURLToPath(import.meta.url)) !== resolve(manager))
    await save(manager, await readFile(fileURLToPath(import.meta.url), "utf8"));
  const bin = (await command([bun, "pm", "-g", "bin"])).trim();
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const wrapper = (action: string): string =>
    `${WRAPPER_HEAD}${shellQuote(bun)} ${shellQuote(manager)} ${action} "$@"\n`;
  for (const [name, action] of COMMANDS) {
    if (process.platform === "win32") {
      const quoted = [bun, manager]
        .map((value) => windowsQuote(value).replaceAll("%", "%%"))
        .join(" ");
      await save(
        join(bin, `${name}.cmd`),
        `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${quoted} ${action} %*\r\nexit /b %errorlevel%\r\n`,
      );
      continue;
    }
    // Bun already linked the package's own command here: keep it. Writing a
    // file over it would make the next `bun add --global` fail with EEXIST.
    const existing = await lstat(join(bin, name)).catch(() => null);
    if (existing?.isSymbolicLink()) continue;
    await save(join(bin, name), wrapper(action), 0o755);
  }
  // The first macOS-only helper lived here and can shadow Bun's bin on PATH.
  if (process.platform === "darwin") {
    const legacy = join(homedir(), ".local", "bin", "mikrotik-mcp-upgrade");
    const source = await optionalFile(legacy);
    if (
      source?.includes('const LABEL = "dev.usestrict.mikrotik-mcp"') &&
      source.includes("macOS only; no sudo.")
    )
      await save(legacy, wrapper("upgrade"), 0o755);
  }
  if (!quiet)
    console.warn(
      `Commands installed in ${bin}. If your terminal cannot find them, add this directory to PATH.`,
    );
}

/** Verify the CLI and the live MCP version after service activation. */
async function waitReady(state: ServiceState): Promise<void> {
  const version = await command([state.bun, state.cli, "--version"]);
  await upgrade({
    install: async () => {},
    installedVersion: async () => version,
    restart: async () => {},
    ready: (v) => ready(`http://127.0.0.1:${state.port}/mcp`, v),
    wait: () => sleep(1000),
  });
  console.warn(
    `MikroTik MCP ${version} is ready.\nDashboard: http://127.0.0.1:${state.dashboardPort}\nMCP: http://127.0.0.1:${state.port}/mcp`,
  );
}

/** Parse a deliberately small CLI with strict options and explicit install-only flags. */
export function serviceOptions(argv: string[]): {
  action: string;
  config?: string;
  port: number;
  dashboardPort: number;
  explicitPorts: boolean;
} {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string" },
      "mcp-port": { type: "string" },
      "dashboard-port": { type: "string" },
      help: { type: "boolean" },
    },
  });
  const action = values.help ? "help" : (positionals[0] ?? "help");
  if (
    positionals.length > 1 ||
    !["help", "install", "upgrade", "restart", "status", "uninstall"].includes(action)
  )
    throw new Error("Use install, upgrade, restart, status or uninstall. See --help.");
  const explicitPorts = values["mcp-port"] !== undefined || values["dashboard-port"] !== undefined;
  if (action !== "install" && (values.config || explicitPorts))
    throw new Error("Config and port options are only supported by install.");
  const port = Number(values["mcp-port"] ?? 8000);
  const dashboardPort = Number(values["dashboard-port"] ?? 9090);
  validatePorts(port, dashboardPort);
  return { action, config: values.config, port, dashboardPort, explicitPorts };
}

/** Set up, upgrade or remove a local shared server without editing AI client settings. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = serviceOptions(argv);
  if (options.action === "help") {
    console.warn(
      `MikroTik MCP shared service (Bun required)\n\n  mikrotik-mcp-service install [--config devices.json]\n  mikrotik-mcp-upgrade\n  mikrotik-mcp-service restart | status | uninstall\n\nOptional install ports: --mcp-port 8000 --dashboard-port 9090\nNo config? Install creates a disabled example router; configure it in the dashboard.\nRuns as your login user: macOS launchd, Linux systemd --user, Windows logon task.\nUninstall keeps your config, keys and history. No sudo required.`,
    );
    return;
  }
  if (!["darwin", "linux", "win32"].includes(process.platform))
    throw new Error("Supported platforms: Windows, macOS, Linux with systemd.");
  if (process.getuid?.() === 0) throw new Error("Run as your regular login user, without sudo.");
  const platform = process.platform as Platform;
  const directory = join(homedir(), ".mikrotik-mcp", "service");
  const metadata = join(directory, "service.json");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, "operation.lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new Error(
      `Another service operation may be running. If a previous command was killed, remove this empty directory: ${lock}`,
    );
  }
  try {
    const raw = await optionalFile(metadata);
    let state: ServiceState | undefined = raw ? JSON.parse(raw) : undefined;
    if (state && (state.format !== 1 || state.platform !== platform))
      throw new Error("Incompatible service metadata; nothing changed.");
    if (!state && platform === "darwin") state = await adoptMac();
    if (options.action === "install") {
      if (state) {
        if (
          (options.config && resolve(options.config) !== state.config) ||
          (options.explicitPorts &&
            (options.port !== state.port || options.dashboardPort !== state.dashboardPort))
        )
          throw new Error(
            "Service already installed with different settings. Uninstall first; config/history will be retained.",
          );
      } else {
        if (platform === "linux") {
          await command(["systemctl", "--user", "show-environment"]);
          if (await optionalFile(nativeFile(platform)))
            throw new Error("An existing systemd unit was found; refusing to overwrite it.");
        }
        if (
          platform === "win32" &&
          (
            await powershell(
              `if(Get-ScheduledTask -TaskName ${psQuote(TASK)} -ErrorAction SilentlyContinue){'exists'}`,
            )
          ).includes("exists")
        )
          throw new Error("An existing scheduled task was found; refusing to overwrite it.");
        const config = resolve(options.config ?? join(homedir(), ".mikrotik-mcp", "devices.json"));
        const current = await optionalFile(config);
        if (!current && options.config) throw new Error(`Config file not found: ${config}`);
        if (current) JSON.parse(current);
        else
          await save(
            config,
            JSON.stringify(
              {
                defaultDevice: "router",
                devices: {
                  router: { host: "127.0.0.1", port: 1, username: "admin", disabled: true },
                },
              },
              null,
              2,
            ),
          );
        // A listener conflict must not silently attach this service to someone else's server.
        for (const port of [options.port, options.dashboardPort]) {
          const { createServer } = await import("node:net");
          await new Promise<void>((ok, fail) => {
            const server = createServer();
            server.once("error", () =>
              fail(new Error(`Port ${port} is already in use. Choose different install ports.`)),
            );
            server.listen(port, "127.0.0.1", () =>
              server.close((error) => (error ? fail(error) : ok())),
            );
          });
        }
        const bun = process.execPath;
        const bin = await command([bun, "pm", "-g", "bin"]);
        const installRoot = dirname(bin);
        const cli = join(
          installRoot,
          "install",
          "global",
          "node_modules",
          "@usex",
          "mikrotik-mcp",
          "dist",
          "cli.js",
        );
        if (!(await optionalFile(cli))) {
          await removeCommandWrappers(bin);
          await command([bun, "add", "--global", `${PACKAGE}@latest`], process.env, true);
        }
        await command([bun, cli, "--version"]);
        const args = [
          "serve",
          "--config",
          config,
          "--transport",
          "streamable-http",
          "--mcp-host",
          "127.0.0.1",
          "--mcp-port",
          String(options.port),
          "--mcp-allowed-hosts",
          `127.0.0.1:${options.port},localhost:${options.port}`,
          "--mcp-allowed-origins",
          `http://127.0.0.1:${options.port},http://localhost:${options.port}`,
          "--dashboard",
          "--dashboard-host",
          "127.0.0.1",
          "--dashboard-port",
          String(options.dashboardPort),
        ];
        state = {
          format: 1,
          platform,
          bun,
          cli,
          installRoot,
          config,
          cwd: join(homedir(), ".mikrotik-mcp"),
          args,
          port: options.port,
          dashboardPort: options.dashboardPort,
        };
        await save(metadata, JSON.stringify(state, null, 2));
      }
      await save(metadata, JSON.stringify(state, null, 2));
      await installCommands(directory, state.bun);
      await ensureStarted(state);
      await waitReady(state);
      return;
    }
    if (!state)
      throw new Error("Service is not installed. Run mikrotik-mcp-service install first.");
    if (options.action === "uninstall") {
      await control(state, "remove");
      if (platform !== "win32") await unlink(nativeFile(platform));
      if (platform === "linux") await command(["systemctl", "--user", "daemon-reload"]);
      await unlink(metadata).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      console.warn(
        "Service removed. Config, SSH keys and history were kept. Run install to enable it again.",
      );
    } else if (options.action === "upgrade") {
      const on = useColor();
      const c = palette(on);
      const say = (line: string): void => console.warn(`  ${line}`);
      const mcp = `http://127.0.0.1:${state.port}/mcp`;
      console.warn(`${banner("upgrade", on)}\n`);
      const before = (await probe(mcp)).version;
      say(`${c.dim("•")} Running now   ${before ? c.bold(before) : c.dim("not answering")}`);
      const started = Date.now();
      // How far the upgrade got, so a failure says what state the service is in.
      let stage: "install" | "restart" | "ready" = "install";
      try {
        const version = await upgrade({
          install: async () => {
            say(`${c.sky("◆")} Installing    ${PACKAGE}@latest ${c.dim("…")}`);
            await removeCommandWrappers(join(state.installRoot, "bin"));
            try {
              await captured([state.bun, "add", "--global", "--no-cache", `${PACKAGE}@latest`], {
                ...process.env,
                BUN_INSTALL: state.installRoot,
              });
            } finally {
              // Bun links the package's commands on success. If it did not (the
              // install failed), put the wrappers back so the commands still exist.
              await installCommands(directory, state.bun, true);
            }
            // Wrappers outside Bun's bin (an older `~/.local/bin` helper) run the
            // manager copy. Refresh it from the package just installed, or it
            // would stay at the version that first ran `install` forever.
            const packaged = await optionalFile(
              join(dirname(dirname(state.cli)), "scripts", "service.ts"),
            );
            if (packaged) await save(join(directory, "manager.ts"), packaged);
          },
          installedVersion: async () => {
            const installed = await command([state.bun, state.cli, "--version"]);
            say(`${c.ok("✓")} Installed     ${c.bold(installed)}`);
            stage = "restart";
            return installed;
          },
          restart: async () => {
            await control(state, "restart");
            say(`${c.ok("✓")} Restarted     ${c.dim(SUPERVISOR[state.platform].split(" · ")[0])}`);
            say(
              `${c.sky("◆")} Waiting       ${c.dim("for the server to answer as the new version …")}`,
            );
            stage = "ready";
          },
          ready: (wanted) => ready(mcp, wanted),
          wait: () => sleep(1000),
        });
        const after = await probe(mcp, { tools: true });
        say(`${c.ok("✓")} Ready         ${c.dim("the server answers as")} ${c.bold(version)}`);
        const changed = before !== undefined && before !== version;
        const rows: Rows = [
          [
            "Version",
            changed ? `${before} ${c.dim("→")} ${c.bold(c.ok(version))}` : c.bold(version),
          ],
          ["Took", `${Math.max(1, Math.round((Date.now() - started) / 1000))}s`],
          ["MCP", c.sky(mcp)],
          ["Dashboard", c.sky(`http://127.0.0.1:${state.dashboardPort}`)],
        ];
        if (after.tools !== undefined)
          rows.push(["Tools", `${after.tools} ${c.dim("in tools/list")}`]);
        console.warn(
          `\n${panel(changed ? "Upgrade complete" : "Already current · reinstalled", rows, on)}\n\n` +
            `  ${c.dim("Client URLs and config are unchanged.")}\n` +
            `  ${c.dim("Reconnect your MCP clients so they load the new tool list.")}\n`,
        );
      } catch (error) {
        const what =
          stage === "install"
            ? `Upgrade stopped during install. The service was not restarted${before ? `; ${before} keeps running` : ""}.`
            : stage === "restart"
              ? "The new version is installed but the restart failed. Run: mikrotik-mcp-service restart"
              : "The service restarted but did not answer as the new version. Check: mikrotik-mcp-service status";
        say(`${c.bad("✗")} ${what}\n`);
        throw error;
      }
    } else if (options.action === "status") {
      console.warn(renderStatus(await inspect(state), useColor()));
    } else {
      await control(state, "restart");
      await waitReady(state);
    }
  } finally {
    await rmdir(lock);
  }
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
