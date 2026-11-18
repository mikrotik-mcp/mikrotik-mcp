/**
 * Parental Controls / Time-of-Day Policy — schedule per-device internet access
 * and content blocking from plain intent ("no internet for the kids' devices
 * after 10 pm; block these domains"). Wires a device address-list, a scheduled
 * forward-drop rule (enabled/disabled by two schedulers), and optional DNS
 * sinkhole entries for blocked domains. Previewable before applying.
 *
 * The pure `buildPolicyCommands` is unit-tested; the tools wire apply/remove.
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { Cmd, looksLikeError, quoted } from "../core/routeros";

export interface PolicyOptions {
  name: string;
  list: string; // device address-list
  addresses?: string[]; // optional addresses to add to the list
  blockStart: string; // "22:00"
  blockEnd: string; // "07:00"
  blockDomains?: string[]; // DNS sinkhole (always blocked)
}

/** Build the address-list, scheduled drop rule, schedulers and DNS sinkholes. */
export function buildPolicyCommands(o: PolicyOptions): { label: string; commands: string[] }[] {
  const tag = `parental-${o.name}`;
  const groups: { label: string; commands: string[] }[] = [];

  if (o.addresses?.length) {
    groups.push({
      label: "Target devices",
      commands: o.addresses.map((addr) =>
        new Cmd("/ip firewall address-list add")
          .set("list", o.list)
          .set("address", addr)
          .set("comment", tag)
          .build(),
      ),
    });
  }

  groups.push({
    label: "Scheduled internet cut-off",
    commands: [
      // The drop rule starts DISABLED; the schedulers toggle it on/off each day.
      new Cmd("/ip firewall filter add")
        .set("chain", "forward")
        .set("src-address-list", o.list)
        .set("action", "drop")
        .set("comment", tag)
        .set("disabled", "yes")
        .build(),
      new Cmd("/system scheduler add")
        .set("name", `${tag}-block`)
        .set("start-time", o.blockStart)
        .set("interval", "1d")
        .set("on-event", `/ip firewall filter enable [find comment=${quoted(tag)}]`)
        .set("comment", tag)
        .build(),
      new Cmd("/system scheduler add")
        .set("name", `${tag}-allow`)
        .set("start-time", o.blockEnd)
        .set("interval", "1d")
        .set("on-event", `/ip firewall filter disable [find comment=${quoted(tag)}]`)
        .set("comment", tag)
        .build(),
    ],
  });

  if (o.blockDomains?.length) {
    groups.push({
      label: "Content blocking (DNS sinkhole)",
      commands: o.blockDomains.map((d) =>
        new Cmd("/ip dns static add")
          .set("name", d)
          .set("address", "0.0.0.0")
          .set("comment", tag)
          .build(),
      ),
    });
  }
  return groups;
}

export const parentalControlsTools: ToolModule = [
  defineTool({
    name: "set_time_policy",
    title: "Set Time-of-Day / Parental Policy",
    annotations: WRITE,
    description:
      "Schedules per-device internet access and content blocking. Cuts internet for devices in the " +
      "`list` address-list between `block_start` and `block_end` daily (a forward-drop rule toggled by " +
      "two schedulers), optionally adds `addresses` to that list, and DNS-sinkholes any `block_domains` " +
      "(always blocked). DEFAULTS TO A DRY RUN (`apply=false`) showing every command; set `apply=true` " +
      "to install. Everything is tagged 'parental-<name>' so remove_time_policy can undo it. Returns " +
      "the plan or a build report.",
    inputSchema: {
      name: z.string().describe("Policy id, e.g. 'kids-bedtime'"),
      list: z.string().default("parental-devices").describe("Address-list of the affected devices"),
      addresses: z.array(z.string()).optional().describe("Device IPs to add to the list"),
      block_start: z.string().default("22:00").describe("Daily cut-off time (HH:MM)"),
      block_end: z.string().default("07:00").describe("Daily restore time (HH:MM)"),
      block_domains: z.array(z.string()).optional().describe("Domains to always block via DNS"),
      apply: z.boolean().default(false).describe("false = preview (default); true = install"),
    },
    async handler(a, ctx) {
      const groups = buildPolicyCommands({
        name: a.name,
        list: a.list,
        addresses: a.addresses as string[] | undefined,
        blockStart: a.block_start,
        blockEnd: a.block_end,
        blockDomains: a.block_domains as string[] | undefined,
      });
      const all = groups.flatMap((g) => g.commands);
      if (!a.apply) {
        const preview = groups
          .map((g) => `# ${g.label}\n${g.commands.map((c) => `  ${c}`).join("\n")}`)
          .join("\n\n");
        return `DRY RUN — policy '${a.name}': block ${a.block_start}–${a.block_end} for list '${a.list}'; ${all.length} command(s) (set apply=true to install):\n\n${preview}`;
      }
      const done: string[] = [];
      for (const cmd of all) {
        const result = await executeMikrotikCommand(cmd, ctx);
        if (looksLikeError(result)) {
          return `Installed ${done.length}/${all.length}, then FAILED: ${result}`;
        }
        done.push(cmd);
      }
      return `Policy '${a.name}' installed — internet for '${a.list}' is blocked ${a.block_start}–${a.block_end} daily${a.block_domains?.length ? `, and ${a.block_domains.length} domain(s) sinkholed` : ""}.`;
    },
  }),

  defineTool({
    name: "remove_time_policy",
    title: "Remove Time-of-Day / Parental Policy",
    annotations: DESTRUCTIVE,
    description:
      "Removes a policy installed by set_time_policy: the schedulers, the forward-drop rule, and the " +
      "DNS sinkhole entries tagged 'parental-<name>'. Address-list members added for it are also " +
      "removed. Returns what was cleared.",
    inputSchema: { name: z.string().describe("The policy id used when installing") },
    async handler(a, ctx) {
      const tag = `parental-${a.name}`;
      ctx.info(`Removing parental policy ${tag}`);
      const steps: [string, string][] = [
        ["schedulers", `/system scheduler remove [find comment=${quoted(tag)}]`],
        ["firewall rule", `/ip firewall filter remove [find comment=${quoted(tag)}]`],
        ["dns sinkholes", `/ip dns static remove [find comment=${quoted(tag)}]`],
        ["address-list", `/ip firewall address-list remove [find comment=${quoted(tag)}]`],
      ];
      const cleared: string[] = [];
      for (const [label, cmd] of steps) {
        const r = await executeMikrotikCommand(cmd, ctx);
        if (looksLikeError(r))
          return `Failed removing ${label}: ${r} (cleared: ${cleared.join(", ") || "none"})`;
        cleared.push(label);
      }
      return `Policy '${a.name}' removed (${cleared.join(", ")}).`;
    },
  }),
];
