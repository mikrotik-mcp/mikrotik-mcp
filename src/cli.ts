#!/usr/bin/env bun
/**
 * Command-line entry point for the MikroTik MCP server.
 *
 *   mikrotik-mcp                 start the server (stdio by default)
 *   mikrotik-mcp serve           same, explicit
 *   mikrotik-mcp auth-check      verify SSH connectivity to every configured device
 *   mikrotik-mcp devices         list the configured devices
 *   mikrotik-mcp tools           list every registered tool (name + risk)
 *   mikrotik-mcp --version       print version
 *   mikrotik-mcp --help          usage
 *
 * Connection details come from MIKROTIK_* env vars or --flags (see config.ts).
 * Multiple named devices come from --config / MIKROTIK_DEVICES.
 */
import { existsSync } from "node:fs";
import { loadConfig } from "./config";
import { closeAll as closeConnectionPool } from "./core/connection-pool";
import { closeMemoryStore } from "./memory/accessor";
import { setConfig } from "./core/runtime";
import { createDeviceClient, describeTransport } from "./core/transport";
import { logger } from "./logger";
import { allToolModules } from "./tools";
import { runDashboard } from "./observability/dashboard";
import { runHttp } from "./transport/http";
import { runStdio } from "./transport/stdio";
import { VERSION, SERVER_NAME } from "./version";
import { printBanner } from "./cli-logo";
import { AlertEngine, setAlertEngine } from "./alerts/engine";
import { parseRules } from "./alerts/model";

const HELP = `${SERVER_NAME} v${VERSION} — MikroTik RouterOS MCP server

USAGE
  mikrotik-mcp [command] [options]

COMMANDS
  serve         Start the MCP server (default)
  auth-check    Connect over SSH to every configured device and probe it
  devices       List the configured devices (name · host · auth)
  tools         Print the full tool catalog (name · risk · title)
  version       Print the version

CONNECTION OPTIONS  (env var in parentheses) — defines the "default" device
  --host           RouterOS host             (MIKROTIK_HOST, default 127.0.0.1)
  --username       SSH username              (MIKROTIK_USERNAME, default admin)
  --port           SSH port                  (MIKROTIK_PORT, default 22)

AUTHENTICATION — use a password OR an SSH key (key takes precedence)
  --password       SSH password              (MIKROTIK_PASSWORD)
  --key-filename   Path to a private key     (MIKROTIK_KEY_FILENAME)
  --private-key    Inline private key (PEM)  (MIKROTIK_PRIVATE_KEY)
  --key-passphrase Passphrase for an encrypted key (MIKROTIK_KEY_PASSPHRASE)

MULTIPLE DEVICES — give each router a name to target per tool call
  --config <path>  JSON file of named devices (MIKROTIK_CONFIG_FILE)
                   { "defaultDevice": "site-a",
                     "devices": { "site-a": { "host": "...", ... },
                                  "site-b": { "host": "...", ... } } }
  MIKROTIK_DEVICES Inline JSON alternative to --config

TRANSPORT OPTIONS
  --transport          stdio | sse | streamable-http   (MIKROTIK_MCP__TRANSPORT)
  --mcp-host           HTTP bind host                   (MIKROTIK_MCP__HOST)
  --mcp-port           HTTP bind port                   (MIKROTIK_MCP__PORT)
  --mcp-allowed-hosts  Host header allow-list (DNS-rebinding protection)

SSH CONNECTION POOLING  (persistent connections, on by default)
  --ssh-keep-alive          Enable/disable pooling   (MIKROTIK_SSH__KEEP_ALIVE, default true)
  --ssh-keepalive-interval  Keepalive packet interval (ms) (MIKROTIK_SSH__KEEPALIVE_INTERVAL)
  --ssh-idle-timeout        Close idle connections after (ms) (MIKROTIK_SSH__IDLE_TIMEOUT)

OBSERVABILITY DASHBOARD  (optional; real-time feed + analytics of every tool call)
  --dashboard               Enable the dashboard     (MIKROTIK_DASHBOARD__ENABLED)
  --dashboard-host          Bind host (default 0.0.0.0=LAN) (MIKROTIK_DASHBOARD__HOST)
  --dashboard-port          Bind port (default 9090)       (MIKROTIK_DASHBOARD__PORT)
  --dashboard-db            SQLite path (bun:sqlite; ":memory:" for ephemeral)
                                                           (MIKROTIK_DASHBOARD__DB_PATH)
  --dashboard-max-events    Retention cap (default 100000) (MIKROTIK_DASHBOARD__MAX_EVENTS)
  --dashboard-capture-body  Record redacted in/out bodies  (MIKROTIK_DASHBOARD__CAPTURE_BODY)
  --dashboard-token         Bearer token to protect the dashboard
                                                           (MIKROTIK_DASHBOARD__TOKEN)
`;

