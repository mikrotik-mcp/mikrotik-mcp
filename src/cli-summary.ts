/**
 * Start summary for an interactive `serve`: where the server can be reached,
 * and which routers it has, with their live state.
 *
 * Like the banner, it goes to **stderr** (stdout is the JSON-RPC channel of the
 * stdio transport) and only to an interactive terminal. It does not use the
 * logger, so it shows whatever the log level is.
 */
import { networkInterfaces } from "node:os";
import type { MikrotikConfig } from "./config";
import type { DeviceStatus } from "./observability/health";

const ESC = "\x1B[";
const R = `${ESC}0m`;
const DIM = `${ESC}90m`;
const BOLD = `${ESC}1m`;
const rgb = (r: number, g: number, b: number): string => `${ESC}38;2;${r};${g};${b}m`;
const VIOLET = rgb(157, 123, 255);
const SKY = rgb(50, 145, 255);
const TEAL = rgb(45, 212, 191);
const AMBER = rgb(245, 166, 35);
const RED = rgb(255, 92, 122);

/** The IPv4 addresses of this machine that other machines can reach. */
export function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((net) => net.family === "IPv4" && !net.internal)
    .map((net) => net.address);
}

/**
 * The URLs a listener answers on. A wildcard bind (`0.0.0.0`, `::`) answers on
 * loopback and on every address of the machine; any other bind on itself only.
 */
export function listenUrls(host: string, port: number, path: string, lan: string[]): string[] {
  const hosts = host === "0.0.0.0" || host === "::" || host === "" ? ["127.0.0.1", ...lan] : [host];
  return hosts.map((name) => `http://${name.includes(":") ? `[${name}]` : name}:${port}${path}`);
}

/** `24w2d20h24m9s` → `24w 2d`: the two largest units, apart, are enough at a glance. */
export function shortUptime(raw: string): string {
  const parts = raw.match(/\d+[a-z]+/gi);
  return parts ? parts.slice(0, 2).join(" ") : raw;
}

export interface DeviceRow {
  name: string;
  isDefault: boolean;
  /** `user@host:port`, or the MAC address of a Layer-2 device. */
  address: string;
  /** `ssh`, `ssh via <jump>` or `mac-telnet`. */
  via: string;
  state: "online" | "offline" | "disabled" | "unknown";
  /** Latency, identity, version and board when online; the reason when offline. */
  detail: string;
}

type DeviceEntry = MikrotikConfig["devices"][string];

