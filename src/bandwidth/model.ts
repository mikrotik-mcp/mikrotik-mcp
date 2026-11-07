import { z } from "zod";
import { Cmd, flattenLiveOutput, looksLikeError } from "../core/routeros";
import { parseKeyValues } from "../core/routeros-parse";
import type { BandwidthJob, BandwidthRun } from "./types";

export const BandwidthJobSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    name: z.string().trim().min(1).max(100),
    source: z.string().min(1).max(128),
    destination: z.string().min(1).max(128),
    sourceInterface: z.string().min(1).max(128),
    sourceAddress: z.ipv4(),
    destinationAddress: z.ipv4(),
    protocol: z.enum(["tcp", "udp"]).default("tcp"),
    direction: z.enum(["transmit", "receive", "both"]).default("both"),
    durationSeconds: z.number().int().min(5).max(60).default(10),
    localTxBps: z.number().int().min(1).max(100_000_000_000).default(10_000_000),
    remoteTxBps: z.number().int().min(1).max(100_000_000_000).default(10_000_000),
    localUdpTxSize: z.number().int().min(28).max(64000).default(1500),
    remoteUdpTxSize: z.number().int().min(28).max(64000).default(1500),
    randomData: z.boolean().default(false),
    connectionCount: z.number().int().min(1).max(255).default(1),
    reportIntervalSeconds: z
      .number()
      .min(0.02)
      .max(5)
      .refine((v) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-9, "Use whole milliseconds")
      .default(1),
    intervalSeconds: z.number().int().min(300).max(604800).default(3600),
    enabled: z.boolean().default(false),
    nextRunAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export const PATH_WARNING =
  "Interface and source address are route expectations, not bindings. RouterOS bandwidth-test has no documented local-address parameter. Routing chooses the source and path; policy routing, NAT, firewall and route changes can affect delivery. Transmit is source → destination; receive is destination → source. Tests consume link bandwidth and router CPU. Destination server/firewall settings are never changed.";

/** Build only documented RouterOS arguments; credentials remain transient. */
export function bandwidthCommand(
  job: BandwidthJob,
  credentials?: { username: string; password: string },
): string {
  const cmd = new Cmd("/tool bandwidth-test")
    .set("address", job.destinationAddress)
    .set("direction", job.direction)
    .set("duration", `${job.durationSeconds}s`)
    .set("interval", `${Math.round(job.reportIntervalSeconds * 1000)}ms`)
    .set("protocol", job.protocol)
    .set("local-tx-speed", job.localTxBps)
    .set("remote-tx-speed", job.remoteTxBps)
    .bool("random-data", job.randomData);
  if (job.protocol === "udp") {
    cmd.set("local-udp-tx-size", job.localUdpTxSize).set("remote-udp-tx-size", job.remoteUdpTxSize);
  } else cmd.set("connection-count", job.connectionCount);
  if (credentials) cmd.set("user", credentials.username).set("password", credentials.password);
  return cmd.build();
}

/** Convert RouterOS SI rates, preserving absent or malformed values as unknown. */
export function bandwidthRate(value: string | undefined): number | null {
  const match = value?.match(/^(\d+(?:\.\d+)?)\s*([kMGT]?)bps$/i);
  if (!match) return null;
  const valueBps =
    Number(match[1]) * 1000 ** ({ "": 0, k: 1, m: 2, g: 3, t: 4 }[match[2].toLowerCase()] ?? 0);
  return Number.isFinite(valueBps) ? valueBps : null;
}

/** Use the final terminal redraw, and never turn partial/error output into a success. */
export function parseBandwidthResult(
  raw: string,
  direction: BandwidthJob["direction"],
): Pick<BandwidthRun, "status" | "txBps" | "rxBps" | "lostPackets" | "message"> {
  const output = flattenLiveOutput(raw);
  // Last occurrence wins across newline-delimited progress frames as well as terminal redraws.
  const fields = Object.assign(
    {},
    ...output.split(/\r?\n/).map((line) => parseKeyValues(line)),
  ) as Record<string, string>;
  const txBps = direction === "receive" ? null : bandwidthRate(fields["tx-total-average"]);
  const rxBps = direction === "transmit" ? null : bandwidthRate(fields["rx-total-average"]);
  const ok =
    !looksLikeError(output) &&
    fields.status === "done testing" &&
    (direction === "receive" || txBps !== null) &&
    (direction === "transmit" || rxBps !== null);
  const lost = fields["lost-packets"];
  return {
    status: ok ? "ok" : "failed",
    txBps: ok ? txBps : null,
    rxBps: ok ? rxBps : null,
    lostPackets:
      ok && lost && /^\d+$/.test(lost) && Number.isSafeInteger(Number(lost)) ? Number(lost) : null,
    message: ok
      ? "Completed; averages are measured from the source router."
      : "No complete measurement. Check destination authentication, firewall, route, device mode and server availability. Partial output is not a successful test.",
  };
}

/** Match a destination to an IPv4 route without signed integer overflow. */
function prefixLength(cidr: string | undefined, address: string): number {
  if (!cidr) return -1;
  const [network, bitsText] = cidr.split("/");
  const bits = Number(bitsText ?? 32);
  if (!z.ipv4().safeParse(network).success || !Number.isInteger(bits) || bits < 0 || bits > 32)
    return -1;
  const number = (ip: string) => ip.split(".").reduce((acc, octet) => acc * 256 + Number(octet), 0);
  return Math.floor(number(network) / 2 ** (32 - bits)) ===
    Math.floor(number(address) / 2 ** (32 - bits))
    ? bits
    : -1;
}

/** Fail closed when the active main-table route is missing, ambiguous or points elsewhere. */
export function expectedRoute(job: BandwidthJob, rows: Record<string, string>[]): boolean {
  const candidates = rows.filter(
    (row) =>
      (row.active === "true" || row.active === "yes" || /A/.test(row.flags ?? "")) &&
      !/[XI]/.test(row.flags ?? "") &&
      row.disabled !== "true" &&
      row.disabled !== "yes" &&
      (row["routing-table"] ?? "main") === "main" &&
      !row["routing-mark"] &&
      prefixLength(row["dst-address"], job.destinationAddress) >= 0,
  );
  const best = Math.max(
    -1,
    ...candidates.map((row) => prefixLength(row["dst-address"], job.destinationAddress)),
  );
  const matches = candidates.filter(
    (row) => prefixLength(row["dst-address"], job.destinationAddress) === best,
  );
  if (matches.length !== 1) return false;
  const route = matches[0];
  if (
    ["true", "yes"].includes(route.blackhole) ||
    ["blackhole", "unreachable", "prohibit"].includes(route.type) ||
    /B/.test(route.flags ?? "")
  )
    return false;
  const gateway = route["immediate-gw"] || route.gateway || "";
  if (gateway.includes(",") || gateway.includes(";")) return false;
  const iface = gateway.includes("%") ? gateway.split("%").at(-1) : gateway;
  return (
    iface === job.sourceInterface && (!route["pref-src"] || route["pref-src"] === job.sourceAddress)
  );
}
