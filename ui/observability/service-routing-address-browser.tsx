import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { api } from "./api";
import { IpNetwork } from "./ip-network";
import { createAddressIndexCache, searchAddressEntries } from "./routing-address-search";
import type { AddressFamily, AddressIndex } from "./routing-address-search";
import { MonitorButton, MonitorEmpty, MonitorSelect, Segmented } from "./monitoring-ui";
import { hhmm } from "./service-routing-ui";
import { cn } from "@/lib/utils";

export const routingAddressCache = createAddressIndexCache((device, family, offset, signal) =>
  api(
    `/api/service-routing/addresses?device=${encodeURIComponent(device)}&family=${family}&offset=${offset}`,
    signal,
  ),
);
const idle: AddressIndex = { rows: [], status: "idle" };
const PAGE = 40;
function useAddressIndex(device: string, family: AddressFamily, enabled: boolean) {
  const subscribe = useCallback(
    (listener: () => void) =>
      enabled ? routingAddressCache.subscribe(device, family, listener) : () => {},
    [device, family, enabled],
  );
  const snapshot = useCallback(
    () => (enabled ? routingAddressCache.get(device, family) : idle),
    [device, family, enabled],
  );
  const value = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => {
    if (enabled) void routingAddressCache.read(device, family);
  }, [device, family, enabled]);
  return value;
}

