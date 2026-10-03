import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createRouting,
  listRouting,
  previewRouting,
  applyRouting,
  armRouting,
  probeRouting,
} from "../../src/service-routing/service";
import { operationsRoutes } from "../../src/observability/operations-routes";
import { parseRecords } from "../../src/core/routeros-parse";
import { ownerTag } from "../../src/service-routing/model";
import type { RoutingPolicy } from "../../src/service-routing/model";

const mock = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  readOnly: false,
  rules: [] as Record<string, string>[],
  addresses: [] as Record<string, string>[],
  commands: [] as string[],
  fail: false,
  commitOk: true,
  locks: new Set<string>(),
  enable: vi.fn(async () => "Safe mode ENABLED"),
  commit: vi.fn(async () => ({ ok: true })),
  rollback: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../../src/core/registry", () => ({
  defineTool: (tool: unknown) => tool,
  READ: {},
  WRITE: {},
}));
vi.mock("../../src/core/runtime", () => ({
  resolveDeviceName: (d: string) => {
    if (!["lab", "other"].includes(d)) throw new Error("Unknown router");
    return d;
  },
  getConfig: () => ({
    devices: { lab: {} },
    serviceProbes: {
      targets: {
        example: {
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
vi.mock("../../src/core/scoped-access", () => ({
  assertDeviceAccess: (_d: string[], _t: string, risk: string) => {
    if (mock.readOnly && risk !== "READ") throw new Error("read-only");
  },
}));
vi.mock("../../src/operations/store", () => ({
  operationsStore: async () => ({
    get: (_k: string, id: string, device: string) => {
      const p = mock.records.get(id) as RoutingPolicy;
      return p?.device === device ? structuredClone(p) : undefined;
    },
    put: (_k: string, p: RoutingPolicy) => mock.records.set(p.id, structuredClone(p)),
    list: (_k: string, device: string) =>
      [...mock.records.values()]
        .filter((p) => (p as RoutingPolicy).device === device)
        .map((p) => structuredClone(p)),
    lock: (d: string) => {
      if (mock.locks.has(d)) throw new Error("locked");
      mock.locks.add(d);
    },
    unlock: (d: string) => mock.locks.delete(d),
  }),
}));
vi.mock("../../src/home/read", () => ({
  rows: async (path: string) => {
    if (path === "/routing table")
      return [
        { name: "main", fib: "yes" },
        { name: "warp", fib: "yes" },
      ];
    if (path === "/ip route")
      return ["main", "warp"].map((t) => ({
        "routing-table": t,
        "dst-address": "0.0.0.0/0",
        active: "yes",
      }));
    if (path.endsWith("mangle")) return structuredClone(mock.rules);
    if (path.endsWith("address-list")) return structuredClone(mock.addresses);
    if (path === "/ip vrf") return [{ name: "main" }];
    return [];
  },
  checkedRead: async (command: string) => {
    mock.commands.push(command);
    if (command.includes("count-only")) return "0";
    if (command.includes(" add")) {
      if (mock.fail) throw new Error("Lost SSH response");
      if (command.includes("mangle")) mock.rules.push(parseRecords(`0 ${command}`).rows[0]);
      if (command.includes("address-list"))
        mock.addresses.push(parseRecords(`0 ${command}`).rows[0]);
    }
    return "";
  },
}));
vi.mock("../../src/snapshots/capture", () => ({ captureSnapshot: async () => "backup-before" }));
vi.mock("../../src/ssh/safe-mode", () => ({
  getSafeModeManager: () => ({
    isActive: false,
    enable: mock.enable,
    commit: mock.commit,
    rollback: mock.rollback,
  }),
}));
vi.mock("../../src/service-contracts/probe", () => ({
  nativeProbeIO: { resolve: async () => ["203.0.113.5"] },
}));
vi.mock("../../src/core/connector", () => ({
  executeMikrotikCommand: async () => '{"status":"finished","code":200}',
}));
const ctx = { device: "lab", info: () => {}, error: () => {} };
const input = {
  name: "Example",
  target: "example",
  family: "ipv4",
  sources: ["10.1.0.0/24"],
  tables: ["main", "warp"],
  primary: "main",
};
beforeEach(() => {
  mock.records.clear();
  mock.locks.clear();
  mock.rules = [];
  mock.addresses = [];
  mock.commands = [];
  mock.readOnly = false;
  mock.fail = false;
  vi.clearAllMocks();
  mock.commit.mockResolvedValue({ ok: true });
});
describe("service routing lifecycle", () => {
  it("creates only local drafts and keeps ownership isolated", async () => {
    const p = await createRouting(input, ctx);
    expect(mock.commands).toHaveLength(0);
    expect(p.state).toBe("draft");
    expect((await listRouting({ ...ctx, device: "other" })).policies).toHaveLength(0);
    await expect(previewRouting(p.id, "main", false, { ...ctx, device: "other" })).rejects.toThrow(
      /not found/,
    );
  });
  it("requires confirmation and exact unexpired preview, then verifies with Safe Mode", async () => {
    const p = await createRouting(input, ctx);
    const preview = await previewRouting(p.id, "main", false, ctx);
    await expect(applyRouting(p.id, preview.plan!.id, false, ctx)).rejects.toThrow(/confirmation/);
    await expect(applyRouting(p.id, "other", true, ctx)).rejects.toThrow(/Preview/);
    const applied = await applyRouting(p.id, preview.plan!.id, true, ctx);
    expect(applied.state).toBe("active");
    expect(applied.snapshot).toBe("backup-before");
    expect(mock.commit).toHaveBeenCalledOnce();
    expect(applied.plan).toBeUndefined();
  });
  it("binds preview to state and does not silently bypass foreign marks", async () => {
    const p = await createRouting(input, ctx);
    const preview = await previewRouting(p.id, "main", false, ctx);
    mock.rules.push({ action: "mark-routing", comment: "not-owned" });
    await expect(applyRouting(p.id, preview.plan!.id, true, ctx)).rejects.toThrow(/changed/);
    expect(mock.enable).not.toHaveBeenCalled();
  });
  it("records uncertainty on interrupted writes without replay", async () => {
    const p = await createRouting(input, ctx);
    const preview = await previewRouting(p.id, "main", false, ctx);
    mock.fail = true;
    await expect(applyRouting(p.id, preview.plan!.id, true, ctx)).rejects.toThrow(/Lost/);
    expect(mock.rollback).toHaveBeenCalledOnce();
    expect((await listRouting(ctx)).policies[0].state).toBe("uncertain");
    await expect(previewRouting(p.id, "main", false, ctx)).rejects.toThrow(/Reconcile/);
  });
  it("does not issue rollback after an ambiguous commit", async () => {
    const p = await createRouting(input, ctx);
    const preview = await previewRouting(p.id, "main", false, ctx);
    mock.commit.mockResolvedValue({ ok: false });
    await expect(applyRouting(p.id, preview.plan!.id, true, ctx)).rejects.toThrow(/uncertain/);
    expect(mock.rollback).not.toHaveBeenCalled();
  });
  it("keeps non-VRF exits unknown and rejects unproven automation", async () => {
    const p = await createRouting(input, ctx);
    const probed = await probeRouting(p.id, ctx);
    expect(probed.samples.map((s) => s.state)).toEqual(["pass", "unknown"]);
    mock.records.set(p.id, { ...probed, state: "active", activeTable: "main" });
    await expect(armRouting(p.id, 30, true, ctx)).rejects.toThrow(/fresh passing/);
  });
  it("denies writes in read-only mode and unapproved targets", async () => {
    await expect(createRouting({ ...input, target: "unknown" }, ctx)).rejects.toThrow(/approved/);
    mock.readOnly = true;
    await expect(createRouting(input, ctx)).rejects.toThrow(/read-only/);
  });
  it("blocks a forged browser origin and requires an explicit router", async () => {
    const url = new URL("http://localhost/api/service-routing?device=lab");
    const response = await operationsRoutes(
      new Request(url, {
        method: "POST",
        headers: { origin: "https://attacker.invalid" },
        body: JSON.stringify(input),
      }),
      url,
    );
    expect(response?.status).toBe(403);
    expect(mock.records.size).toBe(0);
    const missing = new URL("http://localhost/api/service-routing");
    expect((await operationsRoutes(new Request(missing), missing))?.status).toBe(400);
  });
  it("rejects tampered scope before switching an existing route", async () => {
    const p = await createRouting(input, ctx);
    const preview = await previewRouting(p.id, "main", false, ctx);
    await applyRouting(p.id, preview.plan!.id, true, ctx);
    mock.rules.find((r) => r.comment === ownerTag(p.id) && r.action === "jump")![
      "src-address-list"
    ] = "all";
    await expect(previewRouting(p.id, "warp", false, ctx)).rejects.toThrow(/scope/);
  });
});
