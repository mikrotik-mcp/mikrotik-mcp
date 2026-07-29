/**
 * Connected device management — a unified view of who is on the network and the
 * controls to manage them, built on top of several RouterOS tables:
 *
 *   - `/ip dhcp-server lease`  — the canonical IP ↔ MAC ↔ host map + status,
 *     plus `make-static` (pin the IP) and `set address=` (change it).
 *   - `/ip arp`                — interface + reachability for each MAC.
 *   - `/queue simple` stats    — per-device download/upload (when a queue exists).
 *
 * "Block / allow" is enforced by MAC (so it survives the device changing IP)
 * via tagged `/ip firewall filter` drop rules — found/removed by the same
 * `mcp-blocked:<mac>` comment, the idempotent-tagged-rule pattern used by the
 * port-forward and port-knock wizards.
 *
 * The OPERATIONS below are exported as plain functions taking a {@link ToolContext}
 * so both the MCP tools here AND the observability dashboard's REST endpoints
 * share one implementation (no behaviour drift).
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import type { ToolContext } from "../core/context";
import { isEmpty, looksLikeError, quoteValue, Cmd } from "../core/routeros";
import { isYes } from "../utils/yes";
import { parseRecords, parseLeadingNumber } from "../core/routeros-parse";
import { uiViewUri } from "../core/ui-meta";

/** Comment tag on the firewall drop rules a block installs (keyed by MAC). */
export const BLOCK_TAG = "mcp-blocked";

/** Normalise a MAC to RouterOS's uppercase, colon-separated form. */
function normalizeMac(mac: string): string {
  return mac.trim().toUpperCase().replace(/-/g, ":");
}

/** A merged connected-device record. */
export interface Device {
  mac: string;
  ip: string;
  host: string;
  iface: string;
  server: string;
  status: string;
  static: boolean;
  blocked: boolean;
  lastSeen: string;
  comment: string;
}

/** Live download/upload sample for one device (bits-per-second + cumulative bytes). */
export interface DeviceTraffic {
  ip: string;
  source: "queue" | "none";
  rxBitsPerSec: number;
  txBitsPerSec: number;
  rxBytes: number;
  txBytes: number;
  /** Configured max download rate (e.g. "10M"), "" when unlimited/unset. */
  downloadLimit: string;
  /** Configured max upload rate (e.g. "2M"), "" when unlimited/unset. */
  uploadLimit: string;
}

/** Where the per-host traffic figures came from. */
export type TrafficSource = "accounting" | "kid-control" | "none";

/** Live rates (bits/sec) + cumulative bytes for one host, normalised across sources. */
export interface HostTraffic {
  rxRate: number;
  txRate: number;
  rxBytes: number;
  txBytes: number;
}

/**
 * Bulk traffic snapshot for the Clients page, covering EVERY LAN host (not just
 * those with a queue). Two sources are used depending on RouterOS version:
 *
 *   - **v6:** `/ip accounting` — per-host-pair byte counters, read by snapshot.
 *   - **v7:** Kid Control — accounting was removed in v7; `/ip kid-control`
 *     exposes per-device rate + byte counters once a monitor entry exists.
 *
 * Both are normalised to `hosts` (rates in bits/sec + cumulative bytes), so the
 * frontend has one code path. `limits` still comes from `/queue simple` — the
 * only place rate limits live — so the limits editor keeps working.
 */
export interface BulkTrafficPayload {
  ts: number;
  source: TrafficSource;
  /** Diagnostic shown to the user when `source` is `none`. */
  note?: string;
  hosts: Record<string, HostTraffic>;
  limits: Record<string, { download: string; upload: string }>;
}

/** Resolved traffic source per device (`""` = default). Process-lifetime cache. */
const resolvedSource = new Map<string, TrafficSource>();

/** First line of a device error, for a compact note. */
const firstLine = (s: string): string => s.trim().split("\n")[0]!.trim();

/**
 * Enable `/ip accounting` (v6). Returns an error note (e.g. "bad command name
 * accounting" on v7, where it was removed), or null on success.
 */
async function enableAccounting(ctx: ToolContext): Promise<string | null> {
  // `threshold` caps how many host pairs are tracked between snapshots; the
  // default (256) truncates on a busy LAN, so raise it.
  const out = await executeMikrotikCommand("/ip accounting set enabled=yes threshold=2000", ctx);
  return looksLikeError(out) ? firstLine(out) : null;
}

