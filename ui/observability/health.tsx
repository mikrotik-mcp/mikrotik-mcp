import type { ReactNode } from "react";
import { bytes } from "./format";
import type { DeviceInfo } from "./types";

/** The boards' bar colours: amber from 60 %, red from 85 %. */
export function meterTone(value: number | null | undefined): string | undefined {
  if (value == null) return undefined;
  return value >= 85 ? "bad" : value >= 60 ? "warn" : undefined;
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
export function DeviceResources({ d }: { d: DeviceInfo }): ReactNode {
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
  const max = Math.max(20, ...hist.map((h) => h.cpuLoad ?? 0));
  const step = hist.length > 1 ? 300 / (hist.length - 1) : 0;
  const points = hist
    .map((h, i) => `${(i * step).toFixed(1)},${(38 - ((h.cpuLoad ?? 0) / max) * 34).toFixed(1)}`)
    .join(" ");
  return (
    <div className="flex min-w-0 flex-col gap-2" aria-label={`Resources for ${d.name}`}>
      <span className="monitor-label">
        Resources
        {!hasReadings ? (
          <span className="font-normal"> · awaiting readings</span>
        ) : stale ? (
          <span className="font-normal"> · last known, not live</span>
        ) : null}
      </span>
      {rows.map(([label, value, detail]) => (
        <span className="monitor-meter" key={label} title={detail}>
          <span className="text-muted-foreground w-14 flex-none">{label}</span>
          <MeterBar value={value} label={label} />
          <span className="w-9 flex-none text-right">
            {value != null ? `${Math.round(value)}%` : "—"}
          </span>
        </span>
      ))}
      {hist.length > 1 ? (
        <>
          <svg
            viewBox="0 0 300 40"
            width="100%"
            height="40"
            role="img"
            aria-label={`CPU over the ${span(hist[hist.length - 1].ts - hist[0].ts)}`}
            preserveAspectRatio="none"
          >
            <polyline
              points={points}
              fill="none"
              stroke="var(--chart-1)"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <span className="text-muted-foreground text-[12px]">
            CPU, {span(hist[hist.length - 1].ts - hist[0].ts)} · {hist.length} samples
          </span>
        </>
      ) : (
        <span className="text-muted-foreground text-[12px]">
          No CPU samples yet. Test this router to collect one.
        </span>
      )}
    </div>
  );
}
