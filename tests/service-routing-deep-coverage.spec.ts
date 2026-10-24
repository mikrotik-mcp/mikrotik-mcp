import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createRouting, probeRouting, routingPolicy } from "../src/service-routing/service";

const mock = vi.hoisted(() => ({
  records: new Map<string, any>(),
  commands: [] as string[],
  addresses: ["203.0.113.5"] as string[],
  response: '{"status":"finished","code":200}',
  resolve: vi.fn(async () => mock.addresses),
  execute: vi.fn(async (command: string) => {
    mock.commands.push(command);
    return mock.response;
  }),
  locks: new Set<string>(),
}));
vi.mock("../src/core/runtime", () => ({
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
      },
    },
  }),
}));
vi.mock("../src/core/scoped-access", () => ({ assertDeviceAccess: vi.fn() }));
vi.mock("../src/operations/store", () => ({
  operationsStore: async () => ({
    get: (_kind: string, id: string, device: string) => {
      const policy = mock.records.get(id);
      return policy?.device === device ? structuredClone(policy) : undefined;
    },
    put: (_kind: string, policy: { id: string }) =>
      mock.records.set(policy.id, structuredClone(policy)),
    list: (_kind: string, device: string) =>
      [...mock.records.values()]
        .filter((policy) => policy.device === device)
        .map((policy) => structuredClone(policy)),
    lock: (device: string) => {
      if (mock.locks.has(device)) throw new Error("locked");
      mock.locks.add(device);
    },
    unlock: (device: string) => mock.locks.delete(device),
  }),
}));
vi.mock("../src/service-routing/read", () => ({
  readRoutingRows: async (path: string) =>
    path === "/ip vrf" ? [{ name: "warp", disabled: "no" }] : [],
  readRoutingAddressPage: async () => ({ rows: [], total: 0 }),
}));
vi.mock("../src/service-contracts/probe", () => ({ nativeProbeIO: { resolve: mock.resolve } }));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: mock.execute }));
vi.mock("../src/service-routing/inventory", () => ({
  routerRoutingInventory: {
    read: async () => ({ sections: { tables: { rows: [] } } }),
    clear: vi.fn(),
  },
}));

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
  mock.records.clear();
  mock.commands = [];
  mock.addresses = ["203.0.113.5"];
  mock.response = '{"status":"finished","code":200}';
  mock.locks.clear();
  vi.clearAllMocks();
  mock.resolve.mockImplementation(async () => mock.addresses);
  mock.execute.mockImplementation(async (command: string) => {
    mock.commands.push(command);
    return mock.response;
  });
});

describe("service routing probe evidence", () => {
  it("persists verified VRF success while leaving a table-only path unknown", async () => {
    const policy = await createRouting(input, ctx);
    const result = await probeRouting(policy.id, ctx);
    expect(result.samples).toMatchObject([
      { table: "main", state: "unknown", address: "203.0.113.5" },
      { table: "warp", state: "pass", address: "203.0.113.5" },
    ]);
    expect(mock.commands).toHaveLength(1);
    expect(mock.commands[0]).toContain("203.0.113.5@warp");
    expect((await routingPolicy(policy.id, "lab")).samples).toHaveLength(2);
    expect(mock.locks.size).toBe(0);
  });

  it("refuses unapproved DNS answers without sending a router fetch", async () => {
    const policy = await createRouting(input, ctx);
    mock.addresses = ["192.0.2.9"];
    const result = await probeRouting(policy.id, ctx);
    expect(result.samples.every((sample) => sample.state === "unknown")).toBe(true);
    expect(mock.execute).not.toHaveBeenCalled();
    expect(mock.locks.size).toBe(0);
  });

  it("distinguishes fetch failure from unsupported parser output", async () => {
    const policy = await createRouting(input, ctx);
    mock.response = "failure: SSL handshake failed";
    expect((await probeRouting(policy.id, ctx)).samples.at(-1)).toMatchObject({ state: "fail" });
    mock.response = "syntax error";
    expect((await probeRouting(policy.id, ctx)).samples.at(-1)).toMatchObject({ state: "unknown" });
    expect(mock.locks.size).toBe(0);
  });
});
