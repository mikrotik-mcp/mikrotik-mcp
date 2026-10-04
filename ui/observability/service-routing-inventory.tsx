import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronRight,
  Search,
  Network,
  Route,
  ShieldCheck,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { RoutingInventory, RoutingSectionKey } from "../../src/service-routing/inventory";
import type { Row, RoutingPolicy } from "../../src/service-routing/model";
import { api } from "./api";
import { WorkspaceError } from "./operations-ui";
import { RoutingAddressBrowser } from "./service-routing-address-browser";
import { RoutingGateway } from "./routing-gateway";
import "./service-routing-inventory.css";

export function useRoutingInventory(device: string, paused: boolean) {
  const [data, setData] = useState<RoutingInventory>();
  const [failure, setFailure] = useState({ device: "", message: "" });
  const [loading, setLoading] = useState(false);
  const current = useRef<AbortController | null>(null);
  const reading = useRef(false);
  const refresh = useCallback(async () => {
    if (!device) return;
    current.current?.abort();
    const request = new AbortController();
    current.current = request;
    reading.current = true;
    setLoading(true);
    try {
      const next = await api<RoutingInventory>(
        `/api/service-routing/inventory?device=${encodeURIComponent(device)}`,
        request.signal,
      );
      if (!next.sections || next.device !== device)
        throw new Error(
          "This server does not provide the new router inventory. Rebuild and restart the MCP service to use this view.",
        );
      if (!request.signal.aborted) {
        setData(next);
        setFailure({ device, message: "" });
      }
    } catch (e) {
      if (!request.signal.aborted)
        setFailure({
          device,
          message: e instanceof Error ? e.message : "Could not read router configuration.",
        });
    } finally {
      if (!request.signal.aborted) {
        setLoading(false);
        reading.current = false;
      }
    }
  }, [device]);
  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 0);
    return () => {
      clearTimeout(timer);
      current.current?.abort();
      reading.current = false;
    };
  }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!paused && document.visibilityState === "visible" && !reading.current) void refresh();
    }, 30_000);
    return () => clearInterval(timer);
  }, [paused, refresh]);
  return {
    data: data?.device === device ? data : undefined,
    error: failure.device === device ? failure.message : "",
    loading,
    refresh,
  };
}

export function routeAvailable(data: RoutingInventory, table: string, family: string): boolean {
  const section = data.sections[family === "ipv6" ? "routes6" : "routes4"];
  return (
    section.state === "ready" &&
    section.rows.some(
      (r) =>
        (r["routing-table"] || "main") === table &&
        r["dst-address"] === (family === "ipv6" ? "::/0" : "0.0.0.0/0") &&
        r.disabled !== "yes" &&
        !!r.gateway &&
        r.blackhole !== "yes" &&
        !["blackhole", "unreachable", "prohibit"].includes(r.type) &&
        r.active === "yes",
    )
  );
}

export function policyBlockers(
  data: RoutingInventory,
  policy: Pick<RoutingPolicy, "id" | "family" | "precedence">,
): string[] {
  const mangle = data.sections[policy.family === "ipv6" ? "mangle6" : "mangle4"];
  const filters = data.sections[policy.family === "ipv6" ? "filters6" : "filters4"];
  const reasons: string[] = [];
  if (mangle.state !== "ready" || filters.state !== "ready")
    reasons.push(
      "Conflict checks are incomplete. Refresh the router inventory before planning a change.",
    );
  const conflicts = mangle.rows.filter(
    (r) =>
      r.disabled !== "yes" &&
      r.comment !== `mcp-sr-${policy.id}` &&
      ["mark-routing", "jump", "route"].includes(r.action),
  );
  if (conflicts.length && policy.precedence !== "before-existing")
    reasons.push(
      `${conflicts.length} existing routing marks or jumps need a conflict review. MCP will not override them. Inspect Mangle in Router configuration first.`,
    );
  if (filters.rows.some((r) => r.disabled !== "yes" && r.action === "fasttrack-connection"))
    reasons.push(
      "FastTrack is enabled and may bypass these policies. An administrator must review exclusions before apply.",
    );
  return reasons;
}
const groups = {
  routes: {
    label: "Routes",
    keys: ["routes4", "routes6"],
    help: "All route entries, including connected, dynamic, disabled and inactive routes. Active means selected by RouterOS, not verified internet access.",
  },
  mangle: {
    label: "Mangle",
    keys: ["mangle4", "mangle6"],
    help: "Original router order is preserved. Marks and jumps steer traffic; other actions remain visible. Inspect a rule to see all match conditions and referenced address lists.",
  },
  rules: {
    label: "Routing rules",
    keys: ["rules"],
    help: "Policy lookups in router order. Rules with no IP-family-specific selector apply to both families. Mangle can take precedence; this is configuration, not a packet trace.",
  },
  addresses: {
    label: "Address lists",
    keys: ["addresses4", "addresses6"],
    help: "Static addresses, hostnames and DNS-resolved members. A shared CDN address can belong to more than one service.",
  },
  tables: {
    label: "Tables & VRFs",
    keys: ["tables", "vrfs"],
    help: "FIB tables select forwarding routes. A routing table is not necessarily a VRF: per-exit HTTPS tests require a matching VRF.",
  },
} satisfies Record<string, { label: string; keys: RoutingSectionKey[]; help: string }>;
type Group = keyof typeof groups;
type Entry = { row: Row; section: RoutingSectionKey; family: string };
const familyOf = (key: RoutingSectionKey, row: Row) =>
  key.endsWith("4")
    ? "IPv4"
    : key.endsWith("6")
      ? "IPv6"
      : key === "rules" && (row["src-address"] || row["dst-address"])
        ? `${(row["src-address"] || row["dst-address"]).includes(":") ? "IPv6" : "IPv4"}`
        : "Both";
