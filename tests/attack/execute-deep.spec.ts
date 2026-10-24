/** Exercise the real executor through a scripted offline RouterOS command boundary. */
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { ResponsePlan } from "../../src/attack/respond";
import { executePlan, readScanList, revokeBlock } from "../../src/attack/execute";

const commands = vi.hoisted(() => ({
  run: vi.fn<(command: string, ctx: { device?: string }) => Promise<string>>(),
}));
vi.mock("../../src/core/connector", () => ({ executeMikrotikCommand: commands.run }));

const plan: ResponsePlan = {
  incidentId: "atk-1",
  action: "block",
  source: "203.0.113.7",
  devices: ["edge"],
  timeout: "1h",
  list: "mcp-attack-block",
  reason: "test",
};
afterEach(() => commands.run.mockReset());

describe("attack execution with local command responses", () => {
  test("creates one raw drop then a tagged, expiring address entry", async () => {
    commands.run
      .mockResolvedValueOnce("0")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("0")
      .mockResolvedValueOnce("");
    expect(await executePlan(plan)).toEqual([
      { device: "edge", ok: true, detail: "blocked for 1h" },
    ]);
    const sent = commands.run.mock.calls.map(([command]) => command);
    expect(sent).toHaveLength(4);
    expect(sent[1]).toContain("/ip firewall raw add");
    expect(sent[1]).toContain("src-address-list=mcp-attack-block");
    expect(sent[3]).toContain("/ip firewall address-list add");
    expect(sent[3]).toContain("timeout=1h");
    expect(sent[3]).toContain("mcp-attack-detection: atk-1");
    expect(commands.run.mock.calls.every(([, ctx]) => ctx.device === "edge")).toBe(true);
  });

  test("existing drop and address avoid both writes", async () => {
    commands.run.mockResolvedValueOnce("1").mockResolvedValueOnce("1");
    expect(await executePlan(plan)).toMatchObject([
      { ok: true, detail: "203.0.113.7 was already blocked" },
    ]);
    expect(commands.run).toHaveBeenCalledTimes(2);
  });

  test("a failed drop prevents address writes; later devices still run", async () => {
    commands.run
      .mockResolvedValueOnce("0")
      .mockResolvedValueOnce("failure: denied")
      .mockResolvedValueOnce("1")
      .mockResolvedValueOnce("1");
    const result = await executePlan({ ...plan, devices: ["bad", "good"] });
    expect(result).toMatchObject([
      { device: "bad", ok: false },
      { device: "good", ok: true },
    ]);
    expect(commands.run.mock.calls.filter(([, ctx]) => ctx.device === "bad")).toHaveLength(2);
  });

  test("address insertion error is surfaced, with no success claim", async () => {
    commands.run
      .mockResolvedValueOnce("1")
      .mockResolvedValueOnce("0")
      .mockResolvedValueOnce("failure: invalid address");
    expect(await executePlan(plan)).toMatchObject([
      { ok: false, detail: "failure: invalid address" },
    ]);
  });

  test("watch and escalate make no device commands", async () => {
    expect(await executePlan({ ...plan, action: "watch" })).toMatchObject([{ ok: true }]);
    expect(await executePlan({ ...plan, action: "escalate" })).toMatchObject([{ ok: true }]);
    expect(commands.run).not.toHaveBeenCalled();
  });

  test("revoke skips missing entries and reports a failed removal", async () => {
    commands.run
      .mockResolvedValueOnce("0")
      .mockResolvedValueOnce("1")
      .mockResolvedValueOnce("failure: denied");
    expect(await revokeBlock(plan.source, ["absent", "denied"])).toMatchObject([
      { device: "absent", ok: true, detail: "was not blocked here" },
      { device: "denied", ok: false, detail: "failure: denied" },
    ]);
    expect(
      commands.run.mock.calls
        .map(([command]) => command)
        .filter((command) => command.includes(" remove ")),
    ).toHaveLength(1);
  });

  test("scan list deduplicates addresses and treats RouterOS errors as no data", async () => {
    commands.run.mockResolvedValueOnce(
      "0 address=203.0.113.1\n1 address=203.0.113.2\n2 address=203.0.113.1",
    );
    expect(await readScanList({ device: "edge" } as Parameters<typeof readScanList>[0])).toEqual([
      "203.0.113.1",
      "203.0.113.2",
    ]);
    commands.run.mockResolvedValueOnce("failure: no such list");
    expect(await readScanList({ device: "edge" } as Parameters<typeof readScanList>[0])).toEqual(
      [],
    );
  });
});
