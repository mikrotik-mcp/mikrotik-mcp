import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import { attackTools } from "../src/tools/attack";

const mocks = vi.hoisted(() => ({
  sweep: vi.fn(),
  attackStore: vi.fn(),
  decide: vi.fn(),
  executePlan: vi.fn(),
  revokeBlock: vi.fn(),
  buildGuards: vi.fn(() => ({})),
  policyFromConfig: vi.fn(() => ({})),
  neverBlockSet: vi.fn(() => new Set(["192.0.2.1"])),
  isNeverBlock: vi.fn((address: string) => address === "192.0.2.1"),
}));

vi.mock("../src/attack/session", () => ({
  sweep: mocks.sweep,
  buildGuards: mocks.buildGuards,
  policyFromConfig: mocks.policyFromConfig,
}));
vi.mock("../src/attack/store", () => ({ attackStore: mocks.attackStore }));
vi.mock("../src/attack/respond", () => ({
  decide: mocks.decide,
  isPlan: (value: { action?: string }) => Boolean(value.action),
  neverBlockSet: mocks.neverBlockSet,
  isNeverBlock: mocks.isNeverBlock,
}));
vi.mock("../src/attack/execute", () => ({
  executePlan: mocks.executePlan,
  revokeBlock: mocks.revokeBlock,
}));

const incident = {
  id: "atk-test",
  source: "198.51.100.10",
  devices: ["router-a"],
  stage: "attempt",
  confidence: "high",
  severity: "high",
  firstTs: Date.UTC(2026, 9, 24, 1),
  lastTs: Date.UTC(2026, 9, 24, 2),
  detectors: ["brute_force"],
  narrative: "Repeated failed logins",
  recommendations: ["Inspect account logins"],
  evidence: [{ ts: Date.UTC(2026, 9, 24, 1), device: "router-a", message: "login failure" }],
  spoofableOnly: false,
  signalCount: 2,
};

const store = {
  listIncidents: vi.fn(),
  getIncident: vi.fn(),
  countRecentBlocks: vi.fn(),
  recordResponse: vi.fn(),
  responseFor: vi.fn(),
  revokeResponse: vi.fn(),
  listResponses: vi.fn(),
};

const ctx: ToolContext = { device: "router-a", info: vi.fn(), error: vi.fn() };

