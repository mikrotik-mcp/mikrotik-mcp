import { z } from "zod";

export const checkInput = z.object({
  label: z.string().trim().min(1).max(80),
  caseId: z.uuid().optional(),
  minutes: z.number().int().min(5).max(60).default(15),
});
export const runInput = z
  .object({
    label: z.string().trim().min(1).max(80),
    path: z.enum(["wifi", "vpn", "mobile", "ethernet", "other"]),
    idleMs: z.array(z.number().finite().min(0).max(60000)).max(20),
    loadedMs: z.array(z.number().finite().min(0).max(60000)).max(40),
    download: z
      .object({
        bytes: z.number().int().min(0).max(16_777_216),
        ms: z.number().finite().positive().max(120000),
      })
      .nullable(),
    upload: z
      .object({
        bytes: z.number().int().min(0).max(4_194_304),
        ms: z.number().finite().positive().max(120000),
      })
      .nullable(),
    errors: z.array(z.enum(["idle", "download", "upload", "loaded", "cancelled"])).max(5),
  })
  .strict();
export type CheckRun = z.infer<typeof runInput> & {
  id: string;
  receivedAt: number;
  peerAddress: string;
  family: "IPv4" | "IPv6" | "unknown";
  endpoint: string;
};
export interface CheckSession {
  id: string;
  device: string;
  createdAt: number;
  status: "open" | "closed";
  expiresAt: number;
  label: string;
  caseId?: string;
  tokenHash: string;
  runs: CheckRun[];
}
export interface CheckConnection {
  connectedAt: number;
  lastSeen: number;
  peerAddress: string;
  deviceLabel: string;
}
export type PublicCheckSession = Omit<CheckSession, "tokenHash"> & {
  connection?: CheckConnection | null;
};
export const CHECK_HEARTBEAT_MS = 10_000;
export const CHECK_PRESENCE_TTL_MS = 35_000;
export function checkConnectionState(session: PublicCheckSession, now: number) {
  if (session.status === "closed") return "closed";
  if (session.expiresAt <= now) return "expired";
  if (!session.connection) return "pending";
  return now - session.connection.lastSeen < CHECK_PRESENCE_TTL_MS ? "connected" : "disconnected";
}
/** A destination for a phone, not the server's bind address or this browser's loopback. */
export function clientCheckOrigin(value: string): string {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    /^(localhost|.*\.localhost|127\..*|0\.0\.0\.0|::|::1|::ffff:7f[\da-f]{2}:.*|::ffff:0:0)$/.test(
      host,
    )
  )
    throw new Error(
      "Use this server’s LAN/VPN IP or HTTPS hostname, not localhost, 127.0.0.1 or 0.0.0.0.",
    );
  return url.origin;
}
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y),
    m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
export function summarizeRun(run: z.infer<typeof runInput>) {
  const idle = median(run.idleMs),
    loaded = median(run.loadedMs);
  const rate = (v: typeof run.download) => (v && v.ms > 0 ? (v.bytes * 8) / (v.ms * 1000) : null);
  return {
    idleMs: idle,
    loadedMs: loaded,
    addedLatencyMs: idle !== null && loaded !== null ? loaded - idle : null,
    downloadMbps: rate(run.download),
    uploadMbps: rate(run.upload),
    jitterMs: median(run.idleMs.slice(1).map((v, i) => Math.abs(v - run.idleMs[i]))),
    complete:
      run.errors.length === 0 &&
      run.idleMs.length >= 5 &&
      run.loadedMs.length > 0 &&
      !!run.download?.bytes &&
      !!run.upload?.bytes,
  };
}
export function compareRuns(a: CheckRun, b: CheckRun) {
  const first = summarizeRun(a),
    second = summarizeRun(b);
  if (a.endpoint !== b.endpoint || !first.complete || !second.complete)
    return {
      comparable: false,
      reason: "Use two complete runs to the same endpoint. A failed phase is unknown, not zero.",
    };
  return {
    comparable: true,
    first,
    second,
    downloadChangeMbps: second.downloadMbps! - first.downloadMbps!,
    latencyChangeMs: second.idleMs! - first.idleMs!,
    note: "Sequential browser measurements; radio conditions and server load may differ. No router setting was changed.",
  };
}
