/** The Prometheus `/metrics` text: device gauges and tool-call counters. */
import { beforeEach, expect, test } from "vite-plus/test";
import type { ToolEvent } from "../../src/observability/event";
import type { DeviceStatus } from "../../src/observability/health";
import {
  observeToolCall,
  renderMetrics,
  resetMetrics,
  uptimeSeconds,
} from "../../src/observability/metrics";

beforeEach(resetMetrics);

const status: Record<string, Partial<DeviceStatus>> = {
  edge: {
    reachable: true,
    checkedAt: 1_700_000_000_000,
    latencyMs: 250,
    identity: 'Edge "1"',
    version: "7.25.1",
    boardName: "hAP ax3",
    cpuLoad: 7,
    cpuCount: 4,
    freeMemory: 100,
    totalMemory: 400,
    uptime: "1w2d3h4m5s",
  },
  core: { reachable: false, checkedAt: 1_700_000_000_000, latencyMs: null },
  fresh: { reachable: null, checkedAt: null, latencyMs: null },
};
const statusOf = (name: string): DeviceStatus => status[name] as DeviceStatus;

const call = (over: Partial<ToolEvent>): ToolEvent =>
  ({
    tool: "list_routes",
    risk: "READ",
    device: "edge",
    isError: false,
    durationMs: 500,
    ...over,
  }) as ToolEvent;

test("a RouterOS uptime is converted to seconds", () => {
  expect(uptimeSeconds("1w2d3h4m5s")).toBe(604_800 + 2 * 86_400 + 3 * 3600 + 4 * 60 + 5);
  expect(uptimeSeconds("45s")).toBe(45);
  expect(uptimeSeconds("soon")).toBeUndefined();
  expect(uptimeSeconds(undefined)).toBeUndefined();
});

test("devices are gauges; a router that was never probed has no up sample", () => {
  const text = renderMetrics(["edge", "core", "fresh"], statusOf);
  expect(text).toContain("# TYPE mikrotik_device_up gauge");
  expect(text).toContain('mikrotik_device_up{device="edge"} 1');
  expect(text).toContain('mikrotik_device_up{device="core"} 0');
  expect(text).not.toContain('mikrotik_device_up{device="fresh"}');
  expect(text).toContain(
    'mikrotik_device_info{device="edge",identity="Edge \\"1\\"",version="7.25.1",board="hAP ax3"} 1',
  );
  expect(text).toContain('mikrotik_device_probe_latency_seconds{device="edge"} 0.25');
  expect(text).toContain('mikrotik_device_cpu_load_percent{device="edge"} 7');
  expect(text).toContain('mikrotik_device_uptime_seconds{device="edge"} 788645');
  // A value that is missing gives no sample, and a metric with no sample no header.
  expect(text).not.toContain('mikrotik_device_cpu_load_percent{device="core"}');
  expect(text).not.toContain("mikrotik_device_disk_free_bytes");
  expect(text).not.toContain("mikrotik_mcp_tool_calls_total");
  expect(text.endsWith("\n")).toBe(true);
});

test("tool calls are counted by tool, device and outcome", () => {
  observeToolCall(call({}));
  observeToolCall(call({}));
  observeToolCall(call({ isError: true, durationMs: 1500 }));
  observeToolCall(call({ tool: "reboot_system", risk: "DANGEROUS", device: undefined }));
  const text = renderMetrics([], statusOf);
  expect(text).toContain(
    'mikrotik_mcp_tool_calls_total{tool="list_routes",risk="READ",device="edge",outcome="ok"} 2',
  );
  expect(text).toContain(
    'mikrotik_mcp_tool_calls_total{tool="list_routes",risk="READ",device="edge",outcome="error"} 1',
  );
  expect(text).toContain(
    'mikrotik_mcp_tool_call_duration_seconds_total{tool="list_routes",risk="READ",device="edge",outcome="ok"} 1',
  );
  expect(text).toContain(
    'mikrotik_mcp_tool_calls_total{tool="reboot_system",risk="DANGEROUS",outcome="ok"} 1',
  );
});
