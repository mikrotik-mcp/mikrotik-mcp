import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../../src/config";
import { getConfig, setConfig } from "../../src/core/runtime";
import { installAccessPolicy } from "../../src/core/access";
import { getFlowCollector } from "../../src/flows/collector";
import type { FlowRecord } from "../../src/flows/decode";
import type { FlowStore } from "../../src/flows/store";
import { clientFlowCandidates, inspectFlowPath } from "../../src/investigations/flow-path-service";

const prior = getConfig();
const ctx = { device: "edge", info() {}, error() {} };
const tuple = {
  client: "192.0.2.10",
  destination: "203.0.113.1",
  source_port: 55000,
  destination_port: 443,
  protocol: "tcp" as const,
  interface_names: ["office"],
};
const recent = (): FlowRecord => ({
  exporter: "192.0.2.1",
  start: Date.now() - 1000,
  end: Date.now() - 500,
  src: tuple.client,
  dst: tuple.destination,
  srcPort: tuple.source_port,
  dstPort: tuple.destination_port,
  protocol: 6,
  packets: 2,
  bytes: 120,
  inputIf: 3,
  outputIf: 9,
  version: 9,
});

beforeEach(() => {
  setConfig(
    MikrotikConfigSchema.parse({ defaultDevice: "edge", devices: { edge: { host: "192.0.2.1" } } }),
  );
  installAccessPolicy({ enabled: false, scope: {} });
});
afterEach(() => {
  setConfig(prior);
  installAccessPolicy({ enabled: false, scope: {} });
  vi.restoreAllMocks();
});

function deps(forward: FlowRecord[], reverse: FlowRecord[] = [], output = "") {
  let query = 0;
  const read = vi.fn(async () => output);
  const store = {
    query: vi.fn(() => (query++ % 2 ? reverse : forward)),
    stats: () => ({ evicted: 1 }),
  } as unknown as FlowStore;
  return {
    read,
    store: async () => store,
    stats: () => ({
      ...getFlowCollector().stats(),
      running: false,
      decodeErrors: 1,
      exporters: {},
    }),
    drain: vi.fn(),
  };
}

test("incomplete lookup leaves indexes unresolved and reports missing telemetry", async () => {
  const d = deps([recent()], [], "MCP_FLOW_DETAIL_0\n0 name=office type=wg\n");
  const result = await inspectFlowPath(tuple, ctx, d);
  expect(result.forward[0].outputIf).toBe(9);
  expect(result.forward[0].egress).toBeUndefined();
  expect(result.warnings.join(" ")).toMatch(/could not be resolved/);
  expect(result.warnings.join(" ")).toMatch(/Collector is stopped/);
  expect(result.warnings.join(" ")).toMatch(/incomplete telemetry/);
  expect(d.read).toHaveBeenCalledOnce();
});

test("invalid or mismatched interface rows do not attach a guessed name", async () => {
  for (const body of [
    "MCP_FLOW_DETAIL_0\n0 name=other type=wg\nMCP_FLOW_OID_0\n0 name=.1.3.6.1.2.1.2.2.1.2.9\nMCP_FLOW_END",
    "MCP_FLOW_DETAIL_0\n0 name=office\nMCP_FLOW_OID_0\n0 name=.1.3.6.1.2.1.2.2.1.2.9\nMCP_FLOW_END",
    "MCP_FLOW_DETAIL_0\n0 name=office type=wg\nMCP_FLOW_OID_0\n0 name=bad\nMCP_FLOW_END",
  ]) {
    const result = await inspectFlowPath(tuple, ctx, deps([recent()], [], body));
    expect(result.forward[0].egress).toBeUndefined();
  }
});

test("valid named lookup correlates a reverse export and retains rejection counts", async () => {
  const row = recent();
  const reverse = {
    ...row,
    src: row.dst,
    dst: row.src,
    srcPort: row.dstPort,
    dstPort: row.srcPort,
  };
  const body =
    "MCP_FLOW_DETAIL_0\n0 name=office type=wg\nMCP_FLOW_OID_0\n0 name=.1.3.6.1.2.1.2.2.1.2.9\nMCP_FLOW_END";
  const result = await inspectFlowPath(
    tuple,
    ctx,
    deps([row, { ...row, packets: 0 }], [reverse], body),
  );
  expect(result.forward[0].egress?.name).toBe("office");
  expect(result.reverse).toHaveLength(1);
  expect(result.rejected).toBe(1);
});

test("candidate discovery filters stale, alien, invalid, and duplicate flow tuples", async () => {
  const collector = getFlowCollector();
  const drain = vi.spyOn(collector, "drain").mockImplementation(() => {});
  const traffic = await import("../../src/tools/traffic-flow");
  const row = recent();
  const query = vi.fn(() => [
    row,
    { ...row, start: row.start + 1, end: row.end + 1 },
    { ...row, src: "198.51.100.1" },
    { ...row, exporter: "192.0.2.9" },
    { ...row, protocol: 1 },
    { ...row, packets: 0 },
    { ...row, end: Date.now() + 10_000 },
    { ...row, dstPort: 0 },
  ]);
  vi.spyOn(traffic, "flowStore").mockResolvedValue({ query } as unknown as FlowStore);
  const result = await clientFlowCandidates(tuple.client, ctx);
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0].destination).toBe(tuple.destination);
  expect(drain).toHaveBeenCalledOnce();
});
