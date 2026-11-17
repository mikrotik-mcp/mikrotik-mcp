import type { ReactNode } from "react";
import { MonitorPanel, StatusBadge, StatusDot, formatMs } from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import type { DeviceInfo, SSHPoolPayload } from "./types";

/** "30 s", "5 min": pool timings the way the board writes them. */
function duration(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : formatMs(ms);
}

export function poolState(pool: DeviceInfo["pool"]): { tone: Tone; label: string } {
  if (!pool) return { tone: "default", label: "Not reported" };
  if (pool.dead) return { tone: "warn", label: "Reconnecting" };
  if (!pool.pooled) return { tone: "default", label: "No connection" };
  if (pool.inflight > 0)
    return {
      tone: "brand",
      label: `Busy · ${pool.inflight} call${pool.inflight === 1 ? "" : "s"} running`,
    };
  return { tone: "good", label: "Ready · idle" };
}

const COLS = "minmax(160px,1fr) 120px 120px minmax(140px,1fr)";

/**
 * Open SSH sessions MCP keeps to reuse, per router. An open session shows MCP
 * can reach a router; it does not show the router is healthy.
 */
export function SSHPoolPanel({
  devices,
  poolPayload,
}: {
  devices: DeviceInfo[];
  poolPayload?: SSHPoolPayload | null;
}): ReactNode {
  const cfg = poolPayload?.config;
  const ssh = devices.filter((d) => !d.mac);
  const timing = cfg
    ? `Keepalive every ${duration(cfg.keepAliveInterval)}, idle sessions close after ${duration(cfg.idleTimeout)}.`
    : "Connection timing not reported.";
  const badge = !poolPayload ? (
    <StatusBadge>Status unavailable</StatusBadge>
  ) : poolPayload.enabled ? (
    <StatusBadge tone="good">Pooling on</StatusBadge>
  ) : (
    <StatusBadge>Pooling off</StatusBadge>
  );
  return (
    <MonitorPanel
      className="dv-pool"
      title="SSH connection pool"
      description={`Open sessions MCP keeps to reuse. ${timing}`}
      extra={badge}
      flush
    >
      {poolPayload?.enabled === false ? (
        <div className="monitor-foot">
          Pooling is off. Set --ssh-keep-alive true or MIKROTIK_SSH__KEEP_ALIVE=true in the server
          settings to reuse SSH sessions.
        </div>
      ) : (
        <>
          <div className="monitor-thead max-sm:hidden" style={{ gridTemplateColumns: COLS }}>
            <span>Router</span>
            <span className="text-right">Busy channels</span>
            <span className="text-right">Idle</span>
            <span>State</span>
          </div>
          {ssh.map((d) => {
            const info = poolState(d.pool);
            const open = !!d.pool?.pooled && !d.pool.dead;
            return (
              <div key={d.name} className="monitor-row dv-pool-row" data-state={info.label}>
                <span className="truncate font-mono text-[13px]">{d.name}</span>
                <span className="text-fg-secondary text-right tabular-nums max-sm:hidden">
                  {d.pool ? (open ? d.pool.inflight : 0) : "—"}
                </span>
                <span className="text-fg-secondary text-right tabular-nums max-sm:hidden">
                  {d.pool ? (open && d.pool.inflight === 0 ? 1 : 0) : "—"}
                </span>
                <span className="text-fg-secondary flex items-center gap-2 max-sm:text-[12px]">
                  <StatusDot tone={info.tone} />
                  {info.label}
                </span>
              </div>
            );
          })}
          <div className="monitor-row text-muted-foreground text-[12px]">
            <span className="max-sm:hidden">
              An open session shows MCP can reach the router. It doesn't show the router is healthy.
            </span>
            <span className="sm:hidden">
              {cfg
                ? `Keepalive ${duration(cfg.keepAliveInterval)} · idle sessions close after ${duration(cfg.idleTimeout)}.`
                : "Connection timing not reported."}
            </span>
          </div>
        </>
      )}
    </MonitorPanel>
  );
}
