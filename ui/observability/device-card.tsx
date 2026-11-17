import type { ReactNode } from "react";
import { X } from "lucide-react";
import { DeviceAddressStatus } from "./device-address-status";
import { DeviceResources, MeterBar } from "./health";
import { MonitorButton, MonitorSwitch, StatusBadge, StatusDot, formatMs } from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { num } from "./format";
import { cn } from "@/lib/utils";
import type { CapabilitiesJson, DeviceInfo } from "./types";

export interface DeviceActions {
  onToggle?: (name: string, disabled: boolean) => void;
  onTest?: (name: string) => Promise<void>;
  onReconnect?: (name: string) => Promise<void>;
  onProbeCapabilities?: (name: string) => Promise<void>;
  onManage?: (name: string) => void;
}

export type DeviceBusy = "test" | "reconnect" | "capabilities";
export type DeviceState = "online" | "offline" | "pending" | "disabled";

/** One word for a router: disabled wins, then the last reachability check. */
export function deviceState(d: DeviceInfo): DeviceState {
  if (d.disabled) return "disabled";
  return d.status.reachable === true
    ? "online"
    : d.status.reachable === false
      ? "offline"
      : "pending";
}

const STATE_TONE: Record<DeviceState, Tone> = {
  online: "good",
  offline: "bad",
  pending: "default",
  disabled: "default",
};

/** The jump host a router is reached through: a configured router or an inline bastion. */
export function jumpOf(d: DeviceInfo): string | null {
  if (d.mac) return null;
  return d.jumpVia ?? (d.jumpHost ? `${d.jumpHost.host}:${d.jumpHost.port}` : null);
}

/** "SSH · direct", "SSH · via core-router-01", "MAC-Telnet", "REST, SSH fallback". */
export function transportLine(d: DeviceInfo): string {
  if (d.mac) return "MAC-Telnet";
  if (d.transport === "rest") return "REST, SSH fallback";
  const jump = jumpOf(d);
  return `SSH · ${jump ? `via ${jump}` : "direct"}`;
}

/** 24-hour "14:02", the way the boards write a time of day. */
export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

const addressOf = (d: DeviceInfo): string => d.mac ?? d.host;
const hardware = (d: DeviceInfo, caps: CapabilitiesJson | null): string | undefined =>
  d.status.boardName ?? caps?.board ?? undefined;

/** Second line under a router's name: the failure, or its hardware. */
function routerSub(d: DeviceInfo, caps: CapabilitiesJson | null): { text: string; bad: boolean } {
  const state = deviceState(d);
  if (state === "offline") return { text: d.status.error ?? "Unreachable", bad: true };
  if (state === "disabled") return { text: "Off for MCP", bad: false };
  return { text: hardware(d, caps) ?? "Hardware not seen yet", bad: false };
}

function callsLine(d: DeviceInfo): { text: string; bad: boolean } {
  if (d.activity.errors > 0) return { text: `${num(d.activity.errors)} failed`, bad: true };
  return { text: d.activity.calls === 0 ? "no calls yet" : "no errors", bad: false };
}

function RowMeter({ value, label }: { value?: number; label: string }): ReactNode {
  return (
    <span className="monitor-meter pt-px">
      <MeterBar value={value} label={label} />
      {value != null ? `${Math.round(value)}%` : "—"}
    </span>
  );
}

