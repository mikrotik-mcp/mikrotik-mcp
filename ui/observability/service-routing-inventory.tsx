import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { AlertTriangle, ChevronRight, Network, Route, X } from "lucide-react";
import type { RoutingInventory, RoutingSectionKey } from "../../src/service-routing/inventory";
import type { Row, RoutingPolicy } from "../../src/service-routing/model";
import { api } from "./api";
import { RoutingAddressBrowser } from "./service-routing-address-browser";
import { RoutingGateway } from "./routing-gateway";
import {
  MonitorButton,
  MonitorEmpty,
  MonitorSearch,
  MonitorSelect,
  MonitorTabs,
  StatusDot,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { cn } from "@/lib/utils";

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
    reasons.push("Conflict checks are incomplete. Read the router again before you plan a change.");
  const conflicts = mangle.rows.filter(
    (r) =>
      r.disabled !== "yes" &&
      r.comment !== `mcp-sr-${policy.id}` &&
      ["mark-routing", "jump", "route"].includes(r.action),
  );
  if (conflicts.length && policy.precedence !== "before-existing")
    reasons.push(
      `${conflicts.length} existing routing marks or jumps need a review first. MCP won't override them. Check Mangle in Router configuration.`,
    );
  if (filters.rows.some((r) => r.disabled !== "yes" && r.action === "fasttrack-connection"))
    reasons.push(
      "FastTrack is on and may skip these policies. An administrator must review the exclusions before you apply.",
    );
  return reasons;
}

const groups = {
  routes: {
    label: "Routes",
    keys: ["routes4", "routes6"],
    help: "Every route, including connected, dynamic, disabled and inactive ones. Active means RouterOS picked it, not that the internet works through it.",
    head: ["Destination", "Gateway", "Table"],
  },
  mangle: {
    label: "Mangle",
    keys: ["mangle4", "mangle6"],
    help: "Mangle rules mark packets so a routing rule can send them to another table. Shown in the order the router runs them.",
    head: ["Match", "Action", "Chain"],
  },
  rules: {
    label: "Routing rules",
    keys: ["rules"],
    help: "Routing rules pick a table for matching traffic, in router order. Mangle marks can win over them. This is configuration, not a packet trace.",
    head: ["Match", "Action", "Table"],
  },
  addresses: {
    label: "Address lists",
    keys: ["addresses4", "addresses6"],
    help: "Static entries, host names and members learned from DNS. One CDN address can belong to more than one service.",
    head: ["Address", "List", "List"],
  },
  tables: {
    label: "Tables and VRFs",
    keys: ["tables", "vrfs"],
    help: "A routing table is not always a VRF. Exit checks over HTTPS need a VRF with the same name.",
    head: ["Name", "Type", "Table"],
  },
} satisfies Record<
  string,
  { label: string; keys: RoutingSectionKey[]; help: string; head: [string, string, string] }
>;
type Group = keyof typeof groups;
type Entry = { row: Row; section: RoutingSectionKey; family: string };
const COLS = "grid-cols-[56px_minmax(190px,1fr)_210px_88px_76px_60px]";

const familyOf = (key: RoutingSectionKey, row: Row) =>
  key.endsWith("4")
    ? "IPv4"
    : key.endsWith("6")
      ? "IPv6"
      : key === "rules" && (row["src-address"] || row["dst-address"])
        ? `${(row["src-address"] || row["dst-address"]).includes(":") ? "IPv6" : "IPv4"}`
        : "Both";

function mangleMatch(r: Row): string {
  const proto = r.protocol
    ? `${r.protocol}${r["dst-port"] ? ` dst-port ${r["dst-port"]}` : ""}`
    : "";
  return (
    [
      r["in-interface"] && `in ${r["in-interface"]}`,
      r["in-interface-list"] && `in-list ${r["in-interface-list"]}`,
      r["src-address"] && `src ${r["src-address"]}`,
      r["src-address-list"] && `src-list ${r["src-address-list"]}`,
      r["dst-address"] && `dst ${r["dst-address"]}`,
      r["dst-address-list"] && `dst-list ${r["dst-address-list"]}`,
      proto,
      r["connection-mark"] && `connection-mark ${r["connection-mark"]}`,
      r["connection-state"] && `state ${r["connection-state"]}`,
    ]
      .filter(Boolean)
      .join(", ") || "Any packet"
  );
}

