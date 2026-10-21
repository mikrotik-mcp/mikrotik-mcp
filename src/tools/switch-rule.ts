/** Switch chip ACL/redirect rules — `/interface ethernet switch rule`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, quoteValue, looksLikeError, isEmpty, Cmd } from "../core/routeros";
import type { ToolContext } from "../core/context";
import { executeRuleCreate, readCreatedRule } from "./_create-rule";

interface SwitchRuleArgs {
  rule_id?: string;
  switch?: string;
  ports?: string;
  src_address?: string;
  dst_address?: string;
  src_address6?: string;
  dst_address6?: string;
  src_mac_address?: string;
  dst_mac_address?: string;
  src_port?: string;
  dst_port?: string;
  protocol?: string;
  mac_protocol?: string;
  vlan_header?: string;
  vlan_id?: string;
  vlan_priority?: string;
  dscp?: string;
  flow_label?: string;
  new_dst_ports?: string;
  new_vlan_id?: string;
  new_vlan_priority?: string;
  redirect_to_cpu?: boolean;
  copy_to_cpu?: boolean;
  mirror?: boolean;
  rate?: string;
  comment?: string;
  disabled?: boolean;
}

async function updateSwitchRule(
  a: SwitchRuleArgs & { rule_id: string },
  ctx: ToolContext,
): Promise<string> {
  ctx.info(`Updating switch rule: rule_id=${a.rule_id}`);

  const updates: string[] = [];
  const put = (key: string, val: string | undefined): void => {
    if (val === undefined) return;
    updates.push(val === "" ? `!${key}` : `${key}=${quoteValue(val)}`);
  };
  const putBool = (key: string, val: boolean | undefined): void => {
    if (val !== undefined) updates.push(`${key}=${val ? "yes" : "no"}`);
  };

  if (a.switch) updates.push(`switch=${quoteValue(a.switch)}`);
  put("ports", a.ports);
  put("src-address", a.src_address);
  put("dst-address", a.dst_address);
  put("src-address6", a.src_address6);
  put("dst-address6", a.dst_address6);
  put("src-mac-address", a.src_mac_address);
  put("dst-mac-address", a.dst_mac_address);
  put("src-port", a.src_port);
  put("dst-port", a.dst_port);
  put("protocol", a.protocol);
  put("mac-protocol", a.mac_protocol);
  put("vlan-header", a.vlan_header);
  put("vlan-id", a.vlan_id);
  put("vlan-priority", a.vlan_priority);
  put("dscp", a.dscp);
  put("flow-label", a.flow_label);
  put("new-dst-ports", a.new_dst_ports);
  put("new-vlan-id", a.new_vlan_id);
  put("new-vlan-priority", a.new_vlan_priority);
  putBool("redirect-to-cpu", a.redirect_to_cpu);
  putBool("copy-to-cpu", a.copy_to_cpu);
  putBool("mirror", a.mirror);
  put("rate", a.rate);
  if (a.comment !== undefined) updates.push(`comment=${quoteValue(a.comment)}`);
  putBool("disabled", a.disabled);

  if (updates.length === 0) return "No updates specified.";

  const cmd = `/interface ethernet switch rule set ${a.rule_id} ${updates.join(" ")}`;
  const result = await executeMikrotikCommand(cmd, ctx);
  if (looksLikeError(result)) return `Failed to update switch rule: ${result}`;

  const details = await executeMikrotikCommand(
    `/interface ethernet switch rule print detail where .id=${a.rule_id}`,
    ctx,
  );
  return `Switch rule updated successfully:\n\n${details}`;
}

export const switchRuleTools: ToolModule = [
  defineTool({
    name: "add_switch_rule",
    title: "Add Switch Chip ACL Rule",
    annotations: WRITE,
    description:
      "Creates a hardware switch ACL/redirect rule (`/interface ethernet switch rule add`) " +
      "on the built-in switch chip. Use this to match traffic in hardware at Layer 2/3 on " +
      "specified source ports and redirect, rate-limit, mirror, or drop it without CPU involvement. " +
      "This is NOT a software firewall rule — for software packet filtering use create_filter_rule, " +
      "for address translation use create_nat_rule. Returns the created rule's detail including its `.id`.\n\n" +
      "Arguments:\n" +
      "    switch: the switch chip the rule belongs to, e.g. 'switch1'.\n" +
      "    ports: comma-separated source switch ports the rule matches on, e.g. 'ether1,ether2'.\n" +
      "    new_dst_ports: redirect matched traffic to these ports (non-empty string; omit to leave unset).\n" +
      "    redirect_to_cpu / copy_to_cpu / mirror: divert exclusively, duplicate, or span\n" +
      "        matched traffic to CPU.\n" +
      "    rate: rate limit in bits/second.\n" +
      "    mac_protocol: e.g. 'ip', 'arp', 'vlan', or an EtherType number.",
    inputSchema: {
      switch: z.string().describe("Owning switch chip, e.g. 'switch1'"),
      ports: z.string().describe("Comma-separated source ports the rule matches"),
      src_address: z.string().optional().describe("Source IP/mask"),
      dst_address: z.string().optional().describe("Destination IP/mask"),
      src_address6: z.string().optional().describe("Source IPv6 address/mask"),
      dst_address6: z.string().optional().describe("Destination IPv6 address/mask"),
      src_mac_address: z.string().optional().describe("Source MAC/mask"),
      dst_mac_address: z.string().optional().describe("Destination MAC/mask"),
      src_port: z.string().optional().describe("Layer-4 source port(s)"),
      dst_port: z.string().optional().describe("Layer-4 destination port(s)"),
      protocol: z.string().optional().describe("IP protocol, e.g. 'tcp'"),
      mac_protocol: z
        .string()
        .optional()
        .describe("MAC protocol, e.g. 'ip', 'arp', 'vlan' or a number"),
      vlan_header: z
        .enum(["any", "not-present", "present"])
        .optional()
        .describe("Match on VLAN tag presence"),
      vlan_id: z.string().optional(),
      vlan_priority: z.string().optional(),
      dscp: z.string().optional(),
      flow_label: z.string().optional().describe("IPv6 flow label"),
      new_dst_ports: z
        .string()
        .optional()
        .describe("Redirect target ports; empty string drops the traffic"),
      new_vlan_id: z.string().optional(),
      new_vlan_priority: z.string().optional(),
      redirect_to_cpu: z.boolean().optional(),
      copy_to_cpu: z.boolean().optional(),
      mirror: z.boolean().optional(),
      rate: z.string().optional().describe("Rate limit in bits/second"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Adding switch rule: switch=${a.switch}, ports=${a.ports}`);
      const cmd = new Cmd("/interface ethernet switch rule add")
        .set("switch", a.switch)
        .set("ports", a.ports)
        .opt("src-address", a.src_address)
        .opt("dst-address", a.dst_address)
        .opt("src-address6", a.src_address6)
        .opt("dst-address6", a.dst_address6)
        .opt("src-mac-address", a.src_mac_address)
        .opt("dst-mac-address", a.dst_mac_address)
        .opt("src-port", a.src_port)
        .opt("dst-port", a.dst_port)
        .opt("protocol", a.protocol)
        .opt("mac-protocol", a.mac_protocol)
        .opt("vlan-header", a.vlan_header)
        .opt("vlan-id", a.vlan_id)
        .opt("vlan-priority", a.vlan_priority)
        .opt("dscp", a.dscp)
        .opt("flow-label", a.flow_label)
        .opt("new-dst-ports", a.new_dst_ports)
        .opt("new-vlan-id", a.new_vlan_id)
        .opt("new-vlan-priority", a.new_vlan_priority)
        .bool("redirect-to-cpu", a.redirect_to_cpu)
        .bool("copy-to-cpu", a.copy_to_cpu)
        .bool("mirror", a.mirror)
        .opt("rate", a.rate)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled);

      const result = await executeRuleCreate("/interface ethernet switch rule", cmd, ctx);

      const trimmed = result.trim();

      if (looksLikeError(trimmed)) {
        return `Failed to add switch rule: ${trimmed}`;
      }

      return readCreatedRule("/interface ethernet switch rule", trimmed, "Switch rule", ctx);
    },
  }),

  defineTool({
    name: "list_switch_rules",
    title: "List Switch Chip ACL Rules",
    annotations: READ,
    description:
      "Lists all hardware switch ACL/redirect rules (`/interface ethernet switch rule print`) " +
      "on the switch chip. Use this to audit or discover existing rules before adding or updating. " +
      "Optional filters narrow by switch chip name, port name substring, or disabled-only status. " +
      "For software firewall rules use list_filter_rules; for NAT rules use list_nat_rules. " +
      "Returns a formatted table of all matching rules including their `.id` values needed by " +
      "get_switch_rule, update_switch_rule, remove_switch_rule, enable_switch_rule, and disable_switch_rule.",
    inputSchema: {
      switch_filter: z.string().optional(),
      ports_filter: z.string().optional(),
      disabled_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info("Listing switch rules");
      const filters: string[] = [];
      if (a.switch_filter) filters.push(`switch="${a.switch_filter}"`);
      if (a.ports_filter) filters.push(`ports~"${a.ports_filter}"`);
      if (a.disabled_only) filters.push("disabled=yes");

      const result = await executeMikrotikCommand(
        `/interface ethernet switch rule print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No switch rules found matching the criteria."
        : `SWITCH RULES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_switch_rule",
    title: "Get Switch Chip ACL Rule Detail",
    annotations: READ,
    description:
      "Fetches full detail of a single hardware switch ACL/redirect rule " +
      "(`/interface ethernet switch rule print detail where .id=…`). " +
      "Use this to inspect all match criteria and action fields of one rule. " +
      "`rule_id` takes the `.id` from list_switch_rules (e.g. '*1'). " +
      "For a tabular overview of all rules use list_switch_rules; " +
      "for software firewall rule detail use get_filter_rule.",
    inputSchema: {
      rule_id: z.string().describe("RouterOS '.id', e.g. '*1' or '0'"),
    },
    async handler(a, ctx) {
      ctx.info(`Getting switch rule: rule_id=${a.rule_id}`);
      const result = await executeMikrotikCommand(
        `/interface ethernet switch rule print detail where .id=${a.rule_id}`,
        ctx,
      );
      return isEmpty(result)
        ? `Switch rule '${a.rule_id}' not found.`
        : `SWITCH RULE DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_switch_rule",
    title: "Update Switch Chip ACL Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modifies an existing hardware switch ACL/redirect rule " +
      "(`/interface ethernet switch rule set`) by `.id`. " +
      "Use this to change match criteria (ports, addresses, VLAN, protocol) or actions " +
      "(redirect target ports, mirror, rate limit, disabled state). " +
      'Pass an empty string ("") for any optional field to clear it. ' +
      "`rule_id` takes the `.id` from list_switch_rules. Returns the updated rule's full detail. " +
      "For software firewall rule edits use update_filter_rule; " +
      "to only toggle the enabled state use enable_switch_rule or disable_switch_rule.",
    inputSchema: {
      rule_id: z.string(),
      switch: z.string().optional(),
      ports: z.string().optional(),
      src_address: z.string().optional(),
      dst_address: z.string().optional(),
      src_address6: z.string().optional(),
      dst_address6: z.string().optional(),
      src_mac_address: z.string().optional(),
      dst_mac_address: z.string().optional(),
      src_port: z.string().optional(),
      dst_port: z.string().optional(),
      protocol: z.string().optional(),
      mac_protocol: z.string().optional(),
      vlan_header: z.enum(["any", "not-present", "present"]).optional(),
      vlan_id: z.string().optional(),
      vlan_priority: z.string().optional(),
      dscp: z.string().optional(),
      flow_label: z.string().optional(),
      new_dst_ports: z.string().optional(),
      new_vlan_id: z.string().optional(),
      new_vlan_priority: z.string().optional(),
      redirect_to_cpu: z.boolean().optional(),
      copy_to_cpu: z.boolean().optional(),
      mirror: z.boolean().optional(),
      rate: z.string().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      return updateSwitchRule(a, ctx);
    },
  }),

  defineTool({
    name: "remove_switch_rule",
    title: "Remove Switch Chip ACL Rule",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes a hardware switch ACL/redirect rule " +
      "(`/interface ethernet switch rule remove`) by `.id`. " +
      "Performs an existence check first and returns an error if the rule is not found. " +
      "`rule_id` takes the `.id` from list_switch_rules (e.g. '*1'). " +
      "To keep the rule but stop it from matching use disable_switch_rule instead. " +
      "For removing software firewall rules use remove_filter_rule.",
    inputSchema: { rule_id: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing switch rule: rule_id=${a.rule_id}`);
      const count = await executeMikrotikCommand(
        `/interface ethernet switch rule print count-only where .id=${a.rule_id}`,
        ctx,
      );
      if (count.trim() === "0") return `Switch rule '${a.rule_id}' not found.`;

      const result = await executeMikrotikCommand(
        `/interface ethernet switch rule remove ${a.rule_id}`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove switch rule: ${result}`;
      return `Switch rule '${a.rule_id}' removed successfully.`;
    },
  }),

  defineTool({
    name: "enable_switch_rule",
    title: "Enable Switch Chip ACL Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Re-enables a previously disabled hardware switch ACL/redirect rule " +
      "(`/interface ethernet switch rule set … disabled=no`). " +
      "Use this to activate a rule without recreating it. " +
      "`rule_id` takes the `.id` from list_switch_rules (e.g. '*1'). " +
      "To deactivate a rule without deleting it use disable_switch_rule; " +
      "to permanently delete use remove_switch_rule. Returns the updated rule's full detail.",
    inputSchema: { rule_id: z.string() },
    async handler(a, ctx) {
      return updateSwitchRule({ rule_id: a.rule_id, disabled: false }, ctx);
    },
  }),

  defineTool({
    name: "disable_switch_rule",
    title: "Disable Switch Chip ACL Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Deactivates a hardware switch ACL/redirect rule without deleting it " +
      "(`/interface ethernet switch rule set … disabled=yes`). " +
      "Use this to temporarily suspend a rule's match/action while preserving its configuration. " +
      "`rule_id` takes the `.id` from list_switch_rules (e.g. '*1'). " +
      "To reactivate the rule use enable_switch_rule; to permanently delete use remove_switch_rule. " +
      "Returns the updated rule's full detail.",
    inputSchema: { rule_id: z.string() },
    async handler(a, ctx) {
      return updateSwitchRule({ rule_id: a.rule_id, disabled: true }, ctx);
    },
  }),
];
