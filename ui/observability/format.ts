import type { Risk } from "./types";

// ── formatting ───────────────────────────────────────────────────────────────
export const ms = (n: number): string =>
  n < 1 ? "<1ms" : n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(2)}s`;
export function bytes(n: number): string {
  const u = ["B", "KiB", "MiB", "GiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}
/**
 * User Manager rate limits are bit/s, even when the console's integer display
 * appends B. This is not the unit of transfer-limit (bytes). Display decimal
 * megabytes per second without changing the raw value used by the edit form.
 */
export function limitationRate(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return "—";
  const match = /^(\d+(?:\.\d+)?)\s*([kKmMgG]?)(?:B|bps)?$/.exec(value);
  if (!match) return value;
  const scale: Record<string, number> = { "": 1, k: 1e3, m: 1e6, g: 1e9 };
  const bitsPerSecond = Number(match[1]) * scale[match[2].toLowerCase()];
  if (!Number.isFinite(bitsPerSecond)) return value;
  if (bitsPerSecond === 0) return "Unlimited";
  const megabytesPerSecond = bitsPerSecond / 8e6;
  if (megabytesPerSecond < 1e-6) return "<0.000001 MB/s";
  return `${Number(megabytesPerSecond.toFixed(6))} MB/s`;
}
export const clock = (ts: number): string =>
  new Date(ts).toLocaleTimeString(undefined, { hour12: false });
export const num = (n: number): string => n.toLocaleString();
export const sval = (v: unknown): string => {
  if (v == null) return "?";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
};
/**
 * Per-metric accent for the device system-health gauges & sparkline charts, one
 * distinct chart series each. As `var()` references, not literals, so both
 * themes resolve them — these land in SVG attributes and inline styles, where a
 * Tailwind class cannot reach.
 */
export const HEALTH_COLOR = {
  cpu: "var(--chart-1)", // blue
  mem: "var(--chart-5)", // violet
  disk: "var(--chart-2)", // teal
  latency: "var(--chart-4)", // amber
} as const;

/**
 * Per-risk severity palette (safe → danger), as CSS custom properties rather
 * than literal hex so both themes resolve them from `tailwind.css`. These feed
 * SVG `fill`/`stroke` attributes and inline styles, where a Tailwind class can't
 * reach — a `var()` can.
 */
export const RISK_COLOR: Record<Risk, string> = {
  READ: "var(--chart-3)", // green — read-only, safe
  WRITE: "var(--chart-1)", // blue — normal write
  WRITE_IDEMPOTENT: "var(--chart-2)", // teal — idempotent write
  DESTRUCTIVE: "var(--chart-4)", // amber — removes/replaces config
  DANGEROUS: "var(--destructive)", // red — can lock you out
};

/** Tailwind text/background classes per risk, for the feed's risk pills. */
export const RISK_CLASS: Record<Risk, string> = {
  READ: "border-chart-3/40 text-chart-3",
  WRITE: "border-chart-1/40 text-chart-1",
  WRITE_IDEMPOTENT: "border-chart-2/40 text-chart-2",
  DESTRUCTIVE: "border-chart-4/40 text-chart-4",
  DANGEROUS: "border-destructive/40 text-destructive",
};

export const WINDOWS: [string, number][] = [
  ["5m", 300_000],
  ["15m", 900_000],
  ["1h", 3_600_000],
  ["6h", 21_600_000],
  ["24h", 86_400_000],
];
export const FEED_CAP = 10_000;
