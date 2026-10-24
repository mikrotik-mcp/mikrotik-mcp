import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import { trafficFlowTools } from "../src/tools/traffic-flow";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  getFlowCollector: vi.fn(),
  openFlowStore: vi.fn(),
}));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: mocks.command }));
vi.mock("../src/flows/collector", () => ({ getFlowCollector: mocks.getFlowCollector }));
vi.mock("../src/flows/store", () => ({ openFlowStore: mocks.openFlowStore }));

const store = { query: vi.fn() };
const collector = {
  running: false,
  drain: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  stats: vi.fn(),
};
const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };

function call(name: string, args: Record<string, unknown> = {}) {
  const tool = trafficFlowTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Unknown tool ${name}`);
  return tool.handler(args as never, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.command.mockResolvedValue("0 name=fixture");
  mocks.openFlowStore.mockResolvedValue(store);
  mocks.getFlowCollector.mockReturnValue(collector);
  collector.running = false;
  collector.stats.mockReturnValue({
    running: false,
    packets: 0,
    flows: 0,
    port: 2055,
    templatesPending: 0,
    decodeErrors: 0,
  });
  collector.start.mockResolvedValue({ ok: true });
  store.query.mockReturnValue([]);
});

test("flow health reads only collector counters", async () => {
  const result = await call("get_flow_collector_health");
  expect(result).toContain('"port": 2055');
  expect(mocks.command).not.toHaveBeenCalled();
});

test("settings and target reads distinguish empty, device errors, and values", async () => {
  mocks.command.mockResolvedValueOnce("");
  expect(await call("get_traffic_flow_settings")).toContain("No traffic-flow settings");
  mocks.command.mockResolvedValueOnce("failure: unsupported");
  expect(await call("get_traffic_flow_settings")).toContain("Failed to read");
  expect(await call("get_traffic_flow_settings")).toContain("TRAFFIC FLOW");

  mocks.command.mockResolvedValueOnce("");
  expect(await call("list_traffic_flow_targets")).toContain("No traffic-flow targets");
  mocks.command.mockResolvedValueOnce("failure: unsupported");
  expect(await call("list_traffic_flow_targets")).toContain("Failed to list");
  expect(await call("list_traffic_flow_targets")).toContain("TRAFFIC FLOW TARGETS");
});

test("setting traffic-flow requires at least one option and confirms the applied state", async () => {
  expect(await call("set_traffic_flow_settings")).toContain("No settings specified");
  expect(mocks.command).not.toHaveBeenCalled();
  const result = await call("set_traffic_flow_settings", {
    enabled: true,
    interfaces: "ether1",
    cache_entries: "16k",
    active_flow_timeout: "5m",
    inactive_flow_timeout: "15s",
  });
  expect(mocks.command.mock.calls[0]?.[0]).toContain("enabled=yes");
  expect(mocks.command.mock.calls[0]?.[0]).toContain("cache-entries=16k");
  expect(result).toContain("settings updated");
  mocks.command.mockResolvedValueOnce("failure: rejected");
  expect(await call("set_traffic_flow_settings", { enabled: false })).toContain("Failed to update");
});

test("adding a collector includes all export settings and warns when legacy v5 loses IPv6", async () => {
  const result = await call("add_traffic_flow_target", {
    dst_address: "192.0.2.40",
    port: 2055,
    version: "5",
    v9_template_refresh: 10,
    v9_template_timeout: "30s",
  });
  expect(mocks.command.mock.calls[0]?.[0]).toContain("dst-address=192.0.2.40");
  expect(mocks.command.mock.calls[0]?.[0]).toContain("v9-template-refresh=10");
  expect(result).toContain("IPv6 flows will be missing");
  mocks.command.mockResolvedValueOnce("failure: denied");
  expect(
    await call("add_traffic_flow_target", { dst_address: "192.0.2.40", port: 2055, version: "9" }),
  ).toContain("Failed to add");
});

test("removal does not issue a write for an absent collector", async () => {
  mocks.command.mockResolvedValueOnce("0");
  expect(await call("remove_traffic_flow_target", { dst_address: "192.0.2.40" })).toContain(
    "No traffic-flow target",
  );
  expect(mocks.command).toHaveBeenCalledTimes(1);
  mocks.command.mockResolvedValueOnce("1").mockResolvedValueOnce("failure: denied");
  expect(await call("remove_traffic_flow_target", { dst_address: "192.0.2.40" })).toContain(
    "Failed to remove",
  );
  mocks.command.mockResolvedValueOnce("1").mockResolvedValueOnce("");
  expect(await call("remove_traffic_flow_target", { dst_address: "192.0.2.40" })).toContain(
    "removed",
  );
});

test("host collector lifecycle reports running, bind failure, success, and stop", async () => {
  collector.running = true;
  expect(await call("start_flow_collector", { port: 2055 })).toContain("already running");
  expect(collector.start).not.toHaveBeenCalled();
  collector.running = false;
  collector.start.mockResolvedValueOnce({ ok: false, error: "address in use" });
  expect(await call("start_flow_collector", { port: 2055 })).toContain("address in use");
  expect(await call("start_flow_collector", { port: 2055 })).toContain("listening on UDP 2055");
  expect(await call("stop_flow_collector")).toContain("not running");
  collector.running = true;
  expect(await call("stop_flow_collector")).toContain("stored flows remain queryable");
  expect(collector.stop).toHaveBeenCalledTimes(1);
  expect(mocks.command).not.toHaveBeenCalled();
});

test("empty-flow advice reflects collector state without inventing traffic", async () => {
  expect(
    await call("flow_top_talkers", { dimension: "source", window: "1h", limit: 10 }),
  ).toContain("NOT running");
  expect(store.query).toHaveBeenCalledWith(expect.objectContaining({ limit: 200_000 }));
  collector.stats.mockReturnValue({
    running: true,
    packets: 0,
    port: 2055,
    templatesPending: 0,
    decodeErrors: 0,
  });
  expect(
    await call("flow_top_talkers", { dimension: "source", window: "1h", limit: 10 }),
  ).toContain("received nothing");
  collector.stats.mockReturnValue({
    running: true,
    packets: 3,
    port: 2055,
    templatesPending: 2,
    decodeErrors: 0,
  });
  expect(await call("analyze_flows", { window: "1h", anomaly_ratio: 3 })).toContain(
    "waiting for their template",
  );
  collector.stats.mockReturnValue({
    running: true,
    packets: 3,
    port: 2055,
    templatesPending: 0,
    decodeErrors: 2,
    lastError: "bad header",
  });
  expect(await call("analyze_flows", { window: "1h", anomaly_ratio: 3 })).toContain("bad header");
  collector.stats.mockReturnValue({
    running: true,
    packets: 3,
    port: 2055,
    templatesPending: 0,
    decodeErrors: 0,
  });
  expect(
    await call("flow_top_talkers", { dimension: "source", window: "1h", limit: 10 }),
  ).toContain("idle");
});

test("nonempty flows produce talker and analysis reports without router I/O", async () => {
  const flow = {
    start: Date.now() - 1_000,
    end: Date.now(),
    src: "192.0.2.10",
    dst: "198.51.100.20",
    srcPort: 40000,
    dstPort: 443,
    protocol: 6,
    bytes: 2_000_000,
    packets: 30,
    version: 9,
  };
  store.query.mockReturnValue([flow]);
  const top = await call("flow_top_talkers", { dimension: "source", window: "5m", limit: 10 });
  expect(top).toContain("TOP SOURCE");
  const analysis = await call("analyze_flows", {
    window: "5m",
    anomaly_ratio: 3,
    address: "192.0.2.10",
  });
  expect(analysis).toContain("TRAFFIC FLOW ANALYSIS");
  expect(analysis).toContain("Protocol mix");
  expect(store.query).toHaveBeenCalledWith(expect.objectContaining({ address: "192.0.2.10" }));
  expect(mocks.command).not.toHaveBeenCalled();
});
