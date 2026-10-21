/** Firewall NAT rules — `/ip firewall nat`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import {
  whereClause,
  quoteValue,
  looksLikeError,
  isEmpty,
  placeBeforeError,
  Cmd,
} from "../core/routeros";
import type { ToolContext } from "../core/context";
import { ruleResolver } from "./_resolve-rule-id";
import { executeRuleCreate, readCreatedRule } from "./_create-rule";

const resolveNatRuleId = ruleResolver("/ip firewall nat");

/** Shared update routine — used by update/enable/disable. */
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
    in_interface_list?: string;
    out_interface_list?: string;
    src_address_list?: string;
    dst_address_list?: string;
    connection_mark?: string;
    connection_nat_state?: string;
    connection_state?: string;
    connection_type?: string;
    connection_bytes?: string;
    connection_limit?: string;
    connection_rate?: string;
    port?: string;
    src_mac_address?: string;
    packet_mark?: string;
    routing_mark?: string;
    src_address_type?: string;
    dst_address_type?: string;
    in_bridge_port?: string;
    out_bridge_port?: string;
    in_bridge_port_list?: string;
    out_bridge_port_list?: string;
    icmp_options?: string;
    ipsec_policy?: string;
    layer7_protocol?: string;
    content?: string;
    dscp?: string;
    priority?: string;
    tcp_flags?: string;
    tcp_mss?: string;
    packet_size?: string;
    limit?: string;
    nth?: string;
    psd?: string;
    random?: string;
    per_connection_classifier?: string;
    time?: string;
    ttl?: string;
    hotspot?: string;
    jump_target?: string;
    address_list?: string;
    address_list_timeout?: string;
    fragment?: boolean;
    to_addresses?: string;
    to_ports?: string;
    comment?: string;
    disabled?: boolean;
    log?: boolean;
    log_prefix?: string;
  },
  ctx: ToolContext,
): Promise<string> {
  ctx.info(`Updating NAT rule: rule_id=${a.rule_id}`);

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
  put("src-address-list", a.src_address_list);
  put("dst-address-list", a.dst_address_list);
  put("connection-mark", a.connection_mark);
  put("connection-nat-state", a.connection_nat_state);
  put("connection-state", a.connection_state);
  put("connection-type", a.connection_type);
  put("connection-bytes", a.connection_bytes);
  put("connection-limit", a.connection_limit);
  put("connection-rate", a.connection_rate);
  put("port", a.port);
  put("src-mac-address", a.src_mac_address);
  put("packet-mark", a.packet_mark);
  put("routing-mark", a.routing_mark);
  put("src-address-type", a.src_address_type);
  put("dst-address-type", a.dst_address_type);
  put("in-bridge-port", a.in_bridge_port);
  put("out-bridge-port", a.out_bridge_port);
  put("in-bridge-port-list", a.in_bridge_port_list);
  put("out-bridge-port-list", a.out_bridge_port_list);
  put("icmp-options", a.icmp_options);
  put("ipsec-policy", a.ipsec_policy);
  put("layer7-protocol", a.layer7_protocol);
  put("content", a.content);
  put("dscp", a.dscp);
  put("priority", a.priority);
  put("tcp-flags", a.tcp_flags);
  put("tcp-mss", a.tcp_mss);
  put("packet-size", a.packet_size);
  put("limit", a.limit);
  put("nth", a.nth);
  put("psd", a.psd);
  put("random", a.random);
  put("per-connection-classifier", a.per_connection_classifier);
  put("time", a.time);
  put("ttl", a.ttl);
  put("hotspot", a.hotspot);
  put("jump-target", a.jump_target);
  put("address-list", a.address_list);
  put("address-list-timeout", a.address_list_timeout);
  if (a.fragment !== undefined) updates.push(`fragment=${a.fragment ? "yes" : "no"}`);
  put("to-addresses", a.to_addresses);
  put("to-ports", a.to_ports);
  if (a.comment !== undefined) updates.push(`comment=${quoteValue(a.comment)}`);
  if (a.disabled !== undefined) updates.push(`disabled=${a.disabled ? "yes" : "no"}`);
  if (a.log !== undefined) {
    updates.push(`log=${a.log ? "yes" : "no"}`);
    if (a.log && a.log_prefix) updates.push(`log-prefix=${quoteValue(a.log_prefix)}`);
  }

  if (updates.length === 0) return "No updates specified.";

  const id = await resolveNatRuleId(a.rule_id, ctx);
  if (!id) return `NAT rule '${a.rule_id}' not found.`;
  const cmd = `/ip firewall nat set ${id} ${updates.join(" ")}`;
  const result = await executeMikrotikCommand(cmd, ctx);
  if (looksLikeError(result)) return `Failed to update NAT rule: ${result}`;

  const details = await executeMikrotikCommand(
    `/ip firewall nat print detail where .id=${id}`,
    ctx,
  );
  return `NAT rule updated successfully:\n\n${details}`;
}

