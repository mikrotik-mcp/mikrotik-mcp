/** IPv6 firewall raw rules — `/ipv6 firewall raw`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, quoteValue, looksLikeError, isEmpty, Cmd } from "../core/routeros";
import type { ToolContext } from "../core/context";
import { ruleResolver } from "./_resolve-rule-id";
import { executeRuleCreate, readCreatedRule } from "./_create-rule";

const resolveRuleId = ruleResolver("/ipv6 firewall raw");

async function updateRawRule(
  a: {
    rule_id: string;
    chain?: string;
    action?: string;
    src_address?: string;
    dst_address?: string;
    src_port?: string;
    dst_port?: string;
    port?: string;
    protocol?: string;
    in_interface?: string;
    out_interface?: string;
    in_interface_list?: string;
    out_interface_list?: string;
    src_address_list?: string;
    dst_address_list?: string;
    src_address_type?: string;
    dst_address_type?: string;
    src_mac_address?: string;
    hop_limit?: string;
    tcp_flags?: string;
    tcp_mss?: string;
    packet_size?: string;
    dscp?: string;
    ipsec_policy?: string;
    limit?: string;
    comment?: string;
    disabled?: boolean;
    log?: boolean;
    log_prefix?: string;
  },
  ctx: ToolContext,
): Promise<string> {
  ctx.info(`Updating IPv6 firewall raw rule: rule_id=${a.rule_id}`);

  const updates: string[] = [];
  const put = (key: string, val: string | undefined): void => {
    if (val === undefined) return;
    updates.push(val === "" ? `!${key}` : `${key}=${quoteValue(val)}`);
  };

  if (a.chain) updates.push(`chain=${a.chain}`);
  if (a.action) updates.push(`action=${a.action}`);
  put("src-address", a.src_address);
  put("dst-address", a.dst_address);
  put("src-port", a.src_port);
  put("dst-port", a.dst_port);
  put("port", a.port);
  put("protocol", a.protocol);
  put("in-interface", a.in_interface);
  put("out-interface", a.out_interface);
  put("in-interface-list", a.in_interface_list);
  put("out-interface-list", a.out_interface_list);
  put("src-address-list", a.src_address_list);
  put("dst-address-list", a.dst_address_list);
  put("src-address-type", a.src_address_type);
  put("dst-address-type", a.dst_address_type);
  put("src-mac-address", a.src_mac_address);
  put("hop-limit", a.hop_limit);
  put("tcp-flags", a.tcp_flags);
  put("tcp-mss", a.tcp_mss);
  put("packet-size", a.packet_size);
  put("dscp", a.dscp);
  put("ipsec-policy", a.ipsec_policy);
  put("limit", a.limit);
  if (a.comment !== undefined) updates.push(`comment=${quoteValue(a.comment)}`);
  if (a.disabled !== undefined) updates.push(`disabled=${a.disabled ? "yes" : "no"}`);
  if (a.log !== undefined) {
    updates.push(`log=${a.log ? "yes" : "no"}`);
    if (a.log && a.log_prefix) updates.push(`log-prefix=${quoteValue(a.log_prefix)}`);
  }

  if (updates.length === 0) return "No updates specified.";

  const id = await resolveRuleId(a.rule_id, ctx);
  if (!id) return `IPv6 raw rule '${a.rule_id}' not found.`;

  const cmd = `/ipv6 firewall raw set ${id} ${updates.join(" ")}`;
  const result = await executeMikrotikCommand(cmd, ctx);
  if (looksLikeError(result)) return `Failed to update IPv6 firewall raw rule: ${result}`;

  const details = await executeMikrotikCommand(
    `/ipv6 firewall raw print detail where .id=${id}`,
    ctx,
  );
  return `IPv6 firewall raw rule updated successfully:\n\n${details}`;
}

export const ipv6FirewallRawTools: ToolModule = [
  defineTool({
    name: "create_ipv6_raw_rule",
    title: "Create IPv6 Firewall Raw Rule",
    annotations: WRITE,
    description:
      "Creates an IPv6 raw rule (`/ipv6 firewall raw`) — the pre-connection-tracking table " +
      "for IPv6 traffic. Use to cheaply drop packets before the state machine runs (action=drop) " +
      "or to exempt traffic from connection tracking (action=notrack). " +
      "chain: 'prerouting' (all arriving IPv6 traffic) or 'output' (locally generated IPv6 traffic). " +
      "For IPv6 accept/drop based on state use create_ipv6_filter_rule; " +
      "for IPv6 packet marking use create_ipv6_mangle_rule; for IPv6 address translation use create_ipv6_nat_rule. " +
      "place_before accepts a rule number or ID (*N) to control insertion point. " +
      "Returns the created rule's details including its .id.",
    inputSchema: {
      chain: z.enum(["prerouting", "output"]),
      action: z.enum(["accept", "drop", "notrack", "jump", "log", "passthrough", "return"]),
      src_address: z.string().optional(),
      dst_address: z.string().optional(),
      src_port: z.string().optional(),
      dst_port: z.string().optional(),
      port: z.string().optional().describe("Match src or dst port (any direction)"),
      protocol: z.string().optional(),
      in_interface: z.string().optional(),
      out_interface: z.string().optional(),
      in_interface_list: z.string().optional().describe("Match inbound interface list name"),
      out_interface_list: z.string().optional().describe("Match outbound interface list name"),
      src_address_list: z.string().optional(),
      dst_address_list: z.string().optional(),
      src_address_type: z
        .string()
        .optional()
        .describe('Source address type e.g. "unicast", "local", "multicast"'),
      dst_address_type: z
        .string()
        .optional()
        .describe('Destination address type e.g. "unicast", "local", "multicast"'),
      src_mac_address: z.string().optional().describe("Match source MAC address"),
      hop_limit: z.string().optional().describe('Hop-limit expression e.g. "equal:1" or "less:64"'),
      tcp_flags: z.string().optional().describe('TCP flag expression e.g. "syn,!ack"'),
      tcp_mss: z.string().optional().describe('TCP MSS value or range e.g. "1400-1500"'),
      packet_size: z.string().optional().describe('Packet size or range in bytes e.g. "0-500"'),
      dscp: z.string().optional().describe("DSCP value 0-63"),
      ipsec_policy: z
        .string()
        .optional()
        .describe('IPsec policy match e.g. "in,ipsec" or "out,none"'),
      limit: z.string().optional().describe('Rate/burst string e.g. "10,5:packet"'),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
      log: z.boolean().default(false),
      log_prefix: z.string().optional(),
      place_before: z.string().optional().describe("Rule number or ID (*N) to insert before"),
    },
    async handler(a, ctx) {
      ctx.info(`Creating IPv6 firewall raw rule: chain=${a.chain}, action=${a.action}`);

      const cmd = new Cmd("/ipv6 firewall raw add")
        .set("chain", a.chain)
        .set("action", a.action)
        .opt("src-address", a.src_address)
        .opt("dst-address", a.dst_address)
        .opt("src-port", a.src_port)
        .opt("dst-port", a.dst_port)
        .opt("port", a.port)
        .opt("protocol", a.protocol)
        .opt("in-interface", a.in_interface)
        .opt("out-interface", a.out_interface)
        .opt("in-interface-list", a.in_interface_list)
        .opt("out-interface-list", a.out_interface_list)
        .opt("src-address-list", a.src_address_list)
        .opt("dst-address-list", a.dst_address_list)
        .opt("src-address-type", a.src_address_type)
        .opt("dst-address-type", a.dst_address_type)
        .opt("src-mac-address", a.src_mac_address)
        .opt("hop-limit", a.hop_limit)
        .opt("tcp-flags", a.tcp_flags)
        .opt("tcp-mss", a.tcp_mss)
        .opt("packet-size", a.packet_size)
        .opt("dscp", a.dscp)
        .opt("ipsec-policy", a.ipsec_policy)
        .opt("limit", a.limit)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .flag("log", a.log)
        .opt("log-prefix", a.log ? a.log_prefix : undefined);

      const result = await executeRuleCreate("/ipv6 firewall raw", cmd, ctx, a.place_before);

      const trimmed = result.trim();

      if (looksLikeError(trimmed)) {
        return `Failed to create IPv6 firewall raw rule: ${trimmed}`;
      }

      return readCreatedRule("/ipv6 firewall raw", trimmed, "IPv6 firewall raw rule", ctx);
    },
  }),

  defineTool({
    name: "list_ipv6_raw_rules",
    title: "List IPv6 Firewall Raw Rules",
    annotations: READ,
    description:
      "Lists IPv6 raw rules (`/ipv6 firewall raw`) — the pre-connection-tracking table for IPv6 traffic. " +
      "Use to audit which rules bypass or cheaply drop traffic before connection tracking runs. " +
      "For IPv6 filter use list_ipv6_filter_rules; " +
      "for IPv6 mangle use list_ipv6_mangle_rules; for IPv6 NAT use list_ipv6_nat_rules. " +
      "Supports optional filters: chain_filter, action_filter, src/dst address substring match, " +
      "and disabled_only/invalid_only/dynamic_only flags. " +
      "Returns all matching rules; .id values are used by get_ipv6_raw_rule, update_ipv6_raw_rule, " +
      "remove_ipv6_raw_rule, and move_ipv6_raw_rule.",
    inputSchema: {
      chain_filter: z.string().optional(),
      action_filter: z.string().optional(),
      src_address_filter: z.string().optional(),
      dst_address_filter: z.string().optional(),
      disabled_only: z.boolean().default(false),
      invalid_only: z.boolean().default(false),
      dynamic_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info("Listing IPv6 firewall raw rules");

      const filters: string[] = [];
      if (a.chain_filter) filters.push(`chain=${a.chain_filter}`);
      if (a.action_filter) filters.push(`action=${a.action_filter}`);
      if (a.src_address_filter) filters.push(`src-address~"${a.src_address_filter}"`);
      if (a.dst_address_filter) filters.push(`dst-address~"${a.dst_address_filter}"`);
      if (a.disabled_only) filters.push("disabled=yes");
      if (a.invalid_only) filters.push("invalid=yes");
      if (a.dynamic_only) filters.push("dynamic=yes");

      const result = await executeMikrotikCommand(
        `/ipv6 firewall raw print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No IPv6 firewall raw rules found matching the criteria."
        : `IPV6 FIREWALL RAW RULES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_ipv6_raw_rule",
    title: "Get IPv6 Firewall Raw Rule",
    annotations: READ,
    description:
      "Fetches full detail of a single IPv6 raw rule (`/ipv6 firewall raw print detail`) by its .id. " +
      "Use to inspect the exact match criteria, action, and flags of one specific rule. " +
      "For the full list use list_ipv6_raw_rules. " +
      "rule_id takes the .id value (e.g. '*1' or '0') from list_ipv6_raw_rules output. " +
      "Returns the complete detail block for that rule, or a not-found message if the ID is absent.",
    inputSchema: {
      rule_id: z.string().describe('Rule ID from list output e.g. "*1" or "0"'),
    },
    async handler(a, ctx) {
      ctx.info(`Getting IPv6 firewall raw rule details: rule_id=${a.rule_id}`);

      const id = await resolveRuleId(a.rule_id, ctx);
      if (!id) return `IPv6 firewall raw rule with ID '${a.rule_id}' not found.`;

      const result = await executeMikrotikCommand(
        `/ipv6 firewall raw print detail where .id=${id}`,
        ctx,
      );
      return isEmpty(result)
        ? `IPv6 firewall raw rule with ID '${a.rule_id}' not found.`
        : `IPV6 FIREWALL RAW RULE DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_ipv6_raw_rule",
    title: "Update IPv6 Firewall Raw Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modifies fields of an existing IPv6 raw rule (`/ipv6 firewall raw set`) without deleting and " +
      "recreating it. Use to change chain, action, match criteria (src/dst address, port, protocol, " +
      "interface, address list), comment, log settings, or enabled state. " +
      "To reorder a rule use move_ipv6_raw_rule; to toggle only " +
      "the enabled state use enable_ipv6_raw_rule or disable_ipv6_raw_rule. " +
      'rule_id takes the .id from list_ipv6_raw_rules. Pass "" for any optional string field to clear it. ' +
      "Returns the updated rule's full details.",
    inputSchema: {
      rule_id: z.string(),
      chain: z.string().optional(),
      action: z.string().optional(),
      src_address: z.string().optional(),
      dst_address: z.string().optional(),
      src_port: z.string().optional(),
      dst_port: z.string().optional(),
      port: z.string().optional(),
      protocol: z.string().optional(),
      in_interface: z.string().optional(),
      out_interface: z.string().optional(),
      in_interface_list: z.string().optional(),
      out_interface_list: z.string().optional(),
      src_address_list: z.string().optional(),
      dst_address_list: z.string().optional(),
      src_address_type: z.string().optional(),
      dst_address_type: z.string().optional(),
      src_mac_address: z.string().optional(),
      hop_limit: z.string().optional(),
      tcp_flags: z.string().optional(),
      tcp_mss: z.string().optional(),
      packet_size: z.string().optional(),
      dscp: z.string().optional(),
      ipsec_policy: z.string().optional(),
      limit: z.string().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
      log: z.boolean().optional(),
      log_prefix: z.string().optional(),
    },
    async handler(a, ctx) {
      return updateRawRule(a, ctx);
    },
  }),

  defineTool({
    name: "remove_ipv6_raw_rule",
    title: "Remove IPv6 Firewall Raw Rule",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes an IPv6 raw rule (`/ipv6 firewall raw remove`). " +
      "Use to discard a pre-connection-tracking rule that is no longer needed. " +
      "To temporarily suspend without deleting use disable_ipv6_raw_rule. " +
      "rule_id takes the .id from list_ipv6_raw_rules; the tool verifies existence (count-only check) " +
      "before attempting removal. Returns a success or not-found message.",
    inputSchema: { rule_id: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing IPv6 firewall raw rule: rule_id=${a.rule_id}`);

      const id = await resolveRuleId(a.rule_id, ctx);
      if (!id) return `IPv6 firewall raw rule with ID '${a.rule_id}' not found.`;

      const result = await executeMikrotikCommand(`/ipv6 firewall raw remove ${id}`, ctx);
      if (looksLikeError(result)) return `Failed to remove IPv6 firewall raw rule: ${result}`;
      return `IPv6 firewall raw rule '${a.rule_id}' (${id}) removed successfully.`;
    },
  }),

  defineTool({
    name: "move_ipv6_raw_rule",
    title: "Move IPv6 Firewall Raw Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Reorders an IPv6 raw rule to a specific position (`/ipv6 firewall raw move`). " +
      "Use to change evaluation order — rules are matched top-to-bottom within a chain, so position matters. " +
      "To reorder IPv6 filter rules use move_ipv6_filter_rule. " +
      "rule_id takes the .id from list_ipv6_raw_rules; destination is the 0-based integer target position. " +
      "Returns a confirmation message with the new position.",
    inputSchema: {
      rule_id: z.string(),
      destination: z.number().int().describe("0-based target position index"),
    },
    async handler(a, ctx) {
      ctx.info(`Moving IPv6 firewall raw rule: rule_id=${a.rule_id} to position ${a.destination}`);

      const id = await resolveRuleId(a.rule_id, ctx);
      if (!id) return `IPv6 firewall raw rule with ID '${a.rule_id}' not found.`;

      const result = await executeMikrotikCommand(
        `/ipv6 firewall raw move ${id} destination=${a.destination}`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to move IPv6 firewall raw rule: ${result}`;
      return `IPv6 firewall raw rule '${a.rule_id}' (${id}) moved to position ${a.destination}.`;
    },
  }),

  defineTool({
    name: "enable_ipv6_raw_rule",
    title: "Enable IPv6 Firewall Raw Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Enables a disabled IPv6 raw rule (`/ipv6 firewall raw set disabled=no`). " +
      "Use to activate a rule that was previously suspended without recreating it. " +
      "To disable use disable_ipv6_raw_rule; for full field edits use update_ipv6_raw_rule. " +
      "rule_id takes the .id from list_ipv6_raw_rules. Returns the updated rule's full details.",
    inputSchema: { rule_id: z.string() },
    async handler(a, ctx) {
      return updateRawRule({ rule_id: a.rule_id, disabled: false }, ctx);
    },
  }),

  defineTool({
    name: "disable_ipv6_raw_rule",
    title: "Disable IPv6 Firewall Raw Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Disables an active IPv6 raw rule (`/ipv6 firewall raw set disabled=yes`). " +
      "Use to temporarily suspend a rule without deleting it — disabled rules are skipped during chain evaluation. " +
      "To re-enable use enable_ipv6_raw_rule; for full field edits use update_ipv6_raw_rule. " +
      "rule_id takes the .id from list_ipv6_raw_rules. Returns the updated rule's full details.",
    inputSchema: { rule_id: z.string() },
    async handler(a, ctx) {
      return updateRawRule({ rule_id: a.rule_id, disabled: true }, ctx);
    },
  }),
];
