import type {
  BandwidthJob,
  BandwidthRun,
  BandwidthPreflight,
  BandwidthState,
} from "../../../src/bandwidth/types";
export type { BandwidthJob, BandwidthRun, BandwidthPreflight, BandwidthState };
export type JobInput = Omit<BandwidthJob, "nextRunAt">;
export const impact =
  "Bandwidth tests generate traffic, may saturate tunnels and increase router CPU load. No server or firewall changes are made. Destination credentials come from server runtime configuration.";
/** Validate bounded test definitions before sending them to the dashboard. */
export function validateJob(job: JobInput): void {
  for (const key of [
    "name",
    "source",
    "destination",
    "sourceInterface",
    "sourceAddress",
    "destinationAddress",
  ] as const)
    if (!job[key].trim()) throw new Error(`${key} is required`);
  const ipv4 = (value: string) =>
    /^(\d{1,3}\.){3}\d{1,3}$/.test(value) &&
    value.split(".").every((part) => Number(part) <= 255);
  if (!ipv4(job.destinationAddress) || !ipv4(job.sourceAddress))
    throw new Error(
      "Source and destination must be explicit IPv4 addresses without CIDR",
    );
  for (const [key, min, max] of [
    ["intervalSeconds", 300, 604800],
    ["durationSeconds", 5, 60],
    ["localTxBps", 1, 1e11],
    ["remoteTxBps", 1, 1e11],
    ["localUdpTxSize", 28, 64000],
    ["remoteUdpTxSize", 28, 64000],
    ["connectionCount", 1, 255],
  ] as const)
    if (!Number.isInteger(job[key]) || job[key] < min || job[key] > max)
      throw new Error(`${key} must be an integer from ${min} to ${max}`);
  if (
    !Number.isFinite(job.reportIntervalSeconds) ||
    job.reportIntervalSeconds < 0.02 ||
    job.reportIntervalSeconds > 5 ||
    Math.abs(
      job.reportIntervalSeconds * 1000 -
        Math.round(job.reportIntervalSeconds * 1000),
    ) > 1e-9
  )
    throw new Error(
      "Report interval must be from 0.02 to 5 seconds in whole milliseconds",
    );
  if (
    !["tcp", "udp"].includes(job.protocol) ||
    !["transmit", "receive", "both"].includes(job.direction)
  )
    throw new Error("Invalid protocol or direction");
}
/** Keep router/user text inside a single markdown table cell. */
export function cell(value: unknown): string {
  return String(value ?? "—")
    .replace(/[\\`*_[\]<>]/g, "\\$&")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]/g, " ");
}
/** Preserve unavailable measurements rather than displaying zero throughput. */
export function mbps(value: number | null): string {
  return value === null ? "—" : (value / 1e6).toFixed(2);
}

/** Only completed successful runs contribute throughput chart samples. */
export function measurement(
  run: BandwidthRun,
  field: "txBps" | "rxBps",
): number | null {
  const value = run[field];
  return run.status === "ok" &&
    value !== null &&
    Number.isFinite(value) &&
    value >= 0
    ? value / 1e6
    : null;
}

/** Select stored runs by job identity and inclusive start-time boundaries. */
export function comparisonRuns(
  runs: BandwidthRun[],
  jobIds: string[],
  from: number,
  to: number,
): BandwidthRun[] {
  return runs
    .filter(
      (run) =>
        jobIds.includes(run.job.id) &&
        run.startedAt >= from &&
        run.startedAt <= to,
    )
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** Summarize successful numeric samples independently for each traffic direction. */
export function summarizeRuns(runs: BandwidthRun[]) {
  const stats = (field: "txBps" | "rxBps") => {
    const values = runs
      .map((run) => measurement(run, field))
      .filter((value): value is number => value !== null);
    return values.length
      ? {
          count: values.length,
          min: Math.min(...values),
          mean: values.reduce((sum, value) => sum + value, 0) / values.length,
          max: Math.max(...values),
        }
      : null;
  };
  return {
    success: runs.filter((run) => run.status === "ok").length,
    failed: runs.filter((run) => run.status === "failed").length,
    interrupted: runs.filter((run) => run.status === "interrupted").length,
    running: runs.filter((run) => run.status === "running").length,
    tx: stats("txBps"),
    rx: stats("rxBps"),
  };
}