/** The two lines of a row: what it matches, and where it sends traffic. */
function summary(entry: Entry): { match: string; target: string } {
  const r = entry.row;
  if (entry.section.startsWith("routes"))
    return {
      match: r["dst-address"] || "Unknown destination",
      target:
        r["immediate-gw"] ||
        r.gateway ||
        (r.blackhole === "yes" ? "Blackhole" : "No gateway reported"),
    };
  if (entry.section.startsWith("mangle"))
    return {
      match: mangleMatch(r),
      target:
        r["new-routing-mark"] ||
        r["jump-target"] ||
        r["new-connection-mark"] ||
        r["route-dst"] ||
        r["new-packet-mark"] ||
        r["new-dscp"] ||
        "",
    };
  if (entry.section === "rules")
    return {
      match:
        [
          r["src-address"] && `src ${r["src-address"]}`,
          r["dst-address"] && `dst ${r["dst-address"]}`,
          r.interface && `in ${r.interface}`,
          r["routing-mark"] && `mark ${r["routing-mark"]}`,
        ]
          .filter(Boolean)
          .join(", ") || "Any traffic",
      target: r.table || "",
    };
  if (entry.section.startsWith("addresses"))
    return { match: r.address || "Unknown address", target: r.list || "" };
  return {
    match: r.name || "Unnamed table",
    target: entry.section === "vrfs" ? r.interfaces || "" : "",
  };
}

function stateOf(entry: Entry): { label: string; tone: Tone } {
  const r = entry.row;
  if (r.disabled === "yes") return { label: "Disabled", tone: "default" };
  if (r.invalid === "yes") return { label: "Invalid", tone: "bad" };
  if (entry.section.startsWith("routes"))
    return r.active === "yes"
      ? { label: "Active", tone: "good" }
      : { label: "Inactive", tone: "default" };
  return { label: "Enabled", tone: "good" };
}

const KIND: Partial<Record<RoutingSectionKey, string>> = {
  routes4: "route",
  routes6: "route",
  tables: "table",
  vrfs: "VRF",
};