function warnIfPlaintextPasswordInContainer(anyPassword: boolean): void {
  const inContainer = existsSync("/.dockerenv") || process.env.container === "docker";
  if (inContainer && anyPassword) {
    logger.warn(
      "Security notice: running inside a container with a plaintext password in the environment. " +
        "Environment variables are visible via 'docker inspect'. Prefer Docker secrets / a key file. See SECURITY.md.",
    );
  }
}

function listTools(): void {
  const risk = (a: { readOnlyHint?: boolean; destructiveHint?: boolean }) =>
    a.readOnlyHint ? "READ" : a.destructiveHint ? "DESTRUCTIVE" : "WRITE";
  let total = 0;
  for (const mod of allToolModules) {
    for (const t of mod) {
      total++;
      process.stdout.write(`${risk(t.annotations).padEnd(12)} ${t.name.padEnd(34)} ${t.title}\n`);
    }
  }
  process.stdout.write(`\n${total} tools across ${allToolModules.length} modules\n`);
}

function listDevicesCli(): void {
  const cfg = loadConfig();
  for (const [name, d] of Object.entries(cfg.devices)) {
    const tag = name === cfg.defaultDevice ? " (default)" : "";
    const auth = d.mac
      ? "mac-telnet"
      : d.keyFilename || d.privateKey
        ? "key"
        : d.password
          ? "password"
          : "none";
    const desc = d.description ? ` — ${d.description}` : "";
    process.stdout.write(
      `${name}${tag}\t${d.username}@${describeTransport(d)} [auth: ${auth}]${desc}\n`,
    );
  }
  process.stdout.write(`\n${Object.keys(cfg.devices).length} device(s)\n`);
}

/** Probe one device; returns true on success. */
async function probeDevice(name: string, d: import("./config").DeviceConfig): Promise<boolean> {
  const authMode = d.mac ? "mac-telnet" : d.keyFilename || d.privateKey ? "SSH key" : "password";
  logger.info(
    `[${name}] Connecting to ${d.username}@${describeTransport(d)} (auth: ${authMode}) …`,
  );
  // The transport (SSH or MAC-Telnet) is selected from the config, not assumed.
  const client = createDeviceClient(d);
  if (!(await client.connect())) {
    logger.error(
      `[${name}] Connection FAILED. ${client.lastError ?? "Check credentials/reachability."}`,
    );
    return false;
  }
  try {
    const identity = (await client.run("/system identity print")).trim();
    process.stdout.write(`\n[${name}] Connection OK.\n${identity}\n`);
    return true;
  } finally {
    client.disconnect();
  }
}

async function authCheck(): Promise<number> {
  // Verify every configured device (a no-op extra device costs one SSH probe).
  const cfg = loadConfig();
  const entries = Object.entries(cfg.devices);
  let ok = true;
  for (const [name, d] of entries) {
    ok = (await probeDevice(name, d)) && ok;
  }
  process.stdout.write(`\n${entries.length} device(s) checked.\n`);
  return ok ? 0 : 1;
}

