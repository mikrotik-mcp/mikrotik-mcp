/** IPv6 firewall filter rules — `/ipv6 firewall filter`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, quoteValue, looksLikeError, isEmpty, Cmd } from "../core/routeros";
import type { ToolContext } from "../core/context";
import { listItemIds, ruleResolver } from "./_resolve-rule-id";
import { executeRuleCreate, readCreatedRule } from "./_create-rule";

const resolveRuleId = ruleResolver("/ipv6 firewall filter");

/** Shared update routine — used by update/enable/disable. */
async function updateFilterRule(
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
    connection_state?: string;
    src_address_list?: string;
    dst_address_list?: string;
    hop_limit?: string;
    limit?: string;
    tcp_flags?: string;
    port?: string;
    icmp_options?: string;
    connection_mark?: string;
    connection_type?: string;
    connection_bytes?: string;
    connection_limit?: string;
    connection_rate?: string;
    packet_mark?: string;
    routing_mark?: string;
    packet_size?: string;
    dscp?: string;
    ingress_priority?: string;
    priority?: string;
    src_mac_address?: string;
    src_address_type?: string;
    dst_address_type?: string;
    tcp_mss?: string;
    headers?: string;
    tls_host?: string;
    content?: string;
    nth?: string;
    random?: string;
    time?: string;
    dst_limit?: string;
    ipsec_policy?: string;
    per_connection_classifier?: string;
    jump_target?: string;
    reject_with?: string;
    address_list?: string;
    address_list_timeout?: string;
    comment?: string;
    disabled?: boolean;
    log?: boolean;
    log_prefix?: string;
  },
  ctx: ToolContext,
): Promise<string> {
  ctx.info(`Updating IPv6 firewall filter rule: rule_id=${a.rule_id}`);

  const updates: string[] = [];
  // Clearable string fields: undefined -> skip, "" -> `!field`, else `field=value`.
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
  put("connection-state", a.connection_state);
  put("src-address-list", a.src_address_list);
  put("dst-address-list", a.dst_address_list);
  put("hop-limit", a.hop_limit);
  put("limit", a.limit);
  put("tcp-flags", a.tcp_flags);
  put("port", a.port);
  put("icmp-options", a.icmp_options);
  put("connection-mark", a.connection_mark);
  put("connection-type", a.connection_type);
  put("connection-bytes", a.connection_bytes);
  put("connection-limit", a.connection_limit);
  put("connection-rate", a.connection_rate);
  put("packet-mark", a.packet_mark);
  put("routing-mark", a.routing_mark);
  put("packet-size", a.packet_size);
  put("dscp", a.dscp);
  put("ingress-priority", a.ingress_priority);
  put("priority", a.priority);
  put("src-mac-address", a.src_mac_address);
  put("src-address-type", a.src_address_type);
  put("dst-address-type", a.dst_address_type);
  put("tcp-mss", a.tcp_mss);
  put("headers", a.headers);
  put("tls-host", a.tls_host);
  put("content", a.content);
  put("nth", a.nth);
  put("random", a.random);
  put("time", a.time);
  put("dst-limit", a.dst_limit);
  put("ipsec-policy", a.ipsec_policy);
  put("per-connection-classifier", a.per_connection_classifier);
  put("jump-target", a.jump_target);
  put("reject-with", a.reject_with);
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
  if (!id) return `IPv6 firewall filter rule '${a.rule_id}' not found.`;
  const cmd = `/ipv6 firewall filter set ${id} ${updates.join(" ")}`;
  const result = await executeMikrotikCommand(cmd, ctx);
  if (looksLikeError(result)) return `Failed to update IPv6 firewall filter rule: ${result}`;

  const details = await executeMikrotikCommand(
    `/ipv6 firewall filter print detail where .id=${id}`,
    ctx,
  );
  return `IPv6 firewall filter rule updated successfully:\n\n${details}`;
}