/**
 * Ensure Kid Control is monitoring (v7). Kid Control tracks per-device traffic
 * for ALL devices as soon as at least one control entry exists, so if none does
 * we add a monitor-only one: a 24/7-allowed schedule (`0s-1d` every day) with no
 * device assigned, which never blocks or limits anything — it only turns the
 * counters on. Existing Kid Control setups are left untouched.
 */
async function enableKidControl(ctx: ToolContext): Promise<string | null> {
  const count = await executeMikrotikCommand("/ip kid-control print count-only", ctx);
  if (looksLikeError(count)) return firstLine(count);
  if ((parseLeadingNumber(count.trim()) ?? 0) > 0) return null; // already monitoring

  // No `comment=` — `/ip kid-control add` rejects it on some RouterOS builds
  // ("bad parameter comment"). The `mcp-monitor` name is enough to identify it.
  const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => `${d}=0s-1d`).join(" ");
  const add = await executeMikrotikCommand(`/ip kid-control add name=mcp-monitor ${days}`, ctx);
  return looksLikeError(add) ? firstLine(add) : null;
}

/**
 * Decide (once per device, then cache) which per-host traffic source works:
 * `/ip accounting` on v6, else Kid Control on v7. Returns the source and, when
 * `none`, a note explaining why both were unavailable.
 */
async function resolveSource(ctx: ToolContext): Promise<{ source: TrafficSource; note?: string }> {
  const key = ctx.device ?? "";
  const cached = resolvedSource.get(key);
  if (cached) return { source: cached };

  const accErr = await enableAccounting(ctx);
  if (!accErr) {
    resolvedSource.set(key, "accounting");
    return { source: "accounting" };
  }
  const kidErr = await enableKidControl(ctx);
  if (!kidErr) {
    resolvedSource.set(key, "kid-control");
    return { source: "kid-control" };
  }
  // Don't cache "none" — the router may just be transiently unreachable.
  return {
    source: "none",
    note: `No per-host traffic source. /ip accounting (v6): ${accErr}. Kid Control (v7): ${kidErr}.`,
  };
}

/** Result of a device mutation, shared by the tools (text) and dashboard (JSON). */
export interface OpResult {
  ok: boolean;
  message: string;
}

// ── data layer (shared by the tools and the dashboard) ───────────────────────

/** Fetch + merge the DHCP lease and ARP tables into one device list (by MAC). */
export async function fetchDevices(ctx: ToolContext): Promise<Device[]> {
  const leaseOut = await executeMikrotikCommand("/ip dhcp-server lease print detail", ctx);
  const arpOut = await executeMikrotikCommand("/ip arp print detail", ctx);
  const leases = looksLikeError(leaseOut) ? [] : parseRecords(leaseOut).rows;
  const arp = looksLikeError(arpOut) ? [] : parseRecords(arpOut).rows;

  const arpByMac = new Map<string, Record<string, string>>();
  for (const r of arp) {
    const m = (r["mac-address"] ?? "").toUpperCase();
    if (m) arpByMac.set(m, r);
  }

  const byMac = new Map<string, Device>();
  const yes = isYes;
  for (const l of leases) {
    const mac = (l["mac-address"] ?? "").toUpperCase();
    if (!mac) continue;
    const a = arpByMac.get(mac);
    byMac.set(mac, {
      mac,
      ip: l.address ?? l["active-address"] ?? a?.address ?? "",
      host: l["host-name"] ?? l.comment ?? "",
      iface: a?.interface ?? l.server ?? "",
      server: l.server ?? "",
      status: l.status ?? (a ? "arp-only" : ""),
      static: !yes(l.dynamic),
      blocked: yes(l["block-access"]),
      lastSeen: l["last-seen"] ?? "",
      comment: l.comment ?? "",
    });
  }
  for (const [mac, a] of arpByMac) {
    if (byMac.has(mac)) continue;
    byMac.set(mac, {
      mac,
      ip: a.address ?? "",
      host: "",
      iface: a.interface ?? "",
      server: "",
      status: yes(a.complete) ? "arp-only" : "incomplete",
      static: !yes(a.dynamic),
      blocked: false,
      lastSeen: "",
      comment: a.comment ?? "",
    });
  }
  return [...byMac.values()].sort((x, y) => x.ip.localeCompare(y.ip, undefined, { numeric: true }));
}

