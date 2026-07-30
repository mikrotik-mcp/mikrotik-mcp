/**
 * Attack Detection — watch the fleet's logs, correlate what they say into
 * incidents, and stop an attacker when the operator has asked for that.
 *
 * The repo's other security modules answer "is this box configured well?".
 * These answer **"is someone attacking it right now, and what did they do?"** —
 * which is the question you have when it is happening.
 *
 * Two things to keep in mind when calling these:
 *
 * - **Detection is free; response is not.** `scan_for_attacks` and the list
 *   tools never touch a device's configuration. `block_attacker` does, is a
 *   dry run unless `confirm: true`, and is refused outright when the evidence
 *   is spoofable or the address is protected.
 * - **This is not an IDS.** No packet inspection, no signature database. It
 *   reasons over what RouterOS already writes down, and says so when a source
 *   it needs is missing rather than reporting a calm network.
 */
import { z } from "zod";
import { DESTRUCTIVE, READ, WRITE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { getConfig } from "../core/runtime";
import { executePlan, revokeBlock } from "../attack/execute";
import { decide, isNeverBlock, isPlan, neverBlockSet } from "../attack/respond";
import { buildGuards, policyFromConfig, sweep } from "../attack/session";
import { attackStore } from "../attack/store";
import type { Incident } from "../attack/correlate";

function stamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

const MARK: Record<string, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🟢",
  info: "·",
};

function incidentLine(i: Incident): string {
  return (
    `${MARK[i.severity] ?? "·"} ${i.id}  ${i.source || "(config change)"}  ` +
    `${i.stage}/${i.confidence}  ${i.devices.join(", ")}  ${stamp(i.lastTs)}`
  );
}

