import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Copy,
  ListFilter,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "./api";
import { createAddressIndexCache, searchAddressEntries } from "./routing-address-search";
import type { AddressFamily, AddressIndex } from "./routing-address-search";
import "./service-routing-address-browser.css";

export const routingAddressCache = createAddressIndexCache((device, family, offset, signal) =>
  api(
    `/api/service-routing/addresses?device=${encodeURIComponent(device)}&family=${family}&offset=${offset}`,
    signal,
  ),
);
const idle: AddressIndex = { rows: [], status: "idle" };
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
  const [scope, setScope] = useState(references?.length ? "referenced" : "all");
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
  const pages = Math.max(1, Math.ceil(matches.length / 40));
  const currentPage = Math.min(page, pages - 1);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(""), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const changeScope = (next: string) => {
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
      setCopyError("Clipboard unavailable. Select and copy the address text instead.");
    }
  };
  return (
    <section
      className="address-browser"
      aria-label={references?.length ? "Referenced address lists" : "Search all address lists"}
    >
      <header className="address-browser__header">
        <div>
          <span className="address-browser__icon">
            <ListFilter size={17} />
          </span>
          <div>
            <h4>{scope === "referenced" ? "Referenced address lists" : "All address lists"}</h4>
            <p>
              {device} <span>·</span> Read-only address explorer
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Refresh address search"
          disabled={loading}
          onClick={() => {
            if (family !== "ipv6") void routingAddressCache.read(device, "ipv4", true);
            if (family !== "ipv4") void routingAddressCache.read(device, "ipv6", true);
          }}
        >
          <RefreshCw size={14} /> Refresh
        </Button>
      </header>
      {references?.length ? (
        <div className="address-browser__scope" aria-label="Address search scope">
          <button
            type="button"
            aria-pressed={scope === "referenced"}
            onClick={() => changeScope("referenced")}
          >
            This rule’s lists <span>{new Set(references).size}</span>
          </button>
          <button type="button" aria-pressed={scope === "all"} onClick={() => changeScope("all")}>
            All router lists <span>IPv4 + IPv6</span>
          </button>
        </div>
      ) : null}
      <div className="address-browser__controls">
        <div className="address-browser__search">
          <Search size={16} />
          <Input
            aria-label="Search IP, comment or address list"
            placeholder="Search IP, comment or list…"
            value={query}
            maxLength={160}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
          />
          {query && (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Clear address search"
              onClick={() => {
                setQuery("");
                setPage(0);
              }}
            >
              <X size={14} />
            </Button>
          )}
        </div>
        {scope === "all" && (
          <Select
            value={family}
            onValueChange={(value) => {
              setFamily(value as AddressFamily | "all");
              setPage(0);
              setList("");
            }}
          >
            <SelectTrigger aria-label="Address search IP family">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">IPv4 + IPv6</SelectItem>
              <SelectItem value="ipv4">IPv4</SelectItem>
              <SelectItem value="ipv6">IPv6</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>
      <div className="address-browser__filters">
        <Select
          value={list ? `name:${list}` : "all"}
          onValueChange={(value) => {
            setList(value === "all" ? "" : value.slice(5));
            setPage(0);
          }}
        >
          <SelectTrigger aria-label="Filter address list">
            <SelectValue placeholder="All lists" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              All {scope === "referenced" ? "referenced " : ""}lists
            </SelectItem>
            {names.map((name) => (
              <SelectItem key={name} value={`name:${name}`}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span>
          Fuzzy search <span aria-hidden="true">·</span> exact matches first
        </span>
      </div>
      {scope === "referenced" && (
        <ScrollArea className="address-browser__chips">
          <div>
            {[...new Set(references)].map((name) => (
              <button
                type="button"
                key={name}
                aria-pressed={list === name}
                onClick={() => {
                  setList(list === name ? "" : name);
                  setPage(0);
                }}
              >
                {name}
                <span>
                  {entries.filter((entry) => entry.row.list === name).length}
                  {!complete ? "+" : ""}
                </span>
              </button>
            ))}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      )}
      <div
        className="address-browser__coverage"
        data-complete={complete}
        role="status"
        aria-live="polite"
      >
        {complete ? (
          <CheckCheck size={14} />
        ) : loading ? (
          <LoaderCircle size={14} className="address-browser__spinner" />
        ) : (
          <ListFilter size={14} />
        )}
        <span>
          {complete
            ? `${loaded.toLocaleString()} entries indexed`
            : `${loaded.toLocaleString()} / ${total?.toLocaleString() ?? "…"} entries read`}
          <small>
            {complete
              ? `Snapshot · ${new Date(observedAt).toLocaleTimeString()}`
              : loading
                ? "Reading every page · results still incomplete"
                : "Incomplete snapshot · refresh to retry"}
          </small>
        </span>
        <strong>
          {matches.length.toLocaleString()} {complete ? "matches" : "so far"}
        </strong>
      </div>
      {indexes
        .filter((index) => index.error)
        .map((index, i) => (
          <p className="address-browser__error" role="alert" key={i}>
            {index.error}
          </p>
        ))}
      {copyError && (
        <p className="address-browser__error" role="alert">
          {copyError}
        </p>
      )}
      <ScrollArea className="address-browser__results">
        <ul aria-label="Address search results">
          {matches.slice(currentPage * 40, (currentPage + 1) * 40).map((entry) => {
            const { row } = entry;
            const key = `${entry.family}:${row[".id"]}`;
            return (
              <li key={key} className="address-browser__row" data-disabled={row.disabled === "yes"}>
                <div className="address-browser__row-top">
                  <code>{row.address}</code>
                  <div>
                    <span className="address-browser__family">
                      {entry.family === "ipv4" ? "v4" : "v6"}
                    </span>
                    {query && entry.match === "fuzzy" && (
                      <span className="address-browser__approx">Approximate</span>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Copy ${row.address}`}
                      onClick={() => void copy(row.address, key)}
                    >
                      {copied === key ? <Check size={13} /> : <Copy size={13} />}
                    </Button>
                  </div>
                </div>
                <div className="address-browser__row-meta">
                  <span title={row.list}>{row.list}</span>
                  {row.disabled === "yes" ? (
                    <small>Disabled</small>
                  ) : row.dynamic === "yes" ? (
                    <small>Dynamic</small>
                  ) : null}
                </div>
                {row.comment && (
                  <p className="address-browser__comment" title={row.comment}>
                    {row.comment}
                  </p>
                )}
                <details className="address-browser__entry-details">
                  <summary aria-label={`Details for ${row.address}`}>
                    <ChevronRight size={13} />
                    <span className="sr-only">Entry details</span>
                  </summary>
                  <dl>
                    {Object.entries(row).map(([field, value]) => (
                      <div key={field}>
                        <dt>{field}</dt>
                        <dd>{value || "(empty)"}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              </li>
            );
          })}
        </ul>
        {!matches.length && (
          <div className="address-browser__empty">
            <Search size={23} />
            <strong>
              {loading
                ? "Looking through the remaining entries…"
                : complete
                  ? "No matching addresses"
                  : "Search coverage is incomplete"}
            </strong>
            <p>
              {complete
                ? "Try part of an IP, a comment, or switch to all router lists."
                : "An incomplete read is not an empty address list."}
            </p>
          </div>
        )}
      </ScrollArea>
      <footer className="address-browser__footer">
        <span>
          {matches.length
            ? `${currentPage * 40 + 1}–${Math.min((currentPage + 1) * 40, matches.length)} of ${matches.length}`
            : "0 shown"}
        </span>
        <div>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Previous address results"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            <ChevronLeft size={16} />
          </Button>
          <span>
            {currentPage + 1} / {pages}
          </span>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Next address results"
            disabled={currentPage + 1 >= pages}
            onClick={() => setPage(currentPage + 1)}
          >
            <ChevronRight size={16} />
          </Button>
        </div>
      </footer>
      <p className="address-browser__note">
        Read over multiple pages, not an atomic router snapshot. Refresh after router changes.
      </p>
    </section>
  );
}
