import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../../src/config";
import { getConfig, setConfig } from "../../src/core/runtime";
import { installAccessPolicy } from "../../src/core/access";
import { diagnoseInternet, comparePaths } from "../../src/home/read";
import { homeRoutes } from "../../src/observability/home-routes";
import type { PolicyPlan, HomeClient } from "../../src/home/model";
import { previewPolicy, applyPolicy, undoPolicy } from "../../src/home/policies";

const state = vi.hoisted(() => ({
  plans: new Map<string, PolicyPlan>(),
  clients: new Map<string, HomeClient[]>(),
  read: vi.fn(),
  snapshot: vi.fn(),
  enable: vi.fn(),
  commit: vi.fn(),
  rollback: vi.fn(),
  active: false,
}));
vi.mock("../../src/core/connector", () => ({
  executeMikrotikCommand: (...args: unknown[]) => state.read(...args),
}));
vi.mock("../../src/snapshots/capture", () => ({
  captureSnapshot: (...args: unknown[]) => state.snapshot(...args),
}));
vi.mock("../../src/ssh/safe-mode", () => ({
  getSafeModeManager: () => ({
    get isActive() {
      return state.active;
    },
    enable: state.enable,
    commit: state.commit,
    rollback: state.rollback,
  }),
}));
vi.mock("../../src/home/store", () => ({
  homeStore: async () => ({
    savePlan: (p: PolicyPlan) => state.plans.set(p.id, structuredClone(p)),
    claim: (p: PolicyPlan) => state.plans.set(p.id, structuredClone(p)),
    unresolved: (device: string) =>
      [...state.plans.values()].filter(
        (p) =>
          p.device === device &&
          ["applying", "scheduled", "active", "uncertain"].includes(p.status),
      ),
    plan: (id: string, device: string) => {
      const p = state.plans.get(id);
      return p?.device === device ? structuredClone(p) : undefined;
    },
    plans: (device: string) => [...state.plans.values()].filter((p) => p.device === device),
    clients: (device: string) => state.clients.get(device) ?? [],
    saveClient: (device: string, c: HomeClient) =>
      state.clients.set(device, [
        ...(state.clients.get(device) ?? []).filter((r) => r.mac !== c.mac),
        c,
      ]),
  }),
}));
const original = getConfig(),
  ctx = { device: "home", info() {}, error() {} };
