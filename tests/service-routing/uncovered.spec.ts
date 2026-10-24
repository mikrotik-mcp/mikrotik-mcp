import { beforeEach, expect, test, vi } from "vite-plus/test";
import {
  armRouting,
  createRouting,
  probeRouting,
  routingInventory,
  routingPolicy,
} from "../../src/service-routing/service";

const rig = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  resolve: vi.fn(async () => ["203.0.113.5"]),
  execute: vi.fn(async () => '{"status":"finished","code":200}'),
  vrfs: ["main", "warp"],
  inventory: vi.fn(async () => ({
    sections: {
      tables: {
        rows: [
          { name: "main", fib: "yes" },
          { name: "warp", fib: "true" },
          { name: "disabled", fib: "yes", disabled: "yes" },
          { name: "nonfib", fib: "no" },
        ],
      },
    },
  })),
}));
vi.mock("../../src/core/runtime", () => ({
  resolveDeviceName: (name: string) => name,
  getConfig: () => ({
    devices: { lab: {} },
    serviceProbes: {
      targets: {
        approved: {
          kind: "https",
          host: "example.com",
          path: "/health",
          port: 443,
          addresses: ["203.0.113.5"],
        },
        unapproved: { kind: "tcp", host: "other.example", port: 443 },
      },
    },
  }),
}));
vi.mock("../../src/core/scoped-access", () => ({ assertDeviceAccess: vi.fn() }));
vi.mock("../../src/operations/store", () => ({
  operationsStore: async () => ({
    get: (_kind: string, id: string, device: string) => {
      const p = rig.records.get(id) as { device: string } | undefined;
      return p?.device === device ? structuredClone(p) : undefined;
    },
    put: (_kind: string, p: { id: string }) => rig.records.set(p.id, structuredClone(p)),
    list: (_kind: string, device: string) =>
      [...rig.records.values()]
        .filter((p) => (p as { device: string }).device === device)
        .map((p) => structuredClone(p)),
    lock: vi.fn(),
    unlock: vi.fn(),
  }),
}));
vi.mock("../../src/service-routing/read", () => ({
  readRoutingRows: async (path: string) =>
    path === "/ip vrf" ? rig.vrfs.map((name) => ({ name, disabled: "no" })) : [],
  readRoutingAddressPage: async () => ({ rows: [], total: 0 }),
}));
vi.mock("../../src/service-routing/inventory", () => ({
  routerRoutingInventory: { read: rig.inventory, clear: vi.fn() },
}));
vi.mock("../../src/service-contracts/probe", () => ({ nativeProbeIO: { resolve: rig.resolve } }));
vi.mock("../../src/core/connector", () => ({ executeMikrotikCommand: rig.execute }));

const ctx = { device: "lab" } as Parameters<typeof createRouting>[1];
const input = {
  name: "Example",
  target: "approved",
  family: "ipv4",
  sources: ["10.1.0.0/24"],
  tables: ["main", "warp"],
  primary: "main",
};
beforeEach(() => {
  rig.records.clear();
  rig.vrfs = ["main", "warp"];
  vi.clearAllMocks();
  rig.resolve.mockResolvedValue(["203.0.113.5"]);
  rig.execute.mockResolvedValue('{"status":"finished","code":200}');
});

test("inventory only advertises enabled FIB tables and approved HTTPS targets", async () => {
  expect(await routingInventory(ctx)).toMatchObject({
    tables: ["main", "warp"],
    targets: [{ alias: "approved", host: "example.com" }],
  });
});

test("DNS resolution failure leaves both exits unknown without fetch", async () => {
  const p = await createRouting(input, ctx);
  rig.resolve.mockRejectedValue(new Error("DNS timeout"));
  const result = await probeRouting(p.id, ctx);
  expect(result.samples.map((sample) => sample.state)).toEqual(["unknown", "unknown"]);
  expect(rig.execute).not.toHaveBeenCalled();
});

test("wrong address family leaves IPv4 exits unknown", async () => {
  const p = await createRouting(input, ctx);
  rig.resolve.mockResolvedValue(["2001:db8::5"]);
  const result = await probeRouting(p.id, ctx);
  expect(result.samples.every((sample) => sample.state === "unknown")).toBe(true);
  expect(rig.execute).not.toHaveBeenCalled();
});

test("slow successful HTTPS fetch fails the latency threshold", async () => {
  const p = await createRouting(input, ctx);
  const saved = rig.records.get(p.id) as typeof p;
  rig.records.set(p.id, { ...saved, maxLatencyMs: 1 });
  rig.execute.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return '{"status":"finished","code":200}';
  });
  const result = await probeRouting(p.id, ctx);
  expect(result.samples.map((sample) => sample.state)).toEqual(["fail", "fail"]);
});

test("transport exception remains unknown and changed probe approval is rejected", async () => {
  const p = await createRouting(input, ctx);
  rig.execute.mockRejectedValue(new Error("SSH dropped"));
  const result = await probeRouting(p.id, ctx);
  expect(result.samples.every((sample) => sample.state === "unknown")).toBe(true);
  rig.records.set(p.id, { ...result, probeHost: "changed.example" });
  await expect(probeRouting(p.id, ctx)).rejects.toThrow("Probe approval changed");
});

test("arming requires fresh passing evidence for every exit", async () => {
  const p = await createRouting(input, ctx);
  rig.records.set(p.id, {
    ...p,
    state: "active",
    samples: [
      { table: "main", state: "pass", at: Date.now() },
      { table: "warp", state: "pass", at: Date.now() },
    ],
  });
  const armed = await armRouting(p.id, 10, true, ctx);
  expect(armed.armedUntil).toBeGreaterThan(Date.now());
  expect((await routingPolicy(p.id, "lab")).armedUntil).toBe(armed.armedUntil);
  expect((await armRouting(p.id, 0, true, ctx)).armedUntil).toBeUndefined();
});
