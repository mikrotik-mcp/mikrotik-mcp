/**
 * Prometheus metrics for the dashboard's `/metrics` route.
 *
 * Two sources, both already in memory, so a scrape opens no connection to a
 * router and reads no database:
 *
 * - the last health probe of each router (reachable, latency, CPU, memory, disk,
 *   uptime), from `health.ts`;
 * - counters of the tool calls that finished since this process started.
 *
 * PURE except the counters, which `observeToolCall` fills from the recorder.
 */
import type { ToolEvent } from "./event";
import type { DeviceStatus } from "./health";

/** Escape a label value: backslash, double quote and newline. */
const label = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

const labels = (pairs: Record<string, string | undefined>): string => {
  const parts = Object.entries(pairs)
    .filter((pair): pair is [string, string] => pair[1] !== undefined && pair[1] !== "")
    .map(([key, value]) => `${key}="${label(value)}"`);
  return parts.length > 0 ? `{${parts.join(",")}}` : "";
};

/** A RouterOS duration (`3w2d1h5m9s`) in seconds, or undefined when it is not one. */
export function uptimeSeconds(uptime: string | undefined): number | undefined {
  if (!uptime || !/^(?:\d+[wdhms])+$/.test(uptime)) return undefined;
  const size: Record<string, number> = { w: 604_800, d: 86_400, h: 3600, m: 60, s: 1 };
  let total = 0;
  for (const [, amount, unit] of uptime.matchAll(/(\d+)([wdhms])/g))
    total += Number(amount) * size[unit!]!;
  return total;
}

interface CallCount {
  tool: string;
  risk: string;
  device: string;
  outcome: "ok" | "error";
  count: number;
  seconds: number;
}
const calls = new Map<string, CallCount>();
/** A bound on label combinations: a hostile or broken client cannot grow it without end. */
const MAX_SERIES = 5000;

export function observeToolCall(event: ToolEvent): void {
  const outcome = event.isError ? "error" : "ok";
  const device = event.device ?? "";
  const key = `${event.tool}\0${device}\0${outcome}`;
  let entry = calls.get(key);
  if (!entry) {
    if (calls.size >= MAX_SERIES) return;
    entry = { tool: event.tool, risk: event.risk, device, outcome, count: 0, seconds: 0 };
    calls.set(key, entry);
  }
  entry.count += 1;
  entry.seconds += event.durationMs / 1000;
}

/** Forget the counters (tests only). */
export function resetMetrics(): void {
  calls.clear();
}

type Sample = [labels: Record<string, string | undefined>, value: number | null | undefined];

/** The text exposition format (version 0.0.4). */
export function renderMetrics(devices: string[], statusOf: (name: string) => DeviceStatus): string {
  const out: string[] = [];
  const metric = (
    name: string,
    type: "gauge" | "counter",
    help: string,
    samples: Sample[],
  ): void => {
    const lines = samples
      .filter((sample): sample is [Record<string, string | undefined>, number] =>
        Number.isFinite(sample[1]),
      )
      .map(([pairs, value]) => `${name}${labels(pairs)} ${value}`);
    if (lines.length === 0) return;
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...lines);
  };

  const status = devices.map((device) => ({ device, s: statusOf(device) }));
  const per = (pick: (s: DeviceStatus) => number | null | undefined): Sample[] =>
    status.map(({ device, s }) => [{ device }, pick(s)]);

  metric(
    "mikrotik_device_up",
    "gauge",
    "1 when the last health probe reached the router, 0 when it did not.",
    status
      .filter(({ s }) => s.reachable !== null)
      .map(({ device, s }) => [{ device }, s.reachable ? 1 : 0]),
  );
  metric(
    "mikrotik_device_info",
    "gauge",
    "Always 1. The labels carry the identity, version, board and architecture.",
    status
      .filter(({ s }) => s.reachable === true)
      .map(({ device, s }) => [
        {
          device,
          identity: s.identity ?? undefined,
          version: s.version ?? undefined,
          board: s.boardName,
          architecture: s.architecture,
        },
        1,
      ]),
  );
  metric(
    "mikrotik_device_probe_latency_seconds",
    "gauge",
    "How long the last health probe took.",
    per((s) => (s.latencyMs == null ? null : s.latencyMs / 1000)),
  );
  metric(
    "mikrotik_device_probe_timestamp_seconds",
    "gauge",
    "When the router was last probed (Unix time).",
    per((s) => (s.checkedAt == null ? null : s.checkedAt / 1000)),
  );
  metric(
    "mikrotik_device_cpu_load_percent",
    "gauge",
    "CPU load.",
    per((s) => s.cpuLoad),
  );
  metric(
    "mikrotik_device_cpu_count",
    "gauge",
    "Number of CPU cores.",
    per((s) => s.cpuCount),
  );
  metric(
    "mikrotik_device_memory_free_bytes",
    "gauge",
    "Free memory.",
    per((s) => s.freeMemory),
  );
  metric(
    "mikrotik_device_memory_total_bytes",
    "gauge",
    "Total memory.",
    per((s) => s.totalMemory),
  );
  metric(
    "mikrotik_device_disk_free_bytes",
    "gauge",
    "Free system storage.",
    per((s) => s.freeHdd),
  );
  metric(
    "mikrotik_device_disk_total_bytes",
    "gauge",
    "Total system storage.",
    per((s) => s.totalHdd),
  );
  metric(
    "mikrotik_device_uptime_seconds",
    "gauge",
    "Time since the router started.",
    per((s) => uptimeSeconds(s.uptime)),
  );

  const counted = Array.from(calls.values());
  const callLabels = (c: CallCount): Record<string, string> => ({
    tool: c.tool,
    risk: c.risk,
    device: c.device,
    outcome: c.outcome,
  });
  metric(
    "mikrotik_mcp_tool_calls_total",
    "counter",
    "Tool calls that finished since the server started.",
    counted.map((c) => [callLabels(c), c.count]),
  );
  metric(
    "mikrotik_mcp_tool_call_duration_seconds_total",
    "counter",
    "Total time spent in tool calls. Divide by the call count for the mean.",
    counted.map((c) => [callLabels(c), Number(c.seconds.toFixed(3))]),
  );
  return `${out.join("\n")}\n`;
}
