import type { DeviceInfo, LiveMode, SSHPoolPayload, ToolEvent } from "./types";

export const ISLAND_SNAPSHOT_TTL = 30_000;
export const ISLAND_DEVICE_TTL = 120_000;

export function isFreshSample(
  timestamp: number | null | undefined,
  now: number,
  ttl = ISLAND_SNAPSHOT_TTL,
): boolean {
  return (
    typeof timestamp === "number" &&
    Number.isFinite(timestamp) &&
    timestamp > 0 &&
    now >= timestamp &&
    now - timestamp <= ttl
  );
}

export function islandDeviceState(device: DeviceInfo, now: number, connected: boolean) {
  if (device.disabled) return "disabled" as const;
  if (!connected || !isFreshSample(device.status.checkedAt, now, ISLAND_DEVICE_TTL))
    return "unknown" as const;
  return device.status.reachable === true
    ? ("reachable" as const)
    : device.status.reachable === false
      ? ("unreachable" as const)
      : ("unknown" as const);
}

export function islandSignal({
  mode,
  paused,
  now,
  liveEvent,
  liveEventAt,
  pool,
  poolAt,
  alerts,
  alertsAt,
}: {
  mode: LiveMode;
  paused: boolean;
  now: number;
  liveEvent: ToolEvent | null;
  liveEventAt: number | null;
  pool: SSHPoolPayload | null;
  poolAt: number | null;
  alerts: number | null;
  alertsAt: number | null;
}): {
  kind: "offline" | "paused" | "error" | "alerts" | "busy" | "completed" | "listening";
  label: string;
  detail: string;
  count?: number;
} {
  if (mode === "off")
    return { kind: "offline", label: "Stream offline", detail: "Reconnecting automatically" };
  if (paused)
    return { kind: "paused", label: "Dashboard paused", detail: "Displayed activity is frozen" };
  // Router events timestamp the START of a call. Receipt, not start time,
  // drives the completion pulse, including long calls and server clock skew.
  const recent = liveEvent && isFreshSample(liveEventAt, now, 10_000);
  if (recent && liveEvent.isError)
    return { kind: "error", label: "Tool call failed", detail: liveEvent.tool };
  if (alerts != null && alerts > 0 && isFreshSample(alertsAt, now, 45_000))
    return {
      kind: "alerts",
      label: "Alerts need attention",
      detail: "Active alert rules",
      count: alerts,
    };
  if (
    pool?.enabled &&
    isFreshSample(poolAt, now) &&
    Number.isFinite(pool.aggregate.totalInflight) &&
    pool.aggregate.totalInflight > 0
  )
    return {
      kind: "busy",
      label: "SSH channels busy",
      detail: "Observed in the connection pool",
      count: pool.aggregate.totalInflight,
    };
  if (recent) return { kind: "completed", label: "Tool call completed", detail: liveEvent.tool };
  return {
    kind: "listening",
    label: "Listening for activity",
    detail: mode === "sse" ? "SSE fallback connected" : "WebSocket connected",
  };
}

/** Bounded, deduplicated completion history; never invent pending operations. */
export function islandCompletedAt(event: ToolEvent): number {
  return Number.isFinite(event.durationMs) && event.durationMs >= 0
    ? event.ts + event.durationMs
    : Number.NaN;
}

export function islandRecentEvents(events: readonly ToolEvent[], now: number): ToolEvent[] {
  const seen = new Set<string>();
  return events
    .filter((event) => {
      const completedAt = islandCompletedAt(event);
      if (!event.id || seen.has(event.id) || !Number.isFinite(completedAt) || completedAt > now)
        return false;
      seen.add(event.id);
      return true;
    })
    .sort((a, b) => islandCompletedAt(b) - islandCompletedAt(a))
    .slice(0, 4);
}

export function islandAge(timestamp: number | null | undefined, now: number): string {
  if (timestamp == null || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > now)
    return "Not observed";
  const seconds = Math.floor((now - timestamp) / 1000);
  if (seconds < 5) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
