#!/usr/bin/env bun
import { sleep, spawn } from "bun";
import { chmod, mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
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
async function command(args: string[], env = process.env, visible = false): Promise<string> {
  const child = spawn(args, {
    cwd: homedir(),
    env,
    stdout: visible ? "inherit" : "pipe",
    stderr: "inherit",
  });
  const output = visible ? "" : await new Response(child.stdout as ReadableStream).text();
  if ((await child.exited) !== 0) throw new Error(`Command failed: ${args[0]} ${args[1] ?? ""}`);
  return output.trim();
}

/** Confirm the actual HTTP MCP server version, not just a listening port. */
export async function ready(endpoint: string, version: string): Promise<boolean> {
  let session: string | null = null;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "mikrotik-mcp-upgrade", version: "1.0.0" },
        },
      }),
      signal: AbortSignal.timeout(2000),
    });
    session = response.headers.get("mcp-session-id");
    if (!response.ok) return false;
    const text = await response.text();
    const payload = response.headers.get("content-type")?.includes("text/event-stream")
      ? text
          .split("\n")
          .find((line) => line.startsWith("data:"))
          ?.slice(5)
          .trim()
      : text;
    return JSON.parse(payload ?? "null")?.result?.serverInfo?.version === version;
  } catch {
    return false;
  } finally {
    if (session)
      await fetch(endpoint, {
        method: "DELETE",
        headers: { "mcp-session-id": session },
        signal: AbortSignal.timeout(2000),
      }).catch(() => {});
  }
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

/** Expose the same two commands on every OS, independent of the source checkout. */
async function installCommands(directory: string, bun: string): Promise<void> {
  const manager = join(directory, "manager.ts");
  if (resolve(fileURLToPath(import.meta.url)) !== resolve(manager))
    await save(manager, await readFile(fileURLToPath(import.meta.url), "utf8"));
  const bin = (await command([bun, "pm", "-g", "bin"])).trim();
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  for (const [name, action] of [
    ["mikrotik-mcp-service", ""],
    ["mikrotik-mcp-upgrade", "upgrade"],
  ]) {
    if (process.platform === "win32") {
      const quoted = [bun, manager]
        .map((value) => windowsQuote(value).replaceAll("%", "%%"))
        .join(" ");
      await save(
        join(bin, `${name}.cmd`),
        `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${quoted} ${action} %*\r\nexit /b %errorlevel%\r\n`,
      );
    } else
      await save(
        join(bin, name),
        `#!/bin/sh\nexec ${shellQuote(bun)} ${shellQuote(manager)} ${action} "$@"\n`,
        0o755,
      );
  }
  // The first macOS-only helper lived here and can shadow Bun's bin on PATH.
  if (process.platform === "darwin") {
    const legacy = join(homedir(), ".local", "bin", "mikrotik-mcp-upgrade");
    const source = await optionalFile(legacy);
    if (
      source?.includes('const LABEL = "dev.usestrict.mikrotik-mcp"') &&
      source.includes("macOS only; no sudo.")
    )
      await save(legacy, await readFile(join(bin, "mikrotik-mcp-upgrade"), "utf8"), 0o755);
  }
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
        if (!(await optionalFile(cli)))
          await command([bun, "add", "--global", `${PACKAGE}@latest`], process.env, true);
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
      const version = await upgrade({
        install: async () => {
          await command(
            [state.bun, "add", "--global", "--no-cache", `${PACKAGE}@latest`],
            { ...process.env, BUN_INSTALL: state.installRoot },
            true,
          );
        },
        installedVersion: () => command([state.bun, state.cli, "--version"]),
        restart: () => control(state, "restart"),
        ready: (version) => ready(`http://127.0.0.1:${state.port}/mcp`, version),
        wait: () => sleep(1000),
      });
      console.warn(`MikroTik MCP ${version} is ready. Client URLs and config are unchanged.`);
    } else {
      await control(state, options.action as "status" | "restart");
      if (options.action === "restart") await waitReady(state);
      else
        console.warn(
          `Config: ${state.config}\nMCP: http://127.0.0.1:${state.port}/mcp\nLogs: ${platform === "linux" ? `journalctl --user -u ${UNIT}` : platform === "win32" ? "Windows Task Scheduler: MikroTik MCP / Last Run Result" : "LaunchAgent StandardErrorPath / StandardOutPath"}`,
        );
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