export const attackTools: ToolModule = [
  defineTool({
    name: "scan_for_attacks",
    title: "Scan for Attacks Now",
    annotations: READ,
    noDevice: true,
    description:
      "Reads recent logs from every configured device, runs the attack detectors, and correlates " +
      "what they find into incidents — brute force, credential spraying, a login that SUCCEEDED " +
      "after failures, port scans, management ports answering the internet, and unexplained " +
      "changes to security-relevant configuration. Read-only: it changes nothing on any device. " +
      "One source hitting several routers is reported as ONE incident, which is the pattern no " +
      "single router can see. Detectors whose input is missing say so and name the fix, rather " +
      "than reporting a quiet network.",
    inputSchema: {
      devices: z.array(z.string()).optional().describe("Limit to these devices (default: all)."),
      window_minutes: z.coerce
        .number()
        .int()
        .positive()
        .max(1440)
        .optional()
        .describe("How far back to read. Default from config (10)."),
    },
    async handler(a, ctx) {
      ctx.info("Scanning the fleet for attacks");
      // Never responds: an operator asking "what is happening" has not asked
      // for anything to be changed.
      const result = await sweep({
        devices: a.devices,
        windowMinutes: a.window_minutes,
        respond: false,
      });

      const lines: string[] = [];
      const failed = result.devices.filter((d) => !d.ok);
      lines.push(
        `Scanned ${result.devices.length} device(s), ${result.devices.reduce((n, d) => n + d.events, 0)} log event(s).`,
      );
      for (const f of failed) lines.push(`  ✗ ${f.device}: ${f.error}`);
      lines.push("");

      if (result.incidents.length === 0) {
        lines.push("No attack incidents found in this window.");
      } else {
        lines.push(`${result.incidents.length} incident(s), worst first:`, "");
        for (const incident of result.incidents) {
          lines.push(incidentLine(incident));
          lines.push(`   ${incident.narrative}`);
          lines.push(`   → ${incident.recommendations[0]}`);
          lines.push("");
        }
      }

      if (result.unavailable.length > 0) {
        // The honest part: what could NOT be checked, so silence is never read
        // as safety.
        lines.push("Detectors that could not run:");
        for (const u of result.unavailable) {
          lines.push(`  · ${u.detector} — ${u.reason}${u.fix ? `\n      fix: ${u.fix}` : ""}`);
        }
      }
      return lines.join("\n");
    },
  }),

  defineTool({
    name: "list_attack_incidents",
    title: "List Attack Incidents",
    annotations: READ,
    noDevice: true,
    description:
      "Lists recorded attack incidents newest-first: attacker address, how far they got " +
      "(recon → attempt → breach → persistence), how much the evidence justifies believing it, " +
      "which devices they touched, and when. Use get_attack_incident for the evidence behind one. " +
      "Reads stored history — it does not contact any device.",
    inputSchema: {
      hours: z.coerce.number().int().positive().max(8760).default(24).describe("How far back."),
      min_confidence: z
        .enum(["low", "medium", "high", "confirmed"])
        .optional()
        .describe("Only incidents at or above this confidence."),
      limit: z.coerce.number().int().positive().max(500).default(50),
    },
    async handler(a) {
      const store = await attackStore();
      const rank: Record<string, number> = { low: 0, medium: 1, high: 2, confirmed: 3 };
      const incidents = store
        .listIncidents({ since: Date.now() - a.hours * 3_600_000, limit: a.limit })
        .filter((i) => !a.min_confidence || rank[i.confidence] >= rank[a.min_confidence]);

      if (incidents.length === 0) {
        return `No attack incidents recorded in the last ${a.hours}h. Run scan_for_attacks to look now.`;
      }
      const lines = [`${incidents.length} incident(s) in the last ${a.hours}h:`, ""];
      for (const incident of incidents) {
        lines.push(incidentLine(incident));
        lines.push(`   ${incident.narrative}`);
        lines.push("");
      }
      return lines.join("\n").trimEnd();
    },
  }),

  defineTool({
    name: "get_attack_incident",
    title: "Attack Incident Detail",
    annotations: READ,
    noDevice: true,
    description:
      "One incident in full: the story, every piece of evidence with its raw log line and " +
      "timestamp, which detectors fired, the devices affected, and the existing tools that " +
      "address it. Use this before deciding whether to block someone — an incident that cannot " +
      "show its work should not be acted on.",
    inputSchema: {
      id: z.string().describe("Incident id from list_attack_incidents."),
    },
    async handler(a) {
      const incident = (await attackStore()).getIncident(a.id);
      if (!incident) return `No incident '${a.id}'.`;

      const lines = [
        `${MARK[incident.severity] ?? "·"} ${incident.id}`,
        "",
        incident.narrative,
        "",
        `Source:      ${incident.source || "(a configuration change, not a connection)"}`,
        `Stage:       ${incident.stage}`,
        `Confidence:  ${incident.confidence}`,
        `Devices:     ${incident.devices.join(", ")}`,
        `Detectors:   ${incident.detectors.join(", ")}`,
        `Seen:        ${stamp(incident.firstTs)} → ${stamp(incident.lastTs)} (${incident.signalCount} signal(s))`,
        "",
      ];
      if (incident.spoofableOnly) {
        lines.push(
          "⚠ Every signal here rests on a source address that can be forged. This incident",
          "  cannot be blocked automatically, and blocking it by hand risks punishing whoever",
          "  the attacker chose to name.",
          "",
        );
      }
      lines.push("What to do:");
      for (const r of incident.recommendations) lines.push(`  → ${r}`);
      lines.push("", `Evidence (${incident.evidence.length}):`);
      for (const e of incident.evidence.slice(0, 40)) {
        lines.push(`  ${e.ts ? stamp(e.ts) : "??"} [${e.device}] ${e.message}`);
      }
      return lines.join("\n");
    },
  }),

  defineTool({
    name: "block_attacker",
    title: "Block an Attacker",
    annotations: WRITE,
    noDevice: true,
    description:
      "Blocks an attacker by adding their address to the `mcp-attack-block` address list on every " +
      "affected device, behind a single raw-chain drop rule created once per device. " +
      "DRY RUN unless confirm=true. Timed by default so a wrong block expires on its own; a " +
      "permanent block needs an explicit timeout of ''. " +
      "REFUSED, whatever you pass, when: the evidence is only spoofable (a forged flood would let " +
      "the attacker choose the victim), the address is this server's own management path or a " +
      "device or its gateway/resolver, or the per-hour response cap has been reached. " +
      "A confirmed breach escalates instead — blocking the source does not undo someone already " +
      "being in.",
    inputSchema: {
      incident_id: z.string().describe("Incident to act on, from list_attack_incidents."),
      timeout: z
        .string()
        .optional()
        .describe(
          "How long, e.g. '1h', '1d00:00:00'. Empty string means permanent (needs confirm).",
        ),
      confirm: z.boolean().default(false).describe("Actually apply it. Default false = dry run."),
    },
    async handler(a, ctx) {
      const store = await attackStore();
      const incident = store.getIncident(a.incident_id);
      if (!incident) return `No incident '${a.incident_id}'.`;

      const decision = decide({
        incident,
        policy: policyFromConfig(),
        guards: buildGuards(),
        recentBlockCount: store.countRecentBlocks(incident.devices, Date.now() - 3_600_000),
        manual: true,
        confirm: a.confirm,
        timeout: a.timeout,
      });

      if (!isPlan(decision)) {
        const guard = (decision as { guard: boolean }).guard;
        return `${guard ? "REFUSED" : "Not applied"}: ${decision.reason}`;
      }
      if (decision.action === "escalate") {
        return `Escalated, not blocked: ${decision.reason}\n\n${incident.narrative}`;
      }

      if (!a.confirm) {
        return (
          `DRY RUN — nothing was changed.\n\n` +
          `Would ${decision.action} ${decision.source} on ${decision.devices.join(", ")}\n` +
          `  list:    ${decision.list}\n` +
          `  timeout: ${decision.timeout || "permanent"}\n` +
          `  reason:  ${decision.reason}\n\n` +
          `Re-run with confirm=true to apply.`
        );
      }

      ctx.info(`Blocking ${decision.source} on ${decision.devices.join(", ")}`);
      const applied = await executePlan(decision);
      const ok = applied.some((r) => r.ok);
      store.recordResponse({
        incidentId: incident.id,
        action: decision.action,
        source: decision.source,
        devices: decision.devices,
        timeout: decision.timeout,
        list: decision.list,
        reason: decision.reason,
        ts: Date.now(),
        ok,
        error: ok ? undefined : applied.map((r) => r.detail).join("; "),
      });
      return [
        `${ok ? "Blocked" : "FAILED to block"} ${decision.source}:`,
        ...applied.map((r) => `  ${r.ok ? "✓" : "✗"} ${r.device}: ${r.detail}`),
        "",
        decision.timeout
          ? `It lapses after ${decision.timeout}. Reverse it sooner with unblock_attacker.`
          : "This block is PERMANENT. Reverse it with unblock_attacker.",
      ].join("\n");
    },
  }),

  defineTool({
    name: "unblock_attacker",
    title: "Unblock an Address",
    annotations: DESTRUCTIVE,
    noDevice: true,
    description:
      "Removes an address from the attack block list on every device it was applied to, and marks " +
      "the response as revoked so the history still explains what happened and why it was undone. " +
      "Use when a block turns out to have caught something legitimate.",
    inputSchema: {
      address: z.string().describe("The blocked address."),
      devices: z
        .array(z.string())
        .optional()
        .describe("Devices to clear (default: the ones the block was applied to)."),
    },
    async handler(a, ctx) {
      const store = await attackStore();
      const response = store.responseFor(a.address);
      const devices = a.devices ?? response?.devices;
      if (!devices || devices.length === 0) {
        return `No recorded block for ${a.address}. Pass the devices explicitly to clear it anyway.`;
      }
      ctx.info(`Unblocking ${a.address} on ${devices.join(", ")}`);
      const results = await revokeBlock(a.address, devices, response?.list);
      store.revokeResponse(a.address, Date.now());
      return [
        `Unblocked ${a.address}:`,
        ...results.map((r) => `  ${r.ok ? "✓" : "✗"} ${r.device}: ${r.detail}`),
      ].join("\n");
    },
  }),

  defineTool({
    name: "list_attack_responses",
    title: "List Attack Responses",
    annotations: READ,
    noDevice: true,
    description:
      "Every block this server has applied: what, why, from which incident, on which devices, and " +
      "when it expires. An entry in a device's address list that nobody can explain is worse than " +
      "no entry at all, so this is the record that makes automatic blocking reversible.",
    inputSchema: {
      active_only: z.boolean().default(true).describe("Only blocks still in force."),
      limit: z.coerce.number().int().positive().max(500).default(50),
    },
    async handler(a) {
      const responses = (await attackStore()).listResponses({
        active: a.active_only,
        limit: a.limit,
      });
      if (responses.length === 0) {
        return a.active_only ? "No blocks are currently in force." : "No blocks have been applied.";
      }
      const lines = [`${responses.length} response(s):`, ""];
      for (const r of responses) {
        lines.push(
          `${r.ok ? "✓" : "✗"} ${r.source}  ${r.action}  ${r.devices.join(", ")}  ${stamp(r.ts)}` +
            `${r.revokedAt ? `  (revoked ${stamp(r.revokedAt)})` : ""}` +
            `${r.timeout ? `  expires after ${r.timeout}` : "  PERMANENT"}`,
        );
        lines.push(`   ${r.reason}`);
        if (r.error) lines.push(`   error: ${r.error}`);
        lines.push(`   incident: ${r.incidentId}`);
        lines.push("");
      }
      return lines.join("\n").trimEnd();
    },
  }),

  defineTool({
    name: "configure_attack_response",
    title: "Show Attack Response Policy",
    annotations: READ,
    noDevice: true,
    description:
      "Shows the current detection and response policy: the mode, thresholds, which detectors may " +
      "respond automatically, the per-hour cap, and the never-block list including the entries " +
      "derived from your own deployment. Also checks a specific address against the never-block " +
      "rules, which is the fastest way to answer 'why did it refuse to block that?'. " +
      "The policy itself lives in the `attacks` config block — edit it there or in the dashboard, " +
      "so a change survives a restart.",
    inputSchema: {
      check_address: z
        .string()
        .optional()
        .describe("Ask whether this address would be refused, and why."),
    },
    async handler(a) {
      const cfg = getConfig().attacks;
      const guards = buildGuards();
      const never = neverBlockSet(guards);

      if (a.check_address) {
        const protectedNow = isNeverBlock(a.check_address, never);
        return protectedNow
          ? `${a.check_address} is PROTECTED and can never be blocked.\nIt matches the never-block set, which covers every configured device, this server's own management path, and the private ranges.`
          : `${a.check_address} is not protected by the never-block set. Whether it would actually be blocked also depends on the mode (${cfg.mode}), the confidence floor (${cfg.minConfidence}), and whether its evidence is spoofable.`;
      }

      return [
        `Attack detection: ${cfg.enabled ? "enabled" : "DISABLED"}`,
        `Mode:             ${cfg.mode}${cfg.mode === "detect" ? " — nothing is changed on any device" : " — automatic blocks are ARMED"}`,
        `Sweep:            every ${cfg.pollSeconds}s over a ${cfg.windowMinutes}m window, ${cfg.concurrency} devices at a time`,
        "",
        `Confidence floor: ${cfg.minConfidence}`,
        `Auto-responds to: ${cfg.autoRespondTo.join(", ") || "(nothing)"}`,
        `Block timeout:    ${cfg.blockTimeout}`,
        `Rate cap:         ${cfg.maxBlocksPerHour} blocks per device per hour`,
        `Learning window:  ${cfg.learningDays} days`,
        "",
        `Never blocked (${never.size} entries):`,
        ...[...never].sort().map((n) => `  ${n}`),
        "",
        "Spoofable evidence is never acted on automatically, whatever this policy says.",
      ].join("\n");
    },
  }),
];
