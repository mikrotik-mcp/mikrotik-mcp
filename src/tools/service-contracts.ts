import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineTool, READ, WRITE } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { getConfig, resolveDeviceName } from "../core/runtime";
import { assertDeviceAccess as assertCaseAccess } from "../core/scoped-access";
import { contractInput } from "../service-contracts/model";
import { contractStore } from "../service-contracts/store";
import { runServiceContract } from "../service-contracts/run";
import { auditServiceContracts } from "../service-contracts/audit";

export const serviceContractTools: ToolModule = [
  defineTool({
    name: "audit_service_contracts",
    title: "Audit Enrolled Service Contracts",
    annotations: READ,
    description:
      "Run the administrator-enrolled service contracts for this device (serviceProbes.scheduled) and return stable failures/unknowns for scheduled-audit regression notifications. New contracts are not enrolled automatically. At most five contracts and ten network checks; no router configuration writes.",
    inputSchema: {},
    async handler(_a, ctx) {
      return JSON.stringify({
        findings: await auditServiceContracts(resolveDeviceName(ctx.device)),
      });
    },
  }),
  defineTool({
    name: "list_service_probe_targets",
    title: "List Approved Service Probe Targets",
    annotations: READ,
    description:
      "List the service probe aliases approved by the server administrator. Probes originate from the MCP host, not the router or client. No network request is made. Empty by default; edit serviceProbes.targets in the server config to enable explicitly bounded endpoints.",
    inputSchema: {},
    handler(_a, ctx) {
      assertCaseAccess([resolveDeviceName(ctx.device)], "list_service_probe_targets", "READ");
      return JSON.stringify({
        vantage: "mcp-host",
        targets: Object.entries(getConfig().serviceProbes.targets).map(([name, t]) => ({
          name,
          kind: t.kind,
        })),
      });
    },
  }),
  defineTool({
    name: "create_service_contract",
    title: "Create a Service Health Contract",
    annotations: WRITE,
    description:
      "Save an immutable device-owned contract of DNS/TCP/TLS/HTTPS checks against administrator-approved aliases, latency thresholds and expected HTTPS status codes. Optionally attach a saved packet suite evaluated against a fresh device export. Definition only: no probes or router writes. To revise a contract, create a new one and select its new ID explicitly.",
    inputSchema: contractInput.shape,
    async handler(a, ctx) {
      const device = resolveDeviceName(ctx.device);
      assertCaseAccess([device], "create_service_contract", "WRITE");
      const args = contractInput.parse(a);
      if (args.checks.some((c) => !getConfig().serviceProbes.targets[c.target]))
        throw new Error(
          "Contract references an unapproved target. Ask the administrator to configure it.",
        );
      const contract = { ...args, id: randomUUID(), device, createdAt: Date.now() };
      (await contractStore()).save(contract);
      return JSON.stringify(contract);
    },
  }),
  defineTool({
    name: "list_service_contracts",
    title: "List Service Health Contracts",
    annotations: READ,
    description:
      "Read up to 100 local service contract definitions owned by the selected device. No probes are run.",
    inputSchema: {},
    async handler(_a, ctx) {
      const device = resolveDeviceName(ctx.device);
      assertCaseAccess([device], "list_service_contracts", "READ");
      return JSON.stringify({ contracts: (await contractStore()).list(device) });
    },
  }),
  defineTool({
    name: "run_service_contract",
    title: "Check a Service Health Contract",
    annotations: READ,
    description:
      "Run and record bounded DNS/TCP/TLS/HTTPS checks from the MCP host against server-approved, IP-pinned targets. No redirects, request credentials or response bodies. Report PASS/FAIL/UNKNOWN per check, not blanket client health. An optional packet suite reads a fresh /export terse from its device for this run; never tests an old baseline after a change. No router configuration writes. Unknown never passes a rollout gate. For scheduled checks, explicitly enroll contracts and schedule audit_service_contracts.",
    inputSchema: { id: z.uuid() },
    async handler(a, ctx) {
      return JSON.stringify(await runServiceContract(a.id, resolveDeviceName(ctx.device)));
    },
  }),
  defineTool({
    name: "service_contract_history",
    title: "Read Service Contract History",
    annotations: READ,
    description:
      "Read the latest 100 recorded service checks for a contract owned by the selected device. A historical passing run is not a current gate result.",
    inputSchema: { id: z.uuid() },
    async handler(a, ctx) {
      const device = resolveDeviceName(ctx.device);
      assertCaseAccess([device], "service_contract_history", "READ");
      const store = await contractStore();
      if (store.get(a.id)?.device !== device) throw new Error("Contract not found on this device");
      return JSON.stringify({ runs: store.history(a.id) });
    },
  }),
];
