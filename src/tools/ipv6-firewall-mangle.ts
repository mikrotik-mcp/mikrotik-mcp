/** IPv6 firewall mangle rules — `/ipv6 firewall mangle`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, quoteValue, looksLikeError, isEmpty, Cmd } from "../core/routeros";
import type { ToolContext } from "../core/context";
import { ruleResolver } from "./_resolve-rule-id";
import { executeRuleCreate, readCreatedRule } from "./_create-rule";

const resolveRuleId = ruleResolver("/ipv6 firewall mangle");

async function updateMangleRule(
  a: {
    rule_id: string;
    chain?: string;
    action?: string;
    src_address?: string;
    dst_address?: string;
    src_port?: string;
    dst_port?: string;
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
    port?: string;
    connection_state?: string;
    connection_type?: string;
    connection_bytes?: string;
    connection_limit?: string;
    connection_rate?: string;
    per_connection_classifier?: string;
    tcp_flags?: string;
    tcp_mss?: string;
    icmp_options?: string;
    packet_size?: string;
    dscp?: string;
    priority?: string;
    ingress_priority?: string;
    ipsec_policy?: string;
    nth?: string;
    random?: string;
    time?: string;
    hop_limit?: string;
    content?: string;
    headers?: string;
    limit?: string;
    dst_limit?: string;
    connection_mark?: string;
    packet_mark?: string;
    routing_mark?: string;
    new_connection_mark?: string;
    new_packet_mark?: string;
    new_routing_mark?: string;
    new_dscp?: string;
    new_hop_limit?: string;
    new_mss?: string;
    new_priority?: string;
    jump_target?: string;
    sniff_target?: string;
    sniff_target_port?: string;
    passthrough?: boolean;
    comment?: string;
    disabled?: boolean;
    log?: boolean;
    log_prefix?: string;
  },
  ctx: ToolContext,
): Promise<string> {
  ctx.info(`Updating IPv6 firewall mangle rule: rule_id=${a.rule_id}`);

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
  put("port", a.port);
  put("connection-state", a.connection_state);
  put("connection-type", a.connection_type);
  put("connection-bytes", a.connection_bytes);
  put("connection-limit", a.connection_limit);
  put("connection-rate", a.connection_rate);
  put("per-connection-classifier", a.per_connection_classifier);
  put("tcp-flags", a.tcp_flags);
  put("tcp-mss", a.tcp_mss);
  put("icmp-options", a.icmp_options);
  put("packet-size", a.packet_size);
  put("dscp", a.dscp);
  put("priority", a.priority);
  put("ingress-priority", a.ingress_priority);
  put("ipsec-policy", a.ipsec_policy);
  put("nth", a.nth);
  put("random", a.random);
  put("time", a.time);
  put("hop-limit", a.hop_limit);
  put("content", a.content);
  put("headers", a.headers);
  put("limit", a.limit);
  put("dst-limit", a.dst_limit);
  put("connection-mark", a.connection_mark);
  put("packet-mark", a.packet_mark);
  put("routing-mark", a.routing_mark);
  put("new-connection-mark", a.new_connection_mark);
  put("new-packet-mark", a.new_packet_mark);
  put("new-routing-mark", a.new_routing_mark);
  put("new-dscp", a.new_dscp);
  put("new-hop-limit", a.new_hop_limit);
  put("new-mss", a.new_mss);
  put("new-priority", a.new_priority);
  put("jump-target", a.jump_target);
  put("sniff-target", a.sniff_target);
  put("sniff-target-port", a.sniff_target_port);
  if (a.passthrough !== undefined) updates.push(`passthrough=${a.passthrough ? "yes" : "no"}`);
  if (a.comment !== undefined) updates.push(`comment=${quoteValue(a.comment)}`);
  if (a.disabled !== undefined) updates.push(`disabled=${a.disabled ? "yes" : "no"}`);
  if (a.log !== undefined) {
    updates.push(`log=${a.log ? "yes" : "no"}`);
    if (a.log && a.log_prefix) updates.push(`log-prefix=${quoteValue(a.log_prefix)}`);
  }

  if (updates.length === 0) return "No updates specified.";

  const id = await resolveRuleId(a.rule_id, ctx);
  if (!id) return `IPv6 mangle rule '${a.rule_id}' not found.`;

  const cmd = `/ipv6 firewall mangle set ${id} ${updates.join(" ")}`;
  const result = await executeMikrotikCommand(cmd, ctx);
  if (looksLikeError(result)) return `Failed to update IPv6 firewall mangle rule: ${result}`;

  const details = await executeMikrotikCommand(
    `/ipv6 firewall mangle print detail where .id=${id}`,
    ctx,
  );
  return `IPv6 firewall mangle rule updated successfully:\n\n${details}`;
}

export const ipv6FirewallMangleTools: ToolModule = [
  defineTool({
    name: "create_ipv6_mangle_rule",
    title: "Create IPv6 Firewall Mangle Rule",
    annotations: WRITE,
    description:
      "Creates an IPv6 mangle rule (`/ipv6 firewall mangle add`) — the packet-marking and header-modification table for IPv6 traffic, " +
      "used to mark connections/packets/routing or change DSCP/hop-limit/MSS. " +
      "For accept/drop decisions use create_ipv6_filter_rule; for address translation use create_ipv6_nat_rule; " +
      "for pre-connection-tracking drops use create_ipv6_raw_rule. " +
      "chain: prerouting/input/forward/output/postrouting. " +
      "action: mark-connection/mark-packet/mark-routing/change-dscp/change-hop-limit/change-mss/accept/etc. " +
      "Set the matching new-*-mark field for mark-* actions; keep passthrough=true so later rules can also match the same packet. " +
      "place_before accepts a rule number or ID (*N) to control insertion position. " +
      "Returns the created rule's detail including its `.id`.",
    inputSchema: {
      chain: z.enum(["prerouting", "input", "forward", "output", "postrouting"]),
      action: z.enum([
        "accept",
        "drop",
        "mark-connection",
        "mark-packet",
        "mark-routing",
        "change-dscp",
        "change-hop-limit",
        "change-mss",
        "jump",
        "log",
        "passthrough",
        "return",
        "set-priority",
        "sniff-tzsp",
      ]),
      src_address: z.string().optional(),
      dst_address: z.string().optional(),
      src_port: z.string().optional(),
      dst_port: z.string().optional(),
      protocol: z.string().optional(),
      in_interface: z.string().optional().describe('Negatable, e.g. "!ether1"'),
      out_interface: z.string().optional(),
      in_interface_list: z.string().optional().describe('Interface list, negatable e.g. "!WAN"'),
      out_interface_list: z.string().optional(),
      src_address_list: z.string().optional().describe('Match src in a named list; negate "!name"'),
      dst_address_list: z.string().optional().describe('Match dst in a named list; negate "!name"'),
      src_address_type: z.string().optional().describe('e.g. "unicast", "local", "!local"'),
      dst_address_type: z.string().optional(),
      src_mac_address: z.string().optional().describe('Source MAC, negatable e.g. "!00:11:..."'),
      port: z.string().optional().describe("Match if src OR dst port matches (with protocol)"),
      connection_state: z
        .string()
        .optional()
        .describe('e.g. "new", "established,related", "!invalid"'),
      connection_type: z.string().optional().describe('Helper, e.g. "sip", "ftp"'),
      connection_bytes: z.string().optional().describe('e.g. "1000000-0" (>1 MB connections)'),
      connection_limit: z.string().optional().describe('e.g. "100,128"'),
      connection_rate: z.string().optional().describe('e.g. "100k-1M"'),
      per_connection_classifier: z
        .string()
        .optional()
        .describe('PCC for load balancing, e.g. "both-addresses:2/0"'),
      tcp_flags: z.string().optional().describe('RouterOS flag expression e.g. "syn,!ack"'),
      tcp_mss: z.string().optional().describe('Match TCP MSS, e.g. "1400-1500" or "!1460"'),
      icmp_options: z.string().optional().describe('Match ICMPv6 type:code, e.g. "128:0"'),
      packet_size: z.string().optional().describe('e.g. "1500" or "0-500"'),
      dscp: z.string().optional().describe("Match incoming DSCP (0-63)"),
      priority: z.string().optional().describe("Match packet/queue priority (0-63)"),
      ingress_priority: z.string().optional().describe("Match ingress (VLAN/MPLS) priority (0-63)"),
      ipsec_policy: z.string().optional().describe('e.g. "in,ipsec" or "out,none"'),
      nth: z.string().optional().describe('e.g. "2,1" — every 2nd packet'),
      random: z.string().optional().describe("Match a random N% of packets (1-99)"),
      time: z.string().optional().describe('e.g. "8h-16h,mon,tue,wed,thu,fri"'),
      hop_limit: z.string().optional().describe('Match hop-limit, e.g. "equal:64", "less-than:10"'),
      content: z.string().optional().describe("Match packets containing this text"),
      headers: z.string().optional().describe('Match IPv6 extension headers, e.g. "hop:contains"'),
      limit: z.string().optional().describe('Rate limit matcher, e.g. "50,5:packet"'),
      dst_limit: z
        .string()
        .optional()
        .describe('Per-destination rate matcher, e.g. "50,5,dst-address/1m"'),
      connection_mark: z.string().optional(),
      packet_mark: z.string().optional(),
      routing_mark: z.string().optional(),
      new_connection_mark: z.string().optional(),
      new_packet_mark: z.string().optional(),
      new_routing_mark: z.string().optional(),
      new_dscp: z.string().optional().describe("0-63, for change-dscp"),
      new_hop_limit: z.string().optional().describe('e.g. "decrement", "increment", or "set:64"'),
      new_mss: z.string().optional().describe('e.g. "1440" or "clamp-to-pmtu", for change-mss'),
      new_priority: z.string().optional().describe('e.g. "4" or "from-dscp", for set-priority'),
      jump_target: z.string().optional().describe("Target chain name for action=jump"),
      sniff_target: z.string().optional().describe("TZSP collector IP for action=sniff-tzsp"),
      sniff_target_port: z.string().optional().describe("TZSP collector UDP port for sniff-tzsp"),
      passthrough: z.boolean().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
      log: z.boolean().default(false),
      log_prefix: z.string().optional(),
      place_before: z.string().optional().describe("Rule number or ID (*N) to insert before"),
    },
    async handler(a, ctx) {
      ctx.info(`Creating IPv6 firewall mangle rule: chain=${a.chain}, action=${a.action}`);

      const cmd = new Cmd("/ipv6 firewall mangle add")
        .set("chain", a.chain)
        .set("action", a.action)
        .opt("src-address", a.src_address)
        .opt("dst-address", a.dst_address)
        .opt("src-port", a.src_port)
        .opt("dst-port", a.dst_port)
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
        .opt("port", a.port)
        .opt("connection-state", a.connection_state)
        .opt("connection-type", a.connection_type)
        .opt("connection-bytes", a.connection_bytes)
        .opt("connection-limit", a.connection_limit)
        .opt("connection-rate", a.connection_rate)
        .opt("per-connection-classifier", a.per_connection_classifier)
        .opt("tcp-flags", a.tcp_flags)
        .opt("tcp-mss", a.tcp_mss)
        .opt("icmp-options", a.icmp_options)
        .opt("packet-size", a.packet_size)
        .opt("dscp", a.dscp)
        .opt("priority", a.priority)
        .opt("ingress-priority", a.ingress_priority)
        .opt("ipsec-policy", a.ipsec_policy)
        .opt("nth", a.nth)
        .opt("random", a.random)
        .opt("time", a.time)
        .opt("hop-limit", a.hop_limit)
        .opt("content", a.content)
        .opt("headers", a.headers)
        .opt("limit", a.limit)
        .opt("dst-limit", a.dst_limit)
        .opt("connection-mark", a.connection_mark)
        .opt("packet-mark", a.packet_mark)
        .opt("routing-mark", a.routing_mark)
        .opt("new-connection-mark", a.new_connection_mark)
        .opt("new-packet-mark", a.new_packet_mark)
        .opt("new-routing-mark", a.new_routing_mark)
        .opt("new-dscp", a.new_dscp)
        .opt("new-hop-limit", a.new_hop_limit)
        .opt("new-mss", a.new_mss)
        .opt("new-priority", a.new_priority)
        .opt("jump-target", a.jump_target)
        .opt("sniff-target", a.sniff_target)
        .opt("sniff-target-port", a.sniff_target_port)
        .bool("passthrough", a.passthrough)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .flag("log", a.log)
        .opt("log-prefix", a.log ? a.log_prefix : undefined);

      const result = await executeRuleCreate("/ipv6 firewall mangle", cmd, ctx, a.place_before);

      const trimmed = result.trim();

      if (looksLikeError(trimmed)) {
        return `Failed to create IPv6 firewall mangle rule: ${trimmed}`;
      }

      return readCreatedRule("/ipv6 firewall mangle", trimmed, "IPv6 mangle rule", ctx);
    },
  }),

  defineTool({
    name: "list_ipv6_mangle_rules",
    title: "List IPv6 Firewall Mangle Rules",
    annotations: READ,
    description:
      "Lists IPv6 mangle rules (`/ipv6 firewall mangle print`) — returns all rules in the mangle table with their IDs, chains, actions, and match criteria. " +
      "For IPv6 filter use list_ipv6_filter_rules; for IPv6 NAT use list_ipv6_nat_rules; for IPv6 raw use list_ipv6_raw_rules. " +
      "Optionally filter by chain, action, connection-mark, packet-mark, disabled, invalid, or dynamic status. " +
      "Rule `.id` values from this output are required by get_ipv6_mangle_rule, update_ipv6_mangle_rule, remove_ipv6_mangle_rule, move_ipv6_mangle_rule, enable_ipv6_mangle_rule, and disable_ipv6_mangle_rule.",
    inputSchema: {
      chain_filter: z.string().optional(),
      action_filter: z.string().optional(),
      connection_mark_filter: z.string().optional(),
      packet_mark_filter: z.string().optional(),
      disabled_only: z.boolean().default(false),
      invalid_only: z.boolean().default(false),
      dynamic_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info("Listing IPv6 firewall mangle rules");

      const filters: string[] = [];
      if (a.chain_filter) filters.push(`chain=${a.chain_filter}`);
      if (a.action_filter) filters.push(`action=${a.action_filter}`);
      if (a.connection_mark_filter) filters.push(`connection-mark="${a.connection_mark_filter}"`);
      if (a.packet_mark_filter) filters.push(`packet-mark="${a.packet_mark_filter}"`);
      if (a.disabled_only) filters.push("disabled=yes");
      if (a.invalid_only) filters.push("invalid=yes");
      if (a.dynamic_only) filters.push("dynamic=yes");

      const result = await executeMikrotikCommand(
        `/ipv6 firewall mangle print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No IPv6 firewall mangle rules found matching the criteria."
        : `IPV6 FIREWALL MANGLE RULES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_ipv6_mangle_rule",
    title: "Get IPv6 Firewall Mangle Rule Details",
    annotations: READ,
    description:
      "Retrieves full detail for a single IPv6 mangle rule (`/ipv6 firewall mangle print detail where .id=`). " +
      "Use when you need all fields of one specific rule rather than the full table listing. " +
      "For the full list use list_ipv6_mangle_rules. " +
      'rule_id takes the `.id` value (e.g. "*1" or "0") returned by list_ipv6_mangle_rules.',
    inputSchema: {
      rule_id: z.string().describe('Rule ID from list output e.g. "*1" or "0"'),
    },
    async handler(a, ctx) {
      ctx.info(`Getting IPv6 firewall mangle rule details: rule_id=${a.rule_id}`);

      const id = await resolveRuleId(a.rule_id, ctx);
      if (!id) return `IPv6 mangle rule '${a.rule_id}' not found.`;

      const result = await executeMikrotikCommand(
        `/ipv6 firewall mangle print detail where .id=${id}`,
        ctx,
      );
      return isEmpty(result)
        ? `IPv6 mangle rule '${a.rule_id}' not found.`
        : `IPV6 FIREWALL MANGLE RULE DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_ipv6_mangle_rule",
    title: "Update IPv6 Firewall Mangle Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Updates fields on an existing IPv6 mangle rule (`/ipv6 firewall mangle set`) — change chain, action, match criteria, mark values, DSCP, hop-limit, or flags without recreating the rule. " +
      "To toggle enabled state only use enable_ipv6_mangle_rule or disable_ipv6_mangle_rule. " +
      "rule_id takes the `.id` from list_ipv6_mangle_rules. " +
      'Pass "" (empty string) for an optional field to clear it. ' +
      "Returns the updated rule's full detail.",
    inputSchema: {
      rule_id: z.string(),
      chain: z.string().optional(),
      action: z.string().optional(),
      src_address: z.string().optional(),
      dst_address: z.string().optional(),
      src_port: z.string().optional(),
      dst_port: z.string().optional(),
      protocol: z.string().optional(),
      in_interface: z.string().optional(),
      out_interface: z.string().optional(),
      in_interface_list: z.string().optional(),
      out_interface_list: z.string().optional(),
      src_address_list: z.string().optional().describe('Negate with "!name"'),
      dst_address_list: z.string().optional().describe('Negate with "!name"'),
      src_address_type: z.string().optional(),
      dst_address_type: z.string().optional(),
      src_mac_address: z.string().optional(),
      port: z.string().optional(),
      connection_state: z.string().optional(),
      connection_type: z.string().optional(),
      connection_bytes: z.string().optional(),
      connection_limit: z.string().optional(),
      connection_rate: z.string().optional(),
      per_connection_classifier: z.string().optional(),
      tcp_flags: z.string().optional(),
      tcp_mss: z.string().optional(),
      icmp_options: z.string().optional(),
      packet_size: z.string().optional(),
      dscp: z.string().optional(),
      priority: z.string().optional(),
      ingress_priority: z.string().optional(),
      ipsec_policy: z.string().optional(),
      nth: z.string().optional(),
      random: z.string().optional(),
      time: z.string().optional(),
      hop_limit: z.string().optional(),
      content: z.string().optional(),
      headers: z.string().optional(),
      limit: z.string().optional(),
      dst_limit: z.string().optional(),
      connection_mark: z.string().optional(),
      packet_mark: z.string().optional(),
      routing_mark: z.string().optional(),
      new_connection_mark: z.string().optional(),
      new_packet_mark: z.string().optional(),
      new_routing_mark: z.string().optional(),
      new_dscp: z.string().optional(),
      new_hop_limit: z.string().optional(),
      new_mss: z.string().optional(),
      new_priority: z.string().optional(),
      jump_target: z.string().optional(),
      sniff_target: z.string().optional(),
      sniff_target_port: z.string().optional(),
      passthrough: z.boolean().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
      log: z.boolean().optional(),
      log_prefix: z.string().optional(),
    },
    async handler(a, ctx) {
      return updateMangleRule(a, ctx);
    },
  }),

  defineTool({
    name: "remove_ipv6_mangle_rule",
    title: "Remove IPv6 Firewall Mangle Rule",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes an IPv6 mangle rule (`/ipv6 firewall mangle remove`) — verifies the rule exists first, then removes it. " +
      "To only deactivate without deleting use disable_ipv6_mangle_rule. " +
      "rule_id takes the `.id` from list_ipv6_mangle_rules. " +
      "Returns confirmation on success or a not-found message if the ID is absent.",
    inputSchema: { rule_id: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing IPv6 firewall mangle rule: rule_id=${a.rule_id}`);

      const id = await resolveRuleId(a.rule_id, ctx);
      if (!id) return `IPv6 mangle rule '${a.rule_id}' not found.`;

      const result = await executeMikrotikCommand(`/ipv6 firewall mangle remove ${id}`, ctx);
      if (looksLikeError(result)) return `Failed to remove IPv6 firewall mangle rule: ${result}`;
      return `IPv6 mangle rule '${a.rule_id}' (${id}) removed successfully.`;
    },
  }),

  defineTool({
    name: "move_ipv6_mangle_rule",
    title: "Move IPv6 Firewall Mangle Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Reorders an IPv6 mangle rule to a specific position (`/ipv6 firewall mangle move`) — mangle rules are evaluated top-down, so position controls which rules fire first. " +
      "For IPv6 filter reordering use move_ipv6_filter_rule. " +
      "rule_id takes the `.id` from list_ipv6_mangle_rules; destination is the 0-based target index. " +
      "Verifies the rule exists before moving.",
    inputSchema: {
      rule_id: z.string(),
      destination: z.number().int().describe("0-based target position index"),
    },
    async handler(a, ctx) {
      ctx.info(
        `Moving IPv6 firewall mangle rule: rule_id=${a.rule_id} to position ${a.destination}`,
      );

      const id = await resolveRuleId(a.rule_id, ctx);
      if (!id) return `IPv6 mangle rule '${a.rule_id}' not found.`;

      const result = await executeMikrotikCommand(
        `/ipv6 firewall mangle move ${id} destination=${a.destination}`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to move IPv6 firewall mangle rule: ${result}`;
      return `IPv6 mangle rule '${a.rule_id}' (${id}) moved to position ${a.destination}.`;
    },
  }),

  defineTool({
    name: "enable_ipv6_mangle_rule",
    title: "Enable IPv6 Firewall Mangle Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Enables a disabled IPv6 mangle rule (`/ipv6 firewall mangle set disabled=no`) so it participates in packet processing again. " +
      "To deactivate use disable_ipv6_mangle_rule; to delete permanently use remove_ipv6_mangle_rule. " +
      "rule_id takes the `.id` from list_ipv6_mangle_rules. " +
      "Returns the updated rule's detail.",
    inputSchema: { rule_id: z.string() },
    async handler(a, ctx) {
      return updateMangleRule({ rule_id: a.rule_id, disabled: false }, ctx);
    },
  }),

  defineTool({
    name: "disable_ipv6_mangle_rule",
    title: "Disable IPv6 Firewall Mangle Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Disables an active IPv6 mangle rule (`/ipv6 firewall mangle set disabled=yes`) — the rule remains in the table but is skipped during packet processing. " +
      "To re-enable use enable_ipv6_mangle_rule; to delete permanently use remove_ipv6_mangle_rule. " +
      "rule_id takes the `.id` from list_ipv6_mangle_rules. " +
      "Returns the updated rule's detail.",
    inputSchema: { rule_id: z.string() },
    async handler(a, ctx) {
      return updateMangleRule({ rule_id: a.rule_id, disabled: true }, ctx);
    },
  }),
];