/** Sample a device's live download/upload from a matching `/queue simple` entry. */
export async function sampleDeviceTraffic(ctx: ToolContext, ip: string): Promise<DeviceTraffic> {
  const q = await executeMikrotikCommand(
    `/queue simple print stats detail where target~"${ip}"`,
    ctx,
  );
  if (isEmpty(q) || looksLikeError(q)) {
    return {
      ip,
      source: "none",
      rxBitsPerSec: 0,
      txBitsPerSec: 0,
      rxBytes: 0,
      txBytes: 0,
      downloadLimit: "",
      uploadLimit: "",
    };
  }
  const row = parseRecords(q).rows[0] ?? {};
  const [up, down] = (row.rate ?? "0/0").split("/");
  const [upB, downB] = (row.bytes ?? "0/0").split("/");
  // `max-limit` is RouterOS's `upload/download` (tx/rx); "0" means unlimited.
  const [upLim, downLim] = (row["max-limit"] ?? "0/0").split("/");
  const limit = (v: string | undefined): string => (v && v !== "0" ? v : "");
  return {
    ip,
    source: "queue",
    txBitsPerSec: parseLeadingNumber(up) ?? 0,
    rxBitsPerSec: parseLeadingNumber(down) ?? 0,
    txBytes: parseLeadingNumber(upB) ?? 0,
    rxBytes: parseLeadingNumber(downB) ?? 0,
    downloadLimit: limit(downLim),
    uploadLimit: limit(upLim),
  };
}

/** Per-IP rate limits from `/queue simple` — the only place limits are stored. */
async function readQueueLimits(ctx: ToolContext): Promise<BulkTrafficPayload["limits"]> {
  const limits: BulkTrafficPayload["limits"] = {};
  const out = await executeMikrotikCommand("/queue simple print detail", ctx);
  if (isEmpty(out) || looksLikeError(out)) return limits;
  const val = (v: string | undefined): string => (v && v !== "0" ? v : "");
  for (const row of parseRecords(out).rows) {
    const ip = (row.target ?? "").split("/")[0]?.trim();
    if (!ip) continue;
    // RouterOS `max-limit` is `upload/download` (tx/rx).
    const [upLim, downLim] = (row["max-limit"] ?? "0/0").split("/");
    limits[ip] = { download: val(downLim), upload: val(upLim) };
  }
  return limits;
}

/** Parse a RouterOS number that may carry a k/M/G/T suffix (e.g. `1.5M`, `512000`). */
export function parseMagnitude(v: string | undefined): number {
  const m = (v ?? "").trim().match(/^(-?\d+(?:\.\d+)?)\s*([kMGT])?/i);
  if (!m) return 0;
  const u = (m[2] ?? "").toLowerCase();
  const factor = u === "k" ? 1e3 : u === "m" ? 1e6 : u === "g" ? 1e9 : u === "t" ? 1e12 : 1;
  return Number(m[1]) * factor;
}

/** Accounting per-device state: cumulative bytes + last snapshot time, per device. */
const acctState = new Map<
  string,
  { lastTs: number; cum: Map<string, { rx: number; tx: number }> }
>();

/**
 * Fold `/ip accounting` snapshot rows (src → dst → bytes) into per-host byte
 * DELTAS. A row is traffic from one address to another, so for any host, bytes
 * where it is the destination are its download and bytes where it is the source
 * are its upload — a LAN↔LAN transfer counting as upload for the sender and
 * download for the receiver. Pure, so `tests/accounting-traffic.spec.ts` pins it.
 */
export function aggregateHostTraffic(
  rows: Record<string, string>[],
): Record<string, { rxBytes: number; txBytes: number }> {
  const hosts: Record<string, { rxBytes: number; txBytes: number }> = {};
  const bump = (ip: string, key: "rxBytes" | "txBytes", b: number): void => {
    if (!ip) return;
    (hosts[ip] ??= { rxBytes: 0, txBytes: 0 })[key] += b;
  };
  for (const row of rows) {
    const bytes = parseLeadingNumber(row.bytes) ?? 0;
    if (bytes <= 0) continue;
    bump((row["dst-address"] ?? "").trim(), "rxBytes", bytes); // TO host = download
    bump((row["src-address"] ?? "").trim(), "txBytes", bytes); // FROM host = upload
  }
  return hosts;
}

/**
 * v6: snapshot `/ip accounting`, turn per-host byte deltas into rates.
 *
 * `snapshot take` freezes the live per-host-pair counters and resets them, so
 * each snapshot is the traffic since the previous take. The rate is that delta
 * over the elapsed wall-clock, and cumulative bytes are accumulated per host in
 * `acctState` (accounting has no device-lifetime total of its own).
 */
