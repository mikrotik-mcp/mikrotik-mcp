/**
 * Threat-Feed Auto-Blocklist — subscribe a router to an external threat-intel IP
 * feed. Installs a scheduled `/system script` that fetches the feed and imports
 * it into a dynamic firewall address-list, plus an optional raw drop rule for
 * that list — a continuously self-updating blocklist with no manual upkeep.
 *
 * The feed URL must point to a RouterOS `.rsc` file that populates the
 * address-list (the common format threat feeds publish for MikroTik, e.g.
 * lines of `/ip firewall address-list add list=<name> address=...`).
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { Cmd, looksLikeError, quoted } from "../core/routeros";

const FEED_TAG = "threat-feed";

/**
 * A feed name becomes part of a script name, a file name and the text of a
 * stored script, which the router runs later. Only a plain identifier is safe
 * in all of those, so anything else is refused.
 */
const FEED_NAME = z
  .string()
  .regex(
    /^[A-Za-z0-9][\w.-]{0,40}$/,
    "Use letters, digits, '.', '_' and '-' (41 characters at most).",
  );

export const threatFeedTools: ToolModule = [
  defineTool({
    name: "subscribe_threat_feed",
    title: "Subscribe to Threat-Intel Feed",
    annotations: WRITE,
    description:
      "Subscribes the router to an external threat-intelligence IP feed: installs a `/system script` " +
      "that fetches `url` and imports it into the `address_list`, a `/system scheduler` that re-runs it " +
      "every `interval`, and (when `drop=true`) a raw pre-conntrack drop for that list — a self-updating " +
      "blocklist (e.g. Spamhaus DROP, tor exit nodes, your own deny list). `url` MUST point to a " +
      "RouterOS `.rsc` file that populates the address-list. DEFAULTS TO A DRY RUN (`apply=false`); set " +
      "`apply=true` to install. Script/scheduler/rule are named/tagged `threat-feed-<name>` so " +
      "remove_threat_feed can undo them. Returns the plan or a build report.",
    inputSchema: {
      name: FEED_NAME.describe("Short feed id, e.g. 'spamhaus-drop'"),
      url: z.string().describe("HTTPS URL of a RouterOS .rsc address-list file"),
      address_list: z.string().default("threat-blocklist").describe("Address-list to populate"),
      interval: z.string().default("1h").describe("How often to refresh the feed"),
      drop: z.boolean().default(true).describe("Also add a raw drop rule for the address-list"),
      apply: z.boolean().default(false).describe("false = preview (default); true = install"),
    },
    async handler(a, ctx) {
      const id = `${FEED_TAG}-${a.name}`;
      const rsc = `${id}.rsc`;
      const source = `/tool fetch url=${quoted(a.url)} dst-path=${rsc}; :delay 5s; /import file-name=${rsc}`;
      const commands = [
        new Cmd("/system script add").set("name", id).set("source", source).build(),
        new Cmd("/system scheduler add")
          .set("name", id)
          .set("interval", a.interval)
          .set("on-event", `/system script run ${id}`)
          .set("comment", `${FEED_TAG}: ${a.name}`)
          .build(),
      ];
      if (a.drop) {
        commands.push(
          new Cmd("/ip firewall raw add")
            .set("chain", "prerouting")
            .set("src-address-list", a.address_list)
            .set("action", "drop")
            .set("comment", `${FEED_TAG}: drop ${a.name}`)
            .build(),
        );
      }

      if (!a.apply) {
        const plan = commands.map((c, i) => `${i + 1}. ${c}`).join("\n");
        return `DRY RUN — threat feed '${a.name}' → list '${a.address_list}', every ${a.interval}; ${commands.length} command(s) (set apply=true to install):\n\n${plan}`;
      }
      const done: string[] = [];
      for (const cmd of commands) {
        const result = await executeMikrotikCommand(cmd, ctx);
        if (looksLikeError(result)) {
          return `Installed ${done.length}/${commands.length}, then FAILED: ${result}`;
        }
        done.push(cmd);
      }
      // Kick off an initial fetch so the list is populated immediately.
      await executeMikrotikCommand(`/system script run ${id}`, ctx);
      return `Threat feed '${a.name}' subscribed — script + scheduler (${a.interval})${a.drop ? " + raw drop" : ""} installed, and an initial fetch was triggered. Check /ip firewall address-list for '${a.address_list}'.`;
    },
  }),

  defineTool({
    name: "remove_threat_feed",
    title: "Remove Threat-Intel Feed",
    annotations: DESTRUCTIVE,
    description:
      "Removes a threat feed installed by subscribe_threat_feed: deletes its `/system scheduler` and " +
      "`/system script` (named `threat-feed-<name>`) and any raw drop rule tagged for it. Does NOT " +
      "flush the address-list entries themselves. Returns what was removed.",
    inputSchema: { name: FEED_NAME.describe("The feed id used when subscribing") },
    async handler(a, ctx) {
      const id = `${FEED_TAG}-${a.name}`;
      ctx.info(`Removing threat feed ${id}`);
      const steps: [string, string][] = [
        ["scheduler", `/system scheduler remove [find name=${quoted(id)}]`],
        ["script", `/system script remove [find name=${quoted(id)}]`],
        [
          "raw drop",
          `/ip firewall raw remove [find comment~${quoted(`${FEED_TAG}: drop ${a.name}`)}]`,
        ],
      ];
      const removed: string[] = [];
      for (const [label, cmd] of steps) {
        const r = await executeMikrotikCommand(cmd, ctx);
        if (looksLikeError(r))
          return `Failed removing ${label}: ${r} (removed: ${removed.join(", ") || "none"})`;
        removed.push(label);
      }
      return `Threat feed '${a.name}' removed (${removed.join(", ")}). Address-list entries were left in place.`;
    },
  }),
];
