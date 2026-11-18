import type { ReactNode } from "react";
import { MonitorPanel, StatusBadge, StatusDot, formatMs } from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { deviceState, jumpOf } from "./device-card";
import { cn } from "@/lib/utils";
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

const STATE_TONE: Record<ReturnType<typeof deviceState>, Tone> = {
  online: "good",
  offline: "bad",
  pending: "default",
  disabled: "default",
};

/** "a", "a and b", "a, b and c". */
function names(list: string[]): string {
  return list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

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
  const mac = devices.filter((d) => d.mac).map((d) => d.name);
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
          <div className="monitor-thead dv-pool-cols">
            <span>Router</span>
            <span>Busy channels</span>
            <span>Idle</span>
            <span>State</span>
          </div>
          {ssh.map((d) => {
            const info = poolState(d.pool);
            const open = !!d.pool?.pooled && !d.pool.dead;
            const state = deviceState(d);
            const jump = jumpOf(d);
            return (
              <div
                key={d.name}
                className="monitor-row dv-pool-row dv-pool-cols"
                data-state={info.label}
                data-failed={state === "offline" || undefined}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <StatusDot tone={STATE_TONE[state]} />
                  <span className="flex min-w-0 flex-col">
                    <span className="p truncate font-mono text-[13px]">{d.name}</span>
                    <span
                      className={cn(
                        "truncate text-[12px] leading-[17px]",
                        state === "offline" ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {jump ? `SSH · via ${jump}` : `SSH · ${d.host}:${d.port}`}
                    </span>
                  </span>
                </span>
                <span className="tabular-nums">{d.pool ? (open ? d.pool.inflight : 0) : "—"}</span>
                <span className="tabular-nums">
                  {d.pool ? (open && d.pool.inflight === 0 ? 1 : 0) : "—"}
                </span>
                <span className="flex min-w-0 items-center gap-2">
                  <StatusDot tone={info.tone} />
                  <span className="truncate">{info.label}</span>
                </span>
              </div>
            );
          })}
          <div className="monitor-foot">
            <span>
              An open session shows MCP can reach the router. It doesn't show the router is healthy.
            </span>
            {mac.length > 0 && (
              <>
                <span className="flex-1" />
                <span className="font-mono">
                  {names(mac)} use{mac.length === 1 ? "s" : ""} MAC-Telnet, no pool
                </span>
              </>
            )}
          </div>
        </>
      )}
    </MonitorPanel>
  );
}
