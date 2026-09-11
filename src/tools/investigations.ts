/** Shared MCP/dashboard handlers with explicit device-scope checks. */
import { z } from "zod";
import { defineTool, READ, WRITE } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { resolveDeviceName } from "../core/runtime";
import { assertCaseAccess, collectInvestigation } from "../investigations/collect";
import { investigationInput } from "../investigations/model";
import { investigationStore } from "../investigations/store";
import { flowPathInput } from "../investigations/flow-path";
import { clientFlowCandidates, inspectFlowPath } from "../investigations/flow-path-service";

export const investigationTools: ToolModule = [
  defineTool({
    name: "inspect_flow_path",
    title: "Inspect Exported Client Flow Path",
    annotations: READ,
    description:
      "Read the last five minutes of exact IPv4 TCP/UDP five-tuple NetFlow/IPFIX evidence for the selected router. Reports exporter input/output ifIndex and resolves up to eight explicitly named interfaces with read-only OID queries. Requires a unique configured IPv4 host matching the exporter sender. Never enables capture, changes configuration or generates traffic. Unauthenticated UDP exports, current name mappings and no-match results are not proof of VPN encryption, packet loss or application delivery. NAT aliases are not inferred.",
    inputSchema: flowPathInput.shape,
    async handler(a, ctx) {
      return JSON.stringify(await inspectFlowPath(a, ctx));
    },
  }),
  defineTool({
    name: "list_client_flow_candidates",
    title: "List Recent Client Flow Tuples",
    annotations: READ,
    description:
      "List up to 50 recent exported TCP/UDP tuples originating from an exact client IPv4 on the selected router, including ephemeral source ports, for inspect_flow_path. Reads local NetFlow/IPFIX storage only; does not query the client or router. Requires unambiguous exporter host binding. Missing records do not mean no traffic.",
    inputSchema: { client: z.ipv4() },
    async handler(a, ctx) {
      return JSON.stringify(await clientFlowCandidates(a.client, ctx));
    },
  }),
  defineTool({
    name: "create_investigation",
    title: "Investigate a Client and Service",
    annotations: WRITE,
    description:
      "Read client DHCP/ARP/bridge evidence and VLAN/interface/DNS/route/firewall/NAT context from the selected router and up to two explicit additional routers. Run three router-originated ICMP probes and save a local case. Never changes router configuration or starts captures. WRITE reflects local persistence. Application health remains UNVERIFIED; no endpoint probe is installed. IPv4 or colon-separated MAC clients only. Returns JSON evidence with timestamps, unknowns and next tests.",
    inputSchema: investigationInput.shape,
    async handler(a, ctx) {
      const result = await collectInvestigation(a, ctx);
      (await investigationStore()).save(result);
      return JSON.stringify(result);
    },
  }),
  defineTool({
    name: "list_investigations",
    title: "List Client Investigations",
    annotations: READ,
    description:
      "List up to 100 saved cases for the selected primary device. Cases requiring denied device access are omitted. No router I/O.",
    inputSchema: {},
    async handler(_a, ctx) {
      const device = resolveDeviceName(ctx.device);
      assertCaseAccess([device], "list_investigations", "READ");
      const cases = (await investigationStore())
        .list(device)
        .filter((c) => {
          try {
            assertCaseAccess(c.devices, "list_investigations", "READ");
            return true;
          } catch {
            return false;
          }
        })
        .map(({ evidence, nextTests, ...c }) => ({
          ...c,
          evidenceCount: evidence.length,
          unknownCount: evidence.filter((e) => e.state === "unknown").length,
          nextTestCount: nextTests.length,
        }));
      return JSON.stringify({ cases });
    },
  }),
  defineTool({
    name: "get_investigation",
    title: "Read a Client Investigation",
    annotations: READ,
    description:
      "Read a case by UUID under its primary device. Rechecks access to all evidence devices. Historical evidence is not a current health check.",
    inputSchema: { id: z.uuid() },
    async handler(a, ctx) {
      const device = resolveDeviceName(ctx.device);
      assertCaseAccess([device], "get_investigation", "READ");
      const result = (await investigationStore()).get(a.id);
      if (!result || result.device !== device)
        throw new Error("Investigation not found on this device");
      assertCaseAccess(result.devices, "get_investigation", "READ");
      return JSON.stringify(result);
    },
  }),
];
