/**
 * Zone-based firewall — `design_zone_firewall` / `remove_zone_firewall`.
 *
 * Describe zones (sets of interfaces) and what may pass between them; the tool
 * compiles interface lists and filter rules, shows them, and applies them in
 * Safe Mode after a snapshot. The model is in `src/core/zone-firewall.ts`.
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { DESTRUCTIVE, WRITE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { looksLikeError } from "../core/routeros";
import { parseRecords } from "../core/routeros-parse";
import { resolveDeviceName } from "../core/runtime";
import { ROUTER, ZONE_TAG, checkZoneDesign, compileZones } from "../core/zone-firewall";
import { captureSnapshot } from "../snapshots/capture";
import { applyWritesSafely } from "../utils/safe-mode-apply";

/** The menus that hold tagged items, in the order they must be removed. */
const TAGGED_MENUS = ["/ip firewall filter", "/interface list member", "/interface list"] as const;
const TAGGED = `comment~"^${ZONE_TAG}: "`;

export const zoneFirewallTools: ToolModule = [
  defineTool({
    name: "design_zone_firewall",
    title: "Design a Zone-Based Firewall",
    annotations: WRITE,
    description:
      "Builds a zone-based firewall from a description instead of single rules. You name zones " +
      "(each a set of interfaces, for example lan, guest, wan) and policies (what may go from one " +
      "zone to another, optionally limited to a protocol and ports). The tool creates one " +
      "interface list for each zone and filter rules for each policy, accepts replies to allowed " +
      `connections, and drops everything else that enters from a zone. The special zone '${ROUTER}' ` +
      "is the router itself: `from: lan, to: router` allows access TO the router (an input rule). " +
      "DEFAULTS TO A DRY RUN (`apply=false`) that returns every command. With `apply=true` it " +
      "takes a config snapshot and writes in Safe Mode, so a rule that cuts your own connection is " +
      "rolled back. It refuses a design it cannot make safely: an interface in two zones, an " +
      "unknown zone or interface, ports without a protocol, or `protect_router=true` with no " +
      "accept policy to the router (that would lock everyone out). Rules are added at the END of " +
      "each chain, so existing rules that match first still decide. Use `remove_zone_firewall` to " +
      "take the whole design out. IPv4 only.",
    inputSchema: {
      zones: z
        .array(
          z.object({
            name: z.string().describe("Zone name: lowercase letters, digits, '-'"),
            interfaces: z.array(z.string().min(1)).describe("Interfaces in this zone"),
          }),
        )
        .min(1)
        .max(16),
      policies: z
        .array(
          z.object({
            from: z.string().describe(`Source zone, or '${ROUTER}'`),
            to: z.string().describe(`Destination zone, or '${ROUTER}'`),
            action: z.enum(["accept", "drop", "reject"]).default("accept"),
            protocol: z.enum(["tcp", "udp", "icmp"]).optional(),
            ports: z.string().optional().describe("Destination ports, e.g. '443' or '80,443'"),
            note: z.string().max(60).optional().describe("A short note for the rule comment"),
          }),
        )
        .max(64)
        .default([]),
      protect_router: z
        .boolean()
        .default(false)
        .describe("Also drop traffic to the router itself that no policy allows"),
      apply: z.boolean().default(false).describe("false = show the commands; true = apply"),
    },
    async handler(a, ctx) {
      const design = { zones: a.zones, policies: a.policies, protectRouter: a.protect_router };
      const problems = checkZoneDesign(design);
      const read = { ...ctx, risk: "READ" as const };
      if (problems.length === 0) {
        const known = new Set(
          parseRecords(await executeMikrotikCommand("/interface print detail", read)).rows.map(
            (row) => row.name,
          ),
        );
        for (const zone of a.zones)
          for (const iface of zone.interfaces)
            if (!known.has(iface))
              problems.push(`Interface '${iface}' (zone '${zone.name}') is not on this router.`);
        const existing = await executeMikrotikCommand(
          `/interface list print count-only where ${TAGGED}`,
          read,
        );
        if (Number(existing.trim()) > 0)
          problems.push(
            "A zone firewall is already on this router. Run remove_zone_firewall first, then design it again.",
          );
      }
      if (problems.length > 0)
        return {
          text: `The design cannot be built:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
          isError: true,
        };

      const plan = compileZones(design);
      const commands = plan.groups.flatMap((group) => group.commands);
      const preview = plan.groups
        .map((group) => `# ${group.label}\n${group.commands.map((c) => `  ${c}`).join("\n")}`)
        .join("\n");
      const notes = plan.notes.map((note) => `  - ${note}`).join("\n");
      if (!a.apply)
        return `DRY RUN — ${commands.length} command(s) for ${a.zones.length} zone(s) and ${a.policies.length} policy(ies). Set apply=true to apply.\n\n${preview}\n\nNotes:\n${notes}`;

      const device = resolveDeviceName(ctx.device);
      const snapshotId = await captureSnapshot(ctx, "pre-zone-firewall");
      // No direct fallback: a firewall change must be able to roll back.
      const outcome = await applyWritesSafely(ctx, device, commands, {
        allowDirectFallback: false,
      });
      return [
        `ZONE FIREWALL — snapshot=${snapshotId}  safe-mode=${outcome.safeMode}`,
        `Applied ${outcome.applied}/${outcome.total} command(s).`,
        ...(outcome.error
          ? [
              `FAILED: ${outcome.error}`,
              "Do not run it again before you check what is on the router.",
            ]
          : []),
        "",
        preview,
        "",
        "Notes:",
        notes,
        "",
        `Compare with before: diff_config_snapshots from=${snapshotId} to=live`,
      ].join("\n");
    },
  }),

  defineTool({
    name: "remove_zone_firewall",
    title: "Remove the Zone-Based Firewall",
    annotations: DESTRUCTIVE,
    description:
      "Removes everything `design_zone_firewall` created on a router: its filter rules, zone " +
      `interface-list members and zone interface lists (all carry a '${ZONE_TAG}:' comment). Rules ` +
      "you added yourself are not touched. After this, traffic between the former zones is decided " +
      "by the rules that remain, which may be none: check before you remove a firewall on a router " +
      "that faces the internet. DEFAULTS TO A DRY RUN (`apply=false`) that counts what would go.",
    inputSchema: {
      apply: z.boolean().default(false).describe("false = count only; true = remove"),
    },
    async handler(a, ctx) {
      const read = { ...ctx, risk: "READ" as const };
      const counts: number[] = [];
      for (const menu of TAGGED_MENUS)
        counts.push(
          Number(
            (await executeMikrotikCommand(`${menu} print count-only where ${TAGGED}`, read)).trim(),
          ) || 0,
        );
      const summary = `${counts[0]} filter rule(s), ${counts[1]} list member(s), ${counts[2]} zone list(s)`;
      if (counts.every((count) => count === 0)) return "No zone firewall is on this router.";
      if (!a.apply) return `DRY RUN — would remove ${summary}. Set apply=true to remove.`;

      await captureSnapshot(ctx, "pre-zone-firewall-remove");
      for (const menu of TAGGED_MENUS) {
        const result = await executeMikrotikCommand(`${menu} remove [find ${TAGGED}]`, ctx);
        if (looksLikeError(result)) return `Failed while removing from ${menu}: ${result}`;
      }
      return `Zone firewall removed: ${summary}.`;
    },
  }),
];
