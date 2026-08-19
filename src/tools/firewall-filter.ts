/** Firewall filter rules — `/ip firewall filter`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import {
  WRITE_IDEMPOTENT,
  WRITE,
  READ,
  DESTRUCTIVE,
  defineTool,
  DANGEROUS,
} from "../core/registry";
import type { ToolModule } from "../core/registry";
import {
  whereClause,
  quoteValue,
  looksLikeError,
  isEmpty,
  placeBeforeError,
  interfaceValueError,
  extractCreatedId,
  readBackUnavailable,
  Cmd,
} from "../core/routeros";
import { filterDetailBlocks } from "../core/routeros-parse";
import type { ToolContext } from "../core/context";
import { listItemIds, ruleResolver } from "./_resolve-rule-id";

const isDigits = (s: string): boolean => /^\d+$/.test(s);

/** Resolve a filter rule identifier (`*1F` or positional row index) to its `.id`. */
const resolveFilterRuleId = ruleResolver("/ip firewall filter");

/** Firewall chain names — a common wrong value for the interface fields. */
const CHAIN_NAMES = new Set(["input", "forward", "output"]);

/**
 * Guard against the frequent mix-up of passing a CHAIN name (`input`/`forward`/
 * `output`) into an interface match field. RouterOS would otherwise reject it
 * with the cryptic "input does not match any value of interface". Returns an
 * actionable error string when the mistake is detected, else `undefined`.
 *
 * Note: `in-interface` takes an interface NAME (e.g. `ether1`); an interface
 * LIST (e.g. `WAN`) goes in the `*_interface_list` fields instead.
 */
function interfaceFieldMisuse(
  fields: { name: string; value: string | undefined }[],
): string | undefined {
  for (const { name, value } of fields) {
    if (value !== undefined && CHAIN_NAMES.has(value)) {
      return (
        `'${name}' was set to '${value}', which is a firewall CHAIN, not an interface. ` +
        `Set '${name}' to an interface NAME (e.g. ether1, pppoe-out1), or use ` +
        `'${name}_list' for an interface list. The chain is the separate 'chain' parameter.`
      );
    }
  }
  return undefined;
}

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
    connection_state?: string;
    connection_nat_state?: string;
    src_address_list?: string;
    dst_address_list?: string;
    limit?: string;
    tcp_flags?: string;
    src_mac_address?: string;
    in_interface_list?: string;
    out_interface_list?: string;
    port?: string;
    connection_mark?: string;
    packet_mark?: string;
    routing_mark?: string;
    connection_type?: string;
    connection_bytes?: string;
    connection_limit?: string;
    connection_rate?: string;
    content?: string;
    dscp?: string;
    layer7_protocol?: string;
    packet_size?: string;
    ipsec_policy?: string;
    ttl?: string;
    nth?: string;
    time?: string;
    random?: string;
    tcp_mss?: string;
    fragment?: boolean;
    src_address_type?: string;
    dst_address_type?: string;
    hotspot?: string;
    icmp_options?: string;
    priority?: string;
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
  ctx.info(`Updating firewall filter rule: rule_id=${a.rule_id}`);

  const misuse = interfaceFieldMisuse([
    { name: "in_interface", value: a.in_interface },
    { name: "out_interface", value: a.out_interface },
  ]);
  if (misuse) return `Failed to update firewall filter rule: ${misuse}`;

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
  put("connection-state", a.connection_state);
  put("connection-nat-state", a.connection_nat_state);
  put("src-address-list", a.src_address_list);
  put("dst-address-list", a.dst_address_list);
  put("limit", a.limit);
  put("tcp-flags", a.tcp_flags);
  put("src-mac-address", a.src_mac_address);
  put("in-interface-list", a.in_interface_list);
  put("out-interface-list", a.out_interface_list);
  put("port", a.port);
  put("connection-mark", a.connection_mark);
  put("packet-mark", a.packet_mark);
  put("routing-mark", a.routing_mark);
  put("connection-type", a.connection_type);
  put("connection-bytes", a.connection_bytes);
  put("connection-limit", a.connection_limit);
  put("connection-rate", a.connection_rate);
  put("content", a.content);
  put("dscp", a.dscp);
  put("layer7-protocol", a.layer7_protocol);
  put("packet-size", a.packet_size);
  put("ipsec-policy", a.ipsec_policy);
  put("ttl", a.ttl);
  put("nth", a.nth);
  put("time", a.time);
  put("random", a.random);
  put("tcp-mss", a.tcp_mss);
  put("src-address-type", a.src_address_type);
  put("dst-address-type", a.dst_address_type);
  put("hotspot", a.hotspot);
  put("icmp-options", a.icmp_options);
  put("priority", a.priority);
  put("jump-target", a.jump_target);
  put("reject-with", a.reject_with);
  put("address-list", a.address_list);
  put("address-list-timeout", a.address_list_timeout);
  if (a.fragment !== undefined) updates.push(`fragment=${a.fragment ? "yes" : "no"}`);
  if (a.comment !== undefined) updates.push(`comment=${quoteValue(a.comment)}`);
  if (a.disabled !== undefined) updates.push(`disabled=${a.disabled ? "yes" : "no"}`);
  if (a.log !== undefined) {
    updates.push(`log=${a.log ? "yes" : "no"}`);
    if (a.log && a.log_prefix) updates.push(`log-prefix=${quoteValue(a.log_prefix)}`);
  }

  if (updates.length === 0) return "No updates specified.";

  const id = await resolveFilterRuleId(a.rule_id, ctx);
  if (!id) return `Firewall filter rule '${a.rule_id}' not found.`;
  const cmd = `/ip firewall filter set ${id} ${updates.join(" ")}`;
  const result = await executeMikrotikCommand(cmd, ctx);
  if (looksLikeError(result)) {
    const hint = interfaceValueError(result, [
      { name: "in_interface", value: a.in_interface },
      { name: "out_interface", value: a.out_interface },
    ]);
    return `Failed to update firewall filter rule: ${hint ?? result}`;
  }

  const details = await executeMikrotikCommand(
    `/ip firewall filter print detail where .id=${id}`,
    ctx,
  );
  return `Firewall filter rule updated successfully:\n\n${details}`;
}

