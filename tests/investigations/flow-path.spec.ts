import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
  flowBranches,
  flowPathInput,
  interfaceIndexFromOid,
} from "../../src/investigations/flow-path";
import { flowExporter, inspectFlowPath } from "../../src/investigations/flow-path-service";
import type { FlowRecord } from "../../src/flows/decode";
import type { FlowStore } from "../../src/flows/store";
import { getFlowCollector } from "../../src/flows/collector";
import { MikrotikConfigSchema } from "../../src/config";
import { getConfig, setConfig } from "../../src/core/runtime";
import { installAccessPolicy } from "../../src/core/access";
import { investigationRoutes } from "../../src/observability/investigation-routes";

const tuple = flowPathInput.parse({
  client: "192.0.2.10",
  destination: "203.0.113.1",
  source_port: 55000,
  destination_port: 443,
  protocol: "tcp",
  interface_names: ["office"],
});
const record: FlowRecord = {
  exporter: "192.0.2.1",
  start: 100,
  end: 200,
  src: tuple.client,
  dst: tuple.destination,
  srcPort: 55000,
  dstPort: 443,
  protocol: 6,
  packets: 1,
  bytes: 60,
  inputIf: 3,
  outputIf: 9,
  version: 9,
};
const mapping = [{ index: 9, name: "office", type: "wg", mappedAt: 300 }];
const original = getConfig();
const ctx = { device: "edge", info() {}, error() {} };
beforeEach(() => {
  setConfig(
    MikrotikConfigSchema.parse({ defaultDevice: "edge", devices: { edge: { host: "192.0.2.1" } } }),
  );
  installAccessPolicy({ enabled: false, scope: {} });
});
afterEach(() => {
  setConfig(original);
  installAccessPolicy({ enabled: false, scope: {} });
});

describe("exported flow evidence", () => {
  test("requires all five fields and the exporter, not aggregate VPN counters", () => {
    const rows = [
      record,
      { ...record, srcPort: 55001 },
      { ...record, exporter: "192.0.2.2" },
      { ...record, protocol: 17 },
      { ...record, dst: "203.0.113.2" },
      { ...record, dstPort: 80 },
      { ...record, src: "192.0.2.11" },
    ];
    const result = flowBranches(rows, tuple, record.exporter!, 0, 300, mapping);
    expect(result.matched).toHaveLength(1);
    expect(result.branches[0].egress?.name).toBe("office");
  });
  test("no export never implies packet loss or an exit", () => {
    expect(flowBranches([], tuple, record.exporter!, 0, 300, mapping).branches).toEqual([]);
  });
  test("old schema and index zero stay unknown", () => {
    const result = flowBranches(
      [{ ...record, outputIf: undefined, inputIf: 0 }],
      tuple,
      record.exporter!,
      0,
      300,
      mapping,
    );
    expect(result.branches[0]).toMatchObject({ inputIf: null, outputIf: null, egress: undefined });
  });
  test("ambiguous mappings never assign a name", () => {
    expect(
      flowBranches([record], tuple, record.exporter!, 0, 300, [
        ...mapping,
        { ...mapping[0], name: "other" },
      ]).branches[0].egress,
    ).toBeUndefined();
  });
  test("reports multiple exits, not a made-up sequential tunnel chain", () => {
    expect(
      flowBranches([record, { ...record, outputIf: 11 }], tuple, record.exporter!, 0, 300, mapping)
        .branches,
    ).toHaveLength(2);
  });
  test("rejects future, stale, reversed time and invalid counters", () => {
    const invalid = [
      { ...record, end: 301 },
      { ...record, end: 0 },
      { ...record, start: 201 },
      { ...record, packets: 0 },
      { ...record, bytes: Number.NaN },
    ];
    const result = flowBranches(invalid, tuple, record.exporter!, 1, 300, mapping);
    expect(result.branches).toEqual([]);
    expect(result.rejected).toBe(5);
  });
  test("return evidence requires exact reversed tuple and does not guess NAT", () => {
    const reply = {
      ...record,
      src: record.dst,
      dst: record.src,
      srcPort: record.dstPort,
      dstPort: record.srcPort,
    };
    expect(
      flowBranches([reply], tuple, record.exporter!, 0, 300, mapping, true).matched,
    ).toHaveLength(1);
    expect(
      flowBranches(
        [{ ...reply, dst: "198.51.100.2" }],
        tuple,
        record.exporter!,
        0,
        300,
        mapping,
        true,
      ).matched,
    ).toHaveLength(0);
  });
  test("uses the documented OID index, never the CLI ordinal", () => {
    expect(
      interfaceIndexFromOid("0 R name=.1.3.6.1.2.1.2.2.1.2.42 mtu=.1.3.6.1.2.1.2.2.1.4.42"),
    ).toBe(42);
    expect(interfaceIndexFromOid("0 R name=wg1")).toBeUndefined();
    expect(
      interfaceIndexFromOid("0 name=.1.3.6.1.2.1.2.2.1.2.42\n1 name=.1.3.6.1.2.1.2.2.1.2.43"),
    ).toBeUndefined();
  });
  test("validates IPv4, ports, protocols and bounded interface input", () => {
    for (const patch of [
      { client: "unknown" },
      { source_port: 0 },
      { protocol: "icmp" },
      { interface_names: Array.from({ length: 9 }, () => "office") },
      { interface_names: ["!office"] },
      { interface_names: ["office\n"] },
    ])
      expect(flowPathInput.safeParse({ ...tuple, ...patch }).success).toBe(false);
  });
});

