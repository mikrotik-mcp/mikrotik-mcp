import { describe, expect, test, vi } from "vite-plus/test";
import { withServiceGate } from "../../src/service-contracts/gate";
import type { ContractRun } from "../../src/service-contracts/model";
import { runRollout } from "../../src/rollout/runner";
import { beginRollout } from "../../src/rollout/model";

function executor() {
  return {
    snapshot: vi.fn(async () => "snapshot"),
    apply: vi.fn(async () => {}),
    revert: vi.fn(async () => {}),
    soak: vi.fn(async () => {}),
    health: async (a: string[], b: string[]) =>
      [...new Set([...a, ...b])].map((device) => ({ device, reachable: true })),
  };
}
const refs = [{ id: "contract", device: "edge" }];
describe("service rollout gates", () => {
  test("does not probe when no service contract was requested", () => {
    const base = executor();
    expect(withServiceGate(base, [], vi.fn())).toBe(base);
  });
  test.each(["fail", "unknown"] as const)(
    "%s triggers the existing halt-and-revert path",
    async (status) => {
      const base = executor();
      const run = vi.fn(async () => ({ status }) as ContractRun);
      const result = await runRollout({
        state: beginRollout({
          id: "r",
          devices: ["edge", "core"],
          strategy: { canary: 1, soakSeconds: 0 },
        }),
        commands: ["test-command-never-sent"],
        executor: withServiceGate(base, refs, run),
      });
      expect(result.outcome).toBe("reverted");
      expect(base.apply).toHaveBeenCalledTimes(1);
      expect(base.revert).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith("contract", "edge");
    },
  );
  test("probe exceptions are failed assertions", async () => {
    const rows = await withServiceGate(executor(), refs, async () => {
      throw new Error("denied");
    }).health(["edge"], []);
    expect(rows[0].assertionsPassed).toBe(false);
  });
  test("multiple contracts cannot overwrite an earlier failure with a pass", async () => {
    const rows = await withServiceGate(
      executor(),
      [...refs, { id: "other", device: "edge" }],
      async (id) => ({ status: id === "other" ? "pass" : "unknown" }) as ContractRun,
    ).health(["edge"], []);
    expect(rows[0].assertionsPassed).toBe(false);
  });
  test("passing contracts retain the existing reachability result", async () => {
    const base = executor();
    base.health = async () => [{ device: "edge", reachable: false }];
    const rows = await withServiceGate(
      base,
      refs,
      async () => ({ status: "pass" }) as ContractRun,
    ).health(["edge"], []);
    expect(rows[0].reachable).toBe(false);
    expect(rows[0].assertionsPassed).toBe(true);
  });
});
