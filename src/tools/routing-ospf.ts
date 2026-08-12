/** OSPF — `/routing ospf` (instance, area, area-range, interface-template, neighbor, lsa) — RouterOS v7. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, commandUnsupported, Cmd } from "../core/routeros";

const UNSUPPORTED =
  "OSPF is not available on this device (requires RouterOS v7 with the routing package).";

export const routingOspfTools: ToolModule = [
  // ── Instances ─────────────────────────────────────────────────────────────
  defineTool({
    name: "list_ospf_instances",
    title: "List OSPF Instances",
    annotations: READ,
    description:
      "List all OSPF instances (`/routing ospf instance`) — each instance is one OSPF process with a fixed " +
      "protocol version (2=OSPFv2/IPv4, 3=OSPFv3/IPv6), router-id, redistribution list, and import/export " +
      "filter chains. Use this to verify running processes before adding areas or interface templates. " +
      "For area topology use list_ospf_areas; for per-link config use list_ospf_interface_templates; " +
      "for adjacency state use list_ospf_neighbors. Returns full detail for every instance including disabled ones.",
    async handler(_a, ctx) {
      ctx.info("Listing OSPF instances");
      const result = await executeMikrotikCommand("/routing ospf instance print detail", ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result) ? "No OSPF instances found." : `OSPF INSTANCES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "add_ospf_instance",
    title: "Add OSPF Instance",
    annotations: WRITE,
    description:
      "Create an OSPF instance (`/routing ospf instance add`) — the top-level OSPF process. " +
      "`version` 2 = OSPFv2 (IPv4 routing), 3 = OSPFv3 (IPv6 routing); each address family needs its own instance. " +
      "`router_id` may be an IPv4 address, 'main', or the name of a `/routing id`. " +
      "`redistribute` is a comma-separated list (connected,static,rip,bgp,…). " +
      "Requires RouterOS v7 with the routing package. " +
      "After creating an instance, add areas with add_ospf_area and bind interfaces with add_ospf_interface_template. " +
      "Returns the created instance's full detail.",
    inputSchema: {
      name: z.string().describe("Unique instance name"),
      version: z.number().int().min(2).max(3).default(2).describe("2 = OSPFv2, 3 = OSPFv3"),
      router_id: z.string().optional().describe("IPv4 address, 'main', or a /routing id name"),
      vrf: z.string().optional(),
      redistribute: z.string().optional().describe('Comma list, e.g. "connected,static"'),
      in_filter_chain: z.string().optional().describe("Routing filter chain for received routes"),
      out_filter_chain: z
        .string()
        .optional()
        .describe("Routing filter chain for redistributed routes"),
      originate_default: z.string().optional().describe("never, if-installed, or always"),
      domain_id: z.string().optional().describe("OSPF domain ID (MPLS VPN PE-CE OSPF)"),
      domain_tag: z.number().int().optional().describe("OSPF domain tag (MPLS VPN PE-CE OSPF)"),
      use_dn: z.boolean().optional().describe("Use/ignore DN bit on OSPF routes (MPLS VPN)"),
      mpls_te_area: z.string().optional().describe("Area used for MPLS traffic engineering"),
      mpls_te_address: z.string().optional().describe("Router address advertised for MPLS TE"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding OSPF instance: ${a.name}`);
      const cmd = new Cmd("/routing ospf instance add")
        .set("name", a.name)
        .set("version", a.version)
        .opt("router-id", a.router_id)
        .opt("vrf", a.vrf)
        .opt("redistribute", a.redistribute)
        .opt("in-filter-chain", a.in_filter_chain)
        .opt("out-filter-chain", a.out_filter_chain)
        .opt("originate-default", a.originate_default)
        .opt("domain-id", a.domain_id)
        .opt("domain-tag", a.domain_tag)
        .opt("mpls-te-area", a.mpls_te_area)
        .opt("mpls-te-address", a.mpls_te_address);
      if (a.use_dn !== undefined) cmd.bool("use-dn", a.use_dn);
      cmd.opt("comment", a.comment).flag("disabled", a.disabled);

      const result = await executeMikrotikCommand(cmd.build(), ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to add OSPF instance: ${result}`;
      const details = await executeMikrotikCommand(
        `/routing ospf instance print detail where name="${a.name}"`,
        ctx,
      );
      return `OSPF instance '${a.name}' added successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "update_ospf_instance",
    title: "Update OSPF Instance",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Update an existing OSPF instance (`/routing ospf instance set`) by name — change router-id, " +
      "redistribution list, import/export filter chains, originate-default policy, comment, or disabled state. " +
      "Only supplied fields are modified; omitting a field leaves it unchanged. " +
      "`name` identifies the target instance (use list_ospf_instances to find names). " +
      "Returns the updated instance detail. To remove an instance entirely use remove_ospf_instance.",
    inputSchema: {
      name: z.string().describe("Existing OSPF instance name"),
      router_id: z.string().optional(),
      redistribute: z.string().optional(),
      in_filter_chain: z.string().optional(),
      out_filter_chain: z.string().optional(),
      originate_default: z.string().optional(),
      domain_id: z.string().optional().describe("OSPF domain ID (MPLS VPN PE-CE OSPF)"),
      domain_tag: z.number().int().optional().describe("OSPF domain tag (MPLS VPN PE-CE OSPF)"),
      use_dn: z.boolean().optional().describe("Use/ignore DN bit on OSPF routes (MPLS VPN)"),
      mpls_te_area: z.string().optional().describe("Area used for MPLS traffic engineering"),
      mpls_te_address: z.string().optional().describe("Router address advertised for MPLS TE"),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating OSPF instance: ${a.name}`);
      const base = `/routing ospf instance set [find name="${a.name}"]`;
      const cmd = new Cmd(base)
        .opt("router-id", a.router_id)
        .opt("redistribute", a.redistribute)
        .opt("in-filter-chain", a.in_filter_chain)
        .opt("out-filter-chain", a.out_filter_chain)
        .opt("originate-default", a.originate_default)
        .opt("domain-id", a.domain_id)
        .opt("domain-tag", a.domain_tag)
        .opt("mpls-te-area", a.mpls_te_area)
        .opt("mpls-te-address", a.mpls_te_address);
      if (a.use_dn !== undefined) cmd.bool("use-dn", a.use_dn);
      if (a.comment !== undefined) cmd.set("comment", a.comment);
      if (a.disabled !== undefined) cmd.bool("disabled", a.disabled);

      const built = cmd.build();
      if (built === base) return "No updates specified.";

      const result = await executeMikrotikCommand(built, ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to update OSPF instance: ${result}`;
      const details = await executeMikrotikCommand(
        `/routing ospf instance print detail where name="${a.name}"`,
        ctx,
      );
      return `OSPF instance '${a.name}' updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_ospf_instance",
    title: "Remove OSPF Instance",
    annotations: DESTRUCTIVE,
    description:
      "Remove an OSPF instance by name (`/routing ospf instance remove`) — permanently stops the named OSPF process. " +
      "Use list_ospf_instances to find the instance name. " +
      "Remove dependent areas (remove_ospf_area), area ranges (remove_ospf_area_range), and interface templates " +
      "(remove_ospf_interface_template) first to avoid orphaned config or removal errors. " +
      "Irreversible — all OSPF adjacencies for that process will drop immediately. " +
      "For a non-destructive pause use update_ospf_instance with disabled=true.",
    inputSchema: { name: z.string().describe("OSPF instance name to remove") },
    async handler(a, ctx) {
      ctx.info(`Removing OSPF instance: ${a.name}`);
      const result = await executeMikrotikCommand(
        `/routing ospf instance remove [find name="${a.name}"]`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to remove OSPF instance: ${result}`;
      return `OSPF instance '${a.name}' removed successfully.`;
    },
  }),

  // ── Areas ─────────────────────────────────────────────────────────────────
  defineTool({
    name: "list_ospf_areas",
    title: "List OSPF Areas",
    annotations: READ,
    description:
      "List all OSPF areas (`/routing ospf area`) — areas group links within an OSPF instance and control " +
      "LSA flooding scope; `type` is default (normal), stub, or nssa; area-id 0.0.0.0 is the backbone. " +
      "Use this to verify area membership before adding area ranges or interface templates. " +
      "For prefix summarisation use list_ospf_area_ranges; for adjacency health use list_ospf_neighbors. " +
      "Returns full detail for every area including its instance and type.",
    async handler(_a, ctx) {
      ctx.info("Listing OSPF areas");
      const result = await executeMikrotikCommand("/routing ospf area print detail", ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result) ? "No OSPF areas found." : `OSPF AREAS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "add_ospf_area",
    title: "Add OSPF Area",
    annotations: WRITE,
    description:
      "Create an OSPF area (`/routing ospf area add`) within a named instance — area-id must be in IPv4 " +
      "dotted notation (backbone = '0.0.0.0'). `type` controls LSA flooding: default (normal), stub (no external " +
      "LSAs), or nssa (allow external redistribution via NSSA LSAs). `no_summaries=true` makes a totally-stubby " +
      "or totally-NSSA area by blocking summary LSAs. " +
      "Requires the instance to already exist (add_ospf_instance). " +
      "After adding an area, bind interfaces to it with add_ospf_interface_template. " +
      "Returns a success confirmation.",
    inputSchema: {
      name: z.string().describe("Unique area name"),
      area_id: z.string().describe('Area id in IPv4 notation, e.g. "0.0.0.0" for backbone'),
      instance: z.string().describe("OSPF instance name this area belongs to"),
      type: z.enum(["default", "stub", "nssa"]).optional(),
      no_summaries: z
        .boolean()
        .optional()
        .describe("Make a totally-stubby/NSSA area (block summary LSAs)"),
      default_cost: z
        .number()
        .int()
        .optional()
        .describe("Cost of the default route an ABR injects into a stub/NSSA area"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding OSPF area: ${a.name}`);
      const cmd = new Cmd("/routing ospf area add")
        .set("name", a.name)
        .set("area-id", a.area_id)
        .set("instance", a.instance)
        .opt("type", a.type)
        .opt("default-cost", a.default_cost);
      if (a.no_summaries !== undefined) cmd.bool("no-summaries", a.no_summaries);
      cmd.opt("comment", a.comment).flag("disabled", a.disabled);

      const result = await executeMikrotikCommand(cmd.build(), ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to add OSPF area: ${result}`;
      return `OSPF area '${a.name}' added successfully.`;
    },
  }),

  defineTool({
    name: "remove_ospf_area",
    title: "Remove OSPF Area",
    annotations: DESTRUCTIVE,
    description:
      "Remove an OSPF area by name (`/routing ospf area remove`) — permanently deletes the area and its " +
      "association with the instance. Use list_ospf_areas to find the area name. " +
      "Remove any area ranges (remove_ospf_area_range) and interface templates (remove_ospf_interface_template) " +
      "that reference this area first to avoid orphaned config or removal errors.",
    inputSchema: { name: z.string().describe("OSPF area name to remove") },
    async handler(a, ctx) {
      ctx.info(`Removing OSPF area: ${a.name}`);
      const result = await executeMikrotikCommand(
        `/routing ospf area remove [find name="${a.name}"]`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to remove OSPF area: ${result}`;
      return `OSPF area '${a.name}' removed successfully.`;
    },
  }),

  // ── Area ranges (summarisation) ───────────────────────────────────────────
  defineTool({
    name: "list_ospf_area_ranges",
    title: "List OSPF Area Ranges",
    annotations: READ,
    description:
      "List OSPF area summarisation ranges (`/routing ospf area range`) — aggregate prefixes that an ABR " +
      "(area border router) advertises to condense intra-area routes into fewer inter-area Type-3 LSAs. " +
      "Use this to verify summarisation config before adding or removing ranges. " +
      "For the areas themselves use list_ospf_areas. " +
      "Returns full detail including prefix, area, cost, and advertise flag.",
    async handler(_a, ctx) {
      ctx.info("Listing OSPF area ranges");
      const result = await executeMikrotikCommand("/routing ospf area range print detail", ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result) ? "No OSPF area ranges found." : `OSPF AREA RANGES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "add_ospf_area_range",
    title: "Add OSPF Area Range",
    annotations: WRITE,
    description:
      "Add an OSPF area summarisation range (`/routing ospf area range add`) to a named area — the ABR will " +
      "aggregate matching intra-area prefixes into a single Type-3 LSA advertised to other areas. " +
      "`advertise=false` suppresses the summary entirely (null-routes the aggregate). " +
      "`cost` overrides the auto-computed metric. Area must already exist (add_ospf_area). " +
      "`prefix` is the aggregate prefix, e.g. '10.10.0.0/16'. " +
      "Use list_ospf_area_ranges to verify after creation. Returns a success confirmation.",
    inputSchema: {
      area: z.string().describe("OSPF area name"),
      prefix: z.string().describe('Aggregate prefix, e.g. "10.10.0.0/16"'),
      advertise: z.boolean().default(true).describe("Advertise the summary (false suppresses it)"),
      cost: z.number().int().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Adding OSPF area range ${a.prefix} to ${a.area}`);
      const cmd = new Cmd("/routing ospf area range add")
        .set("area", a.area)
        .set("prefix", a.prefix)
        .bool("advertise", a.advertise)
        .opt("cost", a.cost)
        .opt("comment", a.comment);
      if (a.disabled !== undefined) cmd.flag("disabled", a.disabled);

      const result = await executeMikrotikCommand(cmd.build(), ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to add OSPF area range: ${result}`;
      return `OSPF area range '${a.prefix}' added to area '${a.area}'.`;
    },
  }),

  defineTool({
    name: "remove_ospf_area_range",
    title: "Remove OSPF Area Range",
    annotations: DESTRUCTIVE,
    description:
      "Remove an OSPF area summarisation range (`/routing ospf area range remove`) by its `.id` — " +
      "use list_ospf_area_ranges to obtain the id (e.g. '*1'). " +
      "The ABR will revert to advertising individual intra-area prefixes instead of the aggregate.",
    inputSchema: { range_id: z.string().describe('Range id, e.g. "*1"') },
    async handler(a, ctx) {
      ctx.info(`Removing OSPF area range ${a.range_id}`);
      const result = await executeMikrotikCommand(
        `/routing ospf area range remove ${a.range_id}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to remove OSPF area range: ${result}`;
      return `OSPF area range '${a.range_id}' removed successfully.`;
    },
  }),

  // ── Interface templates ───────────────────────────────────────────────────
  defineTool({
    name: "list_ospf_interface_templates",
    title: "List OSPF Interface Templates",
    annotations: READ,
    description:
      "List OSPF interface templates (`/routing ospf interface-template`) — templates bind interfaces or network " +
      "prefixes to an area and set per-link OSPF parameters (cost, type, timers, authentication, passive). " +
      "This is the RouterOS v7 mechanism that activates OSPF on interfaces; there is no per-interface sub-menu. " +
      "Use this before adding or removing templates. " +
      "For area membership use list_ospf_areas; for active adjacencies use list_ospf_neighbors. " +
      "Returns full detail for every template including its area, interfaces/networks, and auth settings.",
    async handler(_a, ctx) {
      ctx.info("Listing OSPF interface templates");
      const result = await executeMikrotikCommand(
        "/routing ospf interface-template print detail",
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result)
        ? "No OSPF interface templates found."
        : `OSPF INTERFACE TEMPLATES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "add_ospf_interface_template",
    title: "Add OSPF Interface Template",
    annotations: WRITE,
    description:
      "Bind interfaces or network prefixes to an OSPF area (`/routing ospf interface-template add`). " +
      "Match links via `interfaces` (interface or interface-list name) and/or `networks` (prefix, " +
      "e.g. '10.0.0.0/24'). `type` sets the link model: broadcast (LAN), ptp (point-to-point), " +
      "ptp-unnumbered (point-to-point over an unnumbered link), ptmp, ptmp-broadcast, nbma, or " +
      "virtual-link. `passive=true` advertises the subnet without forming OSPF adjacencies " +
      "(for stub networks). `auth`/`auth_id`/`auth_key` enable per-interface authentication; `hello_interval` " +
      "e.g. '10s', `dead_interval` e.g. '40s'. " +
      "Requires the area to already exist (add_ospf_area). " +
      "Returns the new template id (e.g. '*2') if RouterOS echoes one; use list_ospf_interface_templates to verify.",
    inputSchema: {
      area: z.string().describe("OSPF area name to attach matched interfaces to"),
      interfaces: z.string().optional().describe("Interface or interface-list name"),
      networks: z
        .string()
        .optional()
        .describe('Network prefix(es) to enable OSPF on, e.g. "10.0.0.0/24"'),
      cost: z.number().int().optional().describe("Output cost / metric"),
      priority: z.number().int().optional().describe("DR election priority (0 = never DR)"),
      type: z
        .enum([
          "broadcast",
          "ptp",
          "ptp-unnumbered",
          "ptmp",
          "ptmp-broadcast",
          "nbma",
          "virtual-link",
        ])
        .optional(),
      passive: z.boolean().optional(),
      hello_interval: z.string().optional().describe('e.g. "10s"'),
      dead_interval: z.string().optional().describe('e.g. "40s"'),
      retransmit_interval: z
        .string()
        .optional()
        .describe('Interval between LSA retransmissions, e.g. "5s"'),
      transmit_delay: z.string().optional().describe('Estimated LSA transmit delay, e.g. "1s"'),
      instance_id: z
        .number()
        .int()
        .optional()
        .describe("OSPF instance-id carried in hello packets"),
      prefix_list: z
        .string()
        .optional()
        .describe("Prefix-list name filtering which connected networks are advertised"),
      vlink_neighbor_id: z
        .string()
        .optional()
        .describe("Virtual-link remote router-id (type=virtual-link)"),
      vlink_transit_area: z
        .string()
        .optional()
        .describe("Transit area the virtual-link traverses (type=virtual-link)"),
      auth: z.enum(["simple", "md5", "sha1", "sha256", "sha384", "sha512"]).optional(),
      auth_id: z.number().int().optional().describe("Key id for keyed authentication"),
      auth_key: z.string().optional().describe("Authentication key/password"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding OSPF interface template for area ${a.area}`);
      const cmd = new Cmd("/routing ospf interface-template add")
        .set("area", a.area)
        .opt("interfaces", a.interfaces)
        .opt("networks", a.networks)
        .opt("cost", a.cost)
        .opt("priority", a.priority)
        .opt("type", a.type)
        .opt("hello-interval", a.hello_interval)
        .opt("dead-interval", a.dead_interval)
        .opt("retransmit-interval", a.retransmit_interval)
        .opt("transmit-delay", a.transmit_delay)
        .opt("instance-id", a.instance_id)
        .opt("prefix-list", a.prefix_list)
        .opt("vlink-neighbor-id", a.vlink_neighbor_id)
        .opt("vlink-transit-area", a.vlink_transit_area)
        .opt("auth", a.auth)
        .opt("auth-id", a.auth_id)
        .opt("auth-key", a.auth_key)
        .opt("comment", a.comment);
      if (a.passive !== undefined) cmd.bool("passive", a.passive);
      cmd.flag("disabled", a.disabled);

      const result = await executeMikrotikCommand(cmd.build(), ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to add OSPF interface template: ${result}`;
      const t = result.trim();
      return t
        ? `OSPF interface template added (id ${t}).`
        : "OSPF interface template added successfully.";
    },
  }),

  defineTool({
    name: "remove_ospf_interface_template",
    title: "Remove OSPF Interface Template",
    annotations: DESTRUCTIVE,
    description:
      "Remove an OSPF interface template (`/routing ospf interface-template remove`) by its `.id` — " +
      "use list_ospf_interface_templates to obtain the id (e.g. '*2'). " +
      "Removing a template stops OSPF on all matched interfaces; existing adjacencies will drop immediately.",
    inputSchema: { template_id: z.string().describe('Template id, e.g. "*2"') },
    async handler(a, ctx) {
      ctx.info(`Removing OSPF interface template ${a.template_id}`);
      const result = await executeMikrotikCommand(
        `/routing ospf interface-template remove ${a.template_id}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      if (looksLikeError(result)) return `Failed to remove OSPF interface template: ${result}`;
      return `OSPF interface template '${a.template_id}' removed successfully.`;
    },
  }),

  // ── Neighbors & LSAs (read-only) ──────────────────────────────────────────
  defineTool({
    name: "list_ospf_neighbors",
    title: "List OSPF Neighbors",
    annotations: READ,
    description:
      "List active OSPF adjacencies (`/routing ospf neighbor`) — shows each neighbor's router-id, address, " +
      "interface, instance, area, and adjacency state (Full/2-Way/ExStart/Exchange/Loading/…). " +
      "Read-only — the primary health check for confirming OSPF is forming Full adjacencies. " +
      "For the link-state database use list_ospf_lsa; for per-interface config use list_ospf_interface_templates. " +
      "Returns full detail for every discovered neighbor.",
    async handler(_a, ctx) {
      ctx.info("Listing OSPF neighbors");
      const result = await executeMikrotikCommand("/routing ospf neighbor print detail", ctx);
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result) ? "No OSPF neighbors found." : `OSPF NEIGHBORS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "list_ospf_lsa",
    title: "List OSPF LSAs",
    annotations: READ,
    description:
      "List the OSPF link-state database (`/routing ospf lsa`) — every LSA the router holds, by type " +
      "(Router/Network/Summary/ASBR-Summary/External/NSSA/…), area, and originating router-id. " +
      "Read-only — used to inspect topology, verify summarisation (Type-3 LSAs), confirm external " +
      "redistribution (Type-5/Type-7), and diagnose flooding or database synchronisation problems. " +
      "Filter to a single area with `area_filter`. " +
      "For adjacency state use list_ospf_neighbors; for instance/area config use list_ospf_instances.",
    inputSchema: {
      area_filter: z.string().optional().describe("Show only LSAs for this area"),
    },
    async handler(a, ctx) {
      ctx.info("Listing OSPF LSAs");
      const filters: string[] = [];
      if (a.area_filter) filters.push(`area="${a.area_filter}"`);
      const result = await executeMikrotikCommand(
        `/routing ospf lsa print${whereClause(filters)}`,
        ctx,
      );
      if (commandUnsupported(result)) return UNSUPPORTED;
      return isEmpty(result) ? "OSPF link-state database is empty." : `OSPF LSAs:\n\n${result}`;
    },
  }),
];