async function sampleAccounting(
  ctx: ToolContext,
  ts: number,
): Promise<Record<string, HostTraffic>> {
  const key = ctx.device ?? "";
  await executeMikrotikCommand("/ip accounting snapshot take", ctx);
  const out = await executeMikrotikCommand("/ip accounting snapshot print", ctx);
  if (looksLikeError(out)) throw new Error(firstLine(out));

  const deltas = aggregateHostTraffic(parseRecords(out).rows);
  const st = acctState.get(key) ?? { lastTs: 0, cum: new Map() };
  const dtSec = st.lastTs ? Math.max(0.1, (ts - st.lastTs) / 1000) : 0;
  const hosts: Record<string, HostTraffic> = {};
  for (const [ip, d] of Object.entries(deltas)) {
    const c = st.cum.get(ip) ?? { rx: 0, tx: 0 };
    c.rx += d.rxBytes;
    c.tx += d.txBytes;
    st.cum.set(ip, c);
    hosts[ip] = {
      rxRate: dtSec ? (d.rxBytes / dtSec) * 8 : 0,
      txRate: dtSec ? (d.txBytes / dtSec) * 8 : 0,
      rxBytes: c.rx,
      txBytes: c.tx,
    };
  }
  st.lastTs = ts;
  acctState.set(key, st);
  return hosts;
}

/**
 * Parse `/ip kid-control device print detail` rows into per-IP traffic.
 *
 * Kid Control already exposes instantaneous `rate-down`/`rate-up` (bits/sec) and
 * cumulative `bytes-down`/`bytes-up` per device, so no delta math is needed:
 * down = the device's download (rx), up = its upload (tx). Keyed by `ip-address`
 * (rows without one — e.g. a device seen only by MAC — are skipped). Pure.
 */
export function parseKidDevices(rows: Record<string, string>[]): Record<string, HostTraffic> {
  const hosts: Record<string, HostTraffic> = {};
  for (const row of rows) {
    const ip = (row["ip-address"] ?? "").trim();
    if (!ip) continue;
    hosts[ip] = {
      rxRate: parseMagnitude(row["rate-down"]),
      txRate: parseMagnitude(row["rate-up"]),
      rxBytes: parseMagnitude(row["bytes-down"]),
      txBytes: parseMagnitude(row["bytes-up"]),
    };
  }
  return hosts;
}

/** v7: read Kid Control's per-device counters. */
async function sampleKidControl(ctx: ToolContext): Promise<Record<string, HostTraffic>> {
  const out = await executeMikrotikCommand("/ip kid-control device print detail", ctx);
  if (looksLikeError(out)) throw new Error(firstLine(out));
  if (isEmpty(out)) return {};
  return parseKidDevices(parseRecords(out).rows);
}

/**
 * Bulk-sample per-host traffic for the Clients page, from whichever source the
 * RouterOS version provides (`/ip accounting` on v6, Kid Control on v7). Rate
 * limits always come from `/queue simple`. Returns `source: "none"` with a note
 * when neither is available.
 */
export async function sampleAllTraffic(ctx: ToolContext): Promise<BulkTrafficPayload> {
  const ts = Date.now();
  const limits = await readQueueLimits(ctx);
  const { source, note } = await resolveSource(ctx);
  if (source === "none") return { ts, source, note, hosts: {}, limits };

  try {
    const hosts =
      source === "accounting" ? await sampleAccounting(ctx, ts) : await sampleKidControl(ctx);
    return { ts, source, hosts, limits };
  } catch (e) {
    // A read failure after the source resolved: report it but keep limits.
    return {
      ts,
      source: "none",
      note: e instanceof Error ? e.message : String(e),
      hosts: {},
      limits,
    };
  }
}

/**
 * Set (or clear) a device's download/upload rate limits by managing a
 * `/queue simple` targeting its IP. RouterOS `max-limit` is `upload/download`
 * (tx/rx); a blank or "0" rate means unlimited. Updates the existing queue if
 * one already targets the IP, otherwise creates one (which also enables the
 * per-device traffic counter the Clients chart reads). Rates are RouterOS rate
 * strings, e.g. "10M", "512k", "0"/"" for unlimited.
 */
