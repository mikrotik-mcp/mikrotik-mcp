/** Firewall mangle rules — `/ip firewall mangle`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import {
  whereClause,
  quoteValue,
  placeBeforeError,
  looksLikeError,
  isEmpty,
  Cmd,
} from "../core/routeros";
import type { ToolContext } from "../core/context";
import { ruleResolver } from "./_resolve-rule-id";
import { executeRuleCreate, readCreatedRule } from "./_create-rule";

const resolveMangleRuleId = ruleResolver("/ip firewall mangle");

/** Shared update routine — used by update/enable/disable. */
async function updateMangleRule(
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
    src_mac_address?: string;
    in_interface?: string;
    out_interface?: string;
    in_interface_list?: string;
    out_interface_list?: string;
    src_address_list?: string;
    dst_address_list?: string;
    src_address_type?: string;
    dst_address_type?: string;
    connection_mark?: string;
    packet_mark?: string;
    routing_mark?: string;
    connection_state?: string;
    connection_nat_state?: string;
    connection_type?: string;
    connection_bytes?: string;
    connection_limit?: string;
    connection_rate?: string;
    per_connection_classifier?: string;
    tcp_flags?: string;
    dscp?: string;
    priority?: string;
    packet_size?: string;
    ttl?: string;
    tcp_mss?: string;
    fragment?: boolean;
    icmp_options?: string;
    ipv4_options?: string;
    limit?: string;
    dst_limit?: string;
    content?: string;
    psd?: string;
    layer7_protocol?: string;
    ipsec_policy?: string;
    nth?: string;
    random?: string;
    time?: string;
    hotspot?: string;
    p2p?: string;
    new_connection_mark?: string;
    new_packet_mark?: string;
    new_routing_mark?: string;
    new_dscp?: string;
    new_ttl?: string;
    new_mss?: string;
    new_priority?: string;
    routing_table?: string;
    route_dst?: string;
    jump_target?: string;
    sniff_target?: string;
    sniff_target_port?: string;
    address_list?: string;
    address_list_timeout?: string;
    passthrough?: boolean;
    comment?: string;
    disabled?: boolean;
    log?: boolean;
    log_prefix?: string;
  },
  ctx: ToolContext,
): Promise<string> {
  ctx.info(`Updating mangle rule: rule_id=${a.rule_id}`);

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
  put("port", a.port);
  put("protocol", a.protocol);
  put("src-mac-address", a.src_mac_address);
  put("in-interface", a.in_interface);
  put("out-interface", a.out_interface);
  put("in-interface-list", a.in_interface_list);
  put("out-interface-list", a.out_interface_list);
  put("src-address-list", a.src_address_list);
  put("dst-address-list", a.dst_address_list);
  put("src-address-type", a.src_address_type);
  put("dst-address-type", a.dst_address_type);
  put("connection-mark", a.connection_mark);
  put("packet-mark", a.packet_mark);
  put("routing-mark", a.routing_mark);
  put("connection-state", a.connection_state);
  put("connection-nat-state", a.connection_nat_state);
  put("connection-type", a.connection_type);
  put("connection-bytes", a.connection_bytes);
  put("connection-limit", a.connection_limit);
  put("connection-rate", a.connection_rate);
  put("per-connection-classifier", a.per_connection_classifier);
  put("tcp-flags", a.tcp_flags);
  put("dscp", a.dscp);
  put("priority", a.priority);
  put("packet-size", a.packet_size);
  put("ttl", a.ttl);
  put("tcp-mss", a.tcp_mss);
  if (a.fragment !== undefined) updates.push(`fragment=${a.fragment ? "yes" : "no"}`);
  put("icmp-options", a.icmp_options);
  put("ipv4-options", a.ipv4_options);
  put("limit", a.limit);
  put("dst-limit", a.dst_limit);
  put("content", a.content);
  put("psd", a.psd);
  put("layer7-protocol", a.layer7_protocol);
  put("ipsec-policy", a.ipsec_policy);
  put("nth", a.nth);
  put("random", a.random);
  put("time", a.time);
  put("hotspot", a.hotspot);
  put("p2p", a.p2p);
  put("new-connection-mark", a.new_connection_mark);
  put("new-packet-mark", a.new_packet_mark);
  put("new-routing-mark", a.new_routing_mark);
  put("new-dscp", a.new_dscp);
  put("new-ttl", a.new_ttl);
  put("new-mss", a.new_mss);
  put("new-priority", a.new_priority);
  put("routing-table", a.routing_table);
  put("route-dst", a.route_dst);
  put("jump-target", a.jump_target);
  put("sniff-target", a.sniff_target);
  put("sniff-target-port", a.sniff_target_port);
  put("address-list", a.address_list);
  put("address-list-timeout", a.address_list_timeout);
  if (a.passthrough !== undefined) updates.push(`passthrough=${a.passthrough ? "yes" : "no"}`);
  if (a.comment !== undefined) updates.push(`comment=${quoteValue(a.comment)}`);
  if (a.disabled !== undefined) updates.push(`disabled=${a.disabled ? "yes" : "no"}`);
  if (a.log !== undefined) {
    updates.push(`log=${a.log ? "yes" : "no"}`);
    if (a.log && a.log_prefix) updates.push(`log-prefix=${quoteValue(a.log_prefix)}`);
  }

  if (updates.length === 0) return "No updates specified.";

  const id = await resolveMangleRuleId(a.rule_id, ctx);
  if (!id) return `Mangle rule '${a.rule_id}' not found.`;
  const cmd = `/ip firewall mangle set ${id} ${updates.join(" ")}`;
  const result = await executeMikrotikCommand(cmd, ctx);
  if (looksLikeError(result)) return `Failed to update mangle rule: ${result}`;

  const details = await executeMikrotikCommand(
    `/ip firewall mangle print detail where .id=${id}`,
    ctx,
  );
  return `Mangle rule updated successfully:\n\n${details}`;
}

