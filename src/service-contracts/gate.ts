/** Add fail-closed service assertions to the existing rollout executor without changing rollback policy. */
import type { RolloutExecutor } from "../rollout/runner";
import type { ContractRun } from "./model";

export interface ServiceGateRef {
  id: string;
  device: string;
}
export function withServiceGate(
  base: RolloutExecutor,
  refs: ServiceGateRef[],
  run: (id: string, device: string) => Promise<ContractRun>,
): RolloutExecutor {
  if (!refs.length) return base;
  return {
    ...base,
    async health(changed, untouched) {
      const results = await base.health(changed, untouched);
      for (const ref of refs) {
        // Run every contract on each wave, including collateral/untouched services.
        let passed = false;
        let evidence = `Service contract ${ref.id}: no recorded result`;
        try {
          const result = await run(ref.id, ref.device);
          passed = result.status === "pass";
          evidence = `Service contract ${ref.id}, run ${result.id}: ${result.status} (MCP-host perspective)`;
        } catch {
          /* Unknown is a failed assertion, not a skipped gate. */
        }
        let row = results.find((r) => r.device === ref.device);
        if (!row) {
          row = { device: ref.device, reachable: false };
          results.push(row);
        }
        row.assertionsPassed = row.assertionsPassed !== false && passed;
        row.detail = [row.detail, evidence].filter(Boolean).join("; ");
      }
      return results;
    },
  };
}
