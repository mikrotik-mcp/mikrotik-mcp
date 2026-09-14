import { memo, useId, useMemo, useState, useSyncExternalStore } from "react";
import { Activity, Pause, Play } from "lucide-react";
import { Area, Bar, CartesianGrid, ComposedChart, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Button } from "@/components/ui/button";
import { DigitSwap } from "@/components/beui/digit-swap";
import { activityModel, sameActivitySeries } from "./activity-model";
import type { Bucket } from "./types";
import "./activity-chart.css";

const config = {
  ok: { label: "Successful", color: "var(--activity-ok)" },
  error: { label: "Errors", color: "var(--activity-error)" },
};
const timeLabel = (t: number): string =>
  new Date(t).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
const fullTime = (t: number): string =>
  new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
function subscribeMotion(callback: () => void): () => void {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}
const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Separate, zero-based series: zero errors never rides atop successful traffic. */
export const ActivityChart = memo(
  ({ series }: { series: Bucket[] }) => {
    const model = useMemo(() => activityModel(series), [series]);
    const reduceMotion = useSyncExternalStore(subscribeMotion, reducedMotion, () => true);
    const [paused, setPaused] = useState(false);
    const animate = !reduceMotion && !paused;
    const gradientId = `activity-fill-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
    const descriptionId = useId();
    const first = model.rows[0];
    const last = model.rows[model.rows.length - 1];
    const hasCalls = model.ok + model.error > 0;

    return (
      <figure
        className="activity-chart"
        aria-label="Calls over time"
        aria-describedby={descriptionId}
        data-motion={animate ? "on" : "off"}
      >
        <figcaption className="activity-toolbar">
          <div className="activity-legend">
            <span className="activity-legend-item">
              <i className="activity-key-line" aria-hidden="true" />
              <span>Successful</span>
              <strong>
                {first ? (
                  animate ? (
                    <DigitSwap value={model.ok.toLocaleString()} />
                  ) : (
                    model.ok.toLocaleString()
                  )
                ) : (
                  "—"
                )}
              </strong>
            </span>
            <span className="activity-legend-item">
              <i className="activity-key-bar" aria-hidden="true" />
              <span>Errors</span>
              <strong>
                {first ? (
                  animate ? (
                    <DigitSwap value={model.error.toLocaleString()} />
                  ) : (
                    model.error.toLocaleString()
                  )
                ) : (
                  "—"
                )}
              </strong>
            </span>
          </div>
          {reduceMotion ? (
            <span className="activity-motion-note">Reduced motion</span>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={paused ? "Resume chart animation" : "Pause chart animation"}
              title={
                paused
                  ? "Resume chart animation (data keeps updating)"
                  : "Pause chart animation (data keeps updating)"
              }
              aria-pressed={paused}
              onClick={() => setPaused((value) => !value)}
            >
              {paused ? <Play size={14} /> : <Pause size={14} />}
            </Button>
          )}
        </figcaption>
        <div className="activity-plot">
          <span className="activity-axis-caption">Calls / interval</span>
          {first ? (
            <ChartContainer
              config={config}
              className="activity-canvas h-[260px] w-full aspect-auto"
            >
              <ComposedChart
                data={model.rows}
                accessibilityLayer
                margin={{ top: 30, right: 16, left: 0, bottom: 4 }}
              >
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-ok)" stopOpacity={0.24} />
                    <stop offset="80%" stopColor="var(--color-ok)" stopOpacity={0.03} />
                    <stop offset="100%" stopColor="var(--color-ok)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  vertical={false}
                  stroke="var(--activity-grid)"
                  strokeOpacity={0.5}
                  strokeDasharray="2 6"
                />
                <XAxis
                  dataKey="t"
                  ticks={model.rows.length === 1 ? [first.t] : undefined}
                  type="number"
                  domain={
                    first.t === last.t ? [first.t - 30000, first.t + 30000] : ["dataMin", "dataMax"]
                  }
                  tickFormatter={timeLabel}
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={50}
                  tickMargin={12}
                />
                <YAxis
                  width={42}
                  domain={[0, (maximum: number) => Math.max(1, maximum)]}
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                  tickCount={4}
                  tickMargin={8}
                />
                <ChartTooltip
                  isAnimationActive={false}
                  cursor={{
                    stroke: "var(--activity-cursor)",
                    strokeWidth: 1,
                    strokeDasharray: "4 4",
                  }}
                  content={
                    <ChartTooltipContent
                      className="activity-tooltip"
                      indicator="line"
                      labelFormatter={(_label, payload) => {
                        const point = payload?.[0]?.payload as Bucket | undefined;
                        return point ? fullTime(point.t) : "";
                      }}
                    />
                  }
                />
                <Area
                  type="monotoneX"
                  dataKey="ok"
                  name="ok"
                  stroke="var(--color-ok)"
                  strokeWidth={2.5}
                  fill={`url(#${gradientId})`}
                  baseValue={0}
                  dot={
                    model.rows.length === 1
                      ? { r: 4, fill: "var(--color-ok)", stroke: "var(--card)", strokeWidth: 2 }
                      : false
                  }
                  activeDot={{
                    r: 5,
                    fill: "var(--color-ok)",
                    stroke: "var(--card)",
                    strokeWidth: 3,
                  }}
                  isAnimationActive={animate}
                  animationDuration={700}
                  animationEasing="ease-in-out"
                />
                <Bar
                  dataKey="error"
                  name="error"
                  fill="var(--color-error)"
                  maxBarSize={9}
                  radius={[3, 3, 0, 0]}
                  minPointSize={0}
                  isAnimationActive={animate}
                  animationDuration={700}
                  animationEasing="ease-in-out"
                />
              </ComposedChart>
            </ChartContainer>
          ) : (
            <div className="activity-no-data">
              <Activity size={24} />
              <strong>No activity samples yet</strong>
              <span>Intervals appear when statistics become available.</span>
            </div>
          )}
          {first && !hasCalls && (
            <div className="activity-zero">
              <Activity size={18} />
              <span>No tool calls in these intervals</span>
            </div>
          )}
        </div>
        <div className="activity-footer" id={descriptionId}>
          <span>Successful calls & errors · same count scale</span>
          <span>{model.rows.length} intervals</span>
        </div>
        {model.omitted > 0 && (
          <p className="activity-warning">
            {model.omitted} invalid interval(s) omitted; totals cover displayed data only.
          </p>
        )}
        {first && (
          <details className="activity-data">
            <summary>View interval data</summary>
            <div className="activity-table-scroll">
              <table>
                <caption className="sr-only">Exact counts for every displayed interval</caption>
                <thead>
                  <tr>
                    <th scope="col">Interval start</th>
                    <th scope="col">Successful</th>
                    <th scope="col">Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {model.rows.map((row, index) => (
                    <tr key={`${row.t}-${index}`}>
                      <th scope="row">{fullTime(row.t)}</th>
                      <td>{row.ok.toLocaleString()}</td>
                      <td>{row.error.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </figure>
    );
  },
  (previous, next) => sameActivitySeries(previous.series, next.series),
);
