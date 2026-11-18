import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "./api";
import { clientIdentifier, filterClientOptions } from "./investigation-client-options";
import type { ClientOption } from "./investigation-client-options";
import { MonitorButton, MonitorSearch } from "./monitoring-ui";

/** One read per router selection or refresh; never starts traffic sampling or client writes. */
export function InvestigationClients({
  device,
  value,
  disabled,
  onSelect,
}: {
  device: string;
  value: string;
  disabled: boolean;
  onSelect: (identifier: string) => void;
}): ReactNode {
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(Boolean(device));
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false;
    if (!device) return;
    void api<{ devices: ClientOption[] }>(`/api/clients?device=${encodeURIComponent(device)}`)
      .then((r) => {
        if (disposed) return;
        if (!Array.isArray(r.devices)) throw new Error("Missing client list");
        setClients(r.devices);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [device, revision]);
  const options = filterClientOptions(clients, query);
  const message = loading
    ? `Reading clients from ${device}…`
    : failed
      ? "Client list unavailable. Refresh to retry, or type an IPv4 or MAC above."
      : !options.length
        ? query
          ? "No matching clients. Try another search, or type an IPv4 or MAC above."
          : "No DHCP or ARP records came back. Type an IPv4 or MAC above."
        : "";
  return (
    <section aria-label="Detected clients" className="glass inv-picker">
      <div className="inv-picker-top">
        <MonitorSearch
          label="Search detected clients"
          value={query}
          onChange={setQuery}
          placeholder="Search name, IP, MAC or interface…"
        />
        <span className="monitor-chip">
          {loading ? "…" : failed ? "unavailable" : `${clients.length} clients`}
        </span>
        <MonitorButton
          variant="ghost"
          size="sm"
          disabled={!device || loading || disabled}
          icon={
            <RefreshCw
              aria-hidden="true"
              className={loading ? "animate-spin motion-reduce:animate-none" : undefined}
            />
          }
          onClick={() => {
            setLoading(true);
            setFailed(false);
            setClients([]);
            setRevision((r) => r + 1);
          }}
        >
          Refresh
        </MonitorButton>
      </div>
      <div className="monitor-thead inv-picker-grid">
        <span>Host</span>
        <span>IP</span>
        <span className="inv-ev-hide">MAC</span>
        <span className="inv-ev-hide">Port</span>
      </div>
      <div aria-live="polite">
        {message && (
          <p className="inv-picker-msg" role={failed ? "alert" : undefined}>
            {message}
          </p>
        )}
      </div>
      {!loading && !failed && options.length > 0 && (
        <div className="inv-picker-list">
          {options.map((c) => {
            const identifier = clientIdentifier(c);
            const selected = identifier.toLowerCase() === value.trim().toLowerCase();
            return (
              <button
                key={`${c.mac}:${c.ip}`}
                type="button"
                disabled={disabled}
                aria-pressed={selected}
                data-selected={selected || undefined}
                onClick={() => onSelect(identifier)}
                className="monitor-row inv-picker-grid"
              >
                <span className="p inv-trunc" title={c.host || "Unnamed client"}>
                  {c.host || "Unnamed client"}
                </span>
                <span className="inv-mono inv-trunc">{c.ip || "No IPv4"}</span>
                <span className="inv-ev-hide inv-mono inv-mut inv-trunc">{c.mac}</span>
                <span className="inv-ev-hide inv-mono inv-mut inv-trunc">{c.iface || "—"}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="monitor-foot">
        From DHCP and ARP on {device || "the router"}. Pick one or type any IPv4 or MAC.
      </div>
    </section>
  );
}