export const firewallNatTools: ToolModule = [
  defineTool({
    name: "create_nat_rule",
    title: "Create IPv4 Firewall NAT Rule",
    annotations: WRITE,
    description:
      "Creates an IPv4 NAT rule (`/ip firewall nat add`) — the address-translation table for outbound masquerade or source NAT (chain=srcnat: actions masquerade, src-nat, netmap, same) and for port-forwarding or destination NAT (chain=dstnat: actions dst-nat, redirect, netmap, same). " +
      "For accept/drop/reject packet filtering use create_filter_rule; for IPv6 NAT use create_ipv6_nat_rule. " +
      "Returns the created rule's detail including its `.id`. " +
      'to_addresses: single IP or range e.g. "10.0.0.1" or "10.0.0.1-10.0.0.10". ' +
      'to_ports: single port or range e.g. "8080" or "8080-8090". ' +
      'place_before: rule number or ID (*N) to insert before e.g. "0" or "*3".',
    inputSchema: {
      chain: z.enum(["srcnat", "dstnat"]),
      action: z.string(),
      src_address: z.string().optional(),
      dst_address: z.string().optional(),
      src_port: z.string().optional(),
      dst_port: z.string().optional(),
      protocol: z.string().optional(),
      in_interface: z.string().optional().describe('Negatable, e.g. "!ether1"'),
      out_interface: z.string().optional(),
      in_interface_list: z.string().optional().describe('Interface list, e.g. "WAN" or "!LAN"'),
      out_interface_list: z.string().optional(),
      src_address_list: z.string().optional().describe('Match src in a named list; negate "!name"'),
      dst_address_list: z.string().optional().describe('Match dst in a named list; negate "!name"'),
      connection_mark: z.string().optional(),
      connection_nat_state: z.string().optional().describe('"srcnat" / "dstnat" / "!dstnat"'),
      connection_state: z
        .string()
        .optional()
        .describe('Match conn state, e.g. "new" / "established,related" / "!invalid"'),
      connection_type: z
        .string()
        .optional()
        .describe('Match helper-detected conn type, e.g. "ftp" / "sip"'),
      connection_bytes: z.string().optional().describe('Total conn bytes range, e.g. "1000000-"'),
      connection_limit: z.string().optional().describe('Per-address conn limit, e.g. "100,32"'),
      connection_rate: z.string().optional().describe('Conn rate range, e.g. "0-100k"'),
      port: z.string().optional().describe("Match src OR dst port (any protocol with ports)"),
      src_mac_address: z.string().optional().describe('Source MAC, negate "!AA:BB:.."'),
      packet_mark: z.string().optional().describe("Match a packet mark set in mangle"),
      routing_mark: z.string().optional().describe("Match a routing mark set in mangle"),
      src_address_type: z.string().optional().describe('"unicast" / "local" / "broadcast" / etc.'),
      dst_address_type: z.string().optional().describe('"unicast" / "local" / "broadcast" / etc.'),
      in_bridge_port: z.string().optional().describe("Ingress bridge port (bridge-filtered)"),
      out_bridge_port: z.string().optional().describe("Egress bridge port (bridge-filtered)"),
      in_bridge_port_list: z.string().optional().describe("Ingress bridge port list"),
      out_bridge_port_list: z.string().optional().describe("Egress bridge port list"),
      icmp_options: z.string().optional().describe('ICMP type:code, e.g. "8:0"'),
      ipsec_policy: z.string().optional().describe('e.g. "in,ipsec" / "out,none"'),
      layer7_protocol: z.string().optional().describe("Name of an /ip firewall layer7-protocol"),
      content: z.string().optional().describe("Match a literal string in the packet payload"),
      dscp: z.string().optional().describe("DSCP value 0-63"),
      priority: z.string().optional().describe("Match packet priority (queue/VLAN)"),
      tcp_flags: z.string().optional().describe('e.g. "syn,!ack"'),
      tcp_mss: z.string().optional().describe('TCP MSS range, e.g. "1440-1500"'),
      packet_size: z.string().optional().describe('Packet size range, e.g. "1500" or "0-500"'),
      limit: z.string().optional().describe('Rate limit, e.g. "10,5:packet"'),
      nth: z.string().optional().describe('Every Nth packet, e.g. "2,0"'),
      psd: z.string().optional().describe("Port-scan detection params"),
      random: z
        .string()
        .optional()
        .describe("Match packet randomly with given probability % (1-99)"),
      per_connection_classifier: z
        .string()
        .optional()
        .describe('PCC classifier, e.g. "both-addresses:2/0"'),
      time: z.string().optional().describe('Time/day matcher, e.g. "8h-16h,mon,tue,wed,thu,fri"'),
      ttl: z.string().optional().describe('IP TTL matcher, e.g. "equal:64"'),
      hotspot: z.string().optional().describe('Hotspot state, e.g. "auth" / "!auth"'),
      jump_target: z.string().optional().describe("Target chain name when action=jump"),
      address_list: z
        .string()
        .optional()
        .describe("List name for action=add-src-to-address-list / add-dst-to-address-list"),
      address_list_timeout: z
        .string()
        .optional()
        .describe('Timeout for the address-list entry, e.g. "1h" or "none"'),
      fragment: z.boolean().optional().describe("Match non-first IP fragments"),
      to_addresses: z
        .string()
        .optional()
        .describe('Single IP or range e.g. "10.0.0.1" or "10.0.0.1-10.0.0.10"'),
      to_ports: z.string().optional().describe('Single port or range e.g. "8080" or "8080-8090"'),
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
      ctx.info(`Creating NAT rule: chain=${a.chain}, action=${a.action}`);

      // Validate action based on chain
      const srcnatActions = [
        "accept",
        "drop",
        "masquerade",
        "src-nat",
        "same",
        "netmap",
        "jump",
        "return",
        "log",
        "passthrough",
      ];
      const dstnatActions = [
        "accept",
        "drop",
        "dst-nat",
        "jump",
        "return",
        "log",
        "passthrough",
        "redirect",
        "netmap",
        "same",
      ];

      if (a.chain === "srcnat" && !srcnatActions.includes(a.action)) {
        return `Error: Invalid action '${a.action}' for srcnat. Must be one of: ${srcnatActions.join(", ")}`;
      } else if (a.chain === "dstnat" && !dstnatActions.includes(a.action)) {
        return `Error: Invalid action '${a.action}' for dstnat. Must be one of: ${dstnatActions.join(", ")}`;
      }

      const cmd = new Cmd("/ip firewall nat add")
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
        .opt("connection-mark", a.connection_mark)
        .opt("connection-nat-state", a.connection_nat_state)
        .opt("connection-state", a.connection_state)
        .opt("connection-type", a.connection_type)
        .opt("connection-bytes", a.connection_bytes)
        .opt("connection-limit", a.connection_limit)
        .opt("connection-rate", a.connection_rate)
        .opt("port", a.port)
        .opt("src-mac-address", a.src_mac_address)
        .opt("packet-mark", a.packet_mark)
        .opt("routing-mark", a.routing_mark)
        .opt("src-address-type", a.src_address_type)
        .opt("dst-address-type", a.dst_address_type)
        .opt("in-bridge-port", a.in_bridge_port)
        .opt("out-bridge-port", a.out_bridge_port)
        .opt("in-bridge-port-list", a.in_bridge_port_list)
        .opt("out-bridge-port-list", a.out_bridge_port_list)
        .opt("icmp-options", a.icmp_options)
        .opt("ipsec-policy", a.ipsec_policy)
        .opt("layer7-protocol", a.layer7_protocol)
        .opt("content", a.content)
        .opt("dscp", a.dscp)
        .opt("priority", a.priority)
        .opt("tcp-flags", a.tcp_flags)
        .opt("tcp-mss", a.tcp_mss)
        .opt("packet-size", a.packet_size)
        .opt("limit", a.limit)
        .opt("nth", a.nth)
        .opt("psd", a.psd)
        .opt("random", a.random)
        .opt("per-connection-classifier", a.per_connection_classifier)
        .opt("time", a.time)
        .opt("ttl", a.ttl)
        .opt("hotspot", a.hotspot)
        .opt("jump-target", a.jump_target)
        .opt("address-list", a.address_list)
        .opt("address-list-timeout", a.address_list_timeout)
        .bool("fragment", a.fragment)
        .opt("to-addresses", a.to_addresses)
        .opt("to-ports", a.to_ports)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .flag("log", a.log)
        .opt("log-prefix", a.log ? a.log_prefix : undefined);

      const result = await executeRuleCreate("/ip firewall nat", cmd, ctx, a.place_before);

      const trimmed = result.trim();

      // A device error (e.g. a bad place-before) — surface it, never "created".
      if (looksLikeError(trimmed)) {
        const hint = placeBeforeError(trimmed, a.place_before);
        return `Failed to create NAT rule: ${hint ?? trimmed}`;
      }

      return readCreatedRule("/ip firewall nat", trimmed, "NAT rule", ctx);
    },
  }),

  defineTool({
    name: "list_nat_rules",
    title: "List IPv4 Firewall NAT Rules",
    annotations: READ,
    description:
      "Lists IPv4 NAT rules (`/ip firewall nat print`) — returns all srcnat and dstnat rules, optionally filtered by chain, action, address, protocol, or interface. " +
      "Use the returned `.id` values with get_nat_rule, update_nat_rule, move_nat_rule, enable_nat_rule, disable_nat_rule, and remove_nat_rule. " +
      "For IPv6 NAT rules use list_ipv6_nat_rules; for IPv4 filter rules use list_filter_rules.",
    inputSchema: {
      chain_filter: z.string().optional(),
      action_filter: z.string().optional(),
      src_address_filter: z.string().optional(),
      dst_address_filter: z.string().optional(),
      protocol_filter: z.string().optional(),
      interface_filter: z.string().optional(),
      disabled_only: z.boolean().default(false),
      invalid_only: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(
        `Listing NAT rules with filters: chain=${a.chain_filter}, action=${a.action_filter}`,
      );

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

      const result = await executeMikrotikCommand(
        `/ip firewall nat print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No NAT rules found matching the criteria."
        : `NAT RULES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_nat_rule",
    title: "Get IPv4 Firewall NAT Rule Details",
    annotations: READ,
    description:
      "Fetches full detail for a single IPv4 NAT rule (`/ip firewall nat print detail where .id=<rule_id>`). " +
      "Returns chain, action, address matchers, port matchers, to-addresses, to-ports, and rule flags for that rule. " +
      'rule_id takes the `.id` from list_nat_rules e.g. "*1" or "0". ' +
      "To list all rules use list_nat_rules; for IPv6 NAT use get_ipv6_nat_rule.",
    inputSchema: {
      rule_id: z.string().describe('Rule ID from list output e.g. "*1" or "0"'),
    },
    async handler(a, ctx) {
      ctx.info(`Getting NAT rule details: rule_id=${a.rule_id}`);

      const id = await resolveNatRuleId(a.rule_id, ctx);
      if (!id) return `NAT rule '${a.rule_id}' not found.`;

      const result = await executeMikrotikCommand(
        `/ip firewall nat print detail where .id=${id}`,
        ctx,
      );
      return isEmpty(result)
        ? `NAT rule '${a.rule_id}' not found.`
        : `NAT RULE DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_nat_rule",
    title: "Update IPv4 Firewall NAT Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Modifies fields of an existing IPv4 NAT rule (`/ip firewall nat set`) without recreating it. " +
      'rule_id takes the `.id` from list_nat_rules e.g. "*1" or "0"; returns the updated rule\'s full detail. ' +
      "For IPv6 NAT use update_ipv6_nat_rule; to toggle enabled state only use enable_nat_rule or disable_nat_rule. " +
      'to_addresses: single IP or range e.g. "10.0.0.1" or "10.0.0.1-10.0.0.10". ' +
      'to_ports: single port or range e.g. "8080" or "8080-8090". ' +
      'Pass "" to clear an optional field.',
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
      connection_mark: z.string().optional(),
      connection_nat_state: z.string().optional(),
      connection_state: z.string().optional(),
      connection_type: z.string().optional(),
      connection_bytes: z.string().optional(),
      connection_limit: z.string().optional(),
      connection_rate: z.string().optional(),
      port: z.string().optional(),
      src_mac_address: z.string().optional(),
      packet_mark: z.string().optional(),
      routing_mark: z.string().optional(),
      src_address_type: z.string().optional(),
      dst_address_type: z.string().optional(),
      in_bridge_port: z.string().optional(),
      out_bridge_port: z.string().optional(),
      in_bridge_port_list: z.string().optional(),
      out_bridge_port_list: z.string().optional(),
      icmp_options: z.string().optional(),
      ipsec_policy: z.string().optional(),
      layer7_protocol: z.string().optional(),
      content: z.string().optional(),
      dscp: z.string().optional(),
      priority: z.string().optional(),
      tcp_flags: z.string().optional(),
      tcp_mss: z.string().optional(),
      packet_size: z.string().optional(),
      limit: z.string().optional(),
      nth: z.string().optional(),
      psd: z.string().optional(),
      random: z.string().optional(),
      per_connection_classifier: z.string().optional(),
      time: z.string().optional(),
      ttl: z.string().optional(),
      hotspot: z.string().optional(),
      jump_target: z.string().optional(),
      address_list: z.string().optional(),
      address_list_timeout: z.string().optional(),
      fragment: z.boolean().optional(),
      to_addresses: z.string().optional(),
      to_ports: z.string().optional(),
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
    name: "remove_nat_rule",
    title: "Remove IPv4 Firewall NAT Rule",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes an IPv4 NAT rule (`/ip firewall nat remove`). " +
      "Verifies existence with a count-only check before deleting; returns an error if the rule is not found. " +
      'rule_id takes the `.id` from list_nat_rules e.g. "*1" or "0". ' +
      "To disable without deleting use disable_nat_rule; for IPv6 NAT use remove_ipv6_nat_rule.",
    inputSchema: { rule_id: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing NAT rule: rule_id=${a.rule_id}`);

      const id = await resolveNatRuleId(a.rule_id, ctx);
      if (!id) return `NAT rule '${a.rule_id}' not found.`;

      const result = await executeMikrotikCommand(`/ip firewall nat remove ${id}`, ctx);
      if (looksLikeError(result)) return `Failed to remove NAT rule: ${result}`;
      return `NAT rule '${a.rule_id}' (${id}) removed successfully.`;
    },
  }),

  defineTool({
    name: "move_nat_rule",
    title: "Move IPv4 Firewall NAT Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Reorders an IPv4 NAT rule within the NAT chain (`/ip firewall nat move`). " +
      "NAT rules are evaluated top to bottom and the first match wins, so position matters. " +
      'rule_id takes the `.id` from list_nat_rules e.g. "*1" or "0"; destination is the 0-based target position index. ' +
      "For filter rule reordering use move_filter_rule; for IPv6 NAT reordering use move_ipv6_nat_rule.",
    inputSchema: {
      rule_id: z.string(),
      destination: z.number().int().describe("0-based target position index"),
    },
    async handler(a, ctx) {
      ctx.info(`Moving NAT rule: rule_id=${a.rule_id} to position ${a.destination}`);

      const id = await resolveNatRuleId(a.rule_id, ctx);
      if (!id) return `NAT rule '${a.rule_id}' not found.`;

      const result = await executeMikrotikCommand(
        `/ip firewall nat move ${id} destination=${a.destination}`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to move NAT rule: ${result}`;
      return `NAT rule '${a.rule_id}' (${id}) moved to position ${a.destination}.`;
    },
  }),

  defineTool({
    name: "enable_nat_rule",
    title: "Enable IPv4 Firewall NAT Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Re-enables a disabled IPv4 NAT rule (`/ip firewall nat set disabled=no`). " +
      'rule_id takes the `.id` from list_nat_rules e.g. "*1" or "0"; returns the updated rule detail. ' +
      "To disable use disable_nat_rule; to edit other fields use update_nat_rule; for IPv6 NAT use enable_ipv6_nat_rule.",
    inputSchema: { rule_id: z.string() },
    async handler(a, ctx) {
      return updateNatRule({ rule_id: a.rule_id, disabled: false }, ctx);
    },
  }),

  defineTool({
    name: "disable_nat_rule",
    title: "Disable IPv4 Firewall NAT Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Disables an active IPv4 NAT rule without removing it (`/ip firewall nat set disabled=yes`). " +
      'rule_id takes the `.id` from list_nat_rules e.g. "*1" or "0"; returns the updated rule detail after disabling. ' +
      "To re-enable use enable_nat_rule; to permanently delete use remove_nat_rule; for IPv6 NAT use disable_ipv6_nat_rule.",
    inputSchema: { rule_id: z.string() },
    async handler(a, ctx) {
      return updateNatRule({ rule_id: a.rule_id, disabled: true }, ctx);
    },
  }),
];
