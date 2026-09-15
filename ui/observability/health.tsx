import { useId } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Cpu, HardDrive, MemoryStick } from "lucide-react";
import { MetricArea } from "./charts";
import { bytes, HEALTH_COLOR } from "./format";
import type { DeviceInfo } from "./types";

const memory = (value?: number): string => (value == null ? "—" : bytes(value));

/** Resource readings share the device card; older samples are explicitly historical. */
export function DeviceHealthCard({
  d,
  historyOnly = false,
}: {
  d: DeviceInfo;
  historyOnly?: boolean;
}): ReactNode {
  const id = useId();
  const s = d.status;
  const hist = d.history ?? [];
  if (historyOnly)
    return (
      <section className="device-history" aria-label={`Resource history for ${d.name}`}>
        <span className="devices-eyebrow">RECORDED HEALTH SAMPLES</span>
        {hist.length > 0 ? (
          <>
            <p className="devices-caption">
              {hist.length} samples · {new Date(hist[0].ts).toLocaleTimeString()} –{" "}
              {new Date(hist[hist.length - 1].ts).toLocaleTimeString()}. Charts auto-scale; gaps are
              missing samples.
            </p>
            <div className="device-history__charts">
              {(
                [
                  ["CPU", "cpuLoad", HEALTH_COLOR.cpu, "%"],
                  ["Memory", "memUsedPct", HEALTH_COLOR.mem, "%"],
                  ["Latency", "latencyMs", HEALTH_COLOR.latency, "ms"],
                ] as const
              ).map(([label, key, color, unit]) => (
                <div key={key}>
                  <span>{label}</span>
                  <MetricArea
                    id={`${id}-${key}`}
                    values={hist.map((h) => h[key])}
                    color={color}
                    maxValue={unit === "%" ? 100 : undefined}
                    unit={unit}
                  />
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="devices-caption">
            No health samples yet. Test this device to collect a reading.
          </p>
        )}
        <dl className="device-facts">
          <div>
            <dt>RAM used / total</dt>
            <dd>
              {memory(
                s.totalMemory != null && s.freeMemory != null
                  ? s.totalMemory - s.freeMemory
                  : undefined,
              )}{" "}
              / {memory(s.totalMemory)}
            </dd>
          </div>
          <div>
            <dt>Disk free / total</dt>
            <dd>
              {memory(s.freeHdd)} / {memory(s.totalHdd)}
            </dd>
          </div>
          {s.disks?.map((disk) => (
            <div key={disk.slot}>
              <dt>{disk.slot}</dt>
              <dd>
                {disk.model ?? disk.mountPoint ?? "External disk"}
                {disk.fs ? ` · ${disk.fs}` : ""}
                <br />
                {memory(disk.free)} free / {memory(disk.size)}
                {disk.usedPct != null ? ` · ${disk.usedPct}% used` : ""}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    );
  const hasResources = [s.cpuLoad, s.memUsedPct, s.hddUsedPct].some((v) => v != null);
  return (
    <section className="device-resources" aria-label={`Resources for ${d.name}`}>
      <div className="device-resources__heading">
        <span className="devices-eyebrow">SYSTEM RESOURCES</span>
        <span>
          {!hasResources
            ? "Awaiting readings"
            : s.reachable !== true || d.disabled
              ? "Last known · not live"
              : "Last health check"}
        </span>
      </div>
      <div className="device-resources__grid">
        {(
          [
            ["CPU", s.cpuLoad, HEALTH_COLOR.cpu, Cpu],
            ["Memory", s.memUsedPct, HEALTH_COLOR.mem, MemoryStick],
            ["Disk", s.hddUsedPct, HEALTH_COLOR.disk, HardDrive],
          ] as const
        ).map(([label, value, color, Icon]) => (
          <div
            className="device-resource"
            key={label}
            style={{ "--resource-color": color } as CSSProperties}
          >
            <span>
              <Icon size={13} />
              {label}
            </span>
            <strong>
              {value != null ? (
                <>
                  {Math.round(value)}
                  <small>%</small>
                </>
              ) : (
                "—"
              )}
            </strong>
            <div
              className="device-resource__track"
              role={value != null ? "meter" : undefined}
              aria-label={`${label} usage`}
              aria-valuemin={value != null ? 0 : undefined}
              aria-valuemax={value != null ? 100 : undefined}
              aria-valuenow={value != null ? Math.max(0, Math.min(value, 100)) : undefined}
            >
              {value != null && <i style={{ width: `${Math.max(0, Math.min(value, 100))}%` }} />}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
