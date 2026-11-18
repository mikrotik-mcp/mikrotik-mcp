import { useNow } from "./use-now";
import { StatusDot } from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { cn } from "@/lib/utils";
import type { DeviceEndpoints } from "../../src/core/device-endpoints";

type State = "connected" | "verified" | "failed" | "untested";

const STATE_TEXT: Record<State, string> = {
  connected: "Connected",
  verified: "Last success",
  failed: "Failed",
  untested: "Untested",
};
const STATE_TONE: Record<State, Tone> = {
  connected: "good",
  verified: "default",
  failed: "bad",
  untested: "default",
};
const STATE_CLASS: Record<State, string> = {
  connected: "text-success",
  verified: "text-fg-secondary",
  failed: "text-destructive",
  untested: "text-muted-foreground",
};

/**
 * Management addresses of one router, primary first: which one holds the open
 * session, which worked or failed last time, and which were never tried.
 * `compact` drops the footnote. The transport and last error sit in the title.
 */
export function DeviceAddressStatus({
  endpoints,
  compact = false,
}: {
  endpoints: DeviceEndpoints;
  compact?: boolean;
}) {
  const now = useNow();
  const remembered = (endpoints.remembered ?? []).filter((c) => c.expiresAt > now);
  const live = endpoints.connected;
  return (
    <div className="flex flex-col gap-2" aria-label="Management addresses">
      <span className="dv-section">Management addresses</span>
      <div className="flex flex-col gap-1.5 text-[12px]">
        {endpoints.hosts.map((host) => {
          const connections = live.filter((c) => c.host === host);
          const observations = endpoints.observations
            .filter((o) => o.host === host)
            .sort((a, b) => b.checkedAt - a.checkedAt);
          const last = observations[0];
          const preferred = remembered.filter((c) => c.host === host);
          const state: State = connections.length
            ? "connected"
            : !last
              ? "untested"
              : last.error
                ? "failed"
                : "verified";
          const via = (connections.length ? connections : last ? [last] : [])
            .map((c) => `${c.transport.toUpperCase()} :${c.port}`)
            .join(", ");
          const failures = observations.filter((o) => o.error);
          return (
            <div key={host} className="flex flex-col" data-state={state}>
              <div className="flex items-center gap-2">
                <StatusDot tone={STATE_TONE[state]} />
                <span
                  className={cn(
                    "min-w-0 truncate font-mono text-[12px]",
                    host === endpoints.primary
                      ? "text-foreground font-medium"
                      : "text-fg-secondary",
                  )}
                  dir="ltr"
                >
                  {host}
                </span>
                {host === endpoints.primary && <span className="monitor-chip">Primary</span>}
                <span className="flex-1" />
                <span
                  className={cn("text-[12px] whitespace-nowrap", STATE_CLASS[state])}
                  title={[via, last?.error].filter(Boolean).join(" · ") || undefined}
                >
                  {STATE_TEXT[state]}
                </span>
              </div>
              {failures.map((o) => (
                <span
                  key={`${o.transport}:${o.port}`}
                  className="text-muted-foreground truncate pl-[15px] text-[12px]"
                  title={o.error}
                >
                  {o.transport.toUpperCase()} :{o.port} · Last attempt failed ·{" "}
                  <span className="text-destructive">{o.error}</span>
                </span>
              ))}
              {preferred.map((c) => {
                const seconds = Math.ceil((c.expiresAt - now) / 1000);
                return (
                  <span
                    key={`${c.transport}:${c.port}`}
                    className="text-muted-foreground pl-[15px] text-[12px]"
                  >
                    Fast reconnect · Remembered · {c.transport.toUpperCase()} :{c.port} ·{" "}
                    {Math.floor(seconds / 60)}m {String(seconds % 60).padStart(2, "0")}s left
                  </span>
                );
              })}
            </div>
          );
        })}
      </div>
      {!compact && (
        <span className="monitor-hint">
          Fallback addresses are tried only when the primary fails.
        </span>
      )}
    </div>
  );
}