/** One address explorer for both the global inventory and rule references. No router mutations. */
export function RoutingAddressBrowser({
  device,
  references,
  referenceFamily = "ipv4",
}: {
  device: string;
  references?: string[];
  referenceFamily?: AddressFamily;
}) {
  const [scope, setScope] = useState<"referenced" | "all">(
    references?.length ? "referenced" : "all",
  );
  const [family, setFamily] = useState<AddressFamily | "all">(
    references?.length ? referenceFamily : "all",
  );
  const [list, setList] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [copied, setCopied] = useState("");
  const [copyError, setCopyError] = useState("");
  const v4 = useAddressIndex(device, "ipv4", family !== "ipv6");
  const v6 = useAddressIndex(device, "ipv6", family !== "ipv4");
  const indexes = [v4, v6].filter((index) => index !== idle);
  const complete = indexes.every((index) => index.status === "ready");
  const loading = indexes.some((index) => index.status === "loading" || index.status === "idle");
  const loaded = indexes.reduce((n, index) => n + index.rows.length, 0);
  const total = indexes.every((index) => index.total !== undefined)
    ? indexes.reduce((n, index) => n + index.total!, 0)
    : undefined;
  const observedAt = Math.min(...indexes.map((index) => index.observedAt ?? Infinity));
  const entries = useMemo(
    () =>
      [
        ...v4.rows.map((row) => ({ row, family: "ipv4" as const })),
        ...v6.rows.map((row) => ({ row, family: "ipv6" as const })),
      ].filter(
        (entry) =>
          scope !== "referenced" ||
          (entry.family === referenceFamily && references?.includes(entry.row.list)),
      ),
    [v4.rows, v6.rows, scope, referenceFamily, references],
  );
  const names = [
    ...new Set([
      ...entries.map((entry) => entry.row.list),
      ...(scope === "referenced" ? (references ?? []) : []),
    ]),
  ].sort();
  const matches = useMemo(
    () =>
      searchAddressEntries(
        entries.filter((entry) => !list || entry.row.list === list),
        query,
      ),
    [entries, list, query],
  );
  const pages = Math.max(1, Math.ceil(matches.length / PAGE));
  const currentPage = Math.min(page, pages - 1);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(""), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const changeScope = (next: "referenced" | "all") => {
    setScope(next);
    setList("");
    setPage(0);
    setFamily(next === "referenced" ? referenceFamily : "all");
  };
  const copy = async (address: string, key: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(key);
      setCopyError("");
    } catch {
      setCopyError("The clipboard is not available. Select the address and copy it instead.");
    }
  };
  const referenced = [...new Set(references ?? [])];
  return (
    <section
      className="flex min-w-0 flex-col gap-3"
      aria-label={references?.length ? "Referenced address lists" : "Search all address lists"}
    >
      <div className="flex items-center">
        <span className="monitor-label flex-1">
          {references?.length ? "Address lists this rule uses" : "All address lists"}
        </span>
        <MonitorButton
          size="sm"
          variant="ghost"
          aria-label="Refresh address search"
          disabled={loading}
          onClick={() => {
            if (family !== "ipv6") void routingAddressCache.read(device, "ipv4", true);
            if (family !== "ipv4") void routingAddressCache.read(device, "ipv6", true);
          }}
        >
          Refresh
        </MonitorButton>
      </div>
      {references?.length ? (
        <Segmented
          label="Scope"
          className="self-start"
          value={scope}
          onChange={changeScope}
          options={[
            { value: "referenced", label: `This rule's lists (${referenced.length})` },
            { value: "all", label: "All lists" },
          ]}
        />
      ) : null}
      <label className="monitor-field">
        <Search aria-hidden="true" />
        <input
          type="search"
          aria-label="Search IP, comment or address list"
          placeholder="Search an IP, comment or list"
          value={query}
          maxLength={160}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
        />
        {query && (
          <button
            type="button"
            aria-label="Clear address search"
            className="grid size-5 cursor-pointer place-items-center rounded-full text-muted-foreground hover:text-foreground"
            onClick={() => {
              setQuery("");
              setPage(0);
            }}
          >
            <X className="size-4" />
          </button>
        )}
      </label>
      {scope === "referenced" ? (
        <div className="flex flex-wrap gap-1.5">
          {referenced.map((name) => (
            <button
              type="button"
              key={name}
              aria-pressed={list === name}
              className={cn(
                "monitor-chip cursor-pointer",
                list === name && "text-foreground shadow-[inset_0_0_0_1px_var(--chart-1)]",
              )}
              onClick={() => {
                setList(list === name ? "" : name);
                setPage(0);
              }}
            >
              {name} · {entries.filter((entry) => entry.row.list === name).length}
              {!complete ? "+" : ""}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <MonitorSelect
            label="Address search IP family"
            value={family}
            onChange={(value) => {
              setFamily(value as AddressFamily | "all");
              setPage(0);
              setList("");
            }}
            options={[
              { value: "all", label: "IPv4 + IPv6" },
              { value: "ipv4", label: "IPv4" },
              { value: "ipv6", label: "IPv6" },
            ]}
          />
          <MonitorSelect
            label="Filter address list"
            value={list}
            onChange={(value) => {
              setList(value);
              setPage(0);
            }}
            options={[
              { value: "", label: "All lists" },
              ...names.map((name) => ({ value: name, label: name })),
            ]}
          />
        </div>
      )}
      <p className="text-[12px] text-muted-foreground" role="status" aria-live="polite">
        {complete
          ? `${loaded.toLocaleString()} entries searched · read ${hhmm(observedAt)} · ${matches.length.toLocaleString()} ${matches.length === 1 ? "match" : "matches"} · exact matches first`
          : `${loaded.toLocaleString()} of ${total?.toLocaleString() ?? "…"} entries read · ${loading ? "still reading" : "incomplete, refresh to retry"} · ${matches.length.toLocaleString()} so far`}
      </p>
      {indexes
        .filter((index) => index.error)
        .map((index, i) => (
          <p className="monitor-err" role="alert" key={i}>
            {index.error}
          </p>
        ))}
      {copyError && (
        <p className="monitor-err" role="alert">
          {copyError}
        </p>
      )}
      <ul
        aria-label="Address search results"
        className="m-0 flex list-none flex-col border-t border-border p-0"
      >
        {matches.slice(currentPage * PAGE, (currentPage + 1) * PAGE).map((entry) => {
          const { row } = entry;
          const key = `${entry.family}:${row[".id"]}`;
          return (
            <li
              key={key}
              className={cn(
                "flex min-w-0 flex-col gap-0.5 border-b border-border py-2.5",
                row.disabled === "yes" && "opacity-60",
              )}
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 truncate font-mono text-[13px] text-foreground" dir="ltr">
                  {row.address}
                </span>
                <span className="monitor-chip">{entry.family === "ipv4" ? "v4" : "v6"}</span>
                {query && entry.match === "fuzzy" && (
                  <span className="monitor-chip text-warning">Approximate</span>
                )}
                {row.disabled === "yes" ? (
                  <span className="monitor-chip">Disabled</span>
                ) : row.dynamic === "yes" ? (
                  <span className="monitor-chip">Dynamic</span>
                ) : null}
                <span className="flex-1" />
                <MonitorButton
                  size="sm"
                  variant="ghost"
                  className="px-1.5"
                  aria-label={`Copy ${row.address}`}
                  onClick={() => void copy(row.address, key)}
                >
                  {copied === key ? "Copied" : "Copy"}
                </MonitorButton>
              </div>
              <span className="sr-net min-w-0">
                <IpNetwork address={row.address} />
              </span>
              <span
                className="min-w-0 truncate text-[12px] text-muted-foreground"
                title={row.comment}
              >
                <span className="font-mono">{row.list}</span>
                {row.comment ? ` · ${row.comment}` : ""}
              </span>
              <details className="group text-[12px]">
                <summary
                  aria-label={`Details for ${row.address}`}
                  className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden"
                >
                  <ChevronRight
                    aria-hidden="true"
                    className="size-3.5 transition-transform group-open:rotate-90"
                  />
                  Fields
                </summary>
                <dl className="monitor-facts mt-1.5 grid-cols-[100px_minmax(0,1fr)] text-[12px]">
                  {Object.entries(row).map(([field, value]) => (
                    <div key={field} className="contents">
                      <dt className="truncate font-mono">{field}</dt>
                      <dd className="font-mono break-all">{value || "(empty)"}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            </li>
          );
        })}
      </ul>
      {!matches.length && (
        <MonitorEmpty
          compact
          icon={<Search />}
          title={
            loading
              ? "Looking through the rest of the entries…"
              : complete
                ? "No matching addresses"
                : "Search coverage is incomplete"
          }
        >
          {complete
            ? "Try part of an IP or a comment, or search all lists."
            : "A partial read is not an empty address list."}
        </MonitorEmpty>
      )}
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <span className="flex-1 tabular-nums">
          {matches.length
            ? `${currentPage * PAGE + 1}–${Math.min((currentPage + 1) * PAGE, matches.length)} of ${matches.length}`
            : "0 shown"}
        </span>
        {pages > 1 && (
          <>
            <MonitorButton
              size="sm"
              variant="ghost"
              className="px-1.5"
              aria-label="Previous address results"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
              icon={<ChevronLeft />}
            />
            <span className="tabular-nums">
              {currentPage + 1} / {pages}
            </span>
            <MonitorButton
              size="sm"
              variant="ghost"
              className="px-1.5"
              aria-label="Next address results"
              disabled={currentPage + 1 >= pages}
              onClick={() => setPage(currentPage + 1)}
              icon={<ChevronRight />}
            />
          </>
        )}
        <span className="rounded px-[5px] py-px font-mono text-[11px] text-muted-foreground shadow-[inset_0_0_0_1px_var(--input)]">
          40 per page
        </span>
      </div>
    </section>
  );
}