function handler(name: string, args: Record<string, unknown> = {}) {
  const tool = attackTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing attack tool ${name}`);
  return tool.handler(args as never, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.attackStore.mockResolvedValue(store);
  store.listIncidents.mockReturnValue([incident]);
  store.getIncident.mockReturnValue(incident);
  store.countRecentBlocks.mockReturnValue(0);
  store.listResponses.mockReturnValue([]);
  store.responseFor.mockReturnValue(null);
  mocks.sweep.mockResolvedValue({
    devices: [{ device: "router-a", ok: true, events: 2 }],
    skipped: [],
    incidents: [incident],
    unavailable: [],
  });
  mocks.decide.mockReturnValue({
    action: "block",
    source: incident.source,
    devices: incident.devices,
    list: "mcp-attack-block",
    timeout: "1h",
    reason: "Repeated failures",
  });
  mocks.executePlan.mockResolvedValue([{ ok: true, device: "router-a", detail: "added" }]);
  mocks.revokeBlock.mockResolvedValue([{ ok: true, device: "router-a", detail: "removed" }]);
});

test("scan names failed and skipped devices and explains unavailable detectors", async () => {
  mocks.sweep.mockResolvedValueOnce({
    devices: [{ device: "router-a", ok: false, events: 0, error: "timeout" }],
    skipped: ["router-b"],
    incidents: [],
    unavailable: [{ detector: "login", reason: "logs disabled", fix: "enable logging" }],
  });
  const report = await handler("scan_for_attacks", { online_only: true });
  expect(mocks.sweep).toHaveBeenCalledWith(
    expect.objectContaining({ onlineOnly: true, respond: false }),
  );
  expect(report).toContain("router-a: timeout");
  expect(report).toContain("router-b");
  expect(report).toContain("No attack incidents");
  expect(report).toContain("enable logging");
  expect(mocks.executePlan).not.toHaveBeenCalled();
});

test("scan presents correlated incident evidence rather than claiming quiet network", async () => {
  const report = await handler("scan_for_attacks", { window_minutes: 15 });
  expect(report).toContain("Repeated failed logins");
  expect(report).toContain("Inspect account logins");
  expect(report).toContain("router-a");
});

test("incident list filters confidence and reports empty history", async () => {
  expect(
    await handler("list_attack_incidents", { hours: 24, limit: 10, min_confidence: "high" }),
  ).toContain("atk-test");
  expect(store.listIncidents).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }));
  expect(
    await handler("list_attack_incidents", { hours: 24, limit: 10, min_confidence: "confirmed" }),
  ).toContain("No attack incidents");
});

test("incident detail includes evidence and spoofability warning", async () => {
  expect(await handler("get_attack_incident", { id: incident.id })).toContain("login failure");
  store.getIncident.mockReturnValueOnce({ ...incident, spoofableOnly: true });
  expect(await handler("get_attack_incident", { id: incident.id })).toContain("can be forged");
  store.getIncident.mockReturnValueOnce(null);
  expect(await handler("get_attack_incident", { id: "missing" })).toContain("No incident");
});

test("block refuses unknown incidents and protected decisions", async () => {
  store.getIncident.mockReturnValueOnce(null);
  expect(await handler("block_attacker", { incident_id: "missing", confirm: true })).toContain(
    "No incident",
  );
  mocks.decide.mockReturnValueOnce({ guard: true, reason: "management address" });
  expect(await handler("block_attacker", { incident_id: incident.id, confirm: true })).toContain(
    "REFUSED: management address",
  );
  expect(mocks.executePlan).not.toHaveBeenCalled();
});

test("block dry run never executes a plan and confirmed breach escalates", async () => {
  const dryRun = await handler("block_attacker", { incident_id: incident.id, confirm: false });
  expect(dryRun).toContain("DRY RUN");
  expect(dryRun).toContain("router-a");
  mocks.decide.mockReturnValueOnce({ action: "escalate", reason: "breach" });
  expect(await handler("block_attacker", { incident_id: incident.id, confirm: true })).toContain(
    "Escalated, not blocked",
  );
  expect(mocks.executePlan).not.toHaveBeenCalled();
});

test("confirmed block records success and complete failure separately", async () => {
  expect(await handler("block_attacker", { incident_id: incident.id, confirm: true })).toContain(
    "Blocked",
  );
  expect(store.recordResponse).toHaveBeenCalledWith(
    expect.objectContaining({ ok: true, incidentId: incident.id }),
  );
  mocks.executePlan.mockResolvedValueOnce([
    { ok: false, device: "router-a", detail: "connection failed" },
  ]);
  expect(await handler("block_attacker", { incident_id: incident.id, confirm: true })).toContain(
    "FAILED to block",
  );
  expect(store.recordResponse).toHaveBeenLastCalledWith(
    expect.objectContaining({ ok: false, error: "connection failed" }),
  );
});

test("unblock needs device scope and records a revocation only after execution", async () => {
  expect(await handler("unblock_attacker", { address: incident.source })).toContain(
    "Pass the devices explicitly",
  );
  expect(mocks.revokeBlock).not.toHaveBeenCalled();
  store.responseFor.mockReturnValueOnce({ devices: ["router-a"], list: "mcp-attack-block" });
  expect(await handler("unblock_attacker", { address: incident.source })).toContain("removed");
  expect(mocks.revokeBlock).toHaveBeenCalledWith(incident.source, ["router-a"], "mcp-attack-block");
  expect(store.revokeResponse).toHaveBeenCalledWith(incident.source, expect.any(Number));
});

test("response history explains active and revoked entries", async () => {
  expect(await handler("list_attack_responses", { active_only: true, limit: 50 })).toContain(
    "No blocks are currently",
  );
  expect(await handler("list_attack_responses", { active_only: false, limit: 50 })).toContain(
    "No blocks have been",
  );
  store.listResponses.mockReturnValueOnce([
    {
      incidentId: incident.id,
      source: incident.source,
      action: "block",
      devices: ["router-a"],
      ts: incident.lastTs,
      revokedAt: incident.lastTs + 1,
      timeout: "1h",
      reason: "test",
      ok: false,
      error: "connection failed",
    },
  ]);
  const report = await handler("list_attack_responses", { active_only: false, limit: 50 });
  expect(report).toContain("revoked");
  expect(report).toContain("connection failed");
});

test("policy distinguishes never-block addresses from eligible addresses", async () => {
  expect(await handler("configure_attack_response", { check_address: "192.0.2.1" })).toContain(
    "PROTECTED",
  );
  expect(await handler("configure_attack_response", { check_address: incident.source })).toContain(
    "not protected",
  );
  expect(await handler("configure_attack_response")).toContain("Never blocked");
});
