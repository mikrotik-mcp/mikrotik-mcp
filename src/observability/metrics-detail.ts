/**
 * Detailed metrics for `/metrics`: interface counters, load for each CPU core,
 * and the optical levels of SFP modules.
 *
 * These need three reads from each router, so they are not sampled on a timer.
 * A scrape serves what is cached and, when the cache is older than
 * {@link DETAIL_TTL_MS}, starts a refresh in the background. With no scraper,
 * no router is ever read. The first scrape after a start has no detail yet.
 *
 * The reads are small scripts that print one `|`-separated line for each item,
 * because the tables RouterOS prints for a person do not parse reliably.
 */
import { executeMikrotikCommand } from "../core/connector";
import { createContext } from "../core/context";
import { logger } from "../logger";

export const DETAIL_TTL_MS = 30_000;

export const INTERFACES_SCRIPT =
  ':foreach i in=[/interface find] do={ :put ([/interface get $i name] . "|" . ' +
  '[/interface get $i running] . "|" . [/interface get $i rx-byte] . "|" . ' +
  '[/interface get $i tx-byte] . "|" . [/interface get $i rx-error] . "|" . ' +
  '[/interface get $i tx-error] . "|" . [/interface get $i rx-drop] . "|" . ' +
  "[/interface get $i tx-drop]) }";
export const CPU_SCRIPT =
  ":foreach c in=[/system resource cpu find] do={ :put ([/system resource cpu get $c cpu] . " +
  '"|" . [/system resource cpu get $c load]) }';
export const SFP_SCRIPT =
  ':foreach i in=[/interface ethernet find where default-name~"sfp"] do={ ' +
  '/interface ethernet monitor $i once do={ :put ($"name" . "|" . $"sfp-rx-power" . ' +
  '"|" . $"sfp-tx-power" . "|" . $"sfp-temperature" . "|" . $"sfp-supply-voltage") } }';

export interface InterfaceSample {
  name: string;
  running: boolean;
  rxBytes?: number;
  txBytes?: number;
  rxErrors?: number;
  txErrors?: number;
  rxDrops?: number;
  txDrops?: number;
}
export interface SfpSample {
  name: string;
  rxPowerDbm?: number;
  txPowerDbm?: number;
  temperatureC?: number;
  voltage?: number;
}
export interface DeviceDetail {
  at: number;
  interfaces: InterfaceSample[];
  cores: { cpu: string; load: number }[];
  sfps: SfpSample[];
}

