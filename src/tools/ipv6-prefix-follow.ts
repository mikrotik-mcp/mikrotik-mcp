/**
 * IPv6 with a changing ISP prefix — keep firewall address lists on the prefix
 * the ISP delegates today.
 *
 * Many ISPs hand out a different IPv6 prefix after a reconnect. Addresses made
 * with `from-pool` follow it on their own, but a firewall rule that names the
 * prefix, or one host inside it, does not: it keeps the old numbers.
 *
 * The fix is a script on the DHCPv6 client. RouterOS runs it each time the
 * prefix is bound, with the new prefix in `$"pd-prefix"`. The script rewrites
 * address-list entries: one for the whole prefix, and one for each host you
 * name by its fixed suffix. Firewall rules refer to the lists, so they stay
 * right when the numbers change.
 *
 * The script is stored on the router and run later, so every name that goes
 * into it is limited to a plain identifier, and a suffix to an IPv6 literal.
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { DESTRUCTIVE, WRITE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { Cmd, looksLikeError, quoted } from "../core/routeros";
import { parseRecords } from "../core/routeros-parse";

const TAG = "pd-follow";
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$/;
/** A suffix inside the prefix: `::10` (first subnet) or `::1:0:0:0:10` (subnet 1). */
const SUFFIX = /^::[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,4}$/i;

export interface PrefixHost {
  name: string;
  suffix: string;
}

/** The script RouterOS runs when the delegated prefix is bound. */
export function buildPrefixScript(list: string, hosts: PrefixHost[]): string {
  const comment = `${TAG}: ${list}`;
  return [
    `# ${comment}`,
    ':if ($"pd-valid" = 1) do={',
    ':local pfx $"pd-prefix"',
    ':local base [:toip6 [:pick $pfx 0 [:find $pfx "/"]]]',
    `/ipv6 firewall address-list remove [find comment="${comment}"]`,
    `/ipv6 firewall address-list add list=${list} address=$pfx comment="${comment}"`,
    ...hosts.map(
      (host) =>
        `/ipv6 firewall address-list add list=${list}-${host.name} ` +
        `address=($base | [:toip6 "${host.suffix.toLowerCase()}"]) comment="${comment}"`,
    ),
    "}",
  ].join("\n");
}

const isOurs = (script: string | undefined): boolean => (script ?? "").startsWith(`# ${TAG}: `);

