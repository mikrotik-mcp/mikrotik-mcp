import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import type { ToolContext } from "../src/core/context";
import { getConfig, setConfig } from "../src/core/runtime";
import { capsmanTools } from "../src/tools/capsman";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  snapshot: vi.fn(),
  apply: vi.fn(),
  audit: vi.fn(),
  render: vi.fn(),
  propose: vi.fn(),
  weak: vi.fn(),
  steerPresent: vi.fn(),
  steer: vi.fn(),
  balance: vi.fn(),
  balanceCommands: vi.fn(),
  channel: vi.fn(),
  ft: vi.fn(),
  domain: vi.fn(),
  ha: vi.fn(),
  guidance: vi.fn(),
  fixes: vi.fn(),
}));
vi.mock("../src/utils/wifi-query", () => ({ fetchCapsmanState: mocks.fetch }));
vi.mock("../src/snapshots/capture", () => ({ captureSnapshot: mocks.snapshot }));
vi.mock("../src/utils/safe-mode-apply", () => ({ applyWritesSafely: mocks.apply }));
vi.mock("../src/core/capsman", () => ({
  DEFAULT_WEAK_DBM: -70,
  runCapsmanAudit: mocks.audit,
  renderCapsmanReport: mocks.render,
  proposeChannelPlan: mocks.propose,
  reportWeakClients: mocks.weak,
  steerAlreadyPresent: mocks.steerPresent,
  buildSteerCommands: mocks.steer,
  loadBalancePlan: mocks.balance,
  buildLoadBalanceCommands: mocks.balanceCommands,
  buildChannelPlanCommands: mocks.channel,
  buildFtCommands: mocks.ft,
  resolveMobilityDomain: mocks.domain,
  buildHaCommands: mocks.ha,
  haGuidance: mocks.guidance,
  buildFixPlan: mocks.fixes,
}));

const state = {
  path: "/interface wifi",
  managerEnabled: true,
  radios: [{ radioId: "radio-1", cap: "floor-1", band: "5ghz" }],
  clients: [{ mac: "AA:BB:CC:DD:EE:FF", radioId: "radio-1", signal: -80 }],
  securityConfigs: [{ name: "main" }],
};
const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
const initial = getConfig();

