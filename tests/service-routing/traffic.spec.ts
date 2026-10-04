import { describe, it, expect, vi } from "vite-plus/test";
import { routingRate } from "../../src/service-routing/traffic-model";
import type { RoutingTraffic } from "../../src/service-routing/traffic-model";
import type { RoutingPolicy } from "../../src/service-routing/model";
import { ownerTag } from "../../src/service-routing/model";
import {
  trafficCommand,
  parsePolicyTraffic,
  readPolicyTraffic,
} from "../../src/service-routing/traffic";
import { executeMikrotikCommand } from "../../src/core/connector";
vi.mock("../../src/core/connector", () => ({ executeMikrotikCommand: vi.fn() }));
const policy = {
  id: "cdd5432f-72cb-44e4-b70e-0fc27505bf62",
  device: "lab",
  family: "ipv4",
  state: "active",
  activeTable: "warp",
} as RoutingPolicy;
const row = {
  ".id": "*A",
  comment: ownerTag(policy.id),
  action: "mark-routing",
  chain: `sr-${policy.id.slice(0, 12)}`,
  "new-routing-mark": "warp",
  bytes: "9007199254740993",
  packets: "42",
};
const sample: RoutingTraffic = {
  policyId: policy.id,
  device: "lab",
  state: "ready",
  ruleId: "*A",
  table: "warp",
  bytes: row.bytes,
  packets: "42",
  detail: "",
  at: 1000,
};
describe("service routing traffic", () => {
  it("keeps counters exact and selects only a policy's routing mark", () => {
    const cmd = trafficCommand(policy);
    expect(cmd).toContain(`comment=${ownerTag(policy.id)} action=mark-routing`);
    expect(cmd).toContain("options=json.no-string-conversion");
    expect(cmd).toContain(":tostr");
    expect(cmd).not.toContain("reset-counters");
    expect(parsePolicyTraffic(policy, JSON.stringify([row]), 1000)).toMatchObject({
      state: "ready",
      bytes: "9007199254740993",
      packets: "42",
    });
  });
  it("does not fabricate zero for missing, ambiguous, tampered or lossy counters", () => {
    for (const rows of [
      [],
      [row, row],
      [{ ...row, bytes: Number(row.bytes) }],
      [{ ...row, disabled: true }],
      [{ ...row, comment: "foreign" }],
      [{ ...row, "new-routing-mark": "main" }],
      [{ ...row, packets: "bad" }],
    ]) {
      const value = parsePolicyTraffic(policy, JSON.stringify(rows), 1000);
      expect(value.state).toBe("unavailable");
      expect(value.bytes).toBeUndefined();
    }
    expect(() => parsePolicyTraffic(policy, "failure: disconnected", 1000)).toThrow();
  });
  it("computes rate with BigInt subtraction before conversion", () => {
    expect(routingRate(sample, { ...sample, at: 6000, bytes: "9007199254745993" })).toMatchObject({
      bps: 8000,
      reset: false,
    });
    expect(routingRate(sample, { ...sample, at: 6000 })).toMatchObject({ bps: 0 });
  });
  it("breaks the chart for reset, gaps, changed devices, tables and missing readings", () => {
    for (const overrides of [
      { at: 1000 },
      { at: 100_000 },
      { state: "unavailable" as const },
      { ruleId: "*B" },
      { table: "main" },
      { device: "other" },
    ])
      expect(routingRate(sample, { ...sample, at: 6000, ...overrides }).bps).toBeNull();
    expect(routingRate(sample, { ...sample, at: 6000, bytes: "0" })).toMatchObject({
      bps: null,
      reset: true,
    });
    expect(routingRate(sample, { ...sample, at: 6000, packets: "1" }).reset).toBe(true);
  });
  it("does not read drafts; coalesces active reads and isolates router caches", async () => {
    const ctx = { device: "lab", info: () => {}, error: () => {} };
    vi.mocked(executeMikrotikCommand).mockResolvedValue(JSON.stringify([row]));
    expect((await readPolicyTraffic({ ...policy, state: "draft" }, ctx)).state).toBe("inactive");
    expect(executeMikrotikCommand).not.toHaveBeenCalled();
    await Promise.all([readPolicyTraffic(policy, ctx), readPolicyTraffic(policy, ctx)]);
    expect(executeMikrotikCommand).toHaveBeenCalledTimes(1);
    await readPolicyTraffic({ ...policy, device: "other" }, { ...ctx, device: "other" });
    expect(executeMikrotikCommand).toHaveBeenCalledTimes(2);
  });
});
