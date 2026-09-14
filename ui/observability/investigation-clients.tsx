import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Check, Monitor, RefreshCw, Search } from "lucide-react";
import { api } from "./api";
import { Button } from "./components/ui/button";
import { clientIdentifier, filterClientOptions } from "./investigation-client-options";
import type { ClientOption } from "./investigation-client-options";

/** One read per router selection/explicit refresh; never starts traffic sampling or client writes. */
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
  return (
    <section
      aria-label="Detected clients"
      className="min-w-0 rounded-xl border border-border bg-background/50 sm:col-span-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-xs font-medium">
          <Monitor className="size-4 text-muted-foreground" />
          Detected clients{" "}
          <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-muted-foreground">
            {loading ? "…" : failed ? "Unavailable" : clients.length}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          disabled={!device || loading || disabled}
          onClick={() => {
            setLoading(true);
            setFailed(false);
            setClients([]);
            setRevision((r) => r + 1);
          }}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
        >
          <RefreshCw
            className={`size-3.5 ${loading ? "animate-spin motion-reduce:animate-none" : ""}`}
          />
          Refresh
        </Button>
      </div>
      <div className="p-3">
        <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 focus-within:outline-2 focus-within:outline-ring">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <span className="sr-only">Search detected clients</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={disabled}
            placeholder="Search name, IP, MAC or interface…"
            className="min-w-0 flex-1 bg-transparent text-xs outline-none"
          />
        </label>
        <div aria-live="polite" className="text-xs text-muted-foreground">
          {loading ? (
            <p className="p-3">
              Reading clients from {device}… You can still enter an IP or MAC above.
            </p>
          ) : failed ? (
            <p role="alert" className="p-3">
              Client list unavailable. Refresh to retry, or enter an IP or MAC above.
            </p>
          ) : !options.length ? (
            <p className="p-3">
              {query
                ? "No matching records. Try another search or enter an IP or MAC above."
                : "No selectable DHCP/ARP records returned. Enter an IP or MAC above."}
            </p>
          ) : null}
        </div>
        {!loading && !failed && options.length > 0 && (
          <ul className="mt-2 grid max-h-56 gap-1 overflow-y-auto overscroll-contain sm:grid-cols-2">
            {options.map((c) => {
              const identifier = clientIdentifier(c);
              const selected = identifier.toLowerCase() === value.trim().toLowerCase();
              return (
                <li key={`${c.mac}:${c.ip}`} className="min-w-0">
                  <button
                    type="button"
                    disabled={disabled}
                    aria-pressed={selected}
                    onClick={() => onSelect(identifier)}
                    className="flex w-full items-start gap-2 rounded-lg border border-transparent p-3 text-left transition-colors hover:bg-muted aria-pressed:border-primary/30 aria-pressed:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
                  >
                    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border border-border text-primary">
                      {selected ? (
                        <Check className="size-3.5" />
                      ) : (
                        <Monitor className="size-3 text-muted-foreground" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate text-xs font-medium"
                        title={c.host || "Unnamed client"}
                      >
                        {c.host || "Unnamed client"}
                      </span>
                      <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">
                        {c.ip || "No IPv4"}
                      </span>
                      <span
                        className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground"
                        title={`${c.mac} · ${c.iface}`}
                      >
                        {c.mac}
                        {c.iface ? ` · ${c.iface}` : ""}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-2 px-1 text-[11px] text-muted-foreground">
          Select a record to fill the client address above, or type any IPv4/MAC manually. Records
          do not prove current connectivity.
        </p>
      </div>
    </section>
  );
}