/** One row of the Routers table (desktop). */
export function RouterRow({
  d,
  capabilities,
  selected,
  onSelect,
}: {
  d: DeviceInfo;
  capabilities: CapabilitiesJson | null;
  selected: boolean;
  onSelect: () => void;
}): ReactNode {
  const state = deviceState(d);
  const sub = routerSub(d, capabilities);
  const calls = callsLine(d);
  return (
    <button
      type="button"
      className="monitor-row dv-cols items-start"
      data-selected={selected || undefined}
      data-failed={state === "offline" || undefined}
      aria-pressed={selected}
      aria-label={`${d.name}, ${state === "pending" ? "unchecked" : state}`}
      onClick={onSelect}
    >
      <span className="flex min-w-0 gap-2.5">
        <span className="mt-[7px] flex">
          <StatusDot tone={STATE_TONE[state]} />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="dv-name text-foreground truncate font-mono text-[13px]">{d.name}</span>
            {d.isDefault && <span className="monitor-chip">Default</span>}
          </span>
          <span
            className={cn(
              "truncate text-[12px]",
              sub.bad ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {sub.text}
          </span>
        </span>
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-fg-secondary truncate font-mono text-[12px]" dir="ltr">
          {addressOf(d)}
        </span>
        <span className="text-muted-foreground truncate text-[12px]">{transportLine(d)}</span>
      </span>
      <RowMeter value={d.status.cpuLoad} label="CPU" />
      <RowMeter value={d.status.memUsedPct} label="Memory" />
      <span className="text-fg-secondary text-right tabular-nums">
        {d.status.latencyMs != null && state === "online" ? formatMs(d.status.latencyMs) : "—"}
      </span>
      <span className="flex flex-col items-end">
        <span className="text-fg-secondary tabular-nums">{num(d.activity.calls)}</span>
        <span
          className={cn("text-[12px]", calls.bad ? "text-destructive" : "text-muted-foreground")}
        >
          {calls.text}
        </span>
      </span>
    </button>
  );
}

/** One router on the phone board: name and latency, a line of context, CPU and memory. */
export function PhoneRouterRow({
  d,
  capabilities,
  selected,
  onSelect,
}: {
  d: DeviceInfo;
  capabilities: CapabilitiesJson | null;
  selected: boolean;
  onSelect: () => void;
}): ReactNode {
  const state = deviceState(d);
  const sub =
    state === "offline"
      ? { text: d.status.error ?? "Unreachable", bad: true }
      : {
          text: [
            addressOf(d),
            d.mac ? "MAC-Telnet" : d.transport === "rest" ? "REST, SSH fallback" : "SSH",
            state === "disabled" ? "Off for MCP" : hardware(d, capabilities),
          ]
            .filter(Boolean)
            .join(" · "),
          bad: false,
        };
  const cpu = d.status.cpuLoad;
  const mem = d.status.memUsedPct;
  return (
    <button
      type="button"
      className="monitor-row dv-phone-row"
      data-selected={selected || undefined}
      data-failed={state === "offline" || undefined}
      aria-pressed={selected}
      aria-label={`${d.name}, ${state === "pending" ? "unchecked" : state}`}
      onClick={onSelect}
    >
      <span className="flex min-w-0 items-center gap-2">
        <StatusDot tone={STATE_TONE[state]} />
        <span className="text-foreground truncate font-mono text-[13px]">{d.name}</span>
        {d.isDefault && <span className="monitor-chip">Default</span>}
        <span className="flex-1" />
        <span className="text-fg-secondary text-[12px] tabular-nums">
          {d.status.latencyMs != null && state === "online" ? formatMs(d.status.latencyMs) : "—"}
        </span>
      </span>
      <span
        className={cn(
          "truncate pl-[15px] text-[12px]",
          sub.bad ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {sub.text}
      </span>
      {cpu != null && (
        <span className="grid grid-cols-2 gap-3 pl-[15px]">
          <span className="monitor-meter">
            <span className="text-muted-foreground">CPU</span>
            <MeterBar value={cpu} label="CPU" />
            {Math.round(cpu)}%
          </span>
          <span className="monitor-meter">
            <span className="text-muted-foreground">Mem</span>
            <MeterBar value={mem} label="Memory" />
            {mem != null ? `${Math.round(mem)}%` : "—"}
          </span>
        </span>
      )}
    </button>
  );
}

function wirelessLabel(c: CapabilitiesJson): string | null {
  return c.wirelessStack === "wifi"
    ? "WiFi v7"
    : c.wirelessStack === "wireless"
      ? "Legacy wireless"
      : c.wirelessStack === "capsman-legacy"
        ? "CAPsMAN"
        : null;
}

function Capabilities({
  d,
  capabilities,
  chips,
  busy,
  onProbe,
}: {
  d: DeviceInfo;
  capabilities: CapabilitiesJson | null;
  chips: number;
  busy: DeviceBusy | null;
  onProbe?: () => void;
}): ReactNode {
  const tags = capabilities
    ? [capabilities.isRouterBoard ? "RouterBOARD" : null, wirelessLabel(capabilities)].filter(
        (t): t is string => !!t,
      )
    : [];
  const room = Math.max(0, chips - tags.length);
  const packages = capabilities?.packages ?? [];
  const rest = packages.length - room;
  const blocked = capabilities
    ? (["container", "scheduler", "fetch"] as const).filter((k) => !capabilities.deviceMode[k])
    : [];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center">
        <span className="monitor-label flex-1">Capabilities</span>
        {onProbe && (
          <MonitorButton
            size="sm"
            variant="ghost"
            disabled={!!busy || !!d.disabled}
            onClick={onProbe}
          >
            {busy === "capabilities" ? "Probing…" : capabilities ? "Probe again" : "Probe"}
          </MonitorButton>
        )}
      </div>
      {capabilities ? (
        <>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <span key={t} className="monitor-chip">
                {t}
              </span>
            ))}
            {packages.slice(0, room).map((p) => (
              <span key={p} className="monitor-chip">
                {p}
              </span>
            ))}
            {rest > 0 && (
              <span className="monitor-chip" title={packages.slice(room).join(", ")}>
                +{rest} package{rest === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <span className="text-muted-foreground text-[12px]">
            Probed{" "}
            {new Date(capabilities.probedAt).toLocaleDateString([], {
              month: "short",
              day: "numeric",
            })}{" "}
            · {capabilities.channel} channel
          </span>
          {blocked.length > 0 && (
            <span className="text-warning text-[12px]">
              Device mode blocks {blocked.join(", ")}. Changing device mode needs someone at the
              router.
            </span>
          )}
        </>
      ) : (
        <span className="text-muted-foreground text-[12px]">
          Not probed yet. Probe reads version, packages, wireless stack and device mode.
        </span>
      )}
    </div>
  );
}

function Facts({ d, phone }: { d: DeviceInfo; phone: boolean }): ReactNode {
  const s = d.status;
  const login = `${d.username} · ${
    d.authMode === "key" ? "SSH key" : d.authMode === "none" ? "no password" : "password"
  }`;
  const transport = d.mac
    ? "MAC-Telnet"
    : d.transport === "rest"
      ? `REST, port ${d.restPort ?? 443}, SSH fallback`
      : `SSH, port ${d.port}`;
  const hw = [s.architecture, s.cpuCount != null ? `${s.cpuCount} CPUs` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <dl className="monitor-facts dv-facts">
      <dt>Login</dt>
      <dd>{login}</dd>
      {phone && (
        <>
          <dt>Transport</dt>
          <dd>{transport}</dd>
        </>
      )}
      <dt>Hardware</dt>
      <dd>{hw || "Not seen yet"}</dd>
      <dt>Uptime</dt>
      <dd>{s.uptime ?? "Not seen yet"}</dd>
      {d.geo && (
        <>
          <dt>Location</dt>
          <dd>{[d.geo.city, d.geo.country].filter(Boolean).join(", ")}</dd>
        </>
      )}
      <dt>Last call</dt>
      <dd>
        {d.activity.lastSeen > 0 ? (
          <time
            dateTime={new Date(d.activity.lastSeen).toISOString()}
            title={new Date(d.activity.lastSeen).toLocaleString()}
          >
            {clockTime(d.activity.lastSeen)}
          </time>
        ) : (
          "No calls yet"
        )}
      </dd>
    </dl>
  );
}

function MacAddress({ d }: { d: DeviceInfo }): ReactNode {
  return (
    <div className="flex flex-col gap-2" aria-label="Management addresses">
      <span className="monitor-label">Management address</span>
      <div className="flex items-center gap-2 text-[13px]">
        <span className="text-fg-secondary font-mono text-[12px]">{d.mac ?? d.host}</span>
        <span className="flex-1" />
        <span className="text-muted-foreground text-[12px]">MAC-Telnet</span>
      </div>
    </div>
  );
}

function AvailableSwitch({
  d,
  onToggle,
  className,
}: {
  d: DeviceInfo;
  onToggle?: (name: string, disabled: boolean) => void;
  className?: string;
}): ReactNode {
  if (!onToggle) return null;
  return (
    <div className={cn("border-border flex items-start gap-3 border-t", className)}>
      <span className="flex flex-1 flex-col">
        <span className="text-foreground text-[13px]">Available to MCP</span>
        <span className="text-muted-foreground text-[12px]">
          Turns off tool access to this router. The router itself keeps running.
        </span>
      </span>
      <MonitorSwitch
        checked={!d.disabled}
        label={`Available to MCP: ${d.name}`}
        onChange={(checked) => onToggle(d.name, !checked)}
      />
    </div>
  );
}

/**
 * The details block for the selected router: identity, actions, then
 * resources, addresses and facts, capabilities and the MCP switch.
 * `phone` is the single-column layout from the phone board.
 */
export function RouterDetails({
  d,
  capabilities,
  busy,
  error,
  phone = false,
  onClose,
  onAction,
  onToggle,
  onManage,
  canTest,
  canReconnect,
  canProbe,
}: {
  d: DeviceInfo;
  capabilities: CapabilitiesJson | null;
  busy: DeviceBusy | null;
  error: string | null;
  phone?: boolean;
  onClose: () => void;
  onAction: (kind: DeviceBusy) => void;
  onToggle?: (name: string, disabled: boolean) => void;
  onManage?: (name: string) => void;
  canTest: boolean;
  canReconnect: boolean;
  canProbe: boolean;
}): ReactNode {
  const state = deviceState(d);
  const checked = d.status.checkedAt != null ? clockTime(d.status.checkedAt) : null;
  const badge =
    state === "disabled"
      ? "Off for MCP"
      : state === "pending"
        ? "Unchecked"
        : `${state === "online" ? "Online" : "Offline"}${checked ? ` · checked ${checked}` : ""}`;
  const about = [
    hardware(d, capabilities),
    (d.status.version ?? capabilities?.version)
      ? `RouterOS ${d.status.version ?? capabilities?.version}`
      : null,
    d.description,
  ]
    .filter(Boolean)
    .join(" · ");
  const actions = (
    <>
      {canTest && (
        <MonitorButton
          size={phone ? "md" : "sm"}
          disabled={!!busy || !!d.disabled}
          aria-label={`Test ${d.name}`}
          title="Read-only health check on this router"
          onClick={() => onAction("test")}
        >
          {busy === "test" ? "Testing…" : "Test"}
        </MonitorButton>
      )}
      {canReconnect && !d.mac && (
        <MonitorButton
          size={phone ? "md" : "sm"}
          disabled={!!busy || !!d.disabled}
          aria-label={`Reconnect ${d.name}`}
          title="Drop and reopen this router's pooled SSH session"
          onClick={() => onAction("reconnect")}
        >
          {busy === "reconnect" ? "Reconnecting…" : "Reconnect"}
        </MonitorButton>
      )}
      {onManage && (
        <MonitorButton
          size={phone ? "md" : "sm"}
          variant="ghost"
          aria-label={`Edit ${d.name}`}
          onClick={() => onManage(d.name)}
        >
          Edit
        </MonitorButton>
      )}
    </>
  );
  const close = (
    <MonitorButton
      size="sm"
      variant="ghost"
      aria-label="Close router details"
      icon={<X aria-hidden="true" />}
      onClick={onClose}
    />
  );
  const alert = error && (
    <p role="alert" className="monitor-err">
      {error}
    </p>
  );
  const capabilityBlock = (
    <Capabilities
      d={d}
      capabilities={capabilities}
      chips={phone ? 3 : 4}
      busy={busy}
      onProbe={canProbe ? () => onAction("capabilities") : undefined}
    />
  );
  const addresses = d.mac ? (
    <MacAddress d={d} />
  ) : d.endpoints ? (
    <DeviceAddressStatus endpoints={d.endpoints} compact={phone} />
  ) : null;

  if (phone)
    return (
      <section className="monitor-panel dv-details-phone" aria-label={`Router details: ${d.name}`}>
        <div className="border-border flex flex-col gap-2 border-b px-4 py-3.5">
          <div className="flex items-center gap-2">
            <h3 className="text-emphasis flex-1 truncate font-mono text-[15px] font-medium">
              {d.name}
            </h3>
            {close}
          </div>
          <span className="self-start">
            <StatusBadge tone={STATE_TONE[state]}>{badge}</StatusBadge>
          </span>
          {about && <p className="text-muted-foreground text-[12px]">{about}</p>}
          <div className="dv-phone-actions mt-1 grid grid-cols-3 gap-2">{actions}</div>
          {alert}
        </div>
        <div className="flex flex-col gap-5 px-4 pt-3.5 pb-4">
          <DeviceResources d={d} />
          {addresses}
          <Facts d={d} phone />
          {capabilityBlock}
          <AvailableSwitch d={d} onToggle={onToggle} className="pt-3.5" />
        </div>
      </section>
    );

  return (
    <div
      className="border-border bg-overlay-02 border-t"
      role="region"
      aria-label={`Router details: ${d.name}`}
    >
      <div className="border-border flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-5 py-4">
        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <h3 className="text-emphasis truncate font-mono text-[15px] font-medium">{d.name}</h3>
            <StatusBadge tone={STATE_TONE[state]}>{badge}</StatusBadge>
          </div>
          {about && <p className="text-muted-foreground text-[12px]">{about}</p>}
          {alert}
        </div>
        <div className="flex gap-2">
          {actions}
          {close}
        </div>
      </div>
      <div className="dv-details-grid px-5 pt-4 pb-5">
        <DeviceResources d={d} />
        <div className="flex min-w-0 flex-col gap-3">
          {addresses}
          <Facts d={d} phone={false} />
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          {capabilityBlock}
          <AvailableSwitch d={d} onToggle={onToggle} className="mt-2 pt-3" />
        </div>
      </div>
    </div>
  );
}