function ActionCell({ entry, target }: { entry: Entry; target: string }): ReactNode {
  const r = entry.row;
  if (entry.section.startsWith("routes"))
    return (
      <span className="sr-gw flex min-w-0 flex-col gap-0.5">
        <RoutingGateway value={target} />
        {r.distance && (
          <span className="text-[12px] text-muted-foreground">Distance {r.distance}</span>
        )}
      </span>
    );
  const type =
    entry.section === "vrfs"
      ? "VRF"
      : entry.section === "tables"
        ? r.fib === "yes"
          ? "FIB"
          : "RIB only"
        : r.action || "unknown";
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      <span className="monitor-chip font-mono">{type}</span>
      {target && (
        <span className="monitor-chip max-w-full truncate font-mono text-brand">→ {target}</span>
      )}
      {r.passthrough && (
        <span className="w-full text-[12px] text-muted-foreground">
          passthrough{" "}
          {r.passthrough === "yes" ? "on" : r.passthrough === "no" ? "off" : r.passthrough}
        </span>
      )}
    </span>
  );
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
  const [fieldsOpen, setFieldsOpen] = useState(false);
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
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
        {error && (
          <div className="monitor-note" data-tone="bad" role="alert">
            <AlertTriangle aria-hidden="true" className="text-destructive" />
            <span className="flex-1 text-fg-secondary">{error}</span>
          </div>
        )}
        <section className="monitor-panel" role="status">
          <MonitorEmpty
            icon={<Network />}
            title={
              loading ? "Reading this router's configuration…" : "Router configuration unavailable"
            }
            action={
              !loading && (
                <MonitorButton size="sm" onClick={retry}>
                  Read the router again
                </MonitorButton>
              )
            }
          >
            Routes, rules and address lists are read one by one. Nothing on the router changes.
          </MonitorEmpty>
        </section>
      </div>
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
  // One cause for every failed section (an unreachable router): say it once.
  const sameError = (list: typeof failed): boolean =>
    list.length > 1 && list.every((s) => s.error === list[0].error);
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
  const ready = (k: RoutingSectionKey) => data.sections[k].state === "ready";
  const size = (k: RoutingSectionKey) => data.sections[k].total ?? data.sections[k].rows.length;
  const count = (sections: readonly RoutingSectionKey[]) =>
    sections.some((k) => !ready(k)) ? "—" : sections.reduce((n, k) => n + size(k), 0);
  const split = (a: RoutingSectionKey, b: RoutingSectionKey, what = "") =>
    !ready(a) && !ready(b)
      ? "Not read"
      : !ready(a)
        ? `IPv4 ${what}not read`
        : !ready(b)
          ? `IPv6 ${what}not read`
          : `${size(a)} IPv4 · ${size(b)} IPv6`;
  const hints: Record<Exclude<Group, "addresses">, string> = {
    routes: split("routes4", "routes6"),
    mangle: split("mangle4", "mangle6", "mangle "),
    rules: ready("rules")
      ? `${data.sections.rules.rows.filter((r) => r.disabled !== "yes").length} enabled`
      : "Not read",
    tables: `${ready("tables") ? `${size("tables")} tables` : "Tables not read"} · ${ready("vrfs") ? `${size("vrfs")} VRFs` : "VRFs not read"}`,
  };
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
    ? [
        ...new Set(
          ["src-address-list", "dst-address-list"]
            .map((field) => selected.row[field]?.replace(/^!/, ""))
            .filter(Boolean),
        ),
      ]
    : [];
  const pick = (g: Group) => {
    resetPage();
    setGroup(g);
    setTable("all");
    if (g !== group) {
      setQuery("");
      setFamily("all");
    }
  };
  const inspect = (entry: Entry) => {
    setSelected(entry);
    setFieldsOpen(!["src-address-list", "dst-address-list"].some((field) => entry.row[field]));
  };
  const head = groups[group].head;
  const selectedSummary = selected ? summary(selected) : undefined;
  return (
    <div
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6"
      aria-label="Router routing inventory"
    >
      {error && (
        <div className="monitor-note" data-tone="bad" role="alert">
          <AlertTriangle aria-hidden="true" className="text-destructive" />
          <span className="flex-1 text-fg-secondary">
            {error} The data below is from the last read.
          </span>
        </div>
      )}
      {failed.length > 0 && (
        <div className="monitor-note" data-tone="warn" role="alert">
          <AlertTriangle aria-hidden="true" className="text-warning" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-[510] text-foreground">
              {failed.length === Object.keys(data.sections).length
                ? "No section could be read"
                : `${failed.length} ${failed.length === 1 ? "section" : "sections"} could not be read`}
            </span>
            <span className="font-mono text-[12px] break-words text-muted-foreground">
              {sameError(failed)
                ? `${failed.map((s) => s.path).join(" · ")} — ${failed[0].error ?? "not read"}`
                : failed.map((s) => `${s.path} — ${s.error ?? "not read"}`).join(" · ")}
            </span>
            <span className="text-[12px] text-muted-foreground">
              {failed.length === Object.keys(data.sections).length
                ? "Nothing on the router changed. Retry once the router is reachable."
                : "Counts for these sections show “—”. Everything else is current."}
            </span>
          </div>
          <MonitorButton size="sm" onClick={retry} disabled={loading}>
            Retry these sections
          </MonitorButton>
        </div>
      )}

      <section
        className="monitor-strip"
        style={{ "--strip-min": "200px" } as CSSProperties}
        aria-label="Sections"
      >
        {(["routes", "mangle", "rules", "tables"] as const).map((g) => (
          <button
            key={g}
            type="button"
            aria-pressed={group === g}
            onClick={() => pick(g)}
            className={cn(
              "monitor-metric cursor-pointer text-left transition-colors hover:bg-overlay-03",
              group === g &&
                "bg-overlay-03 shadow-[-1px_0_0_var(--border),0_-1px_0_var(--border),inset_0_-2px_0_var(--chart-1)]",
            )}
          >
            <span className="monitor-metric-label">{groups[g].label}</span>
            <span className="monitor-metric-value text-emphasis">{count(groups[g].keys)}</span>
            <span className="monitor-metric-hint">{hints[g]}</span>
          </button>
        ))}
      </section>

      <section className="monitor-panel overflow-hidden">
        <MonitorTabs<Group>
          label="Section"
          value={group}
          onChange={pick}
          tabs={(Object.keys(groups) as Group[]).map((g) => ({
            value: g,
            label: groups[g].label,
            count: count(groups[g].keys),
          }))}
        />
        {group !== "addresses" && (
          <div className="flex flex-wrap items-center gap-2 px-5 pt-4 pb-2">
            <MonitorSearch
              className="flex-[1_1_320px]"
              label="Search router routing"
              placeholder="Find an address, list, comment or gateway"
              value={query}
              onChange={(v) => {
                resetPage();
                setQuery(v);
              }}
            />
            <MonitorSelect
              label="Inventory IP family"
              value={family}
              onChange={(v) => {
                resetPage();
                setFamily(v);
              }}
              options={[
                { value: "all", label: "IPv4 + IPv6" },
                { value: "IPv4", label: "IPv4" },
                { value: "IPv6", label: "IPv6" },
              ]}
            />
            <MonitorSelect
              label="Filter routing table"
              value={table}
              onChange={(v) => {
                resetPage();
                setTable(v);
              }}
              options={[
                { value: "all", label: "All routing tables" },
                ...tableNames.map((name) => ({ value: name, label: name })),
              ]}
            />
          </div>
        )}
        <p
          className={cn(
            "px-5 pb-3.5 text-[12px] text-muted-foreground",
            group === "addresses" && "pt-4",
          )}
        >
          {groups[group].help}
          {table !== "all" &&
            group !== "addresses" &&
            " Filtering by table shows direct references only, not jumps or bypass rules."}
        </p>

        {group === "addresses" ? (
          <div className="border-t border-border px-5 py-4">
            <RoutingAddressBrowser key={data.device} device={data.device} />
          </div>
        ) : (
          <div className="flex flex-wrap border-t border-border">
            <div className="flex min-w-0 flex-[999_1_560px] flex-col">
              <div className="overflow-x-auto" role="table" aria-label={groups[group].label}>
                <div className={cn("monitor-thead min-w-[660px] border-t-0", COLS)} role="row">
                  <span role="columnheader">Order</span>
                  {head.map((label) => (
                    <span role="columnheader" key={label}>
                      {label}
                    </span>
                  ))}
                  <span role="columnheader">State</span>
                  <span role="columnheader">
                    <span className="sr-only">Details</span>
                  </span>
                </div>
                {filtered.slice(currentPage * 40, (currentPage + 1) * 40).map((entry) => {
                  const r = entry.row,
                    { match, target } = summary(entry),
                    state = stateOf(entry);
                  const comment =
                    r.comment || (entry.section.startsWith("mangle") ? "No comment" : "");
                  const isSelected =
                    selected?.section === entry.section &&
                    (selected.row === entry.row ||
                      (!!r[".id"] && selected.row[".id"] === r[".id"]));
                  return (
                    <div
                      key={`${entry.section}-${r[".id"] || r["#"]}`}
                      role="row"
                      className={cn("monitor-row min-w-[660px] items-start", COLS)}
                      data-selected={isSelected || undefined}
                      data-failed={state.tone === "bad" || undefined}
                    >
                      <span role="cell" className="flex flex-col">
                        <span className="font-mono text-[12px] text-fg-secondary">#{r["#"]}</span>
                        <span className="text-[12px] text-muted-foreground">{entry.family}</span>
                      </span>
                      <span role="cell" className="flex min-w-0 flex-col">
                        <span
                          className="truncate font-mono text-[12px] text-foreground"
                          title={match}
                        >
                          {match}
                        </span>
                        {(comment || r.dynamic === "yes") && (
                          <span className="flex min-w-0 items-center gap-1.5">
                            {comment && (
                              <span className="truncate text-[12px] text-muted-foreground">
                                {comment}
                              </span>
                            )}
                            {r.dynamic === "yes" && <span className="monitor-chip">Dynamic</span>}
                          </span>
                        )}
                      </span>
                      <span role="cell" className="min-w-0">
                        <ActionCell
                          entry={entry}
                          target={entry.section.startsWith("rules") ? "" : target}
                        />
                      </span>
                      <span
                        role="cell"
                        className="truncate font-mono text-[12px] text-fg-secondary"
                      >
                        {entry.section.startsWith("routes")
                          ? r["routing-table"] || "main"
                          : entry.section.startsWith("mangle")
                            ? r.chain || "—"
                            : entry.section === "rules"
                              ? r.table || "—"
                              : "—"}
                      </span>
                      <span
                        role="cell"
                        className="flex items-center gap-1.5 text-[12px] text-fg-secondary"
                      >
                        <StatusDot tone={state.tone} />
                        {state.label}
                      </span>
                      <span role="cell" className="text-right">
                        <MonitorButton
                          size="sm"
                          variant="ghost"
                          className="px-1.5"
                          aria-label={`Inspect ${match}`}
                          aria-expanded={isSelected}
                          onClick={() => (isSelected ? setSelected(undefined) : inspect(entry))}
                        >
                          Inspect
                        </MonitorButton>
                      </span>
                    </div>
                  );
                })}
              </div>
              {!filtered.length && (
                <MonitorEmpty
                  compact
                  icon={<Route />}
                  title={
                    keys.some((k) => data.sections[k].state === "error")
                      ? "This section could not be read"
                      : query || table !== "all" || family !== "all"
                        ? "No matching entries"
                        : "No entries in this section"
                  }
                >
                  {query || table !== "all" || family !== "all"
                    ? "Clear the search or filters to see the rest."
                    : "MCP policies are kept apart from these router entries."}
                </MonitorEmpty>
              )}
              <div className="monitor-row mt-auto grid-cols-[1fr_auto] text-[12px] text-muted-foreground hover:bg-transparent">
                <span>
                  {filtered.length} {filtered.length === 1 ? "entry" : "entries"} · router order
                  kept
                </span>
                <span className="flex items-center gap-2">
                  <MonitorButton
                    size="sm"
                    variant="ghost"
                    disabled={currentPage === 0}
                    onClick={() => setPage(currentPage - 1)}
                  >
                    Previous
                  </MonitorButton>
                  <span className="tabular-nums">
                    {currentPage + 1} / {pages}
                  </span>
                  <MonitorButton
                    size="sm"
                    variant="ghost"
                    disabled={currentPage + 1 >= pages}
                    onClick={() => setPage(currentPage + 1)}
                  >
                    Next
                  </MonitorButton>
                </span>
              </div>
            </div>

            {selected && selectedSummary && (
              <aside
                className="sr-inspect flex max-w-[360px] min-w-0 flex-[1_1_300px] flex-col border-l border-border"
                aria-label={`Inspect ${KIND[selected.section] ?? "rule"} ${selected.row["#"]}`}
              >
                <div className="flex flex-col gap-1.5 border-b border-border px-5 py-4">
                  <div className="flex items-center gap-2">
                    <span className="monitor-label flex-1">
                      Inspect · {KIND[selected.section] ?? "rule"} #{selected.row["#"]}
                    </span>
                    <MonitorButton
                      size="sm"
                      variant="ghost"
                      aria-label="Close"
                      icon={<X />}
                      onClick={() => setSelected(undefined)}
                    />
                  </div>
                  <h3 className="font-mono text-[14px] font-medium break-words text-emphasis">
                    {selectedSummary.match}
                    {selectedSummary.target && ` → ${selectedSummary.target}`}
                  </h3>
                  <p className="text-[12px] text-muted-foreground">
                    <span className="font-mono">{data.sections[selected.section].path}</span> ·{" "}
                    {data.device} · read-only
                  </p>
                </div>
                <div className="flex flex-col gap-3 px-5 py-4">
                  {linkedLists.length > 0 && (
                    <RoutingAddressBrowser
                      key={`${data.device}:${selected.section}:${selected.row[".id"]}`}
                      device={data.device}
                      references={linkedLists}
                      referenceFamily={selected.family === "IPv6" ? "ipv6" : "ipv4"}
                    />
                  )}
                  <div
                    className={cn(
                      "flex flex-col gap-2",
                      linkedLists.length > 0 && "border-t border-border pt-3",
                    )}
                  >
                    <button
                      type="button"
                      aria-expanded={fieldsOpen}
                      onClick={() => setFieldsOpen((v) => !v)}
                      className="flex cursor-pointer items-center gap-1.5 text-[13px] font-[510] text-foreground"
                    >
                      <ChevronRight
                        aria-hidden="true"
                        className={cn("size-4 transition-transform", fieldsOpen && "rotate-90")}
                      />
                      Router fields · {Object.keys(selected.row).length}
                    </button>
                    {fieldsOpen && (
                      <dl className="monitor-facts grid-cols-[minmax(0,120px)_minmax(0,1fr)]">
                        {Object.entries(selected.row).map(([key, value]) => (
                          <div key={key} className="contents">
                            <dt className="truncate font-mono text-[12px]">{key}</dt>
                            <dd className="font-mono text-[12px] break-all">
                              {value || "(empty)"}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                </div>
              </aside>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
