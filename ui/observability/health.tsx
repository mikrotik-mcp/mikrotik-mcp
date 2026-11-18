import { Fragment } from "react";
import type { ReactNode } from "react";
import { Sparkline } from "./signal-charts";
import { bytes } from "./format";
import type { DeviceInfo } from "./types";

/** The boards' bar colours: teal, amber from 60 %, red from 85 %. */
export function meterTone(value: number | null | undefined): string | undefined {
  if (value == null) return undefined;
  return value >= 85 ? "bad" : value >= 60 ? "warn" : "good";
}

const clamp = (v: number) => Math.max(0, Math.min(v, 100));
const amount = (value?: number): string => (value == null ? "—" : bytes(value));

/** A 4px bar inside a `.monitor-meter`, or an empty track when there is no reading. */
export function MeterBar({ value, label }: { value?: number | null; label: string }): ReactNode {
  return (
    <span
      className="monitor-bar"
      role={value != null ? "meter" : undefined}
      aria-label={value != null ? `${label} usage` : undefined}
      aria-valuemin={value != null ? 0 : undefined}
      aria-valuemax={value != null ? 100 : undefined}
      aria-valuenow={value != null ? clamp(value) : undefined}
    >
      {value != null && <span data-tone={meterTone(value)} style={{ width: `${clamp(value)}%` }} />}
    </span>
  );
}

function span(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min >= 50 && min <= 70) return "last hour";
  if (min < 60) return `last ${Math.max(min, 1)} min`;
  return `last ${Math.round(min / 60)} h`;
}

/**
 * The Resources column of a router's details: CPU, memory and disk meters, then
 * CPU over the recorded samples. Readings from an offline or disabled router
 * are marked as last known.
 */
export function DeviceResources({
  d,
  phone = false,
}: {
  d: DeviceInfo;
  phone?: boolean;
}): ReactNode {
  const s = d.status;
  const hist = (d.history ?? []).filter((h) => h.cpuLoad != null);
  const hasReadings = [s.cpuLoad, s.memUsedPct, s.hddUsedPct].some((v) => v != null);
  const stale = hasReadings && (s.reachable !== true || !!d.disabled);
  const used =
    s.totalMemory != null && s.freeMemory != null ? s.totalMemory - s.freeMemory : undefined;
  const rows: [string, number | undefined, string][] = [
    ["CPU", s.cpuLoad, s.cpuCount != null ? `${s.cpuCount} CPUs` : "CPU load"],
    ["Memory", s.memUsedPct, `${amount(used)} / ${amount(s.totalMemory)} used`],
    [
      "Disk",
      s.hddUsedPct,
      `${amount(s.freeHdd)} / ${amount(s.totalHdd)} free${
        s.disks?.length ? ` · ${s.disks.length} more disk${s.disks.length === 1 ? "" : "s"}` : ""
      }`,
    ],
  ];
  const peak = Math.max(...hist.map((h) => h.cpuLoad ?? 0));
  const state = !hasReadings ? "awaiting readings" : stale ? "last known, not live" : "live";
  const meters = (
    <div className="dv-res-grid">
      {rows.map(([label, value, detail]) => (
        <Fragment key={label}>
          <span className="text-muted-foreground">{label}</span>
          <span className="monitor-meter" title={detail}>
            <MeterBar value={value} label={label} />
            <span className="w-8 flex-none text-right">
              {value != null ? `${Math.round(value)}%` : "—"}
            </span>
          </span>
        </Fragment>
      ))}
    </div>
  );
  // The phone board shows the three meters alone, under a rule.
  if (phone)
    return (
      <div
        className="border-line flex min-w-0 flex-col gap-2 border-t pt-3.5"
        aria-label={`Resources for ${d.name}`}
      >
        {meters}
        {state !== "live" && <span className="text-faint text-[11px]">{state}</span>}
      </div>
    );
  return (
    <div className="flex min-w-0 flex-col gap-2.5" aria-label={`Resources for ${d.name}`}>
      <div className="flex items-center gap-2">
        <span className="dv-section flex-1">Resources</span>
        <span className="text-faint text-[11px]">{state}</span>
      </div>
      {meters}
      {hist.length > 1 ? (
        <div
          className="glass dv-cpu"
          role="img"
          aria-label={`CPU over the ${span(hist[hist.length - 1].ts - hist[0].ts)}, peak ${Math.round(peak)}%`}
        >
          <Sparkline
            values={hist.map((h) => h.cpuLoad ?? 0)}
            width={300}
            height={40}
            fill
            className="dv-cpu-spark"
          />
          <div className="text-faint flex justify-between text-[11px]">
            <span>CPU, {span(hist[hist.length - 1].ts - hist[0].ts)}</span>
            <span>peak {Math.round(peak)}%</span>
          </div>
        </div>
      ) : (
        <span className="monitor-hint">No CPU samples yet. Test this router to collect one.</span>
      )}
    </div>
  );
}