export const ipv6PrefixFollowTools: ToolModule = [
  defineTool({
    name: "follow_ipv6_prefix",
    title: "Keep IPv6 Address Lists on the Delegated Prefix",
    annotations: WRITE,
    description:
      "Makes IPv6 firewall address lists follow the prefix your ISP delegates, so rules keep " +
      "working when the ISP changes the prefix. It installs a script on the DHCPv6 client of " +
      "`interface`; RouterOS runs it each time a prefix is bound, and it rewrites: the address " +
      "list `list` with the whole delegated prefix, and for each entry in `hosts` a list " +
      "`<list>-<name>` with that host's address (the new prefix plus its fixed `suffix`). Point " +
      "your firewall rules at these lists instead of at literal addresses, for example " +
      "`dst-address-list=isp-prefix-web` to allow inbound HTTPS to one server. The client must " +
      "request a prefix (`request=prefix`). DEFAULTS TO A DRY RUN (`apply=false`) that shows the " +
      "script. An existing script on the client that this tool did not write is kept unless " +
      "`replace=true`. The lists are filled at the next bind: run `renew_ipv6_dhcp_client` " +
      "afterwards to fill them now. A suffix names a host inside the prefix: `::10` is host ::10 " +
      "in the first /64, `::1:0:0:0:10` is host ::10 in the second /64.",
    inputSchema: {
      interface: z
        .string()
        .describe("Interface of the DHCPv6 client, e.g. 'ether1' or 'pppoe-out1'"),
      list: z
        .string()
        .regex(NAME)
        .default("isp-prefix")
        .describe("Address list that gets the whole delegated prefix"),
      hosts: z
        .array(
          z.object({
            name: z.string().regex(NAME).describe("Short name, becomes list '<list>-<name>'"),
            suffix: z.string().regex(SUFFIX).describe("Fixed part of the address, e.g. '::10'"),
          }),
        )
        .max(32)
        .default([]),
      replace: z.boolean().default(false).describe("Replace a script this tool did not write"),
      apply: z.boolean().default(false).describe("false = show the script; true = install"),
    },
    async handler(a, ctx) {
      const clients = parseRecords(
        await executeMikrotikCommand(
          `/ipv6 dhcp-client print detail where interface=${quoted(a.interface)}`,
          { ...ctx, risk: "READ" },
        ),
      ).rows;
      const client = clients[0];
      if (!client)
        return `No DHCPv6 client is on '${a.interface}'. Add one that requests a prefix (add_ipv6_dhcp_client request=prefix) first.`;
      if (!(client.request ?? "").includes("prefix"))
        return `The DHCPv6 client on '${a.interface}' does not request a prefix (request=${client.request ?? "?"}), so there is nothing to follow.`;
      if (client.script && !isOurs(client.script) && !a.replace)
        return `The DHCPv6 client on '${a.interface}' already has a script that this tool did not write. Pass replace=true to replace it, or add these lines to your script by hand.`;

      const script = buildPrefixScript(a.list, a.hosts);
      const lists = [a.list, ...a.hosts.map((host: PrefixHost) => `${a.list}-${host.name}`)];
      if (!a.apply)
        return `DRY RUN — would install this script on the DHCPv6 client of '${a.interface}'. It maintains: ${lists.join(", ")}. Set apply=true to install.\n\n${script}`;

      const result = await executeMikrotikCommand(
        new Cmd(`/ipv6 dhcp-client set [find interface=${quoted(a.interface)}]`)
          .set("script", script)
          .build(),
        ctx,
      );
      if (looksLikeError(result)) return `Failed to install the script: ${result}`;
      return [
        `Installed. The DHCPv6 client of '${a.interface}' now maintains: ${lists.join(", ")}.`,
        "The lists are filled the next time a prefix is bound. Run renew_ipv6_dhcp_client to fill them now.",
        "Use the lists in firewall rules (src-address-list / dst-address-list) in place of literal addresses.",
      ].join("\n");
    },
  }),

  defineTool({
    name: "unfollow_ipv6_prefix",
    title: "Stop Following the Delegated IPv6 Prefix",
    annotations: DESTRUCTIVE,
    description:
      "Undoes `follow_ipv6_prefix`: clears the script it installed on the DHCPv6 client of " +
      "`interface` and removes the address-list entries the script made for `list`. A script " +
      "that this tool did not write is left alone. Firewall rules that use those lists then " +
      "match nothing: change or remove them first. Returns what was cleared.",
    inputSchema: {
      interface: z.string().describe("Interface of the DHCPv6 client"),
      list: z.string().regex(NAME).default("isp-prefix"),
    },
    async handler(a, ctx) {
      const client = parseRecords(
        await executeMikrotikCommand(
          `/ipv6 dhcp-client print detail where interface=${quoted(a.interface)}`,
          { ...ctx, risk: "READ" },
        ),
      ).rows[0];
      const done: string[] = [];
      if (client && isOurs(client.script)) {
        const cleared = await executeMikrotikCommand(
          new Cmd(`/ipv6 dhcp-client set [find interface=${quoted(a.interface)}]`)
            .set("script", "")
            .build(),
          ctx,
        );
        if (looksLikeError(cleared)) return `Failed to clear the script: ${cleared}`;
        done.push("the script");
      }
      const removed = await executeMikrotikCommand(
        `/ipv6 firewall address-list remove [find comment=${quoted(`${TAG}: ${a.list}`)}]`,
        ctx,
      );
      if (looksLikeError(removed)) return `Failed to remove the list entries: ${removed}`;
      done.push(`the entries of '${a.list}'`);
      return `Cleared ${done.join(" and ")}.`;
    },
  }),
];
