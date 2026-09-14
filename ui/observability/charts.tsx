/**
 * Charts for the observability dashboard, built on shadcn/ui's Recharts wrapper
 * (`@/components/ui/chart`). `ChartContainer` supplies the themed gridlines,
 * axis-tick colours, tooltip-cursor styling and per-chart `--color-<key>` CSS
 * variables (from each `ChartConfig`), so the charts no longer depend on the
 * hand-rolled `.chart*` rules in `styles.css`. Series colours come from the
 * shared data-viz tokens (`--chart-1` … `--chart-5`); callers still pass an
 * explicit `color` for the donut segments and health metrics.
 */
import type { ReactNode } from "react";
import {
  Area,
  AreaChart,
  Cell,
  Pie,
  PieChart,
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  YAxis,
} from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import type { ChartConfig } from "@/components/ui/chart";

export { ActivityChart } from "./activity-chart";

/** Donut of risk/status segments with a centered total (replaces the old SVG Donut). */
export function RiskDonut({
  segments,
  centerLabel = "calls",
}: {
  segments: { label: string; value: number; color: string }[];
  centerLabel?: string;
}): ReactNode {
  const data = segments.filter((s) => s.value > 0);
  const total = segments.reduce((a, b) => a + b.value, 0);
  const config: ChartConfig = Object.fromEntries(
    data.map((s) => [s.label, { label: s.label, color: s.color }]),
  );
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3">
      <ChartContainer config={config} className="mx-auto aspect-square w-full max-w-[180px]">
        <PieChart>
          <ChartTooltip content={<ChartTooltipContent hideLabel />} />
          <Pie
            data={data}
            dataKey="value"
            nameKey="label"
            innerRadius={58}
            outerRadius={80}
            paddingAngle={2}
            strokeWidth={0}
            isAnimationActive={false}
          >
            {data.map((s) => (
              <Cell key={s.label} fill={s.color} />
            ))}
          </Pie>
          <text
            x="50%"
            y="47%"
            textAnchor="middle"
            className="fill-foreground"
            fontSize={22}
            fontWeight={600}
          >
            {total.toLocaleString()}
          </text>
          <text x="50%" y="59%" textAnchor="middle" className="fill-muted-foreground" fontSize={10}>
            {centerLabel}
          </text>
        </PieChart>
      </ChartContainer>
      <div className="flex flex-wrap justify-center gap-x-3.5 gap-y-1.5 text-[11px] text-muted-foreground">
        {data.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <i className="size-[9px] rounded-[3px]" style={{ background: s.color }} />
            {s.label} <b className="font-medium text-foreground">{s.value}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Compact area chart for a device health metric over time (replaces Sparkline). */
export function MetricArea({
  values,
  color,
  unit,
  maxValue,
  id,
}: {
  values: (number | null)[];
  color: string;
  unit?: string;
  /** Upper clamp for the auto-scaled axis (e.g. 100 for a percentage). */
  maxValue?: number;
  /** Unique key for this chart's gradient `<def>` (avoids duplicate SVG ids). */
  id?: string;
}): ReactNode {
  const nums = values.filter((v): v is number => v != null);
  if (nums.length === 0)
    return (
      <div className="px-1.5 py-3 text-center text-[11px] text-muted-foreground">
        no samples yet
      </div>
    );
  const data = values.map((v, i) => ({ i, v }));
  const last = nums[nums.length - 1];
  const gid = `ma-${(id ?? color).replace(/[^a-z0-9]/gi, "")}`;
  const config = { v: { label: "value", color } } satisfies ChartConfig;

  // Auto-scale the Y axis to the data so small-but-real movement is visible: a
  // fixed 0–100 axis crushes a 1–2% CPU load or a steady ~9% memory line into a
  // flat strip at the bottom that reads as "nothing". A minimum window keeps a
  // near-constant series (e.g. 9.19 vs 9.20%) calm instead of amplifying jitter
  // into noise; padding adds breathing room; the result is clamped to
  // [0, maxValue]. The absolute level is still shown by the value badge + gauge.
  const lo0 = Math.min(...nums);
  const hi0 = Math.max(...nums);
  const minWindow = unit === "%" ? 10 : 0;
  const grow = Math.max(0, minWindow - (hi0 - lo0)) / 2;
  let lo = lo0 - grow;
  let hi = hi0 + grow;
  const pad = (hi - lo) * 0.15 || 1;
  lo = Math.max(0, lo - pad);
  hi = hi + pad;
  if (maxValue != null) hi = Math.min(maxValue, hi);
  if (hi <= lo) hi = lo + 1; // guard a degenerate domain so recharts still draws
  return (
    <div className="relative w-full">
      <span className="absolute right-0.5 top-0 z-10 text-[10px] font-semibold" style={{ color }}>
        {last.toFixed(unit === "%" ? 0 : 1)}
        {unit ?? ""}
      </span>
      <ChartContainer config={config} className="h-[46px] w-full">
        <AreaChart data={data} margin={{ top: 4, right: 2, left: 2, bottom: 0 }}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-v)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--color-v)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={[lo, hi]} />
          <ChartTooltip
            content={
              <ChartTooltipContent
                hideLabel
                formatter={(value) => (
                  <span className="font-mono tabular-nums text-foreground">
                    {typeof value === "number" ? value.toLocaleString() : String(value)}
                    {unit ?? ""}
                  </span>
                )}
              />
            }
          />
          <Area
            type="monotone"
            dataKey="v"
            stroke="var(--color-v)"
            fill={`url(#${gid})`}
            strokeWidth={1.7}
            connectNulls={false}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ChartContainer>
    </div>
  );
}

/** Radial gauge for an instantaneous 0–100% reading (shadcn radial chart style). */
export function RadialGauge({
  value,
  label,
  color,
}: {
  value: number | undefined;
  label: string;
  color: string;
}): ReactNode {
  const has = value != null;
  const v = has ? Math.max(0, Math.min(100, value)) : 0;
  const data = [{ name: label, value: v, fill: color }];
  const config = { value: { label, color } } satisfies ChartConfig;
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className="relative grid size-[72px] place-items-center">
        <ChartContainer config={config} className="size-[72px]">
          <RadialBarChart
            data={data}
            innerRadius="72%"
            outerRadius="100%"
            startAngle={90}
            endAngle={-270}
            barSize={7}
          >
            <PolarAngleAxis type="number" domain={[0, 100]} tick={false} axisLine={false} />
            <RadialBar
              dataKey="value"
              cornerRadius={4}
              background={{ fill: "var(--muted)" }}
              isAnimationActive={false}
            />
          </RadialBarChart>
        </ChartContainer>
        <span
          className="pointer-events-none absolute inset-0 grid place-items-center text-[13px] font-bold"
          style={{ color: has ? "var(--foreground)" : "var(--muted-foreground)" }}
        >
          {has ? `${Math.round(v)}%` : "n/a"}
        </span>
      </div>
      <span className="text-[10px] tracking-[0.06em] text-muted-foreground">{label}</span>
    </div>
  );
}