function summary(entry: Entry) {
  const r = entry.row;
  if (entry.section.startsWith("routes"))
    return [
      r["dst-address"] || "Unknown destination",
      r["immediate-gw"] ||
        r.gateway ||
        (r.blackhole === "yes" ? "Blackhole" : "No gateway reported"),
    ];
  if (entry.section.startsWith("mangle"))
    return [
      r.comment || r.chain || "Mangle rule",
      r["new-routing-mark"] ||
        r["jump-target"] ||
        r["new-connection-mark"] ||
        r["route-dst"] ||
        r.action ||
        "Unknown action",
    ];
  if (entry.section === "rules")
    return [
      r["src-address"] || r["dst-address"] || r.interface || "Any matching traffic",
      r.table || r.action || "Unknown action",
    ];
  if (entry.section.startsWith("addresses"))
    return [r.list || "Unnamed list", r.address || "Unknown address"];
  return [
    r.name || "Unnamed table",
    entry.section === "vrfs"
      ? r.interfaces || "No interfaces"
      : r.fib === "yes"
        ? "Forwarding table (FIB)"
        : "RIB only",
  ];
}

export function RouterRoutingInventory({
  data: incoming,
  loading,
  error,
  onRetry,
}: {
  data?: RoutingInventory;
  loading: boolean;
  error: string;
  onRetry: () => void;
}) {
  const [group, setGroup] = useState<Group>("routes");
  const [family, setFamily] = useState("all");
  const [table, setTable] = useState("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Entry>();
  const data = incoming;
  const retry = () => {
    setSelected(undefined);
    onRetry();
  };
  const resetPage = () => {
    setPage(0);
    setSelected(undefined);
  };
  if (!data)
    return (
      <section className="routing-inventory">
        <WorkspaceError message={error} />
        <div className="ops-empty" role="status">
          <Network size={30} />
          <h3>
            {loading ? "Reading this router’s configuration…" : "Router inventory is unavailable"}
          </h3>
          <p>
            Routes, policy rules and address lists are read independently. Nothing on the router is
            changed.
          </p>
          {!loading && (
            <Button variant="outline" onClick={retry}>
              Retry router read
            </Button>
          )}
        </div>
      </section>
    );
  const allEntries: Entry[] = Object.values(groups)
    .flatMap((g) => g.keys)
    .flatMap((key) => {
      const section = data.sections[key];
      return section.state === "ready"
        ? section.rows.map((row) => ({
            row,
            section: key as RoutingSectionKey,
            family: familyOf(key as RoutingSectionKey, row),
          }))
        : [];
    });
  const keys: readonly RoutingSectionKey[] = groups[group].keys;
  const failed = Object.values(data.sections).filter((s) => s.state !== "ready");
  const filtered = allEntries.filter(
    (e) =>
      keys.includes(e.section) &&
      (family === "all" || e.family === family || e.family === "Both") &&
      (table === "all" ||
        [
          e.row["routing-table"] || (e.section.startsWith("routes") ? "main" : ""),
          e.row["new-routing-mark"],
          e.row.table,
          e.section === "tables" || e.section === "vrfs" ? e.row.name : "",
        ].includes(table)) &&
      Object.values(e.row).join(" ").toLowerCase().includes(query.toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 40));
  const currentPage = Math.min(page, pages - 1);
  const count = (sections: readonly RoutingSectionKey[]) =>
    sections.some((k) => data.sections[k].state !== "ready")
      ? "—"
      : sections.reduce((n, k) => n + (data.sections[k].total ?? data.sections[k].rows.length), 0);
  const tableNames = [
    ...new Set(
      [
        ...data.sections.tables.rows.map((r) => r.name),
        ...allEntries.map(
          (e) => e.row["routing-table"] || e.row["new-routing-mark"] || e.row.table,
        ),
      ].filter(Boolean),
    ),
  ];
  const linkedLists = selected
    ? ["src-address-list", "dst-address-list"]
        .map((field) => selected.row[field]?.replace(/^!/, ""))
        .filter(Boolean)
    : [];
  return (
    <section className="routing-inventory" aria-label="Router routing inventory">
      <div className="routing-status">
        <span>
          <ShieldCheck size={15} /> Read-only router snapshot
        </span>
        <span role="status">
          {loading
            ? "Refreshing…"
            : error || failed.length
              ? "Partial or last-known data"
              : "Configuration loaded"}{" "}
          · {new Date(data.observedAt).toLocaleTimeString()} · 20s cache / 30s refresh
        </span>
      </div>
      <WorkspaceError message={error} />
      {failed.length > 0 && (
        <div className="routing-warning" role="alert">
          <AlertTriangle size={16} />
          <div>
            <strong>{failed.length} sections could not be read</strong>
            <p>Missing data is not an empty routing table. Other sections remain available.</p>
            <details>
              <summary>Show read errors</summary>
              {failed.map((s) => (
                <p key={s.path}>
                  <code>{s.path}</code> — {s.error}
                </p>
              ))}
            </details>
            <Button variant="link" onClick={retry} disabled={loading}>
              Retry unavailable sections
            </Button>
          </div>
        </div>
      )}
      <div className="routing-counts">
        {(["routes", "mangle", "rules", "tables"] as const).map((g) => (
          <button
            key={g}
            onClick={() => {
              resetPage();
              setGroup(g);
              setQuery("");
              setTable("all");
              setFamily("all");
            }}
            aria-pressed={group === g}
          >
            <span>{groups[g].label}</span>
            <strong>{count(groups[g].keys)}</strong>
            <ChevronRight size={16} />
          </button>
        ))}
      </div>
      {group !== "addresses" && (
        <div className="routing-controls">
          <label className="routing-search">
            <Search size={16} />
            <Input
              aria-label="Search router routing"
              value={query}
              onChange={(e) => {
                resetPage();
                setQuery(e.target.value);
              }}
              placeholder="Find an address, list, comment or gateway…"
            />
          </label>
          <Select
            value={family}
            onValueChange={(value) => {
              resetPage();
              setFamily(value);
            }}
          >
            <SelectTrigger aria-label="Inventory IP family">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">IPv4 + IPv6</SelectItem>
              <SelectItem value="IPv4">IPv4</SelectItem>
              <SelectItem value="IPv6">IPv6</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={table}
            onValueChange={(value) => {
              resetPage();
              setTable(value);
            }}
          >
            <SelectTrigger aria-label="Filter routing table">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All routing tables</SelectItem>
              {tableNames.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <nav className="routing-tabs" aria-label="Router configuration sections">
        {(Object.keys(groups) as Group[]).map((g) => (
          <Button
            key={g}
            variant={group === g ? "secondary" : "ghost"}
            aria-pressed={group === g}
            onClick={() => {
              resetPage();
              setGroup(g);
              setTable("all");
            }}
          >
            {groups[g].label}
            <span>{count(groups[g].keys)}</span>
          </Button>
        ))}
      </nav>
      <p className="routing-help">
        {groups[group].help}
        {table !== "all" &&
          " Table filtering shows direct references only, not indirect jumps or bypass rules."}
      </p>
      {group === "addresses" ? (
        <RoutingAddressBrowser key={data.device} device={data.device} />
      ) : (
        <>
          <ScrollArea className="routing-table-scroll">
            <table className="routing-table">
              <thead>
                <tr>
                  <th>Order / family</th>
                  <th>{group === "routes" ? "Destination" : "Match / name"}</th>
                  <th>{group === "routes" ? "Gateway / interface" : "Action / target"}</th>
                  <th>Table / chain</th>
                  <th>State</th>
                  <th>
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(currentPage * 40, (currentPage + 1) * 40).map((entry) => {
                  const r = entry.row,
                    [from, to] = summary(entry);
                  const state =
                    r.disabled === "yes"
                      ? "Disabled"
                      : r.invalid === "yes"
                        ? "Invalid"
                        : entry.section.startsWith("routes")
                          ? r.active === "yes"
                            ? "Active"
                            : "Inactive"
                          : "Enabled";
                  return (
                    <tr key={`${entry.section}-${r[".id"] || r["#"]}`}>
                      <td>
                        <span className="routing-order">#{r["#"]}</span>
                        <small>
                          {entry.family} ·{" "}
                          {entry.section === "vrfs"
                            ? "VRF"
                            : r.dynamic === "yes"
                              ? "Dynamic"
                              : "Configured"}
                        </small>
                      </td>
                      <td>
                        <strong>{from}</strong>
                        {r.comment && !entry.section.startsWith("mangle") && (
                          <small>{r.comment}</small>
                        )}
                        {entry.section.startsWith("mangle") && (
                          <small>
                            {[
                              r["src-address"] || r["src-address-list"],
                              r["dst-address"] || r["dst-address-list"],
                              r["in-interface"] || r["in-interface-list"],
                            ]
                              .filter(Boolean)
                              .join(" · ") || "Inspect all match conditions"}
                          </small>
                        )}
                      </td>
                      <td>
                        <span className="routing-target">
                          <ArrowRight size={14} />
                          {entry.section.startsWith("routes") ? (
                            <RoutingGateway value={to} />
                          ) : (
                            <code>{to}</code>
                          )}
                        </span>
                        {r.action && (
                          <small>
                            {r.action}
                            {r.passthrough ? ` · passthrough ${r.passthrough}` : ""}
                          </small>
                        )}
                      </td>
                      <td>
                        <code>{r["routing-table"] || r.table || r.chain || "—"}</code>
                        {r.distance && <small>Distance {r.distance}</small>}
                      </td>
                      <td>
                        <span className="routing-state" data-state={state}>
                          {state}
                        </span>
                      </td>
                      <td>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Inspect ${from}`}
                          onClick={() => setSelected(entry)}
                        >
                          Inspect <ChevronRight size={14} />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
          {!filtered.length && (
            <div className="ops-empty">
              <Route size={28} />
              <h3>
                {keys.some((k) => data.sections[k].state === "error")
                  ? "This section is incomplete"
                  : query || table !== "all" || family !== "all"
                    ? "No matching entries"
                    : "No entries in this section"}
              </h3>
              <p>
                {query || table !== "all" || family !== "all"
                  ? "Clear the search or filters to see the rest of the router configuration."
                  : "MCP saved policies are separate from these router entries."}
              </p>
            </div>
          )}
          <footer className="routing-pagination">
            <span>{filtered.length} matching entries · router order preserved</span>
            <div>
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                Previous
              </Button>
              <span>
                {currentPage + 1} / {pages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage + 1 >= pages}
                onClick={() => setPage(currentPage + 1)}
              >
                Next
              </Button>
            </div>
          </footer>
        </>
      )}
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
      >
        <DialogContent className={linkedLists.length ? "sm:max-w-3xl" : "sm:max-w-2xl"}>
          <DialogHeader>
            <DialogTitle>{selected ? summary(selected)[0] : "Routing entry"}</DialogTitle>
            <DialogDescription>
              {selected && data.sections[selected.section].path} · {data.device}. Read-only details;
              existing rules are not automatically adopted by MCP.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea
            className={
              linkedLists.length
                ? "routing-inspector-scroll h-[min(78vh,760px)] overflow-hidden"
                : "routing-inspector-scroll h-[min(65vh,650px)] overflow-hidden"
            }
          >
            {selected && linkedLists.length > 0 && (
              <RoutingAddressBrowser
                key={`${data.device}:${selected.section}:${selected.row[".id"]}`}
                device={data.device}
                references={[...new Set(linkedLists)]}
                referenceFamily={selected.family === "IPv6" ? "ipv6" : "ipv4"}
              />
            )}
            <details className="routing-entry-properties" open={!linkedLists.length}>
              <summary>
                Router fields · {selected ? Object.keys(selected.row).length : 0} properties
              </summary>
              <dl className="routing-detail">
                {selected &&
                  Object.entries(selected.row).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{value || "(empty)"}</dd>
                    </div>
                  ))}
              </dl>
            </details>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </section>
  );
}
