import { Clock3, Radio, Star } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useNow } from "./use-now";
import type { DeviceEndpoints } from "../../src/core/device-endpoints";
import "./device-addresses.css";

/** Connection evidence and short-lived preference are deliberately separate. */
export function DeviceAddressStatus({ endpoints }: { endpoints: DeviceEndpoints }) {
  const now = useNow();
  const remembered = (endpoints.remembered ?? []).filter((c) => c.expiresAt > now);
  const live = endpoints.connected;
  return (
    <section className="device-address-status" aria-label="Management address status">
      <header>
        <span>
          <Radio size={14} /> Management addresses
        </span>
        <small>{live.length ? "Live connection" : "No open session"}</small>
      </header>
      {remembered.length > 0 && (
        <div className="device-address-status__memory">
          <Clock3 size={15} aria-hidden="true" />
          <div>
            <strong>Fast reconnect</strong>
            <small>Recent successful IPs are tried first. Primary stays unchanged.</small>
          </div>
          <span>5 min memory</span>
        </div>
      )}
      <ScrollArea
        className="device-address-status__scroll"
        viewportProps={{
          "aria-label": "Address connection results",
          className: "device-addresses__viewport",
        }}
      >
        {endpoints.hosts.map((host) => {
          const connections = live.filter((c) => c.host === host);
          const observations = endpoints.observations
            .filter((o) => o.host === host)
            .sort((a, b) => b.checkedAt - a.checkedAt);
          const last = observations[0];
          const preferred = remembered.filter((c) => c.host === host);
          const status = connections.length
            ? "connected"
            : !last
              ? "untested"
              : last.error
                ? "failed"
                : "verified";
          return (
            <div className="device-address-status__row" key={host} data-state={status}>
              <i aria-hidden="true" />
              <div>
                <code>{host}</code>
                <small>
                  {connections.length
                    ? connections.map((c) => `${c.transport.toUpperCase()} :${c.port}`).join(" · ")
                    : last
                      ? "No open session"
                      : "Not tested yet"}
                </small>
                {observations.map((o) => (
                  <small
                    key={`${o.transport}:${o.port}`}
                    className={o.error ? "device-address-status__error" : undefined}
                  >
                    {o.transport.toUpperCase()} :{o.port} ·{" "}
                    {o.error ? "Last attempt failed" : "Last success"} ·{" "}
                    <time
                      dateTime={new Date(o.checkedAt).toISOString()}
                      title={new Date(o.checkedAt).toLocaleString()}
                    >
                      {new Date(o.checkedAt).toLocaleTimeString()}
                    </time>
                    {o.error && <span className="device-address-status__reason">{o.error}</span>}
                  </small>
                ))}
                {preferred.map((c) => {
                  const seconds = Math.ceil((c.expiresAt - now) / 1000);
                  return (
                    <small
                      className="device-address-status__preferred"
                      key={`${c.transport}:${c.port}`}
                    >
                      <Clock3 size={11} aria-hidden="true" /> Remembered ·{" "}
                      {c.transport.toUpperCase()} :{c.port} · {Math.floor(seconds / 60)}m{" "}
                      {String(seconds % 60).padStart(2, "0")}s left
                    </small>
                  );
                })}
              </div>
              <div className="device-address-status__badges">
                <strong>
                  {status === "connected"
                    ? "Connected"
                    : status === "verified"
                      ? "Last success"
                      : status === "failed"
                        ? "Failed"
                        : "Untested"}
                </strong>
                {host === endpoints.primary && (
                  <span>
                    <Star size={11} aria-hidden="true" /> Primary
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </ScrollArea>
      <p className="device-address-status__note">
        Updates automatically from connection attempts; unused IPs are not continuously probed.
      </p>
    </section>
  );
}
