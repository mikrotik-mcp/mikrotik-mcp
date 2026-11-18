import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "./api";
import { clientIdentifier, filterClientOptions } from "./investigation-client-options";
import type { ClientOption } from "./investigation-client-options";
import { DetailList, RowDrawer, RowMenu, RowMore } from "./kit";
import { MonitorButton, MonitorSearch } from "./monitoring-ui";
import "./investigation-rows.css";

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
  // The client whose details are open, by identity, so a search keeps it.
  const [openKey, setOpenKey] = useState<string | null>(null);
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
  const keyOf = (c: ClientOption): string => `${c.mac}:${c.ip}`;
  const openIndex = openKey == null ? -1 : options.findIndex((c) => keyOf(c) === openKey);
  const opened = openIndex >= 0 ? options[openIndex] : undefined;
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
      <div className="monitor-thead inv-picker-grid inv-pick-row">
        <span>Host</span>
        <span>IP</span>
        <span className="inv-ev-hide">MAC</span>
        <span className="inv-ev-hide">Port</span>
        <span />
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
            const name = c.host || "Unnamed client";
            const pick = (): void => {
              if (!disabled) onSelect(identifier);
            };
            return (
              <RowMenu
                key={keyOf(c)}
                title={name}
                sub={[c.ip || "No IPv4", c.mac].filter(Boolean).join(" · ")}
                onOpen={() => setOpenKey(keyOf(c))}
                cells={{
                  host: { value: c.host, search: c.host ? () => setQuery(c.host) : undefined },
                  ip: { value: c.ip, kind: "ip", search: c.ip ? () => setQuery(c.ip) : undefined },
                  mac: {
                    value: c.mac,
                    kind: "id",
                    search: c.mac ? () => setQuery(c.mac) : undefined,
                  },
                  iface: {
                    value: c.iface,
                    search: c.iface ? () => setQuery(c.iface) : undefined,
                  },
                }}
                copies={[
                  ...(c.ip ? [{ label: "IP address", value: c.ip }] : []),
                  ...(c.mac ? [{ label: "MAC address", value: c.mac }] : []),
                ]}
                row={c}
                actions={
                  identifier
                    ? [{ label: "Use this client", onSelect: pick, disabled: disabled || selected }]
                    : undefined
                }
              >
                <div
                  role="button"
                  tabIndex={disabled ? -1 : 0}
                  aria-disabled={disabled || undefined}
                  aria-pressed={selected}
                  data-selected={selected || undefined}
                  onClick={pick}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      pick();
                    }
                  }}
                  className="monitor-row inv-picker-grid inv-pick-row"
                >
                  <span data-col="host" className="p inv-trunc">
                    {name}
                  </span>
                  <span data-col="ip" className="inv-mono inv-trunc">
                    {c.ip || "No IPv4"}
                  </span>
                  <span data-col="mac" className="inv-ev-hide inv-mono inv-mut inv-trunc">
                    {c.mac}
                  </span>
                  <span data-col="iface" className="inv-ev-hide inv-mono inv-mut inv-trunc">
                    {c.iface || "—"}
                  </span>
                  <RowMore />
                </div>
              </RowMenu>
            );
          })}
        </div>
      )}
      <div className="monitor-foot">
        From DHCP and ARP on {device || "the router"}. Pick one or type any IPv4 or MAC.
      </div>
      {opened && (
        <ClientDrawer
          client={opened}
          device={device}
          index={openIndex}
          total={options.length}
          selected={clientIdentifier(opened).toLowerCase() === value.trim().toLowerCase()}
          disabled={disabled}
          onPrev={openIndex > 0 ? () => setOpenKey(keyOf(options[openIndex - 1]!)) : undefined}
          onNext={
            openIndex < options.length - 1
              ? () => setOpenKey(keyOf(options[openIndex + 1]!))
              : undefined
          }
          onUse={() => onSelect(clientIdentifier(opened))}
          onClose={() => setOpenKey(null)}
        />
      )}
    </section>
  );
}

/** A detected client's DHCP and ARP record, and the button that picks it. */
function ClientDrawer({
  client: c,
  device,
  index,
  total,
  selected,
  disabled,
  onPrev,
  onNext,
  onUse,
  onClose,
}: {
  client: ClientOption;
  device: string;
  index: number;
  total: number;
  selected: boolean;
  disabled: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  onUse: () => void;
  onClose: () => void;
}): ReactNode {
  const name = c.host || "Unnamed client";
  const usable = Boolean(clientIdentifier(c));
  return (
    <RowDrawer
      open
      onClose={onClose}
      label={`Client details: ${name}`}
      storageKey="investigation-clients"
      rowKey={`${c.mac}:${c.ip}`}
      nav={{ index, total, onPrev, onNext }}
      status={selected ? { tone: "ok", label: "Selected" } : undefined}
      title={name}
      meta={`Seen on ${device || "the router"}`}
      primary={
        usable && (
          <MonitorButton
            size="sm"
            variant="primary"
            disabled={disabled || selected}
            onClick={onUse}
          >
            Use this client
          </MonitorButton>
        )
      }
    >
      <DetailList
        items={[
          { label: "Host", value: name },
          { label: "IP", value: c.ip || "No IPv4", mono: true },
          { label: "MAC", value: c.mac || "—", mono: true },
          { label: "Port", value: c.iface || "—", mono: true },
        ]}
      />
    </RowDrawer>
  );
}
