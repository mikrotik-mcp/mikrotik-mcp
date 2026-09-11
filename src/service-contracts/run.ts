/** Evidence-based service checks: DNS/TCP/TLS/HTTPS plus optional offline packet regressions. */
import { randomUUID } from "node:crypto";
import { getConfig, resolveDeviceName } from "../core/runtime";
import { assertDeviceAccess as assertCaseAccess } from "../core/scoped-access";
import { buildModel } from "../sim/model";
import { tracePacket } from "../sim/trace";
import { getSuite } from "../sim/suites";
import { executeMikrotikCommand } from "../core/connector";
import { createContext } from "../core/context";
import { looksLikeError } from "../core/routeros";
import { contentSha } from "../snapshots/format";
import { overallStatus } from "./model";
import type { ContractCheckResult, ContractRun, ServiceContract } from "./model";
import { probeTarget } from "./probe";
import type { ProbeIO } from "./probe";
import { contractStore } from "./store";

export async function evaluateContract(
  contract: ServiceContract,
  io?: ProbeIO,
  simulationExport?: string,
): Promise<ContractRun> {
  const startedAt = Date.now();
  const checks: ContractCheckResult[] = [];
  for (const check of contract.checks) {
    const start = Date.now();
    const target = getConfig().serviceProbes.targets[check.target];
    if (!target) {
      checks.push({
        target: check.target,
        kind: "unconfigured",
        status: "unknown",
        durationMs: 0,
        detail: "Probe target is not approved in server configuration",
      });
      continue;
    }
    try {
      const observation = await probeTarget(target, getConfig().serviceProbes.timeoutMs, io);
      const durationMs = Date.now() - start;
      const ok =
        observation.ok &&
        durationMs <= check.maxLatencyMs &&
        (target.kind !== "https" ||
          (observation.httpStatus !== undefined &&
            check.expectedStatus.includes(observation.httpStatus)));
      checks.push({
        target: check.target,
        kind: target.kind,
        status: ok ? "pass" : "fail",
        durationMs,
        detail:
          durationMs > check.maxLatencyMs
            ? `Latency exceeded ${check.maxLatencyMs} ms`
            : observation.detail,
      });
    } catch {
      checks.push({
        target: check.target,
        kind: target.kind,
        status: "unknown",
        durationMs: Date.now() - start,
        detail:
          "Resolution, approved-address validation or probe setup failed; no successful service check was observed",
      });
    }
  }
  if (contract.packetSuiteId) {
    try {
      const suite = await getSuite(contract.packetSuiteId);
      if (
        !suite?.packets.length ||
        suite.packets.length > 100 ||
        !simulationExport?.trim() ||
        looksLikeError(simulationExport)
      )
        throw new Error("Missing simulation inputs");
      const model = buildModel(simulationExport);
      const sha = contentSha(simulationExport);
      for (const packet of suite.packets) {
        const result = tracePacket({ model, packet: packet.packet });
        checks.push({
          target: packet.name,
          kind: "simulation",
          status:
            result.verdict === "unknown"
              ? "unknown"
              : result.verdict === packet.expect
                ? "pass"
                : "fail",
          durationMs: 0,
          detail: `Export SHA ${sha}: expected ${packet.expect}, simulated ${result.verdict}; not a live packet test`,
        });
      }
    } catch {
      checks.push({
        target: contract.packetSuiteId,
        kind: "simulation",
        status: "unknown",
        durationMs: 0,
        detail:
          "A saved suite of 1–100 packets and a usable export captured for this run are required",
      });
    }
  }
  return {
    id: randomUUID(),
    contractId: contract.id,
    device: contract.device,
    startedAt,
    finishedAt: Date.now(),
    vantage: "mcp-host",
    status: overallStatus(checks),
    checks,
  };
}

const active = new Set<string>();
/** Execute and retain one run; audit storage failure or revoked permission prevents a passing gate. */
export async function runServiceContract(id: string, device: string): Promise<ContractRun> {
  device = resolveDeviceName(device);
  assertCaseAccess([device], "run_service_contract", "READ");
  const store = await contractStore();
  const contract = store.get(id);
  if (!contract || contract.device !== device)
    throw new Error("Service contract not found on this device");
  if (active.has(id) || active.size >= 4)
    throw new Error("Service probe capacity is busy; retry after the active checks finish");
  active.add(id);
  try {
    let simulationExport: string | undefined;
    if (contract.packetSuiteId) {
      try {
        simulationExport = await executeMikrotikCommand(
          "/export terse",
          createContext(undefined, device),
          { maxMs: 8000 },
        );
      } catch {
        /* Missing export becomes UNKNOWN, never an old baseline. */
      }
    }
    const run = await evaluateContract(contract, undefined, simulationExport);
    assertCaseAccess([device], "run_service_contract", "READ");
    store.record(run);
    return run;
  } finally {
    active.delete(id);
  }
}