function call(name: string, args: Record<string, unknown> = {}) {
  const tool = capsmanTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Unknown CAPsMAN tool ${name}`);
  return tool.handler(args as never, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { fixture: { host: "192.0.2.1", port: 22 } },
      defaultDevice: "fixture",
    }),
  );
  mocks.fetch.mockResolvedValue(state);
  mocks.snapshot.mockResolvedValue("snapshot-1");
  mocks.apply.mockResolvedValue({ safeMode: true, applied: 1, total: 1 });
  mocks.audit.mockReturnValue({ findings: [] });
  mocks.render.mockReturnValue("CAPsMAN audit report");
  mocks.propose.mockReturnValue(new Map([["radio-1", 5180]]));
  mocks.weak.mockReturnValue([]);
  mocks.steerPresent.mockReturnValue(false);
  mocks.steer.mockReturnValue(["/interface wifi access-list add signal-range=-120..-70"]);
  mocks.balance.mockReturnValue([]);
  mocks.balanceCommands.mockReturnValue(["/interface wifi access-list add comment=balance"]);
  mocks.channel.mockReturnValue(["/interface wifi set radio-1 frequency=5180"]);
  mocks.ft.mockReturnValue(["/interface wifi security set main ft=yes"]);
  mocks.domain.mockReturnValue("0001");
  mocks.ha.mockReturnValue(["/interface wifi capsman set require-peer-certificate=yes"]);
  mocks.guidance.mockReturnValue(["Configure backup manager"]);
  mocks.fixes.mockReturnValue(["/interface wifi set radio-1 frequency=5180"]);
});
afterEach(() => setConfig(initial));

test("read-only audit tools scope categories and explain proposed channels", async () => {
  expect(await call("run_capsman_audit", { categories: ["ft"], weak_dbm: -75 })).toContain(
    "CAPsMAN audit report",
  );
  expect(mocks.audit).toHaveBeenCalledWith(state, { categories: ["ft"], weakDbm: -75 });
  expect(await call("audit_capsman_coverage")).toContain("floor-1/radio-1");
  for (const [name, category] of [
    ["audit_capsman_load", "load"],
    ["audit_capsman_ft", "ft"],
    ["audit_capsman_ha", "ha"],
  ]) {
    expect(await call(name)).toContain("CAPsMAN audit report");
    expect(mocks.audit).toHaveBeenLastCalledWith(state, {
      categories: [category],
      weakDbm: undefined,
    });
  }
  expect(mocks.snapshot).not.toHaveBeenCalled();
});

test("weak client report distinguishes no problem, coverage gap and better neighbor", async () => {
  expect(await call("report_weak_signal_clients", { weak_dbm: -75 })).toContain("None below -75");
  mocks.weak.mockReturnValueOnce([
    {
      mac: "AA:BB:CC:DD:EE:FF",
      signal: -80,
      band: "5ghz",
      currentCap: "floor-1",
      recommendCap: "floor-2",
      gainDb: 15,
    },
    { mac: "11:22:33:44:55:66", signal: -85, band: "2ghz", currentCap: "floor-1" },
  ]);
  const report = await call("report_weak_signal_clients");
  expect(report).toContain("steer to floor-2 (+15 dB)");
  expect(report).toContain("coverage gap");
});

test("steering refuses unknown clients and existing rules, and soft mode never writes", async () => {
  expect(
    await call("steer_client", { mac: "00:00:00:00:00:00", mode: "hard", confirm: true }),
  ).toContain("not currently associated");
  mocks.steerPresent.mockReturnValueOnce(true);
  expect(
    await call("steer_client", { mac: state.clients[0].mac, mode: "hard", confirm: true }),
  ).toContain("already exists");
  expect(
    await call("steer_client", { mac: state.clients[0].mac, mode: "soft", confirm: true }),
  ).toContain("advisory-only");
  expect(mocks.snapshot).not.toHaveBeenCalled();
  expect(mocks.apply).not.toHaveBeenCalled();
});

test("hard steering previews commands and confirmed apply snapshots before Safe Mode", async () => {
  const args = { mac: state.clients[0].mac, mode: "hard" };
  expect(await call("steer_client", args)).toContain("DRY RUN");
  expect(mocks.snapshot).not.toHaveBeenCalled();
  const result = await call("steer_client", { ...args, confirm: true });
  expect(result).toContain("snapshot=snapshot-1");
  expect(mocks.snapshot).toHaveBeenCalledOnce();
  expect(mocks.apply).toHaveBeenCalledWith(ctx, "fixture", expect.any(Array), {
    allowDirectFallback: false,
  });
  expect(mocks.snapshot.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.apply.mock.invocationCallOrder[0],
  );
});

test("load balancing ignores absent/duplicate changes and previews available plan", async () => {
  expect(await call("apply_capsman_load_balance", { confirm: true })).toContain(
    "No rebalance needed",
  );
  mocks.balance.mockReturnValue([
    { cap: "floor-1", radioId: "radio-1", targetCap: "floor-2", targetRadioId: "radio-2" },
  ]);
  mocks.balanceCommands.mockReturnValueOnce([]);
  expect(await call("apply_capsman_load_balance", { confirm: true })).toContain("already present");
  expect(await call("apply_capsman_load_balance")).toContain("offload toward floor-2/radio-2");
  expect(await call("apply_capsman_load_balance", { confirm: true })).toContain(
    "snapshot=snapshot-1",
  );
});

test("channel changes reject legacy CAPsMAN and skip already converged radios", async () => {
  mocks.fetch.mockResolvedValueOnce({ ...state, path: "/caps-man" });
  expect(await call("apply_capsman_channel_plan", { confirm: true })).toContain("legacy /caps-man");
  mocks.channel.mockReturnValueOnce([]);
  expect(await call("apply_capsman_channel_plan", { confirm: true })).toContain(
    "No channel changes needed",
  );
  expect(await call("apply_capsman_channel_plan", { radio_ids: ["radio-1"] })).toContain("DRY RUN");
  expect(mocks.channel).toHaveBeenLastCalledWith(state, new Set(["radio-1"]));
  expect(await call("apply_capsman_channel_plan", { confirm: true })).toContain(
    "snapshot=snapshot-1",
  );
});

test("FT enablement requires a security config and preserves an existing domain", async () => {
  mocks.fetch.mockResolvedValueOnce({ ...state, securityConfigs: [] });
  expect(await call("enable_capsman_ft", { confirm: true })).toContain(
    "No CAPsMAN security configs",
  );
  mocks.ft.mockReturnValueOnce([]);
  expect(await call("enable_capsman_ft", { confirm: true })).toContain("mobility-domain=0001");
  expect(await call("enable_capsman_ft", { mobility_domain: "1234" })).toContain("DRY RUN");
  expect(mocks.ft).toHaveBeenLastCalledWith(state, {
    configNames: undefined,
    mobilityDomain: "1234",
  });
  expect(await call("enable_capsman_ft", { confirm: true })).toContain("snapshot=snapshot-1");
});

test("HA setup never assumes a manager and always states remaining manual work", async () => {
  mocks.fetch.mockResolvedValueOnce({ ...state, managerEnabled: false });
  expect(await call("setup_capsman_ha", { confirm: true })).toContain("not a CAPsMAN manager");
  mocks.ha.mockReturnValueOnce([]);
  expect(await call("setup_capsman_ha", { confirm: true })).toContain("MANUAL STEPS");
  expect(await call("setup_capsman_ha", { backup_manager_address: "192.0.2.2" })).toContain(
    "DRY RUN",
  );
  expect(await call("setup_capsman_ha", { confirm: true })).toContain("snapshot=snapshot-1");
});

test("selected finding fixes are idempotent and fail closed in Safe Mode", async () => {
  mocks.fixes.mockReturnValueOnce([]);
  expect(
    await call("apply_capsman_fixes", { finding_ids: ["finding-1"], confirm: true }),
  ).toContain("No applicable automated fix");
  expect(await call("apply_capsman_fixes", { finding_ids: ["finding-1"] })).toContain("DRY RUN");
  mocks.apply.mockResolvedValueOnce({
    safeMode: true,
    applied: 0,
    total: 1,
    error: "connection lost",
  });
  const failed = await call("apply_capsman_fixes", { finding_ids: ["finding-1"], confirm: true });
  expect(failed).toContain("FAILED: connection lost");
  expect(failed).toContain("snapshot=snapshot-1");
});