async function main(): Promise<void> {
  process.title = `MikroTik-MCP (${VERSION})`;
  const argv = process.argv.slice(2);
  const command = argv.find((a) => !a.startsWith("--")) ?? "serve";

  if (argv.includes("--help") || argv.includes("-h") || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes("--version") || argv.includes("-v") || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (command === "tools") {
    listTools();
    return;
  }
  if (command === "devices") {
    listDevicesCli();
    return;
  }
  if (command === "auth-check") {
    process.exit(await authCheck());
  }

  // serve
  // When re-exec'd by a hard restart (dashboard "restart process"), wait for the
  // old process to release its ports before this fresh one binds them.
  const restartDelayMs = Number.parseInt(process.env.MIKROTIK_RESTART_DELAY_MS ?? "", 10);
  if (Number.isFinite(restartDelayMs) && restartDelayMs > 0) {
    logger.info(
      `Restart: waiting ${restartDelayMs}ms for the previous process to release its ports…`,
    );
    await new Promise((resolve) => setTimeout(resolve, restartDelayMs));
  }
  const cfg = loadConfig();
  setConfig(cfg);
  await printBanner();
  warnIfPlaintextPasswordInContainer(Object.values(cfg.devices).some((d) => !!d.password));
  const deviceNames = Object.keys(cfg.devices);
  logger.info(
    `Starting ${SERVER_NAME} v${VERSION} (transport=${cfg.mcp.transport}, ` +
      `devices=${deviceNames.length === 1 ? deviceNames[0] : deviceNames.join("/")}, ` +
      `ssh-pool=${cfg.ssh.keepAlive ? "on" : "off"})`,
  );

  // Alerting: opt-in via the `alerts` config block. Installed before any tool
  // registers so a rule can fire on the very first call. A malformed rule
  // disables alerting with a clear log line rather than refusing to boot — the
  // server's job is managing routers, and it should still do that.
  if (cfg.alerts?.enabled !== false && cfg.alerts) {
    try {
      const rules = parseRules(cfg.alerts.rules);
      setAlertEngine(
        new AlertEngine({
          rules,
          channels: cfg.alerts.channels,
          historyDb: cfg.dashboard.dbPath,
          maxHistory: cfg.alerts.maxHistory,
        }),
      );
      logger.info(`Alerting enabled: ${rules.length} rule(s)`);
    } catch (e) {
      logger.error(
        `Alerting disabled — invalid rules: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Close pooled SSH connections on shutdown so the device sees a clean
  // disconnect (vs. a TCP RST that RouterOS logs as a broken session).
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down…`);
    closeConnectionPool();
    closeMemoryStore();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("exit", closeConnectionPool);

  // Optional real-time observability dashboard — runs alongside whichever MCP
  // transport is active, on its own host/port. It opens local stores and kicks
  // off an immediate SSH health probe of every device, which can take seconds
  // on an unreachable/slow router; never let that delay the protocol handshake.
  const startDashboard = async (): Promise<void> => {
    if (!cfg.dashboard.enabled) return;
    try {
      await runDashboard(cfg.dashboard, cfg.mcp.transport);
    } catch (e) {
      logger.error(
        `Failed to start observability dashboard: ${e instanceof Error ? e.message : String(e)}. ` +
          "Continuing without it.",
      );
    }
  };

  if (cfg.mcp.transport === "stdio") {
    // Connect the stdio transport FIRST so `initialize` is answered immediately
    // (Claude Desktop times out the handshake after ~60s). runStdio() resolves
    // right after `server.connect()` and the process stays alive on the stdin
    // handle, so the dashboard starts afterward without blocking the handshake.
    // The recorder installs a beat later — tool calls never arrive that early.
    await runStdio();
    await startDashboard();
  } else {
    // HTTP serves until exit, so start the dashboard before it.
    await startDashboard();
    await runHttp(cfg.mcp);
  }
}

main().catch((e) => {
  logger.error(`Fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});