const input = { mac: "AA:BB:CC:DD:EE:FF", action: "pause" };
function fixture(command: string): string {
  if (command.includes("/system device-mode")) return "scheduler: yes";
  if (command.startsWith(":put [:typeof")) return "code";
  const applying = [...state.plans.values()].find((p) => p.status === "applying");
  if (
    command.includes("/ip firewall filter print detail") &&
    applying &&
    state.read.mock.calls.some(([c]) => c.startsWith("/ip firewall filter add"))
  )
    return `0 chain=forward action=drop comment=mcp-home-${applying.id} src-address-list=mcp-home-${applying.id}-end\n1 chain=forward action=drop comment=mcp-home-${applying.id} dst-address-list=mcp-home-${applying.id}-end`;
  if (command.includes("/ip firewall address-list print count-only")) return applying ? "1" : "0";
  if (command.includes("print count-only where comment=mcp-home-") && !applying) return "0";
  if (command.includes("/ip firewall connection")) return "0";
  if (command.includes("/ip dhcp-server lease"))
    return "0 address=192.168.88.10 mac-address=AA:BB:CC:DD:EE:FF status=bound dynamic=no host-name=laptop";
  if (command.includes("/routing table")) return "0 name=main fib=yes\n1 name=fiber fib=yes";
  if (command.includes("/ip route print"))
    return "0 dst-address=0.0.0.0/0 routing-table=fiber active=yes";
  if (command.includes("/ip address print")) return "0 address=192.168.88.1/24 interface=bridge";
  if (command.includes("/ipv6 settings")) return "disable-ipv6: yes";
  if (command.includes("/system resource"))
    return "cpu-load: 93\nfree-memory: 50MiB\ntotal-memory: 100MiB";
  if (command.startsWith(":put [:resolve")) return "93.184.215.14";
  if (command.startsWith("/ping"))
    return "sent=5 received=5 min-rtt=10ms avg-rtt=12ms max-rtt=15ms";
  if (command.includes("/system scheduler print count-only")) return "2";
  return "";
}
beforeEach(() => {
  state.plans.clear();
  state.clients.clear();
  state.active = false;
  vi.clearAllMocks();
  state.read.mockImplementation(async (cmd: string) => fixture(cmd));
  state.snapshot.mockResolvedValue("snapshot-before");
  state.enable.mockResolvedValue("Safe mode ENABLED.");
  state.commit.mockResolvedValue({ ok: true });
  state.rollback.mockResolvedValue("rolled back");
  setConfig(
    MikrotikConfigSchema.parse({
      defaultDevice: "home",
      devices: { home: { host: "192.0.2.1" }, other: { host: "192.0.2.2" } },
    }),
  );
  installAccessPolicy({ enabled: false, scope: {} });
});
afterEach(() => {
  setConfig(original);
  installAccessPolicy({ enabled: false, scope: {} });
});
async function request(path: string, body?: unknown, origin?: string) {
  const req = new Request(
    `http://localhost/api/home-internet${path}`,
    body === undefined
      ? {}
      : {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
        },
  );
  return (await homeRoutes(req, new URL(req.url)))!;
}
describe("home service and HTTP safety", () => {
  test("diagnosis has evidence/unknowns, bounded reads and no hidden writes", async () => {
    const result = await diagnoseInternet({ client: "192.168.88.10" }, ctx);
    expect(result.findings.find((f) => f.area === "Router")?.state).toBe("suspected");
    expect(result.findings.find((f) => f.area === "Wi-Fi")?.state).toBe("unknown");
    expect(result.applicationHealth).toBe("unverified");
    expect(
      state.read.mock.calls.every(
        ([command, , opts]) =>
          !/\b(add|set|remove|enable|disable)\b/.test(command) && opts.maxMs === 8000,
      ),
    ).toBe(true);
  });
  test("unsupported probes are unknown, not healthy and not switched", async () => {
    state.read.mockImplementation(async (cmd: string) =>
      cmd.startsWith("/ping") ? "bad command name ping" : fixture(cmd),
    );
    const report = await comparePaths({ target: "1.1.1.1", tables: ["fiber"] }, ctx);
    expect(report.paths[0].state).toBe("unknown");
    expect(report.recommended).toBeNull();
    await expect(comparePaths({ target: "1.1.1.1", tables: ["missing"] }, ctx)).rejects.toThrow(
      /existing/,
    );
  });
  test("preview does not mutate a router; apply requires consent and cannot replay", async () => {
    const p = await previewPolicy(input, ctx);
    expect(state.enable).not.toHaveBeenCalled();
    expect(state.snapshot).not.toHaveBeenCalled();
    await expect(applyPolicy(p.id, false, ctx)).rejects.toThrow(/confirm/);
    await expect(applyPolicy(p.id, true, { ...ctx, device: "other" })).rejects.toThrow(
      /another router/,
    );
    const applied = await applyPolicy(p.id, true, ctx);
    expect(applied.status).toBe("active");
    expect(applied.snapshot).toBe("snapshot-before");
    expect(state.commit).toHaveBeenCalledOnce();
    await expect(applyPolicy(p.id, true, ctx)).rejects.toThrow(/already used/);
  });
  test("rejects stale preview before any configuration writes", async () => {
    const p = await previewPolicy(input, ctx);
    state.plans.get(p.id)!.previewExpiresAt = 1;
    await expect(applyPolicy(p.id, true, ctx)).rejects.toThrow(/expired/);
    expect(state.enable).not.toHaveBeenCalled();
  });
  test("changed state invalidates consent and existing Safe Mode is never committed", async () => {
    const p = await previewPolicy(input, ctx);
    state.read.mockImplementation(async (cmd: string) =>
      fixture(cmd).replace("192.168.88.10", "192.168.88.11"),
    );
    await expect(applyPolicy(p.id, true, ctx)).rejects.toThrow(/state changed/);
    state.read.mockImplementation(async (cmd: string) => fixture(cmd));
    state.active = true;
    await expect(applyPolicy(p.id, true, ctx)).rejects.toThrow(/existing Safe Mode/);
    expect(state.commit).not.toHaveBeenCalled();
    expect(state.enable).not.toHaveBeenCalled();
  });
  test("failed write rolls back and remains uncertain instead of reporting success", async () => {
    const p = await previewPolicy(input, ctx);
    state.read.mockImplementation(async (cmd: string) =>
      cmd.startsWith("/system scheduler add") ? "failure: not enough permissions" : fixture(cmd),
    );
    await expect(applyPolicy(p.id, true, ctx)).rejects.toThrow(/not confirmed/);
    expect(state.rollback).toHaveBeenCalledOnce();
    expect(state.commit).not.toHaveBeenCalled();
    expect(state.plans.get(p.id)?.status).toBe("uncertain");
    await expect(applyPolicy(p.id, true, ctx)).rejects.toThrow(/already used/);
  });
  test("failed pre-change export stops before acquiring Safe Mode", async () => {
    const p = await previewPolicy(input, ctx);
    state.snapshot.mockRejectedValue(new Error("export incomplete"));
    await expect(applyPolicy(p.id, true, ctx)).rejects.toThrow(/export/);
    expect(state.enable).not.toHaveBeenCalled();
    expect(state.plans.get(p.id)?.status).toBe("preview");
  });
  test("uncompilable expiry script never commits", async () => {
    const p = await previewPolicy(input, ctx);
    state.read.mockImplementation(async (cmd: string) =>
      cmd.startsWith(":put [:typeof") ? "str" : fixture(cmd),
    );
    await expect(applyPolicy(p.id, true, ctx)).rejects.toThrow(/compile/);
    expect(state.commit).not.toHaveBeenCalled();
    expect(state.rollback).toHaveBeenCalledOnce();
  });
  test("priority undo verifies restoration and refuses external queue changes", async () => {
    const p = await previewPolicy(input, ctx);
    p.status = "active";
    p.input.action = "priority";
    p.queueBefore = {
      name: "laptop",
      target: "192.168.88.10/32",
      parent: "house",
      priority: "8/8",
    };
    state.plans.set(p.id, p);
    state.read.mockImplementation(async (cmd: string) =>
      cmd.startsWith("/queue simple print")
        ? "0 name=laptop target=192.168.88.10/32 parent=house priority=2/2"
        : fixture(cmd),
    );
    await expect(undoPolicy(p.id, true, ctx)).rejects.toThrow(/restoration/);
    expect(state.commit).not.toHaveBeenCalled();
    expect(state.plans.get(p.id)?.status).toBe("active");
    state.read.mockImplementation(async (cmd: string) =>
      cmd.startsWith("/queue simple print")
        ? "0 name=laptop target=192.168.88.10/32 parent=house priority=8/8"
        : fixture(cmd),
    );
    expect((await undoPolicy(p.id, true, ctx)).status).toBe("undone");
  });
  test("undo uses stored device-owned commands after restart and requires consent", async () => {
    const p = await previewPolicy(input, ctx);
    await applyPolicy(p.id, true, ctx);
    await expect(undoPolicy(p.id, false, ctx)).rejects.toThrow(/confirmation/);
    state.read.mockClear();
    expect((await undoPolicy(p.id, true, ctx)).status).toBe("undone");
    expect(state.read.mock.calls.every(([cmd]) => cmd.includes(`mcp-home-${p.id}`))).toBe(true);
  });
  test("read-only, denied devices, unknown device and cross-origin calls fail closed", async () => {
    expect((await request("?device=missing")).status).toBe(400);
    expect((await request("/preview?device=home", input, "https://evil.example")).status).toBe(403);
    expect((await request("/preview", input)).status).toBe(400);
    setConfig(MikrotikConfigSchema.parse({ ...getConfig(), readOnly: true }));
    expect((await request("/preview?device=home", input)).status).toBe(400);
    expect(state.read).not.toHaveBeenCalled();
  });
  test("inventory names survive refresh and only new devices after baseline notify", async () => {
    let r = await (await request("/refresh?device=home", {})).json();
    expect(r.clients[0].acknowledged).toBe(true);
    await request("/name?device=home", { mac: input.mac, name: "My laptop", person: "Ali" });
    state.read.mockImplementation(async (cmd: string) =>
      fixture(cmd).replace("AA:BB:CC:DD:EE:FF", "11:22:33:44:55:66"),
    );
    r = await (await request("/refresh?device=home", {})).json();
    expect(r.clients.find((c: HomeClient) => c.mac === input.mac).name).toBe("My laptop");
    expect(r.clients.filter((c: HomeClient) => !c.acknowledged)).toHaveLength(1);
    expect((await (await request("?device=other")).json()).clients).toEqual([]);
  });
});