export const ipv6FirewallFilterTools: ToolModule = [
  defineTool({
    name: "create_ipv6_filter_rule",
    title: "Create IPv6 Firewall Filter Rule",
    annotations: WRITE,
    description:
      "Creates an IPv6 firewall FILTER rule (`/ipv6 firewall filter`) — the accept/drop/reject decision table for IPv6 traffic TO the router (chain=input), THROUGH it (forward), or FROM it (output). " +
      "For IPv4 filter rules use create_filter_rule; for IPv6 NAT use create_ipv6_nat_rule; for IPv6 packet marking use create_ipv6_mangle_rule; for IPv6 pre-conntrack drops use create_ipv6_raw_rule. " +
      "Returns the created rule's full detail including its `.id`. " +
      'connection_state: comma-separated e.g. "established,related,new,invalid". ' +
      'hop_limit: RouterOS hop-limit expression e.g. "equal:1" or "less:64". ' +
      'limit: RouterOS rate/burst string e.g. "10,5:packet". ' +
      'tcp_flags: RouterOS flag expression e.g. "syn,!ack". ' +
      'place_before: rule number or ID (*N) to insert before e.g. "0" or "*3".',
    inputSchema: {
      chain: z.enum(["input", "forward", "output"]),
      action: z.enum([
        "accept",
        "drop",
        "reject",
        "jump",
        "log",
        "passthrough",
        "return",
        "tarpit",
        "fasttrack-connection",
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
      in_interface_list: z.string().optional(),
      out_interface_list: z.string().optional(),
      connection_state: z
        .string()
        .optional()
        .describe('Comma-separated e.g. "established,related,new,invalid"'),
      src_address_list: z.string().optional(),
      dst_address_list: z.string().optional(),
      hop_limit: z.string().optional().describe('Hop-limit expression e.g. "equal:1" or "less:64"'),
      limit: z.string().optional().describe('RouterOS rate/burst string e.g. "10,5:packet"'),
      tcp_flags: z.string().optional().describe('RouterOS flag expression e.g. "syn,!ack"'),
      port: z.string().optional().describe("Match src or dst port (any protocol with ports)"),
      icmp_options: z.string().optional().describe('ICMPv6 type:code e.g. "128:0"'),
      connection_mark: z.string().optional().describe("Match packets with this connection mark"),
      connection_type: z
        .string()
        .optional()
        .describe('Match connection helper type e.g. "ftp", "sip"'),
      connection_bytes: z
        .string()
        .optional()
        .describe('Match total connection bytes range e.g. "1000000-"'),
      connection_limit: z
        .string()
        .optional()
        .describe('Limit connections per address e.g. "100,128"'),
      connection_rate: z.string().optional().describe('Match connection data rate e.g. "100k-"'),
      packet_mark: z.string().optional().describe("Match packets with this packet mark"),
      routing_mark: z.string().optional().describe("Match packets with this routing mark"),
      packet_size: z.string().optional().describe('Match packet size range e.g. "1400-1500"'),
      dscp: z.string().optional().describe("Match DSCP (0-63)"),
      ingress_priority: z.string().optional().describe("Match ingress priority (0-63)"),
      priority: z.string().optional().describe("Match priority set by mangle (0-63)"),
      src_mac_address: z.string().optional().describe("Match source MAC address"),
      src_address_type: z
        .string()
        .optional()
        .describe('Match src address type e.g. "unicast", "multicast"'),
      dst_address_type: z
        .string()
        .optional()
        .describe('Match dst address type e.g. "unicast", "multicast"'),
      tcp_mss: z.string().optional().describe('Match TCP MSS value/range e.g. "1300-1536"'),
      headers: z.string().optional().describe("Match IPv6 extension headers present in the packet"),
      tls_host: z.string().optional().describe("Match TLS SNI host (glob pattern)"),
      content: z.string().optional().describe("Match packets containing this text"),
      nth: z.string().optional().describe('Match every Nth packet e.g. "2,0"'),
      random: z.string().optional().describe("Randomly match a percentage of packets (1-99)"),
      time: z.string().optional().describe('Match by time/day e.g. "8h-16h,mon,tue"'),
      dst_limit: z
        .string()
        .optional()
        .describe('Per-destination rate limit e.g. "10,5,dst-address"'),
      ipsec_policy: z
        .string()
        .optional()
        .describe('Match IPsec policy e.g. "in,ipsec" or "out,none"'),
      per_connection_classifier: z
        .string()
        .optional()
        .describe('Hash connections into buckets e.g. "both-addresses:2/0"'),
      jump_target: z.string().optional().describe("Target chain name when action=jump"),
      reject_with: z
        .string()
        .optional()
        .describe('ICMPv6 reject response when action=reject e.g. "icmp-admin-prohibited"'),
      address_list: z
        .string()
        .optional()
        .describe("Address-list name when action=add-src/dst-to-address-list"),
      address_list_timeout: z
        .string()
        .optional()
        .describe('Timeout for the added address-list entry e.g. "1d" or "none"'),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
      log: z.boolean().default(false),
      log_prefix: z.string().optional(),
      place_before: z
        .string()
        .optional()
        .describe('Rule number or ID (*N) to insert before e.g. "0" or "*3"'),
    },
    async handler(a, ctx) {
      ctx.info(`Creating IPv6 firewall filter rule: chain=${a.chain}, action=${a.action}`);

      const cmd = new Cmd("/ipv6 firewall filter add")
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
        .opt("connection-state", a.connection_state)
        .opt("src-address-list", a.src_address_list)
        .opt("dst-address-list", a.dst_address_list)
        .opt("hop-limit", a.hop_limit)
        .opt("limit", a.limit)
        .opt("tcp-flags", a.tcp_flags)
        .opt("port", a.port)
        .opt("icmp-options", a.icmp_options)
        .opt("connection-mark", a.connection_mark)
        .opt("connection-type", a.connection_type)
        .opt("connection-bytes", a.connection_bytes)
        .opt("connection-limit", a.connection_limit)
        .opt("connection-rate", a.connection_rate)
        .opt("packet-mark", a.packet_mark)
        .opt("routing-mark", a.routing_mark)
        .opt("packet-size", a.packet_size)
        .opt("dscp", a.dscp)
        .opt("ingress-priority", a.ingress_priority)
        .opt("priority", a.priority)
        .opt("src-mac-address", a.src_mac_address)
        .opt("src-address-type", a.src_address_type)
        .opt("dst-address-type", a.dst_address_type)
        .opt("tcp-mss", a.tcp_mss)
        .opt("headers", a.headers)
        .opt("tls-host", a.tls_host)
        .opt("content", a.content)
        .opt("nth", a.nth)
        .opt("random", a.random)
        .opt("time", a.time)
        .opt("dst-limit", a.dst_limit)
        .opt("ipsec-policy", a.ipsec_policy)
        .opt("per-connection-classifier", a.per_connection_classifier)
        .opt("jump-target", a.jump_target)
        .opt("reject-with", a.reject_with)
        .opt("address-list", a.address_list)
        .opt("address-list-timeout", a.address_list_timeout)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .flag("log", a.log)
        .opt("log-prefix", a.log ? a.log_prefix : undefined);

      const result = await executeRuleCreate("/ipv6 firewall filter", cmd, ctx, a.place_before);

      const trimmed = result.trim();

      if (looksLikeError(trimmed)) {
        return `Failed to create IPv6 firewall filter rule: ${trimmed}`;
      }

      return readCreatedRule("/ipv6 firewall filter", trimmed, "IPv6 firewall filter rule", ctx);
    },
  }),

  defineTool({
    name: "list_ipv6_filter_rules",
    title: "List IPv6 Firewall Filter Rules",
    annotations: READ,
    description:
      "Lists all IPv6 firewall FILTER rules (`/ipv6 firewall filter`) with optional filtering by chain, action, address, protocol, interface, or state flags. " +
      "Returns the ordered rule list including `.id` values needed by get_ipv6_filter_rule, update_ipv6_filter_rule, move_ipv6_filter_rule, enable_ipv6_filter_rule, disable_ipv6_filter_rule, and remove_ipv6_filter_rule. " +
      "For IPv4 filter rules use list_filter_rules; for IPv6 NAT use list_ipv6_nat_rules; for IPv6 mangle use list_ipv6_mangle_rules; for IPv6 raw use list_ipv6_raw_rules.",
    inputSchema: {
      chain_filter: z.string().optional(),
      action_filter: z.string().optional(),
      src_address_filter: z.string().optional(),
      dst_address_filter: z.string().optional(),
      protocol_filter: z.string().optional(),
      interface_filter: z.string().optional(),
      disabled_only: z.boolean().default(false),
      invalid_only: z.boolean().default(false),
      dynamic_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info("Listing IPv6 firewall filter rules");

      const filters: string[] = [];
      if (a.chain_filter) filters.push(`chain=${a.chain_filter}`);
      if (a.action_filter) filters.push(`action=${a.action_filter}`);
      if (a.src_address_filter) filters.push(`src-address~"${a.src_address_filter}"`);
      if (a.dst_address_filter) filters.push(`dst-address~"${a.dst_address_filter}"`);
      if (a.protocol_filter) filters.push(`protocol=${a.protocol_filter}`);
      if (a.interface_filter) {
        filters.push(
          `(in-interface~"${a.interface_filter}" or out-interface~"${a.interface_filter}")`,
        );
      }
      if (a.disabled_only) filters.push("disabled=yes");
      if (a.invalid_only) filters.push("invalid=yes");
      if (a.dynamic_only) filters.push("dynamic=yes");

      const result = await executeMikrotikCommand(
        `/ipv6 firewall filter print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No IPv6 firewall filter rules found matching the criteria."
        : `IPV6 FIREWALL FILTER RULES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_ipv6_filter_rule",
    title: "Get IPv6 Firewall Filter Rule",
    annotations: READ,
    description:
      "Fetches full detail of a single IPv6 firewall FILTER rule (`/ipv6 firewall filter print detail where .id=…`). " +
      "Use when you need all fields of one specific rule rather than the full list. " +
      "For the complete ordered list use list_ipv6_filter_rules; for the IPv4 equivalent use get_filter_rule. " +
      'rule_id takes the `.id` from list_ipv6_filter_rules output e.g. "*1" or "0".',
    inputSchema: {
      rule_id: z.string().describe('Rule ID from list output e.g. "*1" or "0"'),
    },
    async handler(a, ctx) {
      ctx.info(`Getting IPv6 firewall filter rule details: rule_id=${a.rule_id}`);

      const id = await resolveRuleId(a.rule_id, ctx);
      if (!id) return `IPv6 firewall filter rule '${a.rule_id}' not found.`;

      const result = await executeMikrotikCommand(
        `/ipv6 firewall filter print detail where .id=${id}`,
        ctx,
      );
      return isEmpty(result)
        ? `IPv6 firewall filter rule '${a.rule_id}' not found.`
        : `IPV6 FIREWALL FILTER RULE DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_ipv6_filter_rule",
    title: "Update IPv6 Firewall Filter Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modifies one or more fields of an existing IPv6 firewall FILTER rule (`/ipv6 firewall filter set`) then returns the updated rule detail. " +
      "Only supplied fields are changed; omit a field to leave it untouched. " +
      'Pass "" (empty string) to clear an optional field (e.g. src_address=""). ' +
      "To toggle enabled/disabled state only, prefer enable_ipv6_filter_rule or disable_ipv6_filter_rule. " +
      "For the IPv4 equivalent use update_filter_rule. " +
      'rule_id takes the `.id` from list_ipv6_filter_rules e.g. "*1" or "0".',
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
      connection_state: z.string().optional(),
      src_address_list: z.string().optional(),
      dst_address_list: z.string().optional(),
      hop_limit: z.string().optional(),
      limit: z.string().optional(),
      tcp_flags: z.string().optional(),
      port: z.string().optional(),
      icmp_options: z.string().optional(),
      connection_mark: z.string().optional(),
      connection_type: z.string().optional(),
      connection_bytes: z.string().optional(),
      connection_limit: z.string().optional(),
      connection_rate: z.string().optional(),
      packet_mark: z.string().optional(),
      routing_mark: z.string().optional(),
      packet_size: z.string().optional(),
      dscp: z.string().optional(),
      ingress_priority: z.string().optional(),
      priority: z.string().optional(),
      src_mac_address: z.string().optional(),
      src_address_type: z.string().optional(),
      dst_address_type: z.string().optional(),
      tcp_mss: z.string().optional(),
      headers: z.string().optional(),
      tls_host: z.string().optional(),
      content: z.string().optional(),
      nth: z.string().optional(),
      random: z.string().optional(),
      time: z.string().optional(),
      dst_limit: z.string().optional(),
      ipsec_policy: z.string().optional(),
      per_connection_classifier: z.string().optional(),
      jump_target: z.string().optional(),
      reject_with: z.string().optional(),
      address_list: z.string().optional(),
      address_list_timeout: z.string().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
      log: z.boolean().optional(),
      log_prefix: z.string().optional(),
    },
    async handler(a, ctx) {
      return updateFilterRule(a, ctx);
    },
  }),

  defineTool({
    name: "remove_ipv6_filter_rule",
    title: "Remove IPv6 Firewall Filter Rule",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes an IPv6 firewall FILTER rule (`/ipv6 firewall filter remove`) after verifying the rule exists via a count-only check. " +
      "To temporarily suppress a rule without deleting it use disable_ipv6_filter_rule instead. " +
      "For the IPv4 equivalent use remove_filter_rule. " +
      'rule_id takes the `.id` from list_ipv6_filter_rules e.g. "*1" or "0".',
    inputSchema: { rule_id: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing IPv6 firewall filter rule: rule_id=${a.rule_id}`);

      const id = await resolveRuleId(a.rule_id, ctx);
      if (!id) return `IPv6 firewall filter rule '${a.rule_id}' not found.`;

      const result = await executeMikrotikCommand(`/ipv6 firewall filter remove ${id}`, ctx);
      if (looksLikeError(result)) return `Failed to remove IPv6 firewall filter rule: ${result}`;
      return `IPv6 firewall filter rule '${a.rule_id}' (${id}) removed successfully.`;
    },
  }),

  defineTool({
    name: "move_ipv6_filter_rule",
    title: "Move IPv6 Firewall Filter Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Reorders an IPv6 firewall FILTER rule to a target position within its chain (`/ipv6 firewall filter move`). " +
      "Evaluation order is top-to-bottom; use this to ensure a rule fires before or after others. " +
      "For the IPv4 equivalent use move_filter_rule; for IPv6 NAT reordering use move_ipv6_nat_rule. " +
      "rule_id takes the `.id` from list_ipv6_filter_rules; destination is the 0-based target position index.",
    inputSchema: {
      rule_id: z.string(),
      destination: z.number().int().describe("0-based target position index"),
    },
    async handler(a, ctx) {
      ctx.info(
        `Moving IPv6 firewall filter rule: rule_id=${a.rule_id} to position ${a.destination}`,
      );

      const id = await resolveRuleId(a.rule_id, ctx);
      if (!id) return `IPv6 firewall filter rule '${a.rule_id}' not found.`;

      const before = await listItemIds("/ipv6 firewall filter", ctx);
      const from = before.indexOf(id);
      if (a.destination < 0 || a.destination >= before.length) {
        return `NO CHANGE: destination ${a.destination} is outside the ${before.length} rule positions.`;
      }
      if (from === a.destination)
        return `NO CHANGE: IPv6 firewall filter rule ${id} is already at position ${from}.`;
      const result = await executeMikrotikCommand(
        `/ipv6 firewall filter move ${id} ${before[a.destination]}`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to move IPv6 firewall filter rule: ${result}`;
      const after = await listItemIds("/ipv6 firewall filter", ctx);
      const to = after.indexOf(id);
      return to === a.destination
        ? `IPv6 firewall filter rule '${a.rule_id}' (${id}) moved to position ${to}.`
        : `NO CHANGE or different position: IPv6 firewall filter rule ${id} is at ${to} (requested ${a.destination}); inspect list_ipv6_filter_rules.`;
    },
  }),

  defineTool({
    name: "enable_ipv6_filter_rule",
    title: "Enable IPv6 Firewall Filter Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Re-enables a previously disabled IPv6 firewall FILTER rule (`/ipv6 firewall filter set disabled=no`) without altering any other field. " +
      "For the IPv4 equivalent use enable_filter_rule; to disable use disable_ipv6_filter_rule; to change other fields use update_ipv6_filter_rule. " +
      'rule_id takes the `.id` from list_ipv6_filter_rules e.g. "*1" or "0".',
    inputSchema: { rule_id: z.string() },
    async handler(a, ctx) {
      return updateFilterRule({ rule_id: a.rule_id, disabled: false }, ctx);
    },
  }),

  defineTool({
    name: "disable_ipv6_filter_rule",
    title: "Disable IPv6 Firewall Filter Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Temporarily disables an IPv6 firewall FILTER rule (`/ipv6 firewall filter set disabled=yes`) without deleting it — the rule remains in the list but is skipped during packet evaluation. " +
      "For the IPv4 equivalent use disable_filter_rule; to re-enable use enable_ipv6_filter_rule; to permanently remove use remove_ipv6_filter_rule. " +
      'rule_id takes the `.id` from list_ipv6_filter_rules e.g. "*1" or "0".',
    inputSchema: { rule_id: z.string() },
    async handler(a, ctx) {
      return updateFilterRule({ rule_id: a.rule_id, disabled: true }, ctx);
    },
  }),
];
