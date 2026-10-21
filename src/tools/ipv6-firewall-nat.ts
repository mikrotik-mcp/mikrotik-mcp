/** IPv6 firewall NAT rules — `/ipv6 firewall nat`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, quoteValue, looksLikeError, isEmpty, Cmd } from "../core/routeros";
import type { ToolContext } from "../core/context";
import { ruleResolver } from "./_resolve-rule-id";
import { executeRuleCreate, readCreatedRule } from "./_create-rule";

const resolveRuleId = ruleResolver("/ipv6 firewall nat");

async function updateNatRule(
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
    to_address?: string;
    to_ports?: string;
    src_address_list?: string;
    dst_address_list?: string;
    in_interface_list?: string;
    out_interface_list?: string;
    src_address_type?: string;
    dst_address_type?: string;
    src_mac_address?: string;
    port?: string;
    connection_mark?: string;
    connection_state?: string;
    connection_type?: string;
    connection_bytes?: string;
    connection_limit?: string;
    connection_rate?: string;
    packet_mark?: string;
    routing_mark?: string;
    icmp_options?: string;
    ipsec_policy?: string;
    content?: string;
    dscp?: string;
    priority?: string;
    tcp_flags?: string;
    tcp_mss?: string;
    packet_size?: string;
    hop_limit?: string;
    headers?: string;
    limit?: string;
    dst_limit?: string;
    nth?: string;
    random?: string;
    per_connection_classifier?: string;
    time?: string;
    jump_target?: string;
    address_list?: string;
    address_list_timeout?: string;
    comment?: string;
    disabled?: boolean;
    log?: boolean;
    log_prefix?: string;
  },
  ctx: ToolContext,
): Promise<string> {
  ctx.info(`Updating IPv6 firewall NAT rule: rule_id=${a.rule_id}`);

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
  put("to-address", a.to_address);
  put("to-ports", a.to_ports);
  put("src-address-list", a.src_address_list);
  put("dst-address-list", a.dst_address_list);
  put("in-interface-list", a.in_interface_list);
  put("out-interface-list", a.out_interface_list);
  put("src-address-type", a.src_address_type);
  put("dst-address-type", a.dst_address_type);
  put("src-mac-address", a.src_mac_address);
  put("port", a.port);
  put("connection-mark", a.connection_mark);
  put("connection-state", a.connection_state);
  put("connection-type", a.connection_type);
  put("connection-bytes", a.connection_bytes);
  put("connection-limit", a.connection_limit);
  put("connection-rate", a.connection_rate);
  put("packet-mark", a.packet_mark);
  put("routing-mark", a.routing_mark);
  put("icmp-options", a.icmp_options);
  put("ipsec-policy", a.ipsec_policy);
  put("content", a.content);
  put("dscp", a.dscp);
  put("priority", a.priority);
  put("tcp-flags", a.tcp_flags);
  put("tcp-mss", a.tcp_mss);
  put("packet-size", a.packet_size);
  put("hop-limit", a.hop_limit);
  put("headers", a.headers);
  put("limit", a.limit);
  put("dst-limit", a.dst_limit);
  put("nth", a.nth);
  put("random", a.random);
  put("per-connection-classifier", a.per_connection_classifier);
  put("time", a.time);
  put("jump-target", a.jump_target);
  put("address-list", a.address_list);
  put("address-list-timeout", a.address_list_timeout);
  if (a.comment !== undefined) updates.push(`comment=${quoteValue(a.comment)}`);
  if (a.disabled !== undefined) updates.push(`disabled=${a.disabled ? "yes" : "no"}`);
  if (a.log !== undefined) {
    updates.push(`log=${a.log ? "yes" : "no"}`);
    if (a.log && a.log_prefix) updates.push(`log-prefix=${quoteValue(a.log_prefix)}`);
  }

  if (updates.length === 0) return "No updates specified.";

  const id = await resolveRuleId(a.rule_id, ctx);
  if (!id) return `IPv6 NAT rule '${a.rule_id}' not found.`;

  const cmd = `/ipv6 firewall nat set ${id} ${updates.join(" ")}`;
  const result = await executeMikrotikCommand(cmd, ctx);
  if (looksLikeError(result)) return `Failed to update IPv6 firewall NAT rule: ${result}`;

  const details = await executeMikrotikCommand(
    `/ipv6 firewall nat print detail where .id=${id}`,
    ctx,
  );
  return `IPv6 firewall NAT rule updated successfully:\n\n${details}`;
}

export const ipv6FirewallNatTools: ToolModule = [
  defineTool({
    name: "create_ipv6_nat_rule",
    title: "Create IPv6 Firewall NAT Rule",
    annotations: WRITE,
    description:
      "Creates an IPv6 NAT rule (`/ipv6 firewall nat add`) — the address/port translation table for IPv6 traffic, used to redirect or masquerade connections. " +
      "chain: 'srcnat' (applied after routing, for outbound traffic) or 'dstnat' (applied before routing, for inbound traffic). " +
      "action: masquerade/src-nat/dst-nat/netmap/redirect/accept/drop/return/jump/passthrough/log. " +
      "to_address: rewrite target for src-nat/dst-nat/netmap. " +
      "place_before: rule number or ID (*N) to insert before a specific position. " +
      "For IPv4 NAT use create_nat_rule; for IPv6 packet filtering use create_ipv6_filter_rule; for IPv6 traffic marking use create_ipv6_mangle_rule; for IPv6 pre-connection-tracking drops use create_ipv6_raw_rule. " +
      "Returns the created rule's full detail including its `.id`.",
    inputSchema: {
      chain: z.enum(["srcnat", "dstnat"]),
      action: z.enum([
        "accept",
        "drop",
        "masquerade",
        "src-nat",
        "dst-nat",
        "netmap",
        "redirect",
        "return",
        "jump",
        "passthrough",
        "log",
        "add-src-to-address-list",
        "add-dst-to-address-list",
      ]),
      src_address: z.string().optional(),
      dst_address: z.string().optional(),
      src_port: z.string().optional(),
      dst_port: z.string().optional(),
      protocol: z.string().optional(),
      in_interface: z.string().optional(),
      out_interface: z.string().optional(),
      to_address: z.string().optional(),
      to_ports: z.string().optional(),
      src_address_list: z.string().optional(),
      dst_address_list: z.string().optional(),
      in_interface_list: z
        .string()
        .optional()
        .describe('Ingress interface list, e.g. "WAN" or "!LAN"'),
      out_interface_list: z.string().optional().describe("Egress interface list"),
      src_address_type: z.string().optional().describe('"unicast" / "local" / "multicast" / etc.'),
      dst_address_type: z.string().optional().describe('"unicast" / "local" / "multicast" / etc.'),
      src_mac_address: z.string().optional().describe('Source MAC, negate "!AA:BB:.."'),
      port: z.string().optional().describe("Match src OR dst port (any protocol with ports)"),
      connection_mark: z.string().optional().describe("Match a connection mark set in mangle"),
      connection_state: z
        .string()
        .optional()
        .describe('e.g. "new" / "established,related" / "!invalid"'),
      connection_type: z
        .string()
        .optional()
        .describe('Helper-detected conn type, e.g. "ftp" / "sip"'),
      connection_bytes: z.string().optional().describe('Total conn bytes range, e.g. "1000000-"'),
      connection_limit: z.string().optional().describe('Per-address conn limit, e.g. "100,64"'),
      connection_rate: z.string().optional().describe('Conn rate range, e.g. "0-100k"'),
      packet_mark: z.string().optional().describe("Match a packet mark set in mangle"),
      routing_mark: z.string().optional().describe("Match a routing mark set in mangle"),
      icmp_options: z.string().optional().describe('ICMPv6 type:code, e.g. "128:0"'),
      ipsec_policy: z.string().optional().describe('e.g. "in,ipsec" / "out,none"'),
      content: z.string().optional().describe("Match a literal string in the packet payload"),
      dscp: z.string().optional().describe("DSCP value 0-63"),
      priority: z.string().optional().describe("Match packet priority (queue/VLAN)"),
      tcp_flags: z.string().optional().describe('e.g. "syn,!ack"'),
      tcp_mss: z.string().optional().describe('TCP MSS range, e.g. "1440-1500"'),
      packet_size: z.string().optional().describe('Packet size range, e.g. "1500" or "0-500"'),
      hop_limit: z.string().optional().describe('IPv6 hop-limit matcher, e.g. "equal:64"'),
      headers: z.string().optional().describe("Match IPv6 extension headers"),
      limit: z.string().optional().describe('Rate limit, e.g. "10,5:packet"'),
      dst_limit: z.string().optional().describe('Per-dst rate limit, e.g. "10,5,dst-address/1m"'),
      nth: z.string().optional().describe('Every Nth packet, e.g. "2,0"'),
      random: z
        .string()
        .optional()
        .describe("Match packet randomly with given probability % (1-99)"),
      per_connection_classifier: z
        .string()
        .optional()
        .describe('PCC classifier, e.g. "both-addresses:2/0"'),
      time: z.string().optional().describe('Time/day matcher, e.g. "8h-16h,mon,tue,wed,thu,fri"'),
      jump_target: z.string().optional().describe("Target chain name when action=jump"),
      address_list: z
        .string()
        .optional()
        .describe("List name for add-src-to-address-list / add-dst-to-address-list"),
      address_list_timeout: z
        .string()
        .optional()
        .describe('Timeout for the address-list entry, e.g. "1h" or "none"'),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
      log: z.boolean().default(false),
      log_prefix: z.string().optional(),
      place_before: z.string().optional().describe("Rule number or ID (*N) to insert before"),
    },
    async handler(a, ctx) {
      ctx.info(`Creating IPv6 firewall NAT rule: chain=${a.chain}, action=${a.action}`);

      const cmd = new Cmd("/ipv6 firewall nat add")
        .set("chain", a.chain)
        .set("action", a.action)
        .opt("src-address", a.src_address)
        .opt("dst-address", a.dst_address)
        .opt("src-port", a.src_port)
        .opt("dst-port", a.dst_port)
        .opt("protocol", a.protocol)
        .opt("in-interface", a.in_interface)
        .opt("out-interface", a.out_interface)
        .opt("to-address", a.to_address)
        .opt("to-ports", a.to_ports)
        .opt("src-address-list", a.src_address_list)
        .opt("dst-address-list", a.dst_address_list)
        .opt("in-interface-list", a.in_interface_list)
        .opt("out-interface-list", a.out_interface_list)
        .opt("src-address-type", a.src_address_type)
        .opt("dst-address-type", a.dst_address_type)
        .opt("src-mac-address", a.src_mac_address)
        .opt("port", a.port)
        .opt("connection-mark", a.connection_mark)
        .opt("connection-state", a.connection_state)
        .opt("connection-type", a.connection_type)
        .opt("connection-bytes", a.connection_bytes)
        .opt("connection-limit", a.connection_limit)
        .opt("connection-rate", a.connection_rate)
        .opt("packet-mark", a.packet_mark)
        .opt("routing-mark", a.routing_mark)
        .opt("icmp-options", a.icmp_options)
        .opt("ipsec-policy", a.ipsec_policy)
        .opt("content", a.content)
        .opt("dscp", a.dscp)
        .opt("priority", a.priority)
        .opt("tcp-flags", a.tcp_flags)
        .opt("tcp-mss", a.tcp_mss)
        .opt("packet-size", a.packet_size)
        .opt("hop-limit", a.hop_limit)
        .opt("headers", a.headers)
        .opt("limit", a.limit)
        .opt("dst-limit", a.dst_limit)
        .opt("nth", a.nth)
        .opt("random", a.random)
        .opt("per-connection-classifier", a.per_connection_classifier)
        .opt("time", a.time)
        .opt("jump-target", a.jump_target)
        .opt("address-list", a.address_list)
        .opt("address-list-timeout", a.address_list_timeout)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .flag("log", a.log)
        .opt("log-prefix", a.log ? a.log_prefix : undefined);

      const result = await executeRuleCreate("/ipv6 firewall nat", cmd, ctx, a.place_before);

      const trimmed = result.trim();

      if (looksLikeError(trimmed)) {
        return `Failed to create IPv6 firewall NAT rule: ${trimmed}`;
      }

      return readCreatedRule("/ipv6 firewall nat", trimmed, "IPv6 NAT rule", ctx);
    },
  }),

  defineTool({
    name: "list_ipv6_nat_rules",
    title: "List IPv6 Firewall NAT Rules",
    annotations: READ,
    description:
      "Lists IPv6 NAT rules (`/ipv6 firewall nat print`) with optional filters — use to inspect all address/port translation rules in the srcnat or dstnat chain. " +
      "Filters: chain_filter, action_filter, src_address_filter, dst_address_filter, disabled_only, invalid_only, dynamic_only. " +
      "For a single rule's full detail use get_ipv6_nat_rule. " +
      "For IPv4 NAT use list_nat_rules; for IPv6 filter rules use list_ipv6_filter_rules; for IPv6 mangle use list_ipv6_mangle_rules; for IPv6 raw use list_ipv6_raw_rules. " +
      "Returns matching rule list with `.id` values needed by get_ipv6_nat_rule, update_ipv6_nat_rule, remove_ipv6_nat_rule, move_ipv6_nat_rule, enable_ipv6_nat_rule, and disable_ipv6_nat_rule.",
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
      ctx.info("Listing IPv6 firewall NAT rules");

      const filters: string[] = [];
      if (a.chain_filter) filters.push(`chain=${a.chain_filter}`);
      if (a.action_filter) filters.push(`action=${a.action_filter}`);
      if (a.src_address_filter) filters.push(`src-address~"${a.src_address_filter}"`);
      if (a.dst_address_filter) filters.push(`dst-address~"${a.dst_address_filter}"`);
      if (a.disabled_only) filters.push("disabled=yes");
      if (a.invalid_only) filters.push("invalid=yes");
      if (a.dynamic_only) filters.push("dynamic=yes");

      const result = await executeMikrotikCommand(
        `/ipv6 firewall nat print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No IPv6 firewall NAT rules found matching the criteria."
        : `IPV6 FIREWALL NAT RULES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_ipv6_nat_rule",
    title: "Get IPv6 Firewall NAT Rule",
    annotations: READ,
    description:
      "Fetches full detail of a single IPv6 NAT rule (`/ipv6 firewall nat print detail where .id=...`) — use when you need all fields of one rule rather than scanning the full list. " +
      'rule_id takes the `.id` value from list_ipv6_nat_rules (e.g. "*1" or "0"). ' +
      "For IPv4 use get_nat_rule; for the IPv6 filter table use get_ipv6_filter_rule. " +
      "Returns all fields for the matched rule, or a not-found message if the ID does not exist.",
    inputSchema: {
      rule_id: z.string().describe('Rule ID from list output e.g. "*1" or "0"'),
    },
    async handler(a, ctx) {
      ctx.info(`Getting IPv6 firewall NAT rule details: rule_id=${a.rule_id}`);

      const id = await resolveRuleId(a.rule_id, ctx);
      if (!id) return `IPv6 firewall NAT rule '${a.rule_id}' not found.`;

      const result = await executeMikrotikCommand(
        `/ipv6 firewall nat print detail where .id=${id}`,
        ctx,
      );
      return isEmpty(result)
        ? `IPv6 firewall NAT rule '${a.rule_id}' not found.`
        : `IPV6 FIREWALL NAT RULE DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_ipv6_nat_rule",
    title: "Update IPv6 Firewall NAT Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modifies fields of an existing IPv6 NAT rule (`/ipv6 firewall nat set`) — use to change action, addresses, ports, chain, or flags without removing and recreating the rule. " +
      "rule_id takes the `.id` from list_ipv6_nat_rules. " +
      'Pass "" for any optional field to clear it (e.g. to_address=""). ' +
      "For IPv4 use update_nat_rule; for the IPv6 filter table use update_ipv6_filter_rule. " +
      "To only toggle active state use enable_ipv6_nat_rule or disable_ipv6_nat_rule. " +
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
      to_address: z.string().optional(),
      to_ports: z.string().optional(),
      src_address_list: z.string().optional(),
      dst_address_list: z.string().optional(),
      in_interface_list: z.string().optional(),
      out_interface_list: z.string().optional(),
      src_address_type: z.string().optional(),
      dst_address_type: z.string().optional(),
      src_mac_address: z.string().optional(),
      port: z.string().optional(),
      connection_mark: z.string().optional(),
      connection_state: z.string().optional(),
      connection_type: z.string().optional(),
      connection_bytes: z.string().optional(),
      connection_limit: z.string().optional(),
      connection_rate: z.string().optional(),
      packet_mark: z.string().optional(),
      routing_mark: z.string().optional(),
      icmp_options: z.string().optional(),
      ipsec_policy: z.string().optional(),
      content: z.string().optional(),
      dscp: z.string().optional(),
      priority: z.string().optional(),
      tcp_flags: z.string().optional(),
      tcp_mss: z.string().optional(),
      packet_size: z.string().optional(),
      hop_limit: z.string().optional(),
      headers: z.string().optional(),
      limit: z.string().optional(),
      dst_limit: z.string().optional(),
      nth: z.string().optional(),
      random: z.string().optional(),
      per_connection_classifier: z.string().optional(),
      time: z.string().optional(),
      jump_target: z.string().optional(),
      address_list: z.string().optional(),
      address_list_timeout: z.string().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
      log: z.boolean().optional(),
      log_prefix: z.string().optional(),
    },
    async handler(a, ctx) {
      return updateNatRule(a, ctx);
    },
  }),

  defineTool({
    name: "remove_ipv6_nat_rule",
    title: "Remove IPv6 Firewall NAT Rule",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes an IPv6 NAT rule (`/ipv6 firewall nat remove`) — use to remove a translation entry entirely. " +
      "First verifies the rule exists via a count-only check; returns a not-found message if absent. " +
      "rule_id takes the `.id` from list_ipv6_nat_rules. " +
      "For IPv4 use remove_nat_rule; for the IPv6 filter table use remove_ipv6_filter_rule. " +
      "To temporarily deactivate instead of delete, use disable_ipv6_nat_rule.",
    inputSchema: { rule_id: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing IPv6 firewall NAT rule: rule_id=${a.rule_id}`);

      const id = await resolveRuleId(a.rule_id, ctx);
      if (!id) return `IPv6 firewall NAT rule '${a.rule_id}' not found.`;

      const result = await executeMikrotikCommand(`/ipv6 firewall nat remove ${id}`, ctx);
      if (looksLikeError(result)) return `Failed to remove IPv6 firewall NAT rule: ${result}`;
      return `IPv6 firewall NAT rule '${a.rule_id}' (${id}) removed successfully.`;
    },
  }),

  defineTool({
    name: "move_ipv6_nat_rule",
    title: "Move IPv6 Firewall NAT Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Repositions an IPv6 NAT rule to a different ordinal slot (`/ipv6 firewall nat move ... destination=N`) — NAT rules are evaluated top-to-bottom so position controls which rule matches first. " +
      "destination is a 0-based integer index. rule_id takes the `.id` from list_ipv6_nat_rules. " +
      "For IPv4 use move_nat_rule; for the IPv6 filter table use move_ipv6_filter_rule. " +
      "Confirms success or returns the error message from the device.",
    inputSchema: {
      rule_id: z.string(),
      destination: z.number().int().describe("0-based target position index"),
    },
    async handler(a, ctx) {
      ctx.info(`Moving IPv6 firewall NAT rule: rule_id=${a.rule_id} to position ${a.destination}`);

      const id = await resolveRuleId(a.rule_id, ctx);
      if (!id) return `IPv6 firewall NAT rule '${a.rule_id}' not found.`;

      const result = await executeMikrotikCommand(
        `/ipv6 firewall nat move ${id} destination=${a.destination}`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to move IPv6 firewall NAT rule: ${result}`;
      return `IPv6 firewall NAT rule '${a.rule_id}' (${id}) moved to position ${a.destination}.`;
    },
  }),

  defineTool({
    name: "enable_ipv6_nat_rule",
    title: "Enable IPv6 Firewall NAT Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Re-activates a disabled IPv6 NAT rule (`/ipv6 firewall nat set ... disabled=no`) — use to restore a rule that was previously disabled without recreating it. " +
      "rule_id takes the `.id` from list_ipv6_nat_rules. " +
      "To deactivate use disable_ipv6_nat_rule; to permanently delete use remove_ipv6_nat_rule. " +
      "For IPv4 NAT use enable_nat_rule. " +
      "Returns the updated rule's full detail.",
    inputSchema: { rule_id: z.string() },
    async handler(a, ctx) {
      return updateNatRule({ rule_id: a.rule_id, disabled: false }, ctx);
    },
  }),

  defineTool({
    name: "disable_ipv6_nat_rule",
    title: "Disable IPv6 Firewall NAT Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Temporarily deactivates an IPv6 NAT rule (`/ipv6 firewall nat set ... disabled=yes`) without removing it — use to suspend a translation rule while preserving its configuration. " +
      "rule_id takes the `.id` from list_ipv6_nat_rules. " +
      "To re-activate use enable_ipv6_nat_rule; to permanently delete use remove_ipv6_nat_rule. " +
      "For IPv4 NAT use disable_nat_rule. " +
      "Returns the updated rule's full detail.",
    inputSchema: { rule_id: z.string() },
    async handler(a, ctx) {
      return updateNatRule({ rule_id: a.rule_id, disabled: true }, ctx);
    },
  }),
];