export async function setDeviceLimits(
  ctx: ToolContext,
  ip: string,
  opts: { download?: string; upload?: string; name?: string },
): Promise<OpResult> {
  const rate = (v: string | undefined): string => {
    const t = (v ?? "").trim();
    return t === "" ? "0" : t;
  };
  const down = rate(opts.download);
  const up = rate(opts.upload);
  const maxLimit = `${up}/${down}`;

  const existing = await executeMikrotikCommand(
    `/queue simple print count-only where target~"${ip}"`,
    ctx,
  );
  const have = (parseLeadingNumber(existing.trim()) ?? 0) > 0;

  if (!have && down === "0" && up === "0") {
    return { ok: true, message: `No rate limit set for ${ip} (left unlimited).` };
  }

  const cmd = have
    ? new Cmd(`/queue simple set [find target~"${ip}"]`).set("max-limit", maxLimit).build()
    : new Cmd("/queue simple add")
        .set("name", opts.name?.trim() || `client-${ip}`)
        .set("target", ip)
        .set("max-limit", maxLimit)
        .build();
  const out = await executeMikrotikCommand(cmd, ctx);
  if (looksLikeError(out)) return { ok: false, message: `Failed to set limits: ${out}` };

  const human = (r: string): string => (r === "0" ? "unlimited" : r);
  return {
    ok: true,
    message: `Limits for ${ip} set — ↓ ${human(down)} / ↑ ${human(up)}.`,
  };
}

/** Count firewall drop rules currently blocking a MAC. */
async function blockRuleCount(mac: string, ctx: ToolContext): Promise<number> {
  const out = await executeMikrotikCommand(
    `/ip firewall filter print count-only where comment="${BLOCK_TAG}: ${mac}"`,
    ctx,
  );
  return parseLeadingNumber(out.trim()) ?? 0;
}

export async function blockDevice(
  ctx: ToolContext,
  macRaw: string,
  comment?: string,
): Promise<OpResult> {
  const mac = normalizeMac(macRaw);
  if ((await blockRuleCount(mac, ctx)) > 0) {
    return { ok: true, message: `Device ${mac} is already blocked.` };
  }
  const label = `${BLOCK_TAG}: ${mac}${comment ? ` (${comment})` : ""}`;
  for (const chain of ["forward", "input"]) {
    const cmd = new Cmd("/ip firewall filter add")
      .set("chain", chain)
      .set("src-mac-address", mac)
      .set("action", "drop")
      .set("comment", label)
      .raw("place-before=0")
      .build();
    const out = await executeMikrotikCommand(cmd, ctx);
    if (looksLikeError(out))
      return { ok: false, message: `Failed to add ${chain} block rule: ${out}` };
  }
  await executeMikrotikCommand(
    `/ip dhcp-server lease set [find mac-address="${mac}"] block-access=yes`,
    ctx,
  );
  return {
    ok: true,
    message: `Device ${mac} BLOCKED (forward + input drop rules installed). Reverse with allow_device.`,
  };
}

export async function allowDevice(ctx: ToolContext, macRaw: string): Promise<OpResult> {
  const mac = normalizeMac(macRaw);
  const hadRules = (await blockRuleCount(mac, ctx)) > 0;
  if (hadRules) {
    const out = await executeMikrotikCommand(
      `/ip firewall filter remove [find comment="${BLOCK_TAG}: ${mac}"]`,
      ctx,
    );
    if (looksLikeError(out)) return { ok: false, message: `Failed to remove block rules: ${out}` };
  }
  await executeMikrotikCommand(
    `/ip dhcp-server lease set [find mac-address="${mac}"] block-access=no`,
    ctx,
  );
  return {
    ok: true,
    message: hadRules
      ? `Device ${mac} ALLOWED (block rules removed, access restored).`
      : `Device ${mac} was not blocked (cleared block-access anyway).`,
  };
}

export async function makeDeviceStatic(ctx: ToolContext, macRaw: string): Promise<OpResult> {
  const mac = normalizeMac(macRaw);
  const count = await executeMikrotikCommand(
    `/ip dhcp-server lease print count-only where mac-address="${mac}"`,
    ctx,
  );
  if (count.trim() === "0") return { ok: false, message: `No DHCP lease found for ${mac}.` };
  const out = await executeMikrotikCommand(
    `/ip dhcp-server lease make-static [find mac-address="${mac}"]`,
    ctx,
  );
  if (looksLikeError(out)) return { ok: false, message: `Failed to make lease static: ${out}` };
  return { ok: true, message: `Device ${mac} IP is now pinned (static lease).` };
}

export async function setDeviceIp(ctx: ToolContext, macRaw: string, ip: string): Promise<OpResult> {
  const mac = normalizeMac(macRaw);
  const detail = await executeMikrotikCommand(
    `/ip dhcp-server lease print detail where mac-address="${mac}"`,
    ctx,
  );
  if (isEmpty(detail)) return { ok: false, message: `No DHCP lease found for ${mac}.` };
  if (/\bdynamic\b/.test(detail)) {
    const mk = await executeMikrotikCommand(
      `/ip dhcp-server lease make-static [find mac-address="${mac}"]`,
      ctx,
    );
    if (looksLikeError(mk))
      return { ok: false, message: `Failed to pin lease before setting IP: ${mk}` };
  }
  const cmd = new Cmd(`/ip dhcp-server lease set [find mac-address="${mac}"]`)
    .set("address", ip)
    .build();
  const out = await executeMikrotikCommand(cmd, ctx);
  if (looksLikeError(out)) return { ok: false, message: `Failed to set device IP: ${out}` };
  return { ok: true, message: `Device ${mac} reserved IP set to ${ip}.` };
}

