/** Scheduled enrollment is explicit: newly created contracts never start probing autonomously. */
import { getConfig } from "../core/runtime";
import { assertDeviceAccess as assertCaseAccess } from "../core/scoped-access";
import type { AuditFinding } from "../schedule/model";
import { contractStore } from "./store";
import { runServiceContract } from "./run";

export async function auditServiceContracts(device: string): Promise<AuditFinding[]> {
  assertCaseAccess([device], "audit_service_contracts", "READ");
  const ids = getConfig().serviceProbes.scheduled[device] ?? [];
  if (!ids.length)
    return [
      {
        id: `service:${device}:unconfigured`,
        device,
        severity: "info",
        title: "No service contracts enrolled",
        detail: "Set serviceProbes.scheduled for this device. No health claim was made.",
      },
    ];
  const store = await contractStore();
  const total = ids.reduce((count, id) => count + (store.get(id)?.checks.length ?? 0), 0);
  if (total > 10)
    throw new Error("Scheduled service checks exceed the ten-probe budget; reduce enrollment");
  const findings: AuditFinding[] = [];
  for (const id of ids) {
    try {
      const result = await runServiceContract(id, device);
      result.checks.forEach((check, index) => {
        if (check.status !== "pass")
          findings.push({
            id: `service:${device}:${id}:${index}`,
            device,
            severity: check.status === "fail" ? "high" : "medium",
            title: `${check.target}: ${check.status}`,
            detail: check.detail,
          });
      });
    } catch {
      findings.push({
        id: `service:${device}:${id}:unavailable`,
        device,
        severity: "medium",
        title: "Service contract could not be checked",
        detail: `Contract ${id} is missing, denied, busy or could not persist its result. This is not a passing check.`,
      });
    }
  }
  return findings;
}
