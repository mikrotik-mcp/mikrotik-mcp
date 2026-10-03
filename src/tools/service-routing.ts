import { z } from "zod";
import { defineTool, READ, WRITE } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { routingInput } from "../service-routing/model";
import {
  listRouting,
  createRouting,
  routingInventory,
  probeRouting,
  previewRouting,
  applyRouting,
  armRouting,
} from "../service-routing/service";

export const serviceRoutingTools: ToolModule = [
  defineTool({
    name: "list_service_routing",
    title: "List Service Routing Policies",
    annotations: READ,
    description:
      "Read persistent domain routing policies, path evidence, primary exit, history and authorization expiry for this router. No probes or router changes.",
    inputSchema: {},
    async handler(_, ctx) {
      return JSON.stringify(await listRouting(ctx));
    },
  }),
  defineTool({
    name: "service_routing_inventory",
    title: "Discover Service Routing Exits",
    annotations: READ,
    description:
      "Read enabled FIB tables and administrator-approved HTTPS target aliases. A table is not proof of a working path; HTTPS per-exit probes require a matching VRF.",
    inputSchema: {},
    async handler(_, ctx) {
      return JSON.stringify(await routingInventory(ctx));
    },
  }),
  defineTool({
    name: "create_service_routing",
    title: "Create Service Routing Draft",
    annotations: WRITE,
    description:
      "Save a single-family policy for one approved exact hostname and explicit client subnets. No router changes. Create separate IPv4/IPv6 policies. Shared CDN IPs can affect other services. Preview, then explicitly confirm apply; never infer authorization from a draft.",
    inputSchema: routingInput.shape,
    async handler(a, ctx) {
      return JSON.stringify(await createRouting(a, ctx));
    },
  }),
  defineTool({
    name: "probe_service_routing",
    title: "Probe Service Exits",
    annotations: READ,
    description:
      "Run bounded, IP-approved HTTPS HEAD fetches from the router through matching VRFs, certificate validation on, redirects off. No files/bodies stored. Table-only exits remain UNKNOWN. SSH overhead is included; not end-client reachability or throughput proof.",
    inputSchema: { id: z.uuid() },
    async handler(a, ctx) {
      return JSON.stringify(await probeRouting(a.id, ctx));
    },
  }),
  defineTool({
    name: "preview_service_routing",
    title: "Preview Service Routing Change",
    annotations: READ,
    description:
      "Read router state and save a two-minute, state-bound preview for applying/switching or removing only owned rules. Reject FastTrack and foreign policy-routing conflicts. Does not create exits, NAT, DNS interception or change router configuration.",
    inputSchema: {
      id: z.uuid(),
      table: z.string().min(1).max(64),
      remove: z.boolean().default(false),
    },
    async handler(a, ctx) {
      return JSON.stringify(await previewRouting(a.id, a.table, a.remove, ctx));
    },
  }),
  defineTool({
    name: "apply_service_routing",
    title: "Apply Approved Service Routing Preview",
    annotations: WRITE,
    description:
      "After explicit user confirmation, apply the exact fresh preview with a backup, exclusive Safe Mode and read-back. Router DNS maintains the owned destination list. Does not touch output/input chains. An ambiguous write is never retried; inspect router state. An apply pauses automatic failover.",
    inputSchema: { id: z.uuid(), planId: z.uuid(), confirm: z.boolean().default(false) },
    async handler(a, ctx) {
      return JSON.stringify(await applyRouting(a.id, a.planId, a.confirm, ctx));
    },
  }),
  defineTool({
    name: "arm_service_routing",
    title: "Authorize Time-Limited Service Failover",
    annotations: WRITE,
    description:
      "Explicitly authorize automatic switching between saved exits for 1-60 minutes, or pause with 0. Requires fresh passing VRF evidence for every exit, consecutive definite failures and cooldown; UNKNOWN never triggers a switch. Expiry stops automation but retains the current route. No new exits or global policy rewrites.",
    inputSchema: {
      id: z.uuid(),
      minutes: z.number().int().min(0).max(60),
      confirm: z.boolean().default(false),
    },
    async handler(a, ctx) {
      return JSON.stringify(await armRouting(a.id, a.minutes, a.confirm, ctx));
    },
  }),
];
