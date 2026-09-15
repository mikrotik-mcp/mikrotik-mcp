import type { ReactNode } from "react";
import { Activity, Cable, ChevronDown, Clock3, Radio, Server } from "lucide-react";
import { ms, num } from "./format";
import type { DeviceInfo, SSHPoolPayload } from "./types";

function poolState(pool: DeviceInfo["pool"]): { state: string; label: string } {
  if (!pool) return { state: "unknown", label: "Not reported" };
  if (pool.dead) return { state: "offline", label: "Reconnecting" };
  if (!pool.pooled) return { state: "unknown", label: "No connection" };
  if (pool.inflight > 0) return { state: "busy", label: `${pool.inflight} active channels` };
  return { state: "online", label: "Ready · idle" };
}

/** Fleet-wide management connections, not a router reachability or capacity meter. */
export function SSHPoolPanel({
  devices,
  poolPayload,
}: {
  devices: DeviceInfo[];
  poolPayload?: SSHPoolPayload | null;
}): ReactNode {
  const agg = poolPayload?.aggregate;
  const cfg = poolPayload?.config;
  const sshDevices = devices.filter((d) => !d.mac);
  return (
    <details className="device-pool" open>
      <summary>
        <span className="device-pool__icon">
          <Cable size={19} />
        </span>
        <span>
          <strong>SSH Connection Pool</strong>
          <small>Persistent management channels · entire fleet</small>
        </span>
        <span className="device-pool__state">
          {poolPayload
            ? poolPayload.enabled
              ? "Pooling enabled"
              : "Pooling disabled"
            : "Status unavailable"}
        </span>
        <ChevronDown size={16} />
      </summary>
      <div className="device-pool__body">
        {poolPayload?.enabled === false ? (
          <p className="devices-caption">
            Persistent pooling is disabled. Enable <code>--ssh-keep-alive true</code> or{" "}
            <code>MIKROTIK_SSH__KEEP_ALIVE=true</code> in the server configuration to reuse SSH
            connections.
          </p>
        ) : (
          <>
            <div className="device-pool__metrics">
              <div className="device-pool__total">
                <Server size={18} />
                <strong>{agg ? num(agg.totalConnections) : "—"}</strong>
                <span>open connections</span>
              </div>
              <dl>
                <div>
                  <dt>
                    <Activity size={13} /> In-flight channels
                  </dt>
                  <dd>{agg ? num(agg.totalInflight) : "—"}</dd>
                </div>
                <div>
                  <dt>
                    <Radio size={13} /> Busy connections
                  </dt>
                  <dd>{agg ? num(agg.totalBusy) : "—"}</dd>
                </div>
                <div>
                  <dt>
                    <Clock3 size={13} /> Idle connections
                  </dt>
                  <dd>{agg ? num(agg.totalIdle) : "—"}</dd>
                </div>
              </dl>
            </div>
            <div className="device-pool__connections">
              {sshDevices.map((d) => {
                const info = poolState(d.pool);
                return (
                  <div key={d.name} data-state={info.state}>
                    <span className="device-pool__socket">
                      <i />
                      <i />
                      <i />
                    </span>
                    <strong>{d.name}</strong>
                    <span>{info.label}</span>
                  </div>
                );
              })}
            </div>
            {!poolPayload && (
              <p className="devices-caption">
                Pool totals have not loaded. Unreported connections are not assumed to be
                disconnected.
              </p>
            )}
          </>
        )}
        <footer>
          <span>
            {cfg ? (
              <>
                Keepalive <b>{ms(cfg.keepAliveInterval)}</b> <i /> Idle timeout{" "}
                <b>{ms(cfg.idleTimeout)}</b>
              </>
            ) : (
              "Connection timing not reported"
            )}
          </span>
          <span>Pool state does not prove router health.</span>
        </footer>
      </div>
    </details>
  );
}
