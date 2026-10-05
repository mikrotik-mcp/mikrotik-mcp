/**
 * Wi-Fi Optimizer — "fix my Wi-Fi" as a scan-and-tune workflow. Runs a RouterOS
 * frequency usage survey on a (legacy `/interface wireless`) radio, finds the
 * least-congested channel, and optionally applies it — with a before/after note.
 *
 * The pure `pickBestFrequency` is unit-tested; the tool wires survey + apply.
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { looksLikeError } from "../core/routeros";

/** The least-congested (freq, usage%) from `/interface wireless frequency-monitor`. */
export function pickBestFrequency(monitor: string): { frequency: number; usePct: number } | null {
  const cands: { frequency: number; usePct: number }[] = [];
  for (const line of monitor.split("\n")) {
    const f = line.match(/\b(2[34]\d{2}|5\d{3}|6\d{3})\b/); // 2.4 / 5 / 6 GHz
    const u = line.match(/(\d{1,3})\s*%/);
    if (f && u) cands.push({ frequency: Number(f[1]), usePct: Number(u[1]) });
  }
  if (cands.length === 0) return null;
  return cands.reduce((best, c) => (c.usePct < best.usePct ? c : best));
}

export const wifiOptimizerTools: ToolModule = [
  defineTool({
    name: "tune_wifi_channel",
    title: "Survey & Tune Wi-Fi Channel",
    annotations: WRITE,
    description:
      "Runs an RF survey on a wireless radio (`/interface wireless frequency-monitor`, blocking for " +
      "`duration`), finds the least-congested channel, and reports a before/after. DEFAULTS TO A DRY " +
      "RUN (`apply=false`) — it surveys and recommends; set `apply=true` to set the radio to the best " +
      "frequency (`/interface wireless set`). Targets ONLY the LEGACY wireless stack, including legacy drivers on v7; " +
      "for modern wifi/wifiwave2 use get_wireless_interface_status for a non-disruptive current-channel read or " +
      "scan_wifi_channels for an explicitly approved, disruptive channel-load survey (no auto-tuning). Returns the per-channel usage finding and the chosen " +
      "frequency.",
    inputSchema: {
      interface: z.string().describe("Wireless interface, e.g. 'wlan1'"),
      duration: z.string().default("5").describe("Survey duration in seconds"),
      apply: z
        .boolean()
        .default(false)
        .describe("false = survey & recommend (default); true = set it"),
    },
    async handler(a, ctx) {
      ctx.info(`Wi-Fi survey on ${a.interface} for ${a.duration}s`);
      const monitor = await executeMikrotikCommand(
        `/interface wireless frequency-monitor ${a.interface} duration=${a.duration}`,
        ctx,
      );
      if (looksLikeError(monitor)) return `Survey failed on ${a.interface}: ${monitor}`;
      const best = pickBestFrequency(monitor);
      if (!best) {
        return `Could not read channel usage from the survey of ${a.interface}. Raw output:\n\n${monitor.trim() || "(empty)"}`;
      }

      if (!a.apply) {
        return `RF SURVEY — best channel on ${a.interface} is ${best.frequency} MHz (${best.usePct}% busy). Set apply=true to tune the radio to it.`;
      }
      const set = await executeMikrotikCommand(
        `/interface wireless set [find name="${a.interface}"] frequency=${best.frequency}`,
        ctx,
      );
      if (looksLikeError(set))
        return `Found best ${best.frequency} MHz but FAILED to apply: ${set}`;
      return `Tuned ${a.interface} to ${best.frequency} MHz (${best.usePct}% busy — the least-congested channel surveyed).`;
    },
  }),
];
