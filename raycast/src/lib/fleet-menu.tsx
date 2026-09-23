import {
  Clipboard,
  Color,
  Icon,
  LaunchType,
  MenuBarExtra,
  Toast,
  launchCommand,
  open,
  openExtensionPreferences,
  showToast,
} from "@raycast/api";
import type { ComponentProps } from "react";
import { withToken } from "./api";
import { clock, ms } from "./format";
import { deviceTone, resourceMeter } from "./fleet-model";
import type { FleetTone } from "./fleet-model";
import type { DeviceInfo } from "./types";

export const TINT: Record<FleetTone, Color> = {
  healthy: Color.Green,
  warning: Color.Orange,
  critical: Color.Red,
  unknown: Color.SecondaryText,
};
export function FleetItem({
  tone = "unknown",
  icon,
  ...props
}: Omit<ComponentProps<typeof MenuBarExtra.Item>, "icon"> & {
  tone?: FleetTone;
  icon?: Icon;
}) {
  return (
    <MenuBarExtra.Item
      {...props}
      icon={icon ? { source: icon, tintColor: TINT[tone] } : undefined}
    />
  );
}

/** Report failures rather than silently swallowing unsuccessful menu actions. */
export async function runFeedback(
  title: string,
  action: () => Promise<unknown>,
) {
  const toast = await showToast({ style: Toast.Style.Animated, title });
  try {
    await action();
    toast.style = Toast.Style.Success;
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.message = error instanceof Error ? error.message : "Action failed";
  }
}
export const launch = (name: string) =>
  runFeedback("Open workspace", () =>
    launchCommand({ name, type: LaunchType.UserInitiated }),
  );
export const openDashboard = (page: string) =>
  runFeedback("Open dashboard", () => open(withToken("/") + `#${page}`));
export const preferences = () =>
  runFeedback("Open settings", openExtensionPreferences);
export function FleetLink({
  title,
  command,
  icon,
}: {
  title: string;
  command: string;
  icon: Icon;
}) {
  return (
    <FleetItem title={title} icon={icon} onAction={() => launch(command)} />
  );
}

async function mutate(path: string, method: string, body: unknown) {
  const response = await fetch(withToken(path), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as { ok?: boolean; error?: string };
  if (!response.ok || result.ok === false || result.error)
    throw new Error(result.error || `Request failed (${response.status})`);
}
export const muteAlert = (id: string) =>
  mutate(`/api/alerts/rules/${encodeURIComponent(id)}`, "PATCH", {
    mute: "1h",
  });
export const runAudit = (id: string) =>
  mutate(`/api/schedules/${encodeURIComponent(id)}/run`, "POST", {});

export function DeviceMenu({
  device,
  stale,
}: {
  device: DeviceInfo;
  stale: boolean;
}) {
  const tone = stale ? "unknown" : deviceTone(device);
  const state = stale
    ? "Saved observation"
    : device.status.reachable === false
      ? "Offline"
      : device.status.reachable == null
        ? "Not checked"
        : tone === "warning"
          ? "High resource use"
          : "Online";
  const address =
    device.address || device.mac || `${device.host}:${device.port}`;
  return (
    <MenuBarExtra.Submenu
      title={`${device.name} · ${state}`}
      icon={{ source: Icon.HardDrive, tintColor: TINT[tone] }}
    >
      <MenuBarExtra.Section title={device.description || "ROUTER HEALTH"}>
        <FleetItem
          title={state}
          subtitle={device.isDefault ? "Default router" : undefined}
          icon={Icon.Dot}
          tone={tone}
        />
        <FleetItem
          title="Last reported CPU"
          subtitle={resourceMeter(device.status.cpuLoad)}
          icon={Icon.ComputerChip}
        />
        <FleetItem
          title="Last reported memory"
          subtitle={resourceMeter(device.status.memUsedPct)}
          icon={Icon.MemoryChip}
        />
        <FleetItem title="Endpoint" subtitle={address} icon={Icon.Network} />
        <FleetItem
          title="Last health check"
          subtitle={
            device.status.checkedAt
              ? clock(device.status.checkedAt)
              : "Not checked"
          }
          icon={Icon.Clock}
        />
        <FleetItem
          title="Probe latency"
          subtitle={
            device.status.latencyMs == null
              ? "Not measured"
              : ms(device.status.latencyMs)
          }
          icon={Icon.BarChart}
        />
        {device.status.uptime && (
          <FleetItem
            title="Uptime"
            subtitle={device.status.uptime}
            icon={Icon.Clock}
          />
        )}
        {device.status.error && (
          <FleetItem
            title="Connection error"
            subtitle={device.status.error}
            tooltip={device.status.error}
            icon={Icon.Warning}
            tone="critical"
          />
        )}
        {device.geo && (
          <FleetItem
            title="Location"
            subtitle={[device.geo.city, device.geo.country]
              .filter(Boolean)
              .join(", ")}
            icon={Icon.Globe}
          />
        )}
        {device.jumpVia && (
          <FleetItem
            title="Via jump host"
            subtitle={device.jumpVia}
            icon={Icon.ArrowRight}
          />
        )}
      </MenuBarExtra.Section>
      <MenuBarExtra.Section>
        <FleetLink title="Inspect devices…" command="devices" icon={Icon.Eye} />
        <FleetItem
          title="Copy endpoint"
          icon={Icon.Clipboard}
          onAction={() =>
            runFeedback("Copy endpoint", () => Clipboard.copy(address))
          }
        />
      </MenuBarExtra.Section>
    </MenuBarExtra.Submenu>
  );
}
