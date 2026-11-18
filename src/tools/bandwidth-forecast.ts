/**
 * Bandwidth Forecaster — answer "when will this link saturate?". Samples an
 * interface's current throughput, compares it to the link capacity, and projects
 * the trend forward at an assumed monthly growth rate to a saturation date — so
 * you can plan an upgrade before users feel it.
 *
 * The pure `projectSaturation` is unit-tested; the tool samples + reports.
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { looksLikeError, quoteValue } from "../core/routeros";
import { parseKeyValues } from "../core/routeros-parse";

export interface Saturation {
  utilizationPct: number;
  /** Whole days until the link reaches `capacity`, or null if already at/over, or no growth. */
  daysToSaturate: number | null;
}

/**
 * Project days-to-saturation from the current load, capacity, and a compounding
 * monthly growth rate. Already-saturated → 0 days; non-positive growth → null
 * (never, on this trend).
 */
export function projectSaturation(
  currentMbps: number,
  capacityMbps: number,
  monthlyGrowthPct: number,
): Saturation {
  const utilizationPct = capacityMbps > 0 ? (currentMbps / capacityMbps) * 100 : 0;
  if (currentMbps >= capacityMbps) return { utilizationPct, daysToSaturate: 0 };
  if (monthlyGrowthPct <= 0 || currentMbps <= 0) return { utilizationPct, daysToSaturate: null };
  const months = Math.log(capacityMbps / currentMbps) / Math.log(1 + monthlyGrowthPct / 100);
  return { utilizationPct, daysToSaturate: Math.round(months * 30.4) };
}

export const bandwidthForecastTools: ToolModule = [
  defineTool({
    name: "forecast_link_saturation",
    title: "Forecast Link Saturation",
    annotations: READ,
    description:
      "Estimates when an interface will saturate. Samples its current throughput " +
      "(`/interface monitor-traffic ... once`), computes utilization against `capacity_mbps` (the " +
      "link's rated speed), and projects the trend forward at `monthly_growth_pct` to a saturation " +
      "date. Note: this is a single live sample projected at an ASSUMED growth rate — feed a realistic " +
      "growth figure (or watch the trend over time) for a better forecast. Returns current load, " +
      "utilization, and the projected days/date to saturation.",
    inputSchema: {
      interface: z.string().describe("Interface to sample, e.g. 'ether1-wan'"),
      capacity_mbps: z
        .number()
        .default(1000)
        .describe("Link rated speed in Mbit/s (e.g. 1000 for gig)"),
      monthly_growth_pct: z
        .number()
        .default(10)
        .describe("Assumed month-over-month traffic growth %"),
    },
    async handler(a, ctx) {
      ctx.info(`Sampling ${a.interface} throughput`);
      const out = await executeMikrotikCommand(
        `/interface monitor-traffic ${quoteValue(a.interface)} once`,
        ctx,
      );
      if (looksLikeError(out)) return `Could not sample ${a.interface}: ${out}`;
      const kv = parseKeyValues(out);
      const rx = Number(kv["rx-bits-per-second"]?.replace(/\D/g, "") ?? "0");
      const tx = Number(kv["tx-bits-per-second"]?.replace(/\D/g, "") ?? "0");
      const currentMbps = Math.max(rx, tx) / 1_000_000;
      if (!Number.isFinite(currentMbps)) {
        return `Could not read throughput from the sample of ${a.interface}. Raw:\n\n${out.trim()}`;
      }

      const s = projectSaturation(currentMbps, a.capacity_mbps, a.monthly_growth_pct);
      const when =
        s.daysToSaturate == null
          ? "no saturation on the current (flat/declining) trend"
          : s.daysToSaturate === 0
            ? "already at or over capacity"
            : `~${s.daysToSaturate} days (≈ ${new Date(Date.now() + s.daysToSaturate * 86_400_000).toISOString().slice(0, 10)}) at ${a.monthly_growth_pct}%/mo`;
      return `LINK FORECAST — ${a.interface}\n  current: ${currentMbps.toFixed(1)} Mbit/s of ${a.capacity_mbps} (${s.utilizationPct.toFixed(1)}% utilized)\n  saturates: ${when}`;
    },
  }),
];
