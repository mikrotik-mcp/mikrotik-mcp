import type { DeviceInfo } from "./types";

export type FleetTone = "healthy" | "warning" | "critical" | "unknown";

/** Missing observations are never evidence of a healthy router. */
export function deviceTone(device: DeviceInfo): FleetTone {
  if (device.disabled || device.status.reachable == null) return "unknown";
  if (!device.status.reachable) return "critical";
  return (device.status.cpuLoad ?? 0) >= 85 ||
    (device.status.memUsedPct ?? 0) >= 85
    ? "warning"
    : "healthy";
}

export function fleetSummary(devices: DeviceInfo[]) {
  const enabled = devices.filter((device) => !device.disabled);
  const priority: Record<FleetTone, number> = {
    critical: 0,
    warning: 1,
    unknown: 2,
    healthy: 3,
  };
  const sorted = [...enabled].sort(
    (a, b) =>
      priority[deviceTone(a)] - priority[deviceTone(b)] ||
      a.name.localeCompare(b.name),
  );
  const online = enabled.filter(
    (device) => device.status.reachable === true,
  ).length;
  const offline = enabled.filter(
    (device) => device.status.reachable === false,
  ).length;
  const unknown = enabled.length - online - offline;
  const stressed = enabled.filter(
    (device) => deviceTone(device) === "warning",
  ).length;
  return {
    sorted,
    online,
    offline,
    unknown,
    stressed,
    total: enabled.length,
    disabled: devices.length - enabled.length,
  };
}

/** Compact meters supplement exact values without inventing absent samples. */
export function resourceMeter(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "Not measured";
  const percent = Math.max(0, Math.min(100, value));
  const filled = Math.round(percent / 20);
  return `${"▰".repeat(filled)}${"▱".repeat(5 - filled)}  ${Math.round(percent)}%`;
}

export function fleetTone(input: {
  unavailable: boolean;
  stale: boolean;
  partial: boolean;
  total: number;
  offline: number;
  unknown: number;
  stressed: number;
  critical: boolean;
  warning: boolean;
}): FleetTone {
  if (input.unavailable || input.critical || input.offline) return "critical";
  if (input.stale || input.partial || input.stressed || input.warning)
    return "warning";
  if (!input.total || input.unknown) return "unknown";
  return "healthy";
}
