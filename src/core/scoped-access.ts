/** Shared service-entry guard for both MCP and dashboard paths, including local writes. */
import { evaluateAccess, getAccessPolicy } from "./access";
import { getConfig, resolveDeviceName } from "./runtime";

export function assertDeviceAccess(devices: string[], tool: string, risk: "READ" | "WRITE"): void {
  if (getConfig().readOnly && risk !== "READ") throw new Error("Server is in read-only mode");
  for (const name of devices) {
    const device = resolveDeviceName(name);
    const decision = evaluateAccess(getAccessPolicy(), { device, tool, risk, now: Date.now() });
    if (!decision.allowed) throw new Error(decision.reason);
  }
}
