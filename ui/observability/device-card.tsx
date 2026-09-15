import { useId, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  Activity,
  ArrowRight,
  ChevronDown,
  Clock3,
  Cpu,
  Globe2,
  Loader2,
  Network,
  RotateCw,
  Router,
  ShieldCheck,
  Terminal,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { deviceColor } from "./connectivity";
import { withToken } from "./api";
import { ms, num } from "./format";
import { DeviceHealthCard } from "./health";
import type { CapabilitiesJson, DeviceInfo } from "./types";

export interface DeviceActions {
  onToggle?: (name: string, disabled: boolean) => void;
  onTest?: (name: string) => Promise<void>;
  onReconnect?: (name: string) => Promise<void>;
  onProbeCapabilities?: (name: string) => Promise<void>;
}

/** One device dossier: observations first, explicit network actions last. */
export function DeviceCard({
  d,
  allNames,
  capabilities,
  onToggle,
  onTest,
  onReconnect,
  onProbeCapabilities,
}: DeviceActions & {
  d: DeviceInfo;
  allNames: string[];
  capabilities: CapabilitiesJson | null;
}): ReactNode {
  const headingId = useId();
  const [busy, setBusy] = useState<"test" | "reconnect" | "capabilities" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const runAction = async (kind: NonNullable<typeof busy>) => {
    if (busy) return;
    const action =
      kind === "test" ? onTest : kind === "reconnect" ? onReconnect : onProbeCapabilities;
    if (!action) return;
    setBusy(kind);
    setError(null);
    try {
      await action(d.name);
    } catch {
      setError(
        `Could not ${kind === "capabilities" ? "probe capabilities on" : kind} ${d.name}. Try again.`,
      );
    } finally {
      setBusy(null);
    }
  };
  const state =
    d.status.reachable === true ? "online" : d.status.reachable === false ? "offline" : "pending";
  const jump = d.jumpVia ?? (d.jumpHost ? `${d.jumpHost.host}:${d.jumpHost.port}` : null);
  const channel = d.mac ? "MAC-Telnet" : d.transport === "rest" ? "REST / SSH fallback" : "SSH";
  const blocked = capabilities
    ? (["container", "scheduler", "fetch"] as const).filter((k) => !capabilities.deviceMode[k])
    : [];
  const wireless =
    capabilities?.wirelessStack === "wifi"
      ? "WiFi v7"
      : capabilities?.wirelessStack === "wireless"
        ? "Legacy wireless"
        : capabilities?.wirelessStack === "capsman-legacy"
          ? "CAPsMAN"
          : null;

  return (
    <article
      className="device-dossier"
      aria-labelledby={headingId}
      data-state={state}
      data-disabled={d.disabled || undefined}
      style={{ "--device-color": deviceColor(d.name, allNames) } as CSSProperties}
    >
      <header className="device-dossier__header">
        <div className="device-dossier__serial">
          <span className="devices-eyebrow">
            NODE {String(allNames.indexOf(d.name) + 1).padStart(2, "0")}
          </span>
          <span>{d.isDefault ? "DEFAULT ROUTER" : "MANAGED ROUTER"}</span>
        </div>
        <div className="device-dossier__identity">
          <span className="device-dossier__emblem">
            <Router size={24} strokeWidth={1.4} />
          </span>
          <div>
            <h3 id={headingId}>{d.name}</h3>
            <p>{d.status.boardName ?? capabilities?.board ?? "Hardware not yet observed"}</p>
          </div>
          <span className="device-connection" data-state={state}>
            <i />
            {state === "pending" ? "Unchecked" : state === "online" ? "Online" : "Offline"}
          </span>
        </div>
        <div className="device-dossier__address">
          <Terminal size={13} />
          <code>{d.address ?? (d.mac || `${d.host}:${d.port}`)}</code>
          <span>{channel}</span>
        </div>
        {d.description && <p className="device-dossier__description">{d.description}</p>}
        <div className="device-dossier__checked">
          <Clock3 size={12} />
          {d.status.checkedAt != null ? (
            <>
              Last check{" "}
              <time
                dateTime={new Date(d.status.checkedAt).toISOString()}
                title={new Date(d.status.checkedAt).toLocaleString()}
              >
                {new Date(d.status.checkedAt).toLocaleTimeString()}
              </time>
            </>
          ) : (
            "No health check received"
          )}
          {d.disabled && <span>Disabled in MCP</span>}
        </div>
      </header>

      {state !== "online" && (
        <div className="device-observation" data-state={state}>
          {state === "offline" ? <WifiOff size={16} /> : <Clock3 size={16} />}
          <div>
            <strong>
              {state === "offline"
                ? "Management connection unavailable"
                : "Waiting for a health check"}
            </strong>
            <p>
              {state === "offline"
                ? (d.status.error ?? "The last connection attempt did not succeed.")
                : d.mac
                  ? "MAC-Telnet checks run less frequently to avoid contending with tool calls."
                  : "There is no reachability result yet. Test this device for a fresh reading."}
            </p>
          </div>
        </div>
      )}

      <DeviceHealthCard d={d} />

      <dl className="device-activity">
        <div>
          <dt>Probe latency</dt>
          <dd>{d.status.latencyMs != null ? ms(d.status.latencyMs) : "—"}</dd>
        </div>
        <div>
          <dt>Tool calls</dt>
          <dd>{num(d.activity.calls)}</dd>
        </div>
        <div data-alert={d.activity.errors > 0 || undefined}>
          <dt>Call errors</dt>
          <dd>{num(d.activity.errors)}</dd>
        </div>
        <div>
          <dt>Avg. call</dt>
          <dd>{d.activity.calls > 0 ? ms(d.activity.avgMs) : "—"}</dd>
        </div>
      </dl>

      <details className="device-details" onToggle={(e) => setDetails(e.currentTarget.open)}>
        <summary>
          <Network size={14} /> Connection & capabilities <ChevronDown size={14} />
        </summary>
        <div className="device-details__body">
          <span className="devices-eyebrow">CONFIGURED MANAGEMENT PATH</span>
          <div className="device-management-path">
            <span>MCP host</span>
            <ArrowRight size={13} />
            {jump && (
              <>
                <span>
                  <ShieldCheck size={13} />
                  {jump}
                </span>
                <ArrowRight size={13} />
              </>
            )}
            <span>
              <Router size={13} />
              {d.name}
            </span>
          </div>
          <p className="devices-caption">Configuration only · not the client's traffic path.</p>
          <dl className="device-facts">
            <div>
              <dt>Login</dt>
              <dd>
                {d.username} · {d.authMode}
              </dd>
            </div>
            <div>
              <dt>Transport</dt>
              <dd>
                {channel}
                {d.transport === "rest" && ` · REST port ${d.restPort ?? 443}`}
              </dd>
            </div>
            <div>
              <dt>RouterOS</dt>
              <dd>{d.status.version ?? capabilities?.version ?? "Not observed"}</dd>
            </div>
            <div>
              <dt>Architecture</dt>
              <dd>
                {d.status.architecture ?? capabilities?.arch ?? "Not observed"}
                {d.status.cpuCount != null && ` · ${d.status.cpuCount} CPUs`}
              </dd>
            </div>
            <div>
              <dt>Uptime</dt>
              <dd>{d.status.uptime ?? "Not observed"}</dd>
            </div>
            {d.status.identity && (
              <div>
                <dt>Identity</dt>
                <dd>{d.status.identity}</dd>
              </div>
            )}
            {d.geo && (
              <div>
                <dt>Location</dt>
                <dd>
                  <img
                    src={withToken(`/api/flag/${d.geo.countryCode}`)}
                    width={16}
                    height={12}
                    alt=""
                    loading="lazy"
                  />
                  {[d.geo.city, d.geo.country].filter(Boolean).join(", ")}
                </dd>
              </div>
            )}
            {d.activity.lastSeen > 0 && (
              <div>
                <dt>Last tool call</dt>
                <dd>{new Date(d.activity.lastSeen).toLocaleString()}</dd>
              </div>
            )}
          </dl>
          <div className="device-capabilities">
            <div>
              <strong>
                <Cpu size={14} /> Capabilities
              </strong>
              {onProbeCapabilities && (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={!!busy || !!d.disabled}
                  onClick={() => void runAction("capabilities")}
                >
                  {busy === "capabilities" ? <Loader2 className="animate-spin" /> : <RotateCw />}
                  {capabilities ? "Reprobe" : "Probe"}
                </Button>
              )}
            </div>
            {capabilities ? (
              <>
                <p className="devices-caption">
                  Probed {new Date(capabilities.probedAt).toLocaleString()} · {capabilities.channel}
                </p>
                <div className="device-capabilities__tags">
                  {capabilities.isRouterBoard && <span>RouterBOARD</span>}
                  {wireless && <span>{wireless}</span>}
                  {capabilities.packages.map((p) => (
                    <span key={p}>{p}</span>
                  ))}
                </div>
                {blocked.length > 0 && (
                  <p className="device-capabilities__warning">
                    Device mode blocks {blocked.join(", ")}. Changing device mode requires physical
                    confirmation.
                  </p>
                )}
              </>
            ) : (
              <p className="devices-caption">
                Not probed yet. Probe reads version, packages, wireless stack and device mode.
              </p>
            )}
          </div>
          {details && <DeviceHealthCard d={d} historyOnly />}
          {onToggle && (
            <label className="device-enabled">
              <span>
                <strong>Enabled in MCP</strong>
                <small>Controls this server's access, not router power.</small>
              </span>
              <Switch
                checked={!d.disabled}
                onCheckedChange={(checked) => onToggle(d.name, !checked)}
                aria-label={`Enable ${d.name} in MCP`}
              />
            </label>
          )}
        </div>
      </details>
      <footer className="device-dossier__footer">
        <span className="devices-caption">
          <Globe2 size={13} />
          {d.status.version ? `RouterOS ${d.status.version}` : "RouterOS not observed"}
        </span>
        <div>
          {onTest && (
            <Button
              size="sm"
              variant="outline"
              disabled={!!busy || !!d.disabled}
              onClick={() => void runAction("test")}
              aria-label={`Test ${d.name}`}
              title="Read-only health check on this device"
            >
              {busy === "test" ? <Loader2 className="animate-spin" /> : <Activity />}Test
            </Button>
          )}
          {onReconnect && !d.mac && (
            <Button
              size="sm"
              variant="ghost"
              disabled={!!busy || !!d.disabled}
              onClick={() => void runAction("reconnect")}
              aria-label={`Reconnect ${d.name}`}
              title="Drop and re-establish this device's pooled SSH connection"
            >
              {busy === "reconnect" ? <Loader2 className="animate-spin" /> : <RotateCw />}Reconnect
            </Button>
          )}
        </div>
      </footer>
      {error && (
        <p className="device-action-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