export const firewallMangleTools: ToolModule = [
  defineTool({
    name: "create_mangle_rule",
    title: "Create IPv4 Firewall Mangle Rule",
    annotations: WRITE,
    description:
      "Creates an IPv4 mangle rule (`/ip firewall mangle add`) — the packet-marking and header-modification table, " +
      "used to mark connections/packets/routing (for policy routing, QoS and per-connection classification) or to change DSCP/TTL/MSS. " +
      "For accept/drop decisions use create_filter_rule; for address translation use create_nat_rule; for IPv6 mangle use create_ipv6_mangle_rule. " +
      "chain: prerouting/input/forward/output/postrouting. " +
      "action: mark-connection/mark-packet/mark-routing/change-dscp/change-ttl/change-mss/add-src-to-address-list/add-dst-to-address-list/fasttrack-connection/route/set-priority/accept/etc. " +
      "Set the matching new-*-mark field for mark-* actions and keep passthrough=true so later rules can also match the same packet; " +
      "for add-*-to-address-list set address_list (and optionally address_list_timeout). " +
      "Full match surface: address-lists (src_address_list/dst_address_list — negate with a leading '!', e.g. dst_address_list='!IR' to route traffic NOT bound for a list), " +
      "interface-lists, per_connection_classifier (PCC load-balancing), connection_nat_state, tcp_flags, dscp, layer7_protocol, time, and more. " +
      "Typical policy-routing rule: chain=prerouting, src_address=<lan>, dst_address_list='!IR', action=mark-routing, new_routing_mark=<table>, then a routing rule/route uses that table. " +
      "place_before accepts a rule number or ID (*N) to control insertion position. " +
      "Returns the created rule's detail including its `.id`.",
    inputSchema: {
      chain: z.enum(["prerouting", "input", "forward", "output", "postrouting"]),
      action: z.enum([
        "accept",
        "add-dst-to-address-list",
        "add-src-to-address-list",
        "change-dscp",
        "change-mss",
        "change-ttl",
        "clear-df",
        "drop",
        "fasttrack-connection",
        "jump",
        "log",
        "mark-connection",
        "mark-packet",
        "mark-routing",
        "passthrough",
        "return",
        "route",
        "set-priority",
        "sniff-pc",
        "sniff-tzsp",
      ]),
      src_address: z.string().optional(),
      dst_address: z.string().optional(),
      src_port: z.string().optional(),
      dst_port: z.string().optional(),
      port: z.string().optional().describe("Match if src OR dst port matches (with protocol)"),
      protocol: z.string().optional(),
      src_mac_address: z.string().optional().describe('Source MAC, negatable e.g. "!00:11:..."'),
      in_interface: z.string().optional().describe('Negatable, e.g. "!ether1"'),
      out_interface: z.string().optional(),
      in_interface_list: z.string().optional().describe('Interface list, negatable e.g. "!WAN"'),
      out_interface_list: z.string().optional(),
      // Address-list matches (the key gap for policy routing). Negate with a
      // leading "!", e.g. dst_address_list="!IR" → "destination NOT in list IR".
      src_address_list: z.string().optional().describe('Match src in a named list; negate "!name"'),
      dst_address_list: z
        .string()
        .optional()
        .describe('Match dst in a named list; negate "!name" (e.g. "!IR" routes foreign traffic)'),
      src_address_type: z.string().optional().describe('e.g. "local", "unicast", "!local"'),
      dst_address_type: z.string().optional(),
      connection_mark: z.string().optional(),
      packet_mark: z.string().optional(),
      routing_mark: z.string().optional(),
      connection_state: z
        .string()
        .optional()
        .describe('e.g. "new", "established,related", "!invalid"'),
      connection_nat_state: z.string().optional().describe('"srcnat" / "dstnat" / "!dstnat"'),
      connection_type: z.string().optional().describe('Helper, e.g. "sip", "ftp"'),
      connection_bytes: z.string().optional().describe('e.g. "1000000-0" (>1 MB connections)'),
      connection_limit: z.string().optional().describe('e.g. "100,32"'),
      connection_rate: z.string().optional().describe('e.g. "100k-1M"'),
      per_connection_classifier: z
        .string()
        .optional()
        .describe('PCC for load balancing, e.g. "both-addresses:2/0"'),
      tcp_flags: z.string().optional().describe('RouterOS flag expression e.g. "syn,!ack"'),
      dscp: z.string().optional().describe("Match incoming DSCP (0-63)"),
      priority: z.string().optional().describe("Match packet/queue priority (0-63)"),
      packet_size: z.string().optional().describe('e.g. "1500" or "0-500"'),
      ttl: z.string().optional().describe('Match TTL, e.g. "equal:64", "less-than:10"'),
      tcp_mss: z.string().optional().describe('Match TCP MSS, e.g. "1400-1500" or "!1460"'),
      fragment: z.boolean().optional().describe("Match second and further fragments"),
      icmp_options: z.string().optional().describe('Match ICMP type:code, e.g. "8:0"'),
      ipv4_options: z
        .string()
        .optional()
        .describe('e.g. "any", "loose-source-routing", "record-route"'),
      limit: z.string().optional().describe('Rate limit matcher, e.g. "50,5:packet"'),
      dst_limit: z
        .string()
        .optional()
        .describe('Per-destination rate matcher, e.g. "50,5,dst-address/1m"'),
      content: z.string().optional().describe("Match packets containing this text"),
      psd: z.string().optional().describe('Port scan detection, e.g. "21,3s,3,1"'),
      layer7_protocol: z
        .string()
        .optional()
        .describe("Name of an /ip firewall layer7-protocol regex"),
      ipsec_policy: z.string().optional().describe('e.g. "in,ipsec" or "out,none"'),
      nth: z.string().optional().describe('e.g. "2,1" — every 2nd packet'),
      random: z.string().optional().describe("Match a random N% of packets (1-99)"),
      time: z.string().optional().describe('e.g. "8h-16h,mon,tue,wed,thu,fri"'),
      hotspot: z.string().optional().describe('e.g. "auth", "!auth", "from-client"'),
      p2p: z.string().optional(),
      new_connection_mark: z.string().optional(),
      new_packet_mark: z.string().optional(),
      new_routing_mark: z.string().optional(),
      new_dscp: z.string().optional().describe("0-63, for change-dscp"),
      new_ttl: z.string().optional().describe('e.g. "decrement", "increment", or "set:64"'),
      new_mss: z.string().optional().describe('e.g. "1440" or "clamp-to-pmtu", for change-mss'),
      new_priority: z
        .string()
        .optional()
        .describe('Priority for action=set-priority, e.g. "4", "from-dscp", "from-ingress"'),
      routing_table: z.string().optional().describe("Routing table for action=route"),
      route_dst: z.string().optional().describe("Gateway IP for action=route"),
      jump_target: z.string().optional().describe("Target chain name for action=jump"),
      sniff_target: z.string().optional().describe("Collector IP for action=sniff-tzsp/sniff-pc"),
      sniff_target_port: z.string().optional().describe("Collector UDP port for action=sniff-tzsp"),
      address_list: z
        .string()
        .optional()
        .describe("Target list name for add-src/dst-to-address-list"),
      address_list_timeout: z
        .string()
        .optional()
        .describe('Entry timeout for add-*-to-address-list e.g. "1h", "none"'),
      passthrough: z.boolean().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
      log: z.boolean().default(false),
      log_prefix: z.string().optional(),
      place_before: z.string().optional().describe("Rule number or ID (*N) to insert before"),
    },
    async handler(a, ctx) {
      ctx.info(`Creating mangle rule: chain=${a.chain}, action=${a.action}`);

      const cmd = new Cmd("/ip firewall mangle add")
        .set("chain", a.chain)
        .set("action", a.action)
        .opt("src-address", a.src_address)
        .opt("dst-address", a.dst_address)
        .opt("src-port", a.src_port)
        .opt("dst-port", a.dst_port)
        .opt("port", a.port)
        .opt("protocol", a.protocol)
        .opt("src-mac-address", a.src_mac_address)
        .opt("in-interface", a.in_interface)
        .opt("out-interface", a.out_interface)
        .opt("in-interface-list", a.in_interface_list)
        .opt("out-interface-list", a.out_interface_list)
        .opt("src-address-list", a.src_address_list)
        .opt("dst-address-list", a.dst_address_list)
        .opt("src-address-type", a.src_address_type)
        .opt("dst-address-type", a.dst_address_type)
        .opt("connection-mark", a.connection_mark)
        .opt("packet-mark", a.packet_mark)
        .opt("routing-mark", a.routing_mark)
        .opt("connection-state", a.connection_state)
        .opt("connection-nat-state", a.connection_nat_state)
        .opt("connection-type", a.connection_type)
        .opt("connection-bytes", a.connection_bytes)
        .opt("connection-limit", a.connection_limit)
        .opt("connection-rate", a.connection_rate)
        .opt("per-connection-classifier", a.per_connection_classifier)
        .opt("tcp-flags", a.tcp_flags)
        .opt("dscp", a.dscp)
        .opt("priority", a.priority)
        .opt("packet-size", a.packet_size)
        .opt("ttl", a.ttl)
        .opt("tcp-mss", a.tcp_mss)
        .bool("fragment", a.fragment)
        .opt("icmp-options", a.icmp_options)
        .opt("ipv4-options", a.ipv4_options)
        .opt("limit", a.limit)
        .opt("dst-limit", a.dst_limit)
        .opt("content", a.content)
        .opt("psd", a.psd)
        .opt("layer7-protocol", a.layer7_protocol)
        .opt("ipsec-policy", a.ipsec_policy)
        .opt("nth", a.nth)
        .opt("random", a.random)
        .opt("time", a.time)
        .opt("hotspot", a.hotspot)
        .opt("p2p", a.p2p)
        .opt("new-connection-mark", a.new_connection_mark)
        .opt("new-packet-mark", a.new_packet_mark)
        .opt("new-routing-mark", a.new_routing_mark)
        .opt("new-dscp", a.new_dscp)
        .opt("new-ttl", a.new_ttl)
        .opt("new-mss", a.new_mss)
        .opt("new-priority", a.new_priority)
        .opt("routing-table", a.routing_table)
        .opt("route-dst", a.route_dst)
        .opt("jump-target", a.jump_target)
        .opt("sniff-target", a.sniff_target)
        .opt("sniff-target-port", a.sniff_target_port)
        .opt("address-list", a.address_list)
        .opt("address-list-timeout", a.address_list_timeout)
        .bool("passthrough", a.passthrough)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .flag("log", a.log)
        .opt("log-prefix", a.log ? a.log_prefix : undefined);

      const result = await executeRuleCreate("/ip firewall mangle", cmd, ctx, a.place_before);

      const trimmed = result.trim();

      // A device error (e.g. a bad place-before) — surface it, never "created".
      if (looksLikeError(trimmed)) {
        const hint = placeBeforeError(trimmed, a.place_before);
        return `Failed to create mangle rule: ${hint ?? trimmed}`;
      }

      return readCreatedRule("/ip firewall mangle", trimmed, "Mangle rule", ctx);
    },
  }),

  defineTool({
    name: "list_mangle_rules",
    title: "List IPv4 Firewall Mangle Rules",
    annotations: READ,
    description:
      "Lists IPv4 mangle rules (`/ip firewall mangle print`) — returns all rules in the mangle table with their IDs, chains, actions, and match criteria. " +
      "For IPv4 filter use list_filter_rules; for IPv4 NAT use list_nat_rules; for IPv6 mangle use list_ipv6_mangle_rules. " +
      "Optionally filter by chain, action, connection-mark, packet-mark, disabled, invalid, or dynamic status. " +
      "Rule `.id` values from this output are required by get_mangle_rule, update_mangle_rule, remove_mangle_rule, move_mangle_rule, enable_mangle_rule, and disable_mangle_rule.",
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
      ctx.info("Listing mangle rules");

      const filters: string[] = [];
      if (a.chain_filter) filters.push(`chain=${a.chain_filter}`);
      if (a.action_filter) filters.push(`action=${a.action_filter}`);
      if (a.connection_mark_filter) filters.push(`connection-mark="${a.connection_mark_filter}"`);
      if (a.packet_mark_filter) filters.push(`packet-mark="${a.packet_mark_filter}"`);
      if (a.disabled_only) filters.push("disabled=yes");
      if (a.invalid_only) filters.push("invalid=yes");
      if (a.dynamic_only) filters.push("dynamic=yes");

      const result = await executeMikrotikCommand(
        `/ip firewall mangle print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No mangle rules found matching the criteria."
        : `MANGLE RULES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_mangle_rule",
    title: "Get IPv4 Firewall Mangle Rule Details",
    annotations: READ,
    description:
      "Retrieves full detail for a single IPv4 mangle rule (`/ip firewall mangle print detail where .id=`). " +
      "Use when you need all fields of one specific rule rather than the full table listing. " +
      "For the full list use list_mangle_rules; for IPv6 mangle use get_ipv6_mangle_rule. " +
      'rule_id takes the `.id` value (e.g. "*1" or "0") returned by list_mangle_rules.',
    inputSchema: {
      rule_id: z.string().describe('Rule ID from list output e.g. "*1" or "0"'),
    },
    async handler(a, ctx) {
      ctx.info(`Getting mangle rule details: rule_id=${a.rule_id}`);

      const id = await resolveMangleRuleId(a.rule_id, ctx);
      if (!id) return `Mangle rule '${a.rule_id}' not found.`;

      const result = await executeMikrotikCommand(
        `/ip firewall mangle print detail where .id=${id}`,
        ctx,
      );
      return isEmpty(result)
        ? `Mangle rule '${a.rule_id}' not found.`
        : `MANGLE RULE DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_mangle_rule",
    title: "Update IPv4 Firewall Mangle Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Updates fields on an existing IPv4 mangle rule (`/ip firewall mangle set`) — change chain, action, match criteria, mark values, DSCP, TTL, MSS, or flags without recreating the rule. " +
      "To toggle enabled state only use enable_mangle_rule or disable_mangle_rule; for IPv6 mangle use update_ipv6_mangle_rule. " +
      "rule_id takes the `.id` from list_mangle_rules. " +
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
      port: z.string().optional(),
      protocol: z.string().optional(),
      src_mac_address: z.string().optional(),
      in_interface: z.string().optional(),
      out_interface: z.string().optional(),
      in_interface_list: z.string().optional(),
      out_interface_list: z.string().optional(),
      src_address_list: z.string().optional().describe('Negate with "!name" (e.g. "!IR")'),
      dst_address_list: z.string().optional().describe('Negate with "!name" (e.g. "!IR")'),
      src_address_type: z.string().optional(),
      dst_address_type: z.string().optional(),
      connection_mark: z.string().optional(),
      packet_mark: z.string().optional(),
      routing_mark: z.string().optional(),
      connection_state: z.string().optional(),
      connection_nat_state: z.string().optional(),
      connection_type: z.string().optional(),
      connection_bytes: z.string().optional(),
      connection_limit: z.string().optional(),
      connection_rate: z.string().optional(),
      per_connection_classifier: z.string().optional(),
      tcp_flags: z.string().optional(),
      dscp: z.string().optional(),
      priority: z.string().optional(),
      packet_size: z.string().optional(),
      ttl: z.string().optional(),
      tcp_mss: z.string().optional(),
      fragment: z.boolean().optional(),
      icmp_options: z.string().optional(),
      ipv4_options: z.string().optional(),
      limit: z.string().optional(),
      dst_limit: z.string().optional(),
      content: z.string().optional(),
      psd: z.string().optional(),
      layer7_protocol: z.string().optional(),
      ipsec_policy: z.string().optional(),
      nth: z.string().optional(),
      random: z.string().optional(),
      time: z.string().optional(),
      hotspot: z.string().optional(),
      p2p: z.string().optional(),
      new_connection_mark: z.string().optional(),
      new_packet_mark: z.string().optional(),
      new_routing_mark: z.string().optional(),
      new_dscp: z.string().optional(),
      new_ttl: z.string().optional(),
      new_mss: z.string().optional(),
      new_priority: z.string().optional(),
      routing_table: z.string().optional(),
      route_dst: z.string().optional(),
      jump_target: z.string().optional(),
      sniff_target: z.string().optional(),
      sniff_target_port: z.string().optional(),
      address_list: z.string().optional(),
      address_list_timeout: z.string().optional(),
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
    name: "remove_mangle_rule",
    title: "Remove IPv4 Firewall Mangle Rule",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes an IPv4 mangle rule (`/ip firewall mangle remove`) — verifies the rule exists first, then removes it. " +
      "To only deactivate without deleting use disable_mangle_rule; for IPv6 mangle use remove_ipv6_mangle_rule. " +
      "rule_id takes the `.id` from list_mangle_rules. " +
      "Returns confirmation on success or a not-found message if the ID is absent.",
    inputSchema: { rule_id: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing mangle rule: rule_id=${a.rule_id}`);

      const id = await resolveMangleRuleId(a.rule_id, ctx);
      if (!id) return `Mangle rule '${a.rule_id}' not found.`;

      const result = await executeMikrotikCommand(`/ip firewall mangle remove ${id}`, ctx);
      if (looksLikeError(result)) return `Failed to remove mangle rule: ${result}`;
      return `Mangle rule '${a.rule_id}' (${id}) removed successfully.`;
    },
  }),

  defineTool({
    name: "move_mangle_rule",
    title: "Move IPv4 Firewall Mangle Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Reorders an IPv4 mangle rule to a specific position (`/ip firewall mangle move`) — mangle rules are evaluated top-down, so position controls which rules fire first. " +
      "For IPv4 filter reordering use move_filter_rule; for IPv6 mangle use move_ipv6_mangle_rule. " +
      "rule_id takes the `.id` from list_mangle_rules; destination is the 0-based target index. " +
      "Verifies the rule exists before moving.",
    inputSchema: {
      rule_id: z.string(),
      destination: z.number().int().describe("0-based target position index"),
    },
    async handler(a, ctx) {
      ctx.info(`Moving mangle rule: rule_id=${a.rule_id} to position ${a.destination}`);

      const id = await resolveMangleRuleId(a.rule_id, ctx);
      if (!id) return `Mangle rule '${a.rule_id}' not found.`;

      const result = await executeMikrotikCommand(
        `/ip firewall mangle move ${id} destination=${a.destination}`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to move mangle rule: ${result}`;
      return `Mangle rule '${a.rule_id}' (${id}) moved to position ${a.destination}.`;
    },
  }),

  defineTool({
    name: "enable_mangle_rule",
    title: "Enable IPv4 Firewall Mangle Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Enables a disabled IPv4 mangle rule (`/ip firewall mangle set disabled=no`) so it participates in packet processing again. " +
      "To deactivate use disable_mangle_rule; to delete permanently use remove_mangle_rule; for IPv6 mangle use enable_ipv6_mangle_rule. " +
      "rule_id takes the `.id` from list_mangle_rules. " +
      "Returns the updated rule's detail.",
    inputSchema: { rule_id: z.string() },
    async handler(a, ctx) {
      return updateMangleRule({ rule_id: a.rule_id, disabled: false }, ctx);
    },
  }),

  defineTool({
    name: "disable_mangle_rule",
    title: "Disable IPv4 Firewall Mangle Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Disables an active IPv4 mangle rule (`/ip firewall mangle set disabled=yes`) — the rule remains in the table but is skipped during packet processing. " +
      "To re-enable use enable_mangle_rule; to delete permanently use remove_mangle_rule; for IPv6 mangle use disable_ipv6_mangle_rule. " +
      "rule_id takes the `.id` from list_mangle_rules. " +
      "Returns the updated rule's detail.",
    inputSchema: { rule_id: z.string() },
    async handler(a, ctx) {
      return updateMangleRule({ rule_id: a.rule_id, disabled: true }, ctx);
    },
  }),
];