function dependencies(rows: FlowRecord[] = []) {
  const read = vi.fn(
    async (_command: string) =>
      "MCP_FLOW_DETAIL_0\r\n0 R name=office type=wg\r\nMCP_FLOW_OID_0\r\n0 R name=.1.3.6.1.2.1.2.2.1.2.9\r\nMCP_FLOW_END\r\n",
  );
  const store = { query: vi.fn(() => rows), stats: () => ({ evicted: 0 }) } as unknown as FlowStore;
  return {
    read,
    store: async () => store,
    stats: () => ({ ...getFlowCollector().stats(), running: true, exporters: { "192.0.2.1": 1 } }),
    drain() {},
  };
}
test("unknown device fails before any store or router I/O", async () => {
  const deps = dependencies();
  deps.store = vi.fn(deps.store);
  await expect(inspectFlowPath(tuple, { ...ctx, device: "missing" }, deps)).rejects.toThrow();
  expect(deps.read).not.toHaveBeenCalled();
  expect(deps.store).not.toHaveBeenCalled();
});
test("ambiguous and DNS exporter bindings fail closed", () => {
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { edge: { host: "192.0.2.1" }, other: { host: "192.0.2.1" } },
      defaultDevice: "edge",
    }),
  );
  expect(() => flowExporter("edge")).toThrow("ambiguous");
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { edge: { host: "router.example" } },
      defaultDevice: "edge",
    }),
  );
  expect(() => flowExporter("edge")).toThrow("IPv4");
});
test("empty telemetry never contacts a router or silently passes", async () => {
  const deps = dependencies();
  const result = await inspectFlowPath(tuple, ctx, deps);
  expect(deps.read).not.toHaveBeenCalled();
  expect(result.forward).toEqual([]);
  expect(result.warnings.join(" ")).toContain("does not mean blocked");
});
test("matching evidence uses named read-only lookups, preserves numeric evidence on failure", async () => {
  const deps = dependencies([{ ...record, start: Date.now() - 1000, end: Date.now() - 500 }]);
  const result = await inspectFlowPath(tuple, ctx, deps);
  expect(result.forward[0].egress?.name).toBe("office");
  const command = deps.read.mock.calls[0]?.[0];
  expect(command).toContain("oid without-paging where name=office");
  expect(command).not.toMatch(/sniffer|torch|set |add |remove |start /);
  deps.read.mockResolvedValue("MCP_FLOW_DETAIL_0\n0 name=office type=wg");
  const partial = await inspectFlowPath(tuple, ctx, deps);
  expect(partial.forward[0].egress).toBeUndefined();
  expect(partial.forward[0].outputIf).toBe(9);
});
test("access denial precedes I/O", async () => {
  installAccessPolicy({ enabled: true, scope: { devices: ["other"] } });
  const deps = dependencies();
  await expect(inspectFlowPath(tuple, ctx, deps)).rejects.toThrow();
  expect(deps.read).not.toHaveBeenCalled();
});
test("dashboard rejects cross-origin requests and invalid tuple without I/O", async () => {
  const url = new URL("http://localhost:9091/api/investigations/flow-path?device=edge");
  const cross = await investigationRoutes(
    new Request(url, {
      method: "POST",
      headers: { origin: "http://evil.example" },
      body: JSON.stringify(tuple),
    }),
    url,
  );
  expect(cross?.status).toBe(403);
  const bad = await investigationRoutes(new Request(url, { method: "POST", body: "{}" }), url);
  expect(bad?.status).toBe(400);
  const get = await investigationRoutes(new Request(url), url);
  expect(get?.status).toBe(405);
});