/** A number at the start of a field (`-5.2dBm`, `42C`, `3.3V`), or undefined. */
const number = (field: string | undefined): number | undefined => {
  const match = (field ?? "").trim().match(/^-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : undefined;
};
const rows = (output: string): string[][] =>
  output
    .split(/\r?\n/)
    .filter((line) => line.includes("|"))
    .map((line) => line.split("|"));

export function parseInterfaces(output: string): InterfaceSample[] {
  return rows(output)
    .filter((f) => f[0])
    .map((f) => ({
      name: f[0]!,
      running: f[1] === "true",
      rxBytes: number(f[2]),
      txBytes: number(f[3]),
      rxErrors: number(f[4]),
      txErrors: number(f[5]),
      rxDrops: number(f[6]),
      txDrops: number(f[7]),
    }));
}
export function parseCores(output: string): { cpu: string; load: number }[] {
  return rows(output)
    .map((f) => ({ cpu: f[0]!, load: number(f[1]) }))
    .filter((core): core is { cpu: string; load: number } => core.load !== undefined && !!core.cpu);
}
export function parseSfps(output: string): SfpSample[] {
  return (
    rows(output)
      .filter((f) => f[0])
      .map((f) => ({
        name: f[0]!,
        rxPowerDbm: number(f[1]),
        txPowerDbm: number(f[2]),
        temperatureC: number(f[3]),
        voltage: number(f[4]),
      }))
      // A cage with no module reports no level at all.
      .filter((sfp) => sfp.rxPowerDbm !== undefined || sfp.txPowerDbm !== undefined)
  );
}

const cache = new Map<string, DeviceDetail>();
const refreshing = new Set<string>();

/** Forget everything (tests only). */
export function resetDetail(): void {
  cache.clear();
  refreshing.clear();
}

export async function readDetail(device: string, now = Date.now()): Promise<DeviceDetail> {
  const ctx = createContext(undefined, device);
  ctx.risk = "READ";
  const read = (script: string): Promise<string> =>
    executeMikrotikCommand(script, ctx, { maxMs: 20_000 }).catch(() => "");
  return {
    at: now,
    interfaces: parseInterfaces(await read(INTERFACES_SCRIPT)),
    cores: parseCores(await read(CPU_SCRIPT)),
    sfps: parseSfps(await read(SFP_SCRIPT)),
  };
}

/**
 * What is cached for these routers. A router whose cache is stale is refreshed
 * in the background; this call never waits for a router.
 */
export function detailFor(
  devices: string[],
  now = Date.now(),
  read: (device: string) => Promise<DeviceDetail> = readDetail,
): Map<string, DeviceDetail> {
  for (const device of devices) {
    const have = cache.get(device);
    if ((have && now - have.at < DETAIL_TTL_MS) || refreshing.has(device)) continue;
    refreshing.add(device);
    void read(device)
      .then((detail) => cache.set(device, detail))
      .catch((error: unknown) =>
        logger.debug(`[metrics] detail of ${device} failed: ${String(error)}`),
      )
      .finally(() => refreshing.delete(device));
  }
  return new Map(devices.flatMap((d) => (cache.has(d) ? [[d, cache.get(d)!] as const] : [])));
}

const esc = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/** The detail as Prometheus text, appended to the main metrics. */
export function renderDetail(detail: Map<string, DeviceDetail>): string {
  const out: string[] = [];
  const metric = (
    name: string,
    type: "gauge" | "counter",
    help: string,
    samples: [string, number | undefined][],
  ): void => {
    const lines = samples
      .filter((s): s is [string, number] => Number.isFinite(s[1]))
      .map(([labels, value]) => `${name}{${labels}} ${value}`);
    if (lines.length > 0) out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...lines);
  };
  const each = <T>(pick: (d: DeviceDetail) => T[]): [string, T][] =>
    Array.from(detail).flatMap(([device, d]) =>
      pick(d).map((item) => [`device="${esc(device)}"`, item] as [string, T]),
    );
  const ifaces = each((d) => d.interfaces);
  const iface = (
    pick: (i: InterfaceSample) => number | undefined,
  ): [string, number | undefined][] =>
    ifaces.map(([device, i]) => [`${device},interface="${esc(i.name)}"`, pick(i)]);
  metric(
    "mikrotik_interface_running",
    "gauge",
    "1 when the interface is running.",
    iface((i) => (i.running ? 1 : 0)),
  );
  metric(
    "mikrotik_interface_receive_bytes_total",
    "counter",
    "Bytes received.",
    iface((i) => i.rxBytes),
  );
  metric(
    "mikrotik_interface_transmit_bytes_total",
    "counter",
    "Bytes sent.",
    iface((i) => i.txBytes),
  );
  metric(
    "mikrotik_interface_receive_errors_total",
    "counter",
    "Receive errors.",
    iface((i) => i.rxErrors),
  );
  metric(
    "mikrotik_interface_transmit_errors_total",
    "counter",
    "Transmit errors.",
    iface((i) => i.txErrors),
  );
  metric(
    "mikrotik_interface_receive_drops_total",
    "counter",
    "Packets dropped on receive.",
    iface((i) => i.rxDrops),
  );
  metric(
    "mikrotik_interface_transmit_drops_total",
    "counter",
    "Packets dropped on transmit.",
    iface((i) => i.txDrops),
  );
  metric(
    "mikrotik_cpu_core_load_percent",
    "gauge",
    "Load of one CPU core.",
    each((d) => d.cores).map(([device, c]) => [`${device},cpu="${esc(c.cpu)}"`, c.load]),
  );
  const sfps = each((d) => d.sfps);
  const sfp = (pick: (s: SfpSample) => number | undefined): [string, number | undefined][] =>
    sfps.map(([device, s]) => [`${device},interface="${esc(s.name)}"`, pick(s)]);
  metric(
    "mikrotik_sfp_rx_power_dbm",
    "gauge",
    "Optical receive power.",
    sfp((s) => s.rxPowerDbm),
  );
  metric(
    "mikrotik_sfp_tx_power_dbm",
    "gauge",
    "Optical transmit power.",
    sfp((s) => s.txPowerDbm),
  );
  metric(
    "mikrotik_sfp_temperature_celsius",
    "gauge",
    "Module temperature.",
    sfp((s) => s.temperatureC),
  );
  metric(
    "mikrotik_sfp_supply_voltage_volts",
    "gauge",
    "Module supply voltage.",
    sfp((s) => s.voltage),
  );
  metric(
    "mikrotik_detail_timestamp_seconds",
    "gauge",
    "When the interface, core and SFP values of the router were read.",
    Array.from(detail).map(([device, d]) => [`device="${esc(device)}"`, d.at / 1000]),
  );
  return out.length > 0 ? `${out.join("\n")}\n` : "";
}
