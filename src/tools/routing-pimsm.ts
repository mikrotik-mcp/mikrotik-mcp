/** PIM-SM — `/routing pimsm` (instance, interface-template, rp, neighbor) — RouterOS v7. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import {
  looksLikeError,
  isEmpty,
  commandUnsupported,
  Cmd,
  quoted,
  quoteValue,
} from "../core/routeros";

const UNSUPPORTED =
  "PIM-SM is not available on this device (requires RouterOS v7 with the routing/multicast package).";

export const routingPimsmTools: ToolModule = [
  // ── Instances ─────────────────────────────────────────────────────────────
  defineTool({
    name: "list_pimsm_instances",
    title: "List PIM-SM Instances",
    annotations: READ,
    description:
      "List all PIM-SM protocol instances (`/routing pimsm instance`). Each instance enables PIM Sparse-Mode " +
      "multicast routing for a specific address family (ipv4 or ipv6) and VRF. " +
      "For interface bindings within an instance use list_pimsm_interface_templates; " +
      "for static RP entries use list_pimsm_rps; for discovered PIM peers use list_pimsm_neighbors. " +
      "Returns a detail printout of every instance, or 'No PIM-SM instances found.' if none exist.",
    async handler(_a, ctx) {
      ctx.info("Listing PIM-SM instances");
      const result = await executeMikrotikCommand("/routing pimsm instance print detail", ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result) ? "No PIM-SM instances found." : `PIM-SM INSTANCES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "add_pimsm_instance",
    title: "Add PIM-SM Instance",
    annotations: WRITE,
    description:
      "Create a PIM-SM protocol instance (`/routing pimsm instance`). An instance is required before any " +
      "interface templates or static RPs can be added — it anchors the address family (ipv4/ipv6) and VRF " +
      "that multicast routing runs in. " +
      "Once created, bind interfaces with add_pimsm_interface_template and add RPs with add_pimsm_rp. " +
      "Returns the detail of the newly created instance including its name and settings.",
    inputSchema: {
      name: z.string().describe("Unique instance name"),
      afi: z.enum(["ipv4", "ipv6"]).default("ipv4").describe("Address family"),
      vrf: z.string().optional(),
      rp_set: z.string().optional().describe("Static RP-set name, if used"),
      ssm_range: z
        .string()
        .optional()
        .describe("Source-Specific Multicast group range(s) for this instance"),
      rp_hash_mask_length: z
        .number()
        .int()
        .optional()
        .describe("RP hash mask length for group-to-RP mapping"),
      rp_static_override: z
        .boolean()
        .optional()
        .describe("Static RP entries override dynamically learned (BSR) RPs"),
      switch_to_spt: z
        .boolean()
        .optional()
        .describe("Switch from the shared (RP) tree to the shortest-path tree"),
      switch_to_spt_bytes: z
        .number()
        .int()
        .optional()
        .describe("Traffic threshold in bytes before switching to the SPT"),
      switch_to_spt_interval: z
        .string()
        .optional()
        .describe('SPT switchover measurement interval, e.g. "1m"'),
      bsm_forward_back: z
        .boolean()
        .optional()
        .describe("Forward bootstrap (BSM) messages back out the receiving interface"),
      crp_advertise_contained: z
        .boolean()
        .optional()
        .describe("Candidate-RP advertises only contained group ranges"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding PIM-SM instance: ${a.name}`);
      const cmd = new Cmd("/routing pimsm instance add")
        .set("name", a.name)
        .opt("afi", a.afi)
        .opt("vrf", a.vrf)
        .opt("rp-set", a.rp_set)
        .opt("ssm-range", a.ssm_range)
        .opt("rp-hash-mask-length", a.rp_hash_mask_length)
        .bool("rp-static-override", a.rp_static_override)
        .bool("switch-to-spt", a.switch_to_spt)
        .opt("switch-to-spt-bytes", a.switch_to_spt_bytes)
        .opt("switch-to-spt-interval", a.switch_to_spt_interval)
        .bool("bsm-forward-back", a.bsm_forward_back)
        .bool("crp-advertise-contained", a.crp_advertise_contained)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to add PIM-SM instance: ${result}`;
      const details = await executeMikrotikCommand(
        `/routing pimsm instance print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return `PIM-SM instance '${a.name}' added successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_pimsm_instance",
    title: "Remove PIM-SM Instance",
    annotations: DESTRUCTIVE,
    description:
      "Remove a PIM-SM protocol instance (`/routing pimsm instance`) by name, tearing down all multicast " +
      "routing for that address family and VRF. " +
      "Use list_pimsm_instances to obtain the exact instance name. " +
      "To remove only an interface binding without deleting the instance use remove_pimsm_interface_template; " +
      "to remove only an RP entry use remove_pimsm_rp. " +
      "Confirms success or returns the RouterOS error on failure.",
    inputSchema: {
      name: z.string().describe("PIM-SM instance name to remove"),
    },
    async handler(a, ctx) {
      ctx.info(`Removing PIM-SM instance: ${a.name}`);
      const result = await executeMikrotikCommand(
        `/routing pimsm instance remove [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to remove PIM-SM instance: ${result}`;
      return `PIM-SM instance '${a.name}' removed successfully.`;
    },
  }),

  // ── Interface templates ───────────────────────────────────────────────────
  defineTool({
    name: "list_pimsm_interface_templates",
    title: "List PIM-SM Interface Templates",
    annotations: READ,
    description:
      "List PIM-SM interface templates (`/routing pimsm interface-template`) — the per-interface bindings that " +
      "activate PIM on physical or logical interfaces within a named instance. Shows the interface or " +
      "interface-list, DR election priority, and hello interval for each template. " +
      "For the parent instance configuration use list_pimsm_instances; " +
      "for dynamically discovered PIM peers on those interfaces use list_pimsm_neighbors. " +
      "Returns a detail printout of all interface templates, or 'No PIM-SM interface templates found.'",
    async handler(_a, ctx) {
      ctx.info("Listing PIM-SM interface templates");
      const result = await executeMikrotikCommand(
        "/routing pimsm interface-template print detail",
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result)
        ? "No PIM-SM interface templates found."
        : `PIM-SM INTERFACE TEMPLATES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "add_pimsm_interface_template",
    title: "Add PIM-SM Interface Template",
    annotations: WRITE,
    description:
      "Activate PIM-SM on one or more interfaces by creating an interface template (`/routing pimsm interface-template`). " +
      "Binds a physical or logical interface (or interface-list) to an existing PIM-SM instance and sets " +
      'DR election priority and hello interval (e.g. hello_period="30s"). ' +
      "Requires the parent instance to exist first — use add_pimsm_instance. " +
      "To configure static RPs for that instance use add_pimsm_rp instead. " +
      "Returns the new template's `.id` (e.g. '*1') if RouterOS echoes it back from the add command, " +
      "or a plain success message; use list_pimsm_interface_templates to look it up afterwards.",
    inputSchema: {
      instance: z.string().describe("PIM-SM instance name"),
      interfaces: z.string().describe("Interface or interface-list name"),
      priority: z.number().int().optional().describe("DR election priority"),
      hello_period: z.string().optional().describe('Hello interval, e.g. "30s"'),
      hello_delay: z
        .string()
        .optional()
        .describe('Max random delay before the first Hello, e.g. "5s"'),
      join_prune_period: z
        .string()
        .optional()
        .describe('Interval between periodic Join/Prune messages, e.g. "1m"'),
      join_tracking_support: z
        .boolean()
        .optional()
        .describe("Enable explicit Join/Prune tracking support"),
      override_interval: z
        .string()
        .optional()
        .describe('Randomized Join override interval, e.g. "2s500ms"'),
      propagation_delay: z
        .string()
        .optional()
        .describe('Expected link propagation delay, e.g. "500ms"'),
      source_addresses: z
        .string()
        .optional()
        .describe("Source IP address(es) used for PIM messages on these interfaces"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding PIM-SM interface template for instance ${a.instance}`);
      const cmd = new Cmd("/routing pimsm interface-template add")
        .set("instance", a.instance)
        .set("interfaces", a.interfaces)
        .opt("priority", a.priority)
        .opt("hello-period", a.hello_period)
        .opt("hello-delay", a.hello_delay)
        .opt("join-prune-period", a.join_prune_period)
        .bool("join-tracking-support", a.join_tracking_support)
        .opt("override-interval", a.override_interval)
        .opt("propagation-delay", a.propagation_delay)
        .opt("source-addresses", a.source_addresses)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to add PIM-SM interface template: ${result}`;
      const t = result.trim();
      return t
        ? `PIM-SM interface template added (id ${t}).`
        : "PIM-SM interface template added successfully.";
    },
  }),

  defineTool({
    name: "remove_pimsm_interface_template",
    title: "Remove PIM-SM Interface Template",
    annotations: DESTRUCTIVE,
    description:
      "Remove a PIM-SM interface template (`/routing pimsm interface-template`) by its `.id`, deactivating PIM " +
      "on the interfaces it covered without removing the parent instance. " +
      "The template_id (e.g. '*1') comes from list_pimsm_interface_templates. " +
      "To tear down the entire PIM instance use remove_pimsm_instance; " +
      "to remove a static RP entry use remove_pimsm_rp. " +
      "Confirms success or returns the RouterOS error on failure.",
    inputSchema: { template_id: z.string().describe('Template id, e.g. "*1"') },
    async handler(a, ctx) {
      ctx.info(`Removing PIM-SM interface template ${a.template_id}`);
      const result = await executeMikrotikCommand(
        `/routing pimsm interface-template remove ${quoteValue(a.template_id)}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to remove PIM-SM interface template: ${result}`;
      return `PIM-SM interface template '${a.template_id}' removed successfully.`;
    },
  }),

  // ── Rendezvous Points (static RP) ─────────────────────────────────────────
  defineTool({
    name: "list_pimsm_rps",
    title: "List PIM-SM Rendezvous Points",
    annotations: READ,
    description:
      "List statically configured PIM-SM Rendezvous Points (`/routing pimsm rp`). Each entry maps an RP IP " +
      "address to the multicast group range it roots the shared distribution tree for. " +
      "For the parent instance configuration use list_pimsm_instances; " +
      "for interface PIM settings use list_pimsm_interface_templates; " +
      "for dynamically discovered PIM peers (not RPs) use list_pimsm_neighbors. " +
      "Returns a detail printout of all RP entries, or 'No PIM-SM RPs found.'",
    async handler(_a, ctx) {
      ctx.info("Listing PIM-SM RPs");
      const result = await executeMikrotikCommand("/routing pimsm rp print detail", ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result) ? "No PIM-SM RPs found." : `PIM-SM RENDEZVOUS POINTS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "add_pimsm_rp",
    title: "Add PIM-SM Rendezvous Point",
    annotations: WRITE,
    description:
      "Register a static Rendezvous Point (RP) for a multicast group range (`/routing pimsm rp`). Tells " +
      "PIM-SM routers which IP address is the root of the shared distribution tree for a given multicast " +
      "prefix. The group field accepts a multicast prefix e.g. '239.0.0.0/8'; omit to cover the default " +
      "multicast range. Requires the target instance to exist — use add_pimsm_instance first. " +
      "To enable PIM on interfaces (not configure an RP) use add_pimsm_interface_template. " +
      "Returns a success message; use list_pimsm_rps to retrieve the new entry's `.id`.",
    inputSchema: {
      instance: z.string().describe("PIM-SM instance name"),
      address: z.string().describe("RP IP address"),
      group: z.string().optional().describe('Multicast group range, e.g. "239.0.0.0/8"'),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding PIM-SM RP ${a.address}`);
      const cmd = new Cmd("/routing pimsm rp add")
        .set("instance", a.instance)
        .set("address", a.address)
        .opt("group", a.group)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to add PIM-SM RP: ${result}`;
      return `PIM-SM RP '${a.address}' added successfully.`;
    },
  }),

  defineTool({
    name: "remove_pimsm_rp",
    title: "Remove PIM-SM Rendezvous Point",
    annotations: DESTRUCTIVE,
    description:
      "Remove a static PIM-SM Rendezvous Point entry (`/routing pimsm rp`) by its `.id`, stopping the router " +
      "from treating that address as the shared-tree root for the associated multicast group range. " +
      "The rp_id (e.g. '*1') comes from list_pimsm_rps. " +
      "To remove an interface template instead use remove_pimsm_interface_template; " +
      "to tear down the whole PIM instance use remove_pimsm_instance. " +
      "Confirms success or returns the RouterOS error on failure.",
    inputSchema: { rp_id: z.string().describe('RP id, e.g. "*1"') },
    async handler(a, ctx) {
      ctx.info(`Removing PIM-SM RP ${a.rp_id}`);
      const result = await executeMikrotikCommand(
        `/routing pimsm rp remove ${quoteValue(a.rp_id)}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to remove PIM-SM RP: ${result}`;
      return `PIM-SM RP '${a.rp_id}' removed successfully.`;
    },
  }),

  // ── Neighbors (read-only) ─────────────────────────────────────────────────
  defineTool({
    name: "list_pimsm_neighbors",
    title: "List PIM-SM Neighbors",
    annotations: READ,
    description:
      "List dynamically discovered PIM-SM neighbors (`/routing pimsm neighbor`) — adjacent PIM routers " +
      "learned via Hello messages, showing their DR priority and liveliness timers. This table is " +
      "read-only and cannot be configured; entries appear automatically when PIM interfaces are active. " +
      "For interface PIM configuration (hello interval, DR priority) use list_pimsm_interface_templates; " +
      "for statically configured RP addresses use list_pimsm_rps. " +
      "Returns a detail printout of all discovered PIM peers, or 'No PIM-SM neighbors found.'",
    async handler(_a, ctx) {
      ctx.info("Listing PIM-SM neighbors");
      const result = await executeMikrotikCommand("/routing pimsm neighbor print detail", ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result) ? "No PIM-SM neighbors found." : `PIM-SM NEIGHBORS:\n\n${result}`;
    },
  }),
];