export async function setDeviceLabel(
  ctx: ToolContext,
  macRaw: string,
  label: string,
): Promise<OpResult> {
  const mac = normalizeMac(macRaw);
  const count = await executeMikrotikCommand(
    `/ip dhcp-server lease print count-only where mac-address="${mac}"`,
    ctx,
  );
  if (count.trim() === "0") return { ok: false, message: `No DHCP lease found for ${mac}.` };
  const out = await executeMikrotikCommand(
    `/ip dhcp-server lease set [find mac-address="${mac}"] comment=${quoteValue(label)}`,
    ctx,
  );
  if (looksLikeError(out)) return { ok: false, message: `Failed to label device: ${out}` };
  return { ok: true, message: `Device ${mac} labelled '${label}'.` };
}

export async function removeDeviceLease(ctx: ToolContext, macRaw: string): Promise<OpResult> {
  const mac = normalizeMac(macRaw);
  const count = await executeMikrotikCommand(
    `/ip dhcp-server lease print count-only where mac-address="${mac}"`,
    ctx,
  );
  if (count.trim() === "0") return { ok: false, message: `No DHCP lease found for ${mac}.` };
  const out = await executeMikrotikCommand(
    `/ip dhcp-server lease remove [find mac-address="${mac}"]`,
    ctx,
  );
  if (looksLikeError(out)) return { ok: false, message: `Failed to remove lease: ${out}` };
  return { ok: true, message: `DHCP lease for ${mac} removed.` };
}

/** The `structuredContent` payload the connected-devices MCP App view renders. */
export function devicesView(devices: Device[]): Record<string, unknown> {
  return {
    __mikrotikView: "connected-devices",
    devices,
    counts: {
      total: devices.length,
      blocked: devices.filter((d) => d.blocked).length,
      static: devices.filter((d) => d.static).length,
    },
    generatedAt: new Date().toISOString(),
  };
}

// ── MCP tools (thin wrappers over the operations above) ──────────────────────

const DEVICE_UI = {
  resourceUri: uiViewUri("connected-devices"),
  visibility: ["model", "app"] as ("model" | "app")[],
};