export const firewallFilterTools: ToolModule = [
  defineTool({
    name: "create_filter_rule",
    title: "Create Firewall Filter Rule",
    annotations: WRITE,
    description:
      "Creates an IPv4 firewall FILTER rule (`/ip firewall filter`) — the accept/drop/reject " +
      "decision table for traffic TO the router (chain=input), THROUGH it (forward) or FROM it " +
      "(output). Use this to allow or block traffic. For address translation use the NAT tools, " +
      "for packet marking use mangle, for pre-connection-tracking drops use raw, and for IPv6 use " +
      "create_ipv6_filter_rule. `chain` also accepts a CUSTOM sub-chain name (e.g. detect-portscan) " +
      "reached by an action=jump rule, and `action` supports add-src-to-address-list / " +
      "add-dst-to-address-list (with `address_list` + `address_list_timeout`) for tagging/detection " +
      "rules. Rule order matters (first match wins) — use place_before or " +
      "move_filter_rule to position it. Returns the created rule's detail including its `.id`. " +
      'connection_state: comma-separated e.g. "established,related,new,invalid". ' +
      'limit: RouterOS rate/burst string e.g. "10,5:packet" or "10/1s:packet". ' +
      'tcp_flags: RouterOS flag expression e.g. "syn,!ack". ' +
      'place_before: rule number or ID (*N) to insert before e.g. "0" or "*3".',
    inputSchema: {
      chain: z
        .string()
        .describe(
          "The built-in `input`, `forward`, or `output` chain — OR a custom sub-chain name " +
            "(e.g. `detect-portscan`). A custom chain runs only when a rule with action=jump and " +
            "jump-target=<that chain> sends traffic into it; use this to build tagging/detection sub-chains.",
        ),
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
      in_interface: z
        .string()
        .optional()
        .describe(
          "Match by inbound interface NAME (e.g. ether1, pppoe-out1) — NOT a chain and NOT an " +
            "interface list. For an interface list use in_interface_list.",
        ),
      out_interface: z
        .string()
        .optional()
        .describe(
          "Match by outbound interface NAME (e.g. ether1, pppoe-out1) — NOT a chain and NOT an " +
            "interface list. For an interface list use out_interface_list.",
        ),
      connection_state: z
        .string()
        .optional()
        .describe('Comma-separated e.g. "established,related,new,invalid"'),
      connection_nat_state: z.string().optional(),
      src_address_list: z.string().optional(),
      dst_address_list: z.string().optional(),
      limit: z.string().optional().describe('RouterOS rate/burst string e.g. "10,5:packet"'),
      tcp_flags: z.string().optional().describe('RouterOS flag expression e.g. "syn,!ack"'),
      src_mac_address: z
        .string()
        .optional()
        .describe('Source MAC, supports ! and mask e.g. "00:11:..."'),
      in_interface_list: z.string().optional().describe("Match by inbound interface list name"),
      out_interface_list: z.string().optional().describe("Match by outbound interface list name"),
      port: z.string().optional().describe("Match src OR dst port(s) (protocol-agnostic)"),
      connection_mark: z.string().optional().describe("Match packets with this connection mark"),
      packet_mark: z.string().optional().describe("Match packets with this packet mark"),
      routing_mark: z.string().optional().describe("Match packets with this routing mark"),
      connection_type: z.string().optional().describe('Conntrack helper type e.g. "ftp,sip"'),
      connection_bytes: z.string().optional().describe('Total conn bytes range e.g. "1000000-0"'),
      connection_limit: z.string().optional().describe('Per-address conn limit e.g. "100,32"'),
      connection_rate: z.string().optional().describe('Connection rate range e.g. "0-100k"'),
      content: z.string().optional().describe("Match a literal string in the packet payload"),
      dscp: z.string().optional().describe("Match DSCP/TOS value 0-63"),
      layer7_protocol: z.string().optional().describe("Match a /ip firewall layer7-protocol name"),
      packet_size: z.string().optional().describe('Packet size or range in bytes e.g. "0-1500"'),
      ipsec_policy: z
        .string()
        .optional()
        .describe('IPsec policy match e.g. "in,ipsec" or "out,none"'),
      ttl: z.string().optional().describe('TTL match e.g. "equal:64" or "less-than:5"'),
      nth: z.string().optional().describe('Match every Nth packet e.g. "2,1"'),
      time: z.string().optional().describe('Time/day match e.g. "8h-16h,mon,tue,wed"'),
      random: z
        .string()
        .optional()
        .describe("Match a packet randomly with given probability (1-99)"),
      tcp_mss: z.string().optional().describe('TCP MSS match e.g. "1300-1536" or "!1460"'),
      fragment: z.boolean().optional().describe("Match non-first IP fragments"),
      src_address_type: z
        .string()
        .optional()
        .describe('Source address type e.g. "unicast","local"'),
      dst_address_type: z
        .string()
        .optional()
        .describe('Dest address type e.g. "broadcast","multicast"'),
      hotspot: z
        .string()
        .optional()
        .describe('Hotspot match e.g. "auth","from-client","local-dst"'),
      icmp_options: z.string().optional().describe('ICMP type:code match e.g. "8:0"'),
      priority: z.string().optional().describe("Match packets by priority (0-63) set internally"),
      jump_target: z.string().optional().describe("Target chain name when action=jump"),
      reject_with: z.string().optional().describe("ICMP/TCP reject response when action=reject"),
      address_list: z
        .string()
        .optional()
        .describe("List name for add-src-to-address-list / add-dst-to-address-list actions"),
      address_list_timeout: z
        .string()
        .optional()
        .describe('Timeout for the address-list entry e.g. "1d" or "none"'),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
      log: z.boolean().default(false),
      log_prefix: z.string().optional(),
      place_before: z
        .string()
        .optional()
        .describe(
          'Insert before this position. Either a bare ordinal/row number (e.g. "0", "13") OR a ' +
            'CURRENT internal .id ("*N") from list_filter_rules. Note: a "*N" .id is hexadecimal ' +
            'and reassigned over time — it is NOT the row number, so "*13" ≠ the 13th rule.',
        ),
    },
    async handler(a, ctx) {
      ctx.info(`Creating firewall filter rule: chain=${a.chain}, action=${a.action}`);

      const misuse = interfaceFieldMisuse([
        { name: "in_interface", value: a.in_interface },
        { name: "out_interface", value: a.out_interface },
      ]);
      if (misuse) return `Failed to create firewall filter rule: ${misuse}`;

      const cmd = new Cmd("/ip firewall filter add")
        .set("chain", a.chain)
        .set("action", a.action)
        .opt("src-address", a.src_address)
        .opt("dst-address", a.dst_address)
        .opt("src-port", a.src_port)
        .opt("dst-port", a.dst_port)
        .opt("protocol", a.protocol)
        .opt("in-interface", a.in_interface)
        .opt("out-interface", a.out_interface)
        .opt("connection-state", a.connection_state)
        .opt("connection-nat-state", a.connection_nat_state)
        .opt("src-address-list", a.src_address_list)
        .opt("dst-address-list", a.dst_address_list)
        .opt("limit", a.limit)
        .opt("tcp-flags", a.tcp_flags)
        .opt("src-mac-address", a.src_mac_address)
        .opt("in-interface-list", a.in_interface_list)
        .opt("out-interface-list", a.out_interface_list)
        .opt("port", a.port)
        .opt("connection-mark", a.connection_mark)
        .opt("packet-mark", a.packet_mark)
        .opt("routing-mark", a.routing_mark)
        .opt("connection-type", a.connection_type)
        .opt("connection-bytes", a.connection_bytes)
        .opt("connection-limit", a.connection_limit)
        .opt("connection-rate", a.connection_rate)
        .opt("content", a.content)
        .opt("dscp", a.dscp)
        .opt("layer7-protocol", a.layer7_protocol)
        .opt("packet-size", a.packet_size)
        .opt("ipsec-policy", a.ipsec_policy)
        .opt("ttl", a.ttl)
        .opt("nth", a.nth)
        .opt("time", a.time)
        .opt("random", a.random)
        .opt("tcp-mss", a.tcp_mss)
        .bool("fragment", a.fragment)
        .opt("src-address-type", a.src_address_type)
        .opt("dst-address-type", a.dst_address_type)
        .opt("hotspot", a.hotspot)
        .opt("icmp-options", a.icmp_options)
        .opt("priority", a.priority)
        .opt("jump-target", a.jump_target)
        .opt("reject-with", a.reject_with)
        .opt("address-list", a.address_list)
        .opt("address-list-timeout", a.address_list_timeout)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .flag("log", a.log)
        .opt("log-prefix", a.log ? a.log_prefix : undefined)
        .opt("place-before", a.place_before)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);

      const trimmed = result.trim();

      // A device error (e.g. a bad place-before) — surface it, never "created".
      if (looksLikeError(trimmed)) {
        const hint =
          placeBeforeError(trimmed, a.place_before) ??
          interfaceValueError(trimmed, [
            { name: "in_interface", value: a.in_interface },
            { name: "out_interface", value: a.out_interface },
          ]);
        return `Failed to create firewall filter rule: ${hint ?? trimmed}`;
      }

      // RouterOS echoes the new rule's .id on success. Read it back by that id
      // (extracted as a clean token so a trailing warning can't corrupt the
      // lookup); if the read-back can't return the record, still report success
      // — the rule was created.
      const createdId = extractCreatedId(trimmed);
      if (createdId) {
        const details = await executeMikrotikCommand(
          `/ip firewall filter print detail where .id=${createdId}`,
          ctx,
        );
        return readBackUnavailable(details)
          ? `Firewall filter rule created (id ${createdId}).`
          : `Firewall filter rule created successfully:\n\n${details}`;
      }

      // No id echoed — verify by fetching the last rule.
      const count = await executeMikrotikCommand(
        "/ip firewall filter print detail count-only",
        ctx,
      );
      const c = count.trim();
      if (isDigits(c) && Number.parseInt(c, 10) > 0) {
        const details = await executeMikrotikCommand(
          `/ip firewall filter print detail from=${Number.parseInt(c, 10) - 1}`,
          ctx,
        );
        return readBackUnavailable(details)
          ? "Firewall filter rule created successfully."
          : `Firewall filter rule created successfully:\n\n${details}`;
      }
      return "Firewall filter rule created successfully.";
    },
  }),

  defineTool({
    name: "list_filter_rules",
    title: "List Firewall Filter Rules",
    annotations: READ,
    description:
      "Lists IPv4 firewall FILTER rules (`/ip firewall filter`) in chain/match order — each with " +
      "its `.id`, chain, action, matchers, comment and packet/byte counters. This is the " +
      "accept/drop decision table, NOT NAT (address translation), mangle (marking) or raw " +
      "(pre-conntrack); for IPv6 use list_ipv6_filter_rules. Optional filters narrow by chain, " +
      "action, src/dst address, protocol or interface, or to only disabled/invalid/dynamic rules.",
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
      ctx.info(
        `Listing firewall filter rules with filters: chain=${a.chain_filter}, action=${a.action_filter}`,
      );

      // Device-side `where` handles only what it can express reliably: plain
      // equality on properties every rule carries. RouterOS's print filter has
      // no `or` and no parentheses, and a `~` match against a property the rule
      // never set does not match — so `protocol` and the interface fields
      // (absent on any rule that doesn't match on them) were filtering
      // everything out instead of narrowing. Those run client-side below.
      const filters: string[] = [];
      if (a.chain_filter) filters.push(`chain=${a.chain_filter}`);
      if (a.action_filter) filters.push(`action=${a.action_filter}`);
      if (a.src_address_filter) filters.push(`src-address~"${a.src_address_filter}"`);
      if (a.dst_address_filter) filters.push(`dst-address~"${a.dst_address_filter}"`);
      if (a.disabled_only) filters.push("disabled=yes");
      if (a.invalid_only) filters.push("invalid=yes");
      if (a.dynamic_only) filters.push("dynamic=yes");

      // Use `print detail` so the output includes `.id` values (e.g. *0, *1F).
      // Plain `print` shows only positional row numbers in the `#` column, and
      // users often mistake those for `.id` — leading to silent wrong-rule lookups.
      const raw = await executeMikrotikCommand(
        `/ip firewall filter print detail${whereClause(filters)}`,
        ctx,
      );

      const protocolWanted = a.protocol_filter?.toLowerCase();
      const interfaceWanted = a.interface_filter?.toLowerCase();
      const result =
        protocolWanted || interfaceWanted
          ? filterDetailBlocks(raw, (row) => {
              if (protocolWanted && (row.protocol ?? "").toLowerCase() !== protocolWanted) {
                return false;
              }
              if (interfaceWanted) {
                // Matches either direction, and the list forms too — a rule that
                // matches "WAN" via in-interface-list is a rule on that interface
                // as far as the caller is concerned.
                const hit = [
                  row["in-interface"],
                  row["out-interface"],
                  row["in-interface-list"],
                  row["out-interface-list"],
                ].some((v) => (v ?? "").toLowerCase().includes(interfaceWanted));
                if (!hit) return false;
              }
              return true;
            })
          : raw;

      return isEmpty(result)
        ? "No firewall filter rules found matching the criteria."
        : `FIREWALL FILTER RULES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_filter_rule",
    title: "Get Firewall Filter Rule",
    annotations: READ,
    description:
      "Gets the full detail of one IPv4 firewall FILTER rule (`/ip firewall filter`) by id — " +
      "every matcher, action, counter and flag. For IPv6 use get_ipv6_filter_rule. " +
      'rule_id: preferably the `.id` from list_filter_rules e.g. "*1F". A bare number like "3" ' +
      "is read as the positional ROW INDEX and resolved to whatever `.id` currently sits there — " +
      "it is never treated as `.id=*3`, since a `*N` id is hex and reassigned over time. Row " +
      "positions shift whenever a rule is added, removed or moved, so prefer the `.id`.",
    inputSchema: {
      rule_id: z.string().describe('Rule .id e.g. "*1F", or bare position number e.g. "3"'),
    },
    async handler(a, ctx) {
      ctx.info(`Getting firewall filter rule details: rule_id=${a.rule_id}`);

      const id = await resolveFilterRuleId(a.rule_id, ctx);
      if (!id) return `Firewall filter rule '${a.rule_id}' not found.`;

      const result = await executeMikrotikCommand(
        `/ip firewall filter print detail where .id=${id}`,
        ctx,
      );
      return isEmpty(result)
        ? `Firewall filter rule '${a.rule_id}' not found.`
        : `FIREWALL FILTER RULE DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_filter_rule",
    title: "Update Firewall Filter Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Updates an existing IPv4 firewall FILTER rule (`/ip firewall filter`) in place and returns " +
      "its new detail. To reorder it use move_filter_rule; to toggle it on/off use " +
      "enable_filter_rule / disable_filter_rule; for IPv6 use update_ipv6_filter_rule. " +
      'rule_id: the `.id` from list_filter_rules e.g. "*1" or "0". ' +
      'connection_state: comma-separated e.g. "established,related". ' +
      'limit: RouterOS rate string e.g. "10,5:packet". ' +
      'tcp_flags: RouterOS flag expression e.g. "syn,!ack". ' +
      'Pass "" to clear an optional field (e.g. src_address="").',
    inputSchema: {
      rule_id: z.string(),
      chain: z.string().optional(),
      action: z.string().optional(),
      src_address: z.string().optional(),
      dst_address: z.string().optional(),
      src_port: z.string().optional(),
      dst_port: z.string().optional(),
      protocol: z.string().optional(),
      in_interface: z
        .string()
        .optional()
        .describe(
          "Inbound interface NAME (e.g. ether1) — not a chain; use in_interface_list for a list.",
        ),
      out_interface: z
        .string()
        .optional()
        .describe(
          "Outbound interface NAME (e.g. ether1) — not a chain; use out_interface_list for a list.",
        ),
      connection_state: z.string().optional(),
      connection_nat_state: z.string().optional(),
      src_address_list: z.string().optional(),
      dst_address_list: z.string().optional(),
      limit: z.string().optional(),
      tcp_flags: z.string().optional(),
      src_mac_address: z.string().optional(),
      in_interface_list: z.string().optional(),
      out_interface_list: z.string().optional(),
      port: z.string().optional(),
      connection_mark: z.string().optional(),
      packet_mark: z.string().optional(),
      routing_mark: z.string().optional(),
      connection_type: z.string().optional(),
      connection_bytes: z.string().optional(),
      connection_limit: z.string().optional(),
      connection_rate: z.string().optional(),
      content: z.string().optional(),
      dscp: z.string().optional(),
      layer7_protocol: z.string().optional(),
      packet_size: z.string().optional(),
      ipsec_policy: z.string().optional(),
      ttl: z.string().optional(),
      nth: z.string().optional(),
      time: z.string().optional(),
      random: z.string().optional(),
      tcp_mss: z.string().optional(),
      fragment: z.boolean().optional(),
      src_address_type: z.string().optional(),
      dst_address_type: z.string().optional(),
      hotspot: z.string().optional(),
      icmp_options: z.string().optional(),
      priority: z.string().optional(),
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
    name: "remove_filter_rule",
    title: "Remove Firewall Filter Rule",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes one IPv4 firewall FILTER rule (`/ip firewall filter`) by id (verifies " +
      "it exists first). To keep a rule but stop it matching, use disable_filter_rule instead; " +
      "for IPv6 use remove_ipv6_filter_rule. " +
      'rule_id: the `.id` from list_filter_rules e.g. "*1" or "0".',
    inputSchema: { rule_id: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing firewall filter rule: rule_id=${a.rule_id}`);

      // Resolve the rule id — bare numbers try .id=*N first, then positional.
      const id = await resolveFilterRuleId(a.rule_id, ctx);
      if (!id) return `Firewall filter rule '${a.rule_id}' not found.`;

      const result = await executeMikrotikCommand(`/ip firewall filter remove ${id}`, ctx);
      if (looksLikeError(result)) return `Failed to remove firewall filter rule: ${result}`;
      return `Firewall filter rule '${a.rule_id}' (${id}) removed successfully.`;
    },
  }),

  defineTool({
    name: "move_filter_rule",
    title: "Move Firewall Filter Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Reorders one IPv4 firewall FILTER rule (`/ip firewall filter`) within its chain. Order is " +
      "significant — the first matching rule decides the packet's fate, so position an accept " +
      "before a broad drop. For IPv6 use move_ipv6_filter_rule. " +
      'rule_id: the `.id` from list_filter_rules e.g. "*1" or "0". ' +
      "destination: 0-based target position index.",
    inputSchema: {
      rule_id: z.string(),
      destination: z.number().int().describe("0-based target position index"),
    },
    async handler(a, ctx) {
      ctx.info(`Moving firewall filter rule: rule_id=${a.rule_id} to position ${a.destination}`);

      const id = await resolveFilterRuleId(a.rule_id, ctx);
      if (!id) return `Firewall filter rule '${a.rule_id}' not found.`;

      const before = await listItemIds("/ip firewall filter", ctx);
      const result = await executeMikrotikCommand(
        `/ip firewall filter move ${id} destination=${a.destination}`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to move firewall filter rule: ${result}`;

      // RouterOS silently no-ops a `move` whose destination is out of range or
      // already the rule's position — it returns nothing, exactly like success.
      // Reporting the requested position on that basis is a lie the caller acts
      // on (they believe the ordering changed), so read the order back and
      // report where the rule ACTUALLY is.
      const after = await listItemIds("/ip firewall filter", ctx);
      const from = before.indexOf(id);
      const to = after.indexOf(id);
      if (to === -1) {
        return `Firewall filter rule ${id} moved, but it could not be located afterwards — verify with list_filter_rules.`;
      }
      if (to === a.destination) {
        return `Firewall filter rule '${a.rule_id}' (${id}) moved to position ${to}.`;
      }
      if (to === from) {
        return (
          `NO CHANGE: firewall filter rule '${a.rule_id}' (${id}) is still at position ${to} — ` +
          `RouterOS ignored the move to ${a.destination}. Destination is 0-based and counts ` +
          `ALL rules in the menu (${after.length} total), not just this rule's chain; a ` +
          "destination at or past the end, or equal to the current position, does nothing."
        );
      }
      return (
        `Firewall filter rule '${a.rule_id}' (${id}) moved from position ${from} to ${to} ` +
        `(requested ${a.destination} — RouterOS places the rule BEFORE the item currently at ` +
        "the destination index, so the final index can differ when moving downward)."
      );
    },
  }),

  defineTool({
    name: "enable_filter_rule",
    title: "Enable Firewall Filter Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Enables (un-disables) one IPv4 firewall FILTER rule (`/ip firewall filter`) by id so it " +
      "takes effect again. Idempotent. For IPv6 use enable_ipv6_filter_rule. " +
      'rule_id: the `.id` from list_filter_rules e.g. "*1" or "0".',
    inputSchema: { rule_id: z.string() },
    async handler(a, ctx) {
      return updateFilterRule({ rule_id: a.rule_id, disabled: false }, ctx);
    },
  }),

  defineTool({
    name: "disable_filter_rule",
    title: "Disable Firewall Filter Rule",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Disables one IPv4 firewall FILTER rule (`/ip firewall filter`) by id WITHOUT deleting it, " +
      "so it stops matching traffic but stays in the config. Idempotent and reversible with " +
      "enable_filter_rule. For IPv6 use disable_ipv6_filter_rule. " +
      'rule_id: the `.id` from list_filter_rules e.g. "*1" or "0".',
    inputSchema: { rule_id: z.string() },
    async handler(a, ctx) {
      return updateFilterRule({ rule_id: a.rule_id, disabled: true }, ctx);
    },
  }),

  defineTool({
    name: "create_basic_firewall_setup",
    title: "Create Basic Firewall Setup",
    annotations: DANGEROUS,
    description:
      "Appends a starter set of IPv4 input-chain FILTER rules (`/ip firewall filter`): accept " +
      "established/related, drop invalid, accept ICMP, and a management allow — a safe baseline " +
      "for a fresh router. DANGEROUS: adds several live rules at once and is NOT idempotent " +
      "(running twice duplicates them). Ensure a management-allow rule precedes any drop, or you " +
      "can lock yourself out — prefer plan_changes/apply_plan (Safe Mode) to stage it safely.",
    async handler(_a, ctx) {
      ctx.info("Creating basic firewall setup");

      const results: string[] = [];

      // Allow established and related connections
      const r1 = await executeMikrotikCommand(
        '/ip firewall filter add chain=input action=accept connection-state=established,related comment="Accept established,related"',
        ctx,
      );
      results.push(`Rule 1 (established/related): ${!r1 || r1.includes("*") ? "Created" : r1}`);

      // Drop invalid connections
      const r2 = await executeMikrotikCommand(
        '/ip firewall filter add chain=input action=drop connection-state=invalid comment="Drop invalid"',
        ctx,
      );
      results.push(`Rule 2 (drop invalid): ${!r2 || r2.includes("*") ? "Created" : r2}`);

      // Allow ICMP
      const r3 = await executeMikrotikCommand(
        '/ip firewall filter add chain=input action=accept protocol=icmp comment="Accept ICMP"',
        ctx,
      );
      results.push(`Rule 3 (ICMP): ${!r3 || r3.includes("*") ? "Created" : r3}`);

      // Allow management from specific network
      const r4 = await executeMikrotikCommand(
        '/ip firewall filter add chain=input action=accept src-address=192.168.88.0/24 comment="Accept management network"',
        ctx,
      );
      results.push(`Rule 4 (management network): ${!r4 || r4.includes("*") ? "Created" : r4}`);

      // Drop everything else
      const r5 = await executeMikrotikCommand(
        '/ip firewall filter add chain=input action=drop comment="Drop everything else"',
        ctx,
      );
      results.push(`Rule 5 (drop all): ${!r5 || r5.includes("*") ? "Created" : r5}`);

      return `BASIC FIREWALL SETUP RESULTS:\n\n${results.join("\n")}`;
    },
  }),
];