/** One row for each configured router, the default one first. */
export function deviceRows(
  devices: Record<string, DeviceEntry>,
  defaultDevice: string,
  statusOf: (name: string) => DeviceStatus | undefined,
): DeviceRow[] {
  return Object.entries(devices)
    .map(([name, dc]): DeviceRow => {
      const status = statusOf(name);
      const jump = dc.jumpVia ?? (dc.jumpHost ? "a jump host" : "");
      const row = {
        name,
        isDefault: name === defaultDevice,
        address: dc.mac
          ? dc.mac
          : `${dc.username ? `${dc.username}@` : ""}${dc.host ?? "?"}:${dc.port ?? 22}`,
        via: dc.mac ? "mac-telnet" : jump ? `ssh via ${jump}` : "ssh",
      };
      if (dc.disabled) return { ...row, state: "disabled", detail: "turned off in the config" };
      if (!status || status.reachable === null)
        return { ...row, state: "unknown", detail: "no answer yet" };
      if (!status.reachable)
        return { ...row, state: "offline", detail: status.error ?? "not reachable" };
      const facts = [
        status.latencyMs === null ? "" : `${Math.round(status.latencyMs)} ms`,
        status.identity ?? "",
        status.version ? `RouterOS ${status.version}` : "",
        status.boardName ?? "",
        status.uptime ? `up ${shortUptime(status.uptime)}` : "",
      ];
      return { ...row, state: "online", detail: facts.filter(Boolean).join(" · ") };
    })
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

const pad = (text: string, width: number): string =>
  text + " ".repeat(Math.max(width - text.length, 0));
const head = (title: string, note = ""): string =>
  `  ${BOLD}${VIOLET}${title}${R}${note ? `${DIM}  ${note}${R}` : ""}`;

/** The lines that say where the MCP endpoint and the dashboard answer. */
export function endpointLines(cfg: MikrotikConfig, lan: string[]): string[] {
  const lines = [head("Endpoints")];
  const row = (label: string, note: string, urls: string[]): void => {
    urls.forEach((url, index) =>
      lines.push(
        `    ${pad(index === 0 ? label : "", 11)}${SKY}${url}${R}${index === 0 && note ? `${DIM}  ${note}${R}` : ""}`,
      ),
    );
  };
  if (cfg.mcp.transport === "stdio")
    lines.push(`    ${pad("MCP", 11)}${TEAL}stdio${R}${DIM}  (this process: stdin and stdout)${R}`);
  else
    row(
      "MCP",
      cfg.mcp.transport,
      listenUrls(cfg.mcp.host, cfg.mcp.port, cfg.mcp.transport === "sse" ? "/sse" : "/mcp", lan),
    );
  if (cfg.dashboard.enabled)
    row(
      "Dashboard",
      cfg.dashboard.token ? "token required" : "no token: open to who can reach it",
      listenUrls(cfg.dashboard.host, cfg.dashboard.port, "/", lan),
    );
  else lines.push(`    ${pad("Dashboard", 11)}${DIM}off  (start with --dashboard)${R}`);
  return lines;
}

const MARK: Record<DeviceRow["state"], string> = {
  online: `${TEAL}●${R}`,
  offline: `${RED}●${R}`,
  disabled: `${DIM}○${R}`,
  unknown: `${AMBER}●${R}`,
};

/** The device table, with a count of each state in its title. */
export function deviceLines(rows: DeviceRow[]): string[] {
  const count = (state: DeviceRow["state"]): number =>
    rows.filter((row) => row.state === state).length;
  const parts = [
    `${rows.length} configured`,
    `${count("online")} online`,
    count("offline") ? `${count("offline")} offline` : "",
    count("disabled") ? `${count("disabled")} disabled` : "",
    count("unknown") ? `${count("unknown")} no answer yet` : "",
  ];
  const names = Math.max(...rows.map((row) => row.name.length + (row.isDefault ? 10 : 0)), 4);
  const addresses = Math.max(...rows.map((row) => row.address.length), 7);
  const vias = Math.max(...rows.map((row) => row.via.length), 3);
  return [
    head("Devices", parts.filter(Boolean).join(" · ")),
    ...rows.map((row) => {
      const label = row.isDefault ? `${row.name} (default)` : row.name;
      const tone = row.state === "online" ? TEAL : row.state === "offline" ? RED : DIM;
      return (
        `    ${MARK[row.state]} ${BOLD}${pad(label, names)}${R}  ${pad(row.address, addresses)}  ` +
        `${DIM}${pad(row.via, vias)}${R}  ${tone}${pad(row.state, 8)}${R}  ${DIM}${row.detail}${R}`
      );
    }),
  ];
}

/** How long the summary waits for the routers to answer before it prints what it has. */
const WAIT_MS = 20_000;

/**
 * Print the endpoints now, then the routers when each has answered a probe (or
 * after 20 seconds). `probe` starts a check of every router; pass it when
 * nothing else does (the dashboard checks them itself).
 */
export async function printStartSummary(
  cfg: MikrotikConfig,
  statusOf: (name: string) => DeviceStatus | undefined,
  probe?: () => Promise<void>,
): Promise<void> {
  if (!process.stderr.isTTY) return;
  const write = (lines: string[]): void => void process.stderr.write(`${lines.join("\n")}\n\n`);
  write(endpointLines(cfg, lanAddresses()));

  const names = Object.entries(cfg.devices)
    .filter(([, dc]) => !dc.disabled)
    .map(([name]) => name);
  process.stderr.write(
    `${DIM}  Checking ${names.length} ${names.length === 1 ? "router" : "routers"}…${R}\n`,
  );
  void probe?.().catch(() => {});
  const until = Date.now() + WAIT_MS;
  const answered = (): boolean =>
    names.every((name) => (statusOf(name)?.reachable ?? null) !== null);
  while (!answered() && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 250));
  // Replace the "Checking…" line with the table.
  process.stderr.write(`${ESC}1A${ESC}2K`);
  write(deviceLines(deviceRows(cfg.devices, cfg.defaultDevice, statusOf)));
}