export const connectedDeviceTools: ToolModule = [
  defineTool({
    name: "list_connected_devices",
    title: "List Connected Devices",
    annotations: READ,
    ui: { ...DEVICE_UI },
    description:
      "Show every device on the network as a unified table — merges `/ip dhcp-server lease` (IP, MAC, " +
      "host-name, status), `/ip arp` (interface, reachability) and lease flags. For each device returns " +
      "its IP, MAC, hostname, interface, lease status (bound/waiting), whether its IP is STATIC (pinned), " +
      "whether it is BLOCKED, last-seen activity and comment/label. In an MCP App host this renders an " +
      "interactive table with per-device Download/Upload charts and one-click block/allow + make-static. " +
      "Use make_device_static to pin a device's IP, block_device/allow_device to deny/permit network " +
      "access, set_device_ip to change the reserved IP, set_device_label to name it, and get_device_traffic " +
      "for live ↓/↑ rate. Filter with status_filter, name_filter (host/comment), static_only or blocked_only.",
    inputSchema: {
      name_filter: z.string().optional().describe("Match host-name or comment (substring)"),
      status_filter: z.string().optional().describe('e.g. "bound", "waiting", "arp-only"'),
      static_only: z.boolean().default(false).describe("Only devices with a pinned/static IP"),
      blocked_only: z.boolean().default(false).describe("Only blocked devices"),
    },
    async handler(a, ctx) {
      ctx.info("Listing connected devices");
      let devices = await fetchDevices(ctx);
      if (a.status_filter) devices = devices.filter((d) => d.status.includes(a.status_filter));
      if (a.static_only) devices = devices.filter((d) => d.static);
      if (a.blocked_only) devices = devices.filter((d) => d.blocked);
      if (a.name_filter) {
        const q = a.name_filter.toLowerCase();
        devices = devices.filter(
          (d) => d.host.toLowerCase().includes(q) || d.comment.toLowerCase().includes(q),
        );
      }
      if (devices.length === 0) return "No connected devices found matching the criteria.";

      const lines = devices.map((d) =>
        `${d.ip.padEnd(15)} ${d.mac}  ${d.status.padEnd(8)} ${
          d.static ? "static" : "dynamic"
        }${d.blocked ? " [BLOCKED]" : ""}  ${d.host || d.comment || ""}`.trimEnd(),
      );
      return {
        text: `CONNECTED DEVICES (${devices.length}):\n\n${lines.join("\n")}`,
        structuredContent: devicesView(devices),
      };
    },
  }),

  defineTool({
    name: "get_connected_device",
    title: "Get Connected Device Detail",
    annotations: READ,
    description:
      "Full detail for one device by MAC (preferred) or IP — its DHCP lease record (`/ip dhcp-server lease " +
      "print detail`) plus its ARP entry (interface, reachability). Use list_connected_devices to find the " +
      "MAC/IP; use get_device_traffic for live throughput.",
    inputSchema: {
      mac: z.string().optional().describe("Device MAC address"),
      ip: z.string().optional().describe("Device IP address (used if mac is omitted)"),
    },
    async handler(a, ctx) {
      if (!a.mac && !a.ip) return "Provide a device mac or ip.";
      const where = a.mac ? `mac-address="${normalizeMac(a.mac)}"` : `address="${a.ip}"`;
      ctx.info(`Getting device detail: ${where}`);
      const lease = await executeMikrotikCommand(
        `/ip dhcp-server lease print detail where ${where}`,
        ctx,
      );
      const arp = await executeMikrotikCommand(`/ip arp print detail where ${where}`, ctx);
      if (isEmpty(lease) && isEmpty(arp)) return "Device not found in the DHCP lease or ARP table.";
      return `DEVICE DETAIL:\n\nLEASE:\n${isEmpty(lease) ? "(no lease)" : lease}\n\nARP:\n${
        isEmpty(arp) ? "(no arp entry)" : arp
      }`;
    },
  }),

  defineTool({
    name: "get_device_traffic",
    title: "Get Device Live Traffic (Download/Upload)",
    annotations: READ,
    // App-only: the connected-devices view polls this for its ↓/↑ chart. Kept
    // out of the model's surface so a chat call can't render a stale widget.
    ui: { resourceUri: uiViewUri("connected-devices"), visibility: ["app"] },
    description:
      "Live download/upload throughput for one device, sampled for the connected-devices charts. Reads a " +
      "matching `/queue simple` entry's stats (rate + cumulative bytes) when one targets the device's IP; " +
      "otherwise reports source='none' (create_simple_queue with target=<ip> to enable tracking). Returns " +
      "rx/tx bits-per-second and cumulative bytes so the MCP App can plot the ↓/↑ chart over time.",
    inputSchema: { ip: z.string().describe("Device IP address") },
    async handler(a, ctx) {
      ctx.info(`Sampling device traffic: ${a.ip}`);
      const t = await sampleDeviceTraffic(ctx, a.ip);
      const text =
        t.source === "none"
          ? `No per-device counter for ${a.ip}. Create a simple queue (create_simple_queue target=${a.ip}) to track its traffic.`
          : `DEVICE TRAFFIC ${a.ip}: ↓ ${(t.rxBitsPerSec / 1e6).toFixed(2)} Mbps / ↑ ${(t.txBitsPerSec / 1e6).toFixed(2)} Mbps`;
      return {
        text,
        structuredContent: { __mikrotikView: "device-traffic", ...t, ts: new Date().toISOString() },
      };
    },
  }),

  defineTool({
    name: "make_device_static",
    title: "Pin a Device's IP (Make Lease Static)",
    annotations: WRITE,
    ui: { ...DEVICE_UI },
    description:
      "Pin a device's current IP so it always gets the same address (`/ip dhcp-server lease make-static`) — " +
      "converts its dynamic DHCP lease to a static reservation bound to its MAC. Use this to 'fix' a device's " +
      "IP. To then change the reserved IP use set_device_ip. Identify the device by MAC.",
    inputSchema: { mac: z.string().describe("Device MAC address") },
    async handler(a, ctx) {
      const r = await makeDeviceStatic(ctx, a.mac);
      if (!r.ok) return r.message;
      return { text: r.message, structuredContent: devicesView(await fetchDevices(ctx)) };
    },
  }),

  defineTool({
    name: "set_device_ip",
    title: "Set a Device's Reserved IP",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Change the IP reserved for a device (`/ip dhcp-server lease set address=`). If the device's lease is " +
      "still dynamic it is made static first so the address sticks. Identify the device by MAC. The new IP " +
      "must be within the DHCP server's network. Use make_device_static to pin the current IP without " +
      "changing it.",
    inputSchema: {
      mac: z.string().describe("Device MAC address"),
      ip: z.string().describe("New reserved IP address"),
    },
    async handler(a, ctx) {
      return (await setDeviceIp(ctx, a.mac, a.ip)).message;
    },
  }),

  defineTool({
    name: "set_device_label",
    title: "Label a Device",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Set a friendly label/comment on a device's DHCP lease (`/ip dhcp-server lease set comment=`) so it is " +
      'easy to recognise in list_connected_devices (e.g. "Ali phone", "Living-room TV"). Identify by MAC.',
    inputSchema: {
      mac: z.string().describe("Device MAC address"),
      label: z.string().describe('Friendly name, e.g. "Ali phone". Pass "" to clear.'),
    },
    async handler(a, ctx) {
      return (await setDeviceLabel(ctx, a.mac, a.label)).message;
    },
  }),

  defineTool({
    name: "set_device_limits",
    title: "Set a Device's Download/Upload Rate Limits",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Throttle (or unthrottle) a device's bandwidth by managing a `/queue simple` targeting its IP " +
      "— sets the max download and upload rate. RouterOS rate strings: e.g. `10M`, `512k`; pass `0` " +
      "or omit a side to leave it unlimited. Updates the device's existing simple queue if there is " +
      "one, otherwise creates it (which also enables the per-device traffic counter the Connected " +
      "Devices charts read). Identify the device by IP (the queue target).",
    inputSchema: {
      ip: z.string().describe("Device IP address (the queue target)"),
      download_limit: z
        .string()
        .optional()
        .describe('Max download rate, e.g. "10M". "0"/omit = unlimited'),
      upload_limit: z
        .string()
        .optional()
        .describe('Max upload rate, e.g. "2M". "0"/omit = unlimited'),
      name: z.string().optional().describe("Optional name for a newly created queue"),
    },
    async handler(a, ctx) {
      return (
        await setDeviceLimits(ctx, a.ip, {
          download: a.download_limit,
          upload: a.upload_limit,
          name: a.name,
        })
      ).message;
    },
  }),

  defineTool({
    name: "block_device",
    title: "Block a Device (Deny Network Access)",
    annotations: WRITE,
    ui: { ...DEVICE_UI },
    description:
      "Deny a device all network access by its MAC — installs tagged `/ip firewall filter` drop rules in the " +
      "forward chain (traffic through the router) and the input chain (access to the router itself), and sets " +
      "its DHCP lease block-access=yes. Blocking by MAC survives the device changing IP. Idempotent. Reverse " +
      "with allow_device. Identify by MAC.",
    inputSchema: {
      mac: z.string().describe("Device MAC address to block"),
      comment: z.string().optional().describe("Optional reason, appended to the rule label"),
    },
    async handler(a, ctx) {
      const r = await blockDevice(ctx, a.mac, a.comment);
      if (!r.ok) return r.message;
      return { text: r.message, structuredContent: devicesView(await fetchDevices(ctx)) };
    },
  }),

  defineTool({
    name: "allow_device",
    title: "Allow a Device (Restore Network Access)",
    annotations: DESTRUCTIVE,
    ui: { ...DEVICE_UI },
    description:
      "Restore network access for a previously blocked device — removes the tagged `mcp-blocked` drop rules " +
      "for its MAC from `/ip firewall filter` and clears its DHCP lease block-access. Reverses block_device. " +
      "Identify by MAC.",
    inputSchema: { mac: z.string().describe("Device MAC address to unblock") },
    async handler(a, ctx) {
      const r = await allowDevice(ctx, a.mac);
      if (!r.ok) return r.message;
      return { text: r.message, structuredContent: devicesView(await fetchDevices(ctx)) };
    },
  }),

  defineTool({
    name: "remove_device_lease",
    title: "Remove a Device's DHCP Lease",
    annotations: DESTRUCTIVE,
    description:
      "Delete a device's DHCP lease (`/ip dhcp-server lease remove`) — forgets a static reservation or clears " +
      "a stale dynamic lease. Does NOT block the device (use block_device for that). Identify by MAC. " +
      "Verifies the lease exists first.",
    inputSchema: { mac: z.string().describe("Device MAC address") },
    async handler(a, ctx) {
      return (await removeDeviceLease(ctx, a.mac)).message;
    },
  }),
];
