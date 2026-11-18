import { LoadingState } from "./loading-state";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import {
  AlertTriangle,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Download,
  Globe2,
  Pause,
  Play,
  SlidersHorizontal,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox, DateTimePicker, DetailList, RowDrawer, RowMenu, RowMore, tipProps } from "./kit";
import { api, withToken } from "./api";
import { bytes, num } from "./format";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorEmpty,
  MonitorPanel,
  MonitorSearch,
  MonitorSelect,
  PageIntro,
  Segmented,
  StatusBadge,
  StatusDot,
  Ticker,
  useStaggerIn,
} from "./monitoring-ui";
import "./monitoring.css";
import "./site-activity.css";

type Visit = {
  client: string;
  destination: string;
  domain: string | null;
  source: "flow" | "dns+flow" | "proxy";
  firstSeen: number;
  lastSeen: number;
  bytes: number;
  connections: number;
  kind: string;
  owner: string;
  device: string;
};
type Identity = {
  client: string;
  kind: string;
  owner: string;
  device: string;
  mac: string;
  observed: number;
};
type Summary = {
  observations: number;
  bytes: number;
  destinations: number;
  clients: number;
  groups: { label: string; observations: number; bytes: number }[];
};
type SitePolicy = { enabled: boolean; owners: string[]; until: number | null };
type ActivityPayload = {
  to: number;
  clients: string[];
  identities: Identity[];
  visits: Visit[];
  summary: Summary;
  policy: SitePolicy;
  collection: {
    flows: { running: boolean; flows: number; storageDropped: number };
    dnsPort: number;
  };
  note: string;
};
type Measure = "observations" | "bytes";

/** The server returns this many rows per page. */
const PAGE_SIZE = 100;
const WINDOWS = [
  { label: "24 hours", ms: 86_400_000 },
  { label: "7 days", ms: 7 * 86_400_000 },
  { label: "30 days", ms: 30 * 86_400_000 },
];
const sourceLabel: Record<Visit["source"], string> = {
  "dns+flow": "DNS + traffic",
  flow: "Traffic",
  proxy: "Web Proxy",
};
const kindLabel: Record<string, string> = {
  "*": "All connections",
  wifi: "Wi-Fi",
  lan: "LAN",
  "lan-wifi": "LAN / Wi-Fi",
  openvpn: "OpenVPN",
  proxy: "Web Proxy",
  unknown: "Unidentified",
};
const MEASURES: { value: Measure; label: string }[] = [
  { value: "observations", label: "Observations" },
  { value: "bytes", label: "Traffic bytes" },
];

const MIB = 1024 * 1024;

/** Row traffic, as the board writes it: "2,140 MiB"; under 1 MiB, "512.0 KiB". */
function rowBytes(n: number): string {
  return n >= MIB ? `${num(Math.round(n / MIB))} MiB` : bytes(n);
}

const formatMeasure = (value: number, measure: Measure): string =>
  measure === "bytes" ? rowBytes(value) : num(Math.round(value));

/** "13:52" for today, "Nov 12, 13:52" for older rows. */
function lastSeenLabel(ts: number): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/** The map's height, as on the board. */
const MAP_HEIGHT = 240;
/** At most this many named tiles; every other site shares one "Other" tile. */
const MAP_TILES = 9;

type Tile = {
  name: string;
  value: number;
  rank: number;
  /** Position and size in percent of the map. */
  x: number;
  y: number;
  w: number;
  h: number;
};

/**
 * The board's treemap: the two biggest sites each take a full-height column,
 * the rest share the remaining width in two rows. Values must be sorted,
 * biggest first.
 */
function treemap(items: { name: string; value: number }[]): Tile[] {
  const total = items.reduce((sum, t) => sum + t.value, 0);
  if (!total) return [];
  const tiles: Tile[] = [];
  let x = 0;
  for (const [i, t] of items.slice(0, 2).entries()) {
    const w = (t.value / total) * 100;
    tiles.push({ ...t, rank: i, x, y: 0, w, h: 100 });
    x += w;
  }
  const rest = items.slice(2);
  const restTotal = rest.reduce((sum, t) => sum + t.value, 0);
  const half = Math.floor(rest.length / 2);
  const rows = [rest.slice(0, half), rest.slice(half)];
  let rank = 2;
  rows.forEach((row, ri) => {
    const rowTotal = row.reduce((sum, t) => sum + t.value, 0);
    if (!rowTotal) return;
    const h = (rowTotal / restTotal) * 100;
    const y = ri === 0 ? 0 : 100 - h;
    let xx = x;
    for (const t of row) {
      const w = ((100 - x) * t.value) / rowTotal;
      tiles.push({ ...t, rank: rank++, x: xx, y, w, h });
      xx += w;
    }
  });
  return tiles;
}

/** Tile colours by rank: teal for the top two, indigo for the next three, glass after. */
function tileTone(rank: number): { background: string; edge: string } {
  if (rank < 2) return { background: "var(--sig-soft)", edge: "var(--sig)" };
  if (rank < 5) return { background: "var(--acc-soft)", edge: "var(--chart-1)" };
  return { background: "var(--glass-2)", edge: "var(--line-2)" };
}

/** Enter or Space on a focused row acts like a click. */
function onRowKey(run: () => void): (e: KeyboardEvent<HTMLElement>) => void {
  return (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      run();
    }
  };
}

/** Width of an element, kept current as it resizes. */
function useWidth(ref: RefObject<HTMLElement | null>, fallback: number): number {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

function DestinationMap({
  tiles,
  measure,
  animateKey,
  total,
  onSearch,
}: {
  tiles: Tile[];
  measure: Measure;
  animateKey: string;
  /** All observations or bytes in the selection, for each tile's share. */
  total: number;
  /** Runs the page search for a site; not offered on the "Other" tile. */
  onSearch: (site: string) => void;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref, 1100);
  useStaggerIn(ref, "[data-tile]", animateKey);
  return (
    <div
      ref={ref}
      className="site-map kit-tips"
      style={{ height: MAP_HEIGHT }}
      role="group"
      aria-label={`Map of the top destinations by ${measure === "bytes" ? "traffic bytes" : "observations"}`}
    >
      {tiles.map((t) => {
        const tone = tileTone(t.rank);
        const big = (t.h / 100) * MAP_HEIGHT > 110 && (t.w / 100) * width > 160;
        const other = t.name.startsWith("Other ");
        return (
          <div
            key={t.name}
            data-tile=""
            className="site-tile"
            aria-label={`${t.name}: ${formatMeasure(t.value, measure)}`}
            {...tipProps(() => ({
              title: t.name,
              sub: other ? undefined : `#${t.rank + 1}`,
              rows: [
                {
                  label: measure === "bytes" ? "Traffic" : "Observations",
                  value: formatMeasure(t.value, measure),
                  color: tone.edge,
                },
                ...(total > 0
                  ? [{ label: "Share", value: `${((t.value / total) * 100).toFixed(1)}%` }]
                  : []),
              ],
              action: other
                ? undefined
                : { label: "Search for this site", onClick: () => onSearch(t.name) },
            }))}
            style={{
              left: `${t.x}%`,
              top: `${t.y}%`,
              width: `calc(${t.w}% - 4px)`,
              height: `calc(${t.h}% - 4px)`,
              background: tone.background,
              boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${tone.edge} 45%, transparent)`,
            }}
          >
            <span className="site-tile-name" style={{ fontSize: big ? 14 : 12 }}>
              {t.name}
            </span>
            <span className="site-tile-value">{formatMeasure(t.value, measure)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** "12.6 GiB" as the board's KPI shows it: the number, then the unit in small type. */
function BytesValue({ value }: { value: number }): ReactNode {
  const unit = bytes(value).split(" ")[1];
  return (
    <>
      <Ticker value={value} format={(n) => bytes(n).split(" ")[0]} />
      <small>{unit}</small>
    </>
  );
}

export function SiteActivityView() {
  const [client, setClient] = useState("*");
  const [owner, setOwner] = useState("*");
  const [kind, setKind] = useState("*");
  const [search, setSearch] = useState("");
  const [windowMs, setWindowMs] = useState(WINDOWS[0].ms);
  const [page, setPage] = useState(0);
  const [measure, setMeasure] = useState<Measure>("observations");
  const [payload, setPayload] = useState<ActivityPayload | null>(null);
  // The query behind the payload on screen. It changes on a new filter or
  // page, not on the 15 s refresh, so rows animate only when the query does.
  const [loadedKey, setLoadedKey] = useState("");
  const [error, setError] = useState("");
  const [editingPolicy, setEditingPolicy] = useState(false);
  const [draftPolicy, setDraftPolicy] = useState<SitePolicy>({
    enabled: true,
    owners: [],
    until: null,
  });
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [policySearch, setPolicySearch] = useState("");
  const rowsRef = useRef<HTMLDivElement>(null);
  const [openAt, setOpenAt] = useState<{ q: string; i: number } | null>(null);

  async function savePolicy(next: SitePolicy) {
    setSavingPolicy(true);
    try {
      const response = await fetch(withToken("/api/site-activity/policy"), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!response.ok) throw new Error("Could not save the collection settings");
      const saved = (await response.json()) as SitePolicy;
      setPayload((current) => (current ? { ...current, policy: saved } : current));
      setEditingPolicy(false);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the collection settings");
    } finally {
      setSavingPolicy(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    const key = JSON.stringify([client, owner, kind, search, windowMs, page]);
    const load = async () => {
      const to = Date.now();
      const params = new URLSearchParams({
        from: String(to - windowMs),
        to: String(to),
        client: client === "*" ? "" : client,
        owner: owner === "*" ? "" : owner,
        kind: kind === "*" ? "" : kind,
        search,
        offset: String(page * PAGE_SIZE),
      });
      try {
        const result = await api<ActivityPayload>(
          `/api/site-activity?${params}`,
          controller.signal,
        );
        setPayload(result);
        setLoadedKey(key);
        setError("");
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Could not load activity");
      }
    };
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [client, owner, kind, search, windowMs, page]);

  useStaggerIn(rowsRef, ".site-row", loadedKey);
  // A new query shows other rows, so the open row's index no longer points at it.
  const openRow = openAt && openAt.q === loadedKey ? openAt.i : null;
  const setOpenRow = (i: number | null): void => setOpenAt(i == null ? null : { q: loadedKey, i });

  const visits = payload?.visits ?? [];
  const summary = payload?.summary;
  const owners = [
    ...new Set(
      (payload?.identities ?? [])
        .filter((id) => kind === "*" || id.kind === kind)
        .map((id) => id.owner),
    ),
  ].sort();
  const availableOwners = [...new Set((payload?.identities ?? []).map((id) => id.owner))].sort();
  const filteredOwners = availableOwners.filter((name) =>
    name.toLowerCase().includes(policySearch.trim().toLowerCase()),
  );
  const policy = payload?.policy;
  const active = !!policy?.enabled && (policy.until === null || (payload?.to ?? 0) < policy.until);
  const ended = !!policy?.enabled && !active;

  const topGroups = summary?.groups ?? [];
  // The biggest sites get their own tile. Every other site, including those
  // past the server's top 30, shares the "Other" tile, sized from the totals.
  const ranked = topGroups
    .map((g) => ({ name: g.label, value: g[measure] }))
    .filter((g) => g.value > 0)
    .sort((a, b) => b.value - a.value);
  const named = ranked.slice(0, MAP_TILES);
  const namedTotal = named.reduce((sum, g) => sum + g.value, 0);
  const otherValue = Math.max(
    0,
    (measure === "bytes" ? (summary?.bytes ?? 0) : (summary?.observations ?? 0)) - namedTotal,
  );
  const otherCount = Math.max(0, (summary?.destinations ?? 0) - named.length);
  const tiles = treemap(
    otherValue > 0 && otherCount > 0
      ? [...named, { name: `Other ${num(otherCount)}`, value: otherValue }]
      : named,
  );

  // The busiest site, and who on this page of rows reached it most.
  const busiest = topGroups[0]?.label;
  const busiestOwner = busiest
    ? visits
        .filter((v) => (v.domain ?? v.destination) === busiest && v.owner)
        .sort((a, b) => b.connections - a.connections)[0]?.owner
    : undefined;

  const windowLabel = WINDOWS.find((w) => w.ms === windowMs)?.label ?? "24 hours";
  const isDay = windowMs === WINDOWS[0].ms;
  const selection =
    owner !== "*"
      ? owner
      : client !== "*"
        ? client
        : kind !== "*"
          ? (kindLabel[kind] ?? kind)
          : "everyone";
  const filtered = search !== "" || kind !== "*" || owner !== "*" || client !== "*";
  const exportParams = new URLSearchParams({
    from: String((payload?.to ?? 0) - windowMs),
    to: String(payload?.to ?? 0),
    client: client === "*" ? "" : client,
    owner: owner === "*" ? "" : owner,
    kind: kind === "*" ? "" : kind,
    search,
  });
  const firstRow = page * PAGE_SIZE + 1;
  const lastRow = page * PAGE_SIZE + visits.length;

  const visitKey = (v: Visit, i: number): string => `${v.client}:${v.destination}:${v.domain}:${i}`;
  const visitDrawer = ((): ReactNode => {
    if (openRow == null) return null;
    const v = visits[openRow];
    if (!v) return null;
    const at = openRow;
    return (
      <RowDrawer
        open
        onClose={() => setOpenRow(null)}
        label={`Destination details: ${v.domain ?? v.destination}`}
        storageKey="site-activity"
        rowKey={visitKey(v, at)}
        title={v.domain ?? "Unidentified"}
        meta={`${v.owner || "Unidentified"} · ${v.client}`}
        chips={<span className="monitor-chip">{sourceLabel[v.source]}</span>}
        nav={{
          index: at,
          total: visits.length,
          onPrev: at > 0 ? () => setOpenRow(at - 1) : undefined,
          onNext: at < visits.length - 1 ? () => setOpenRow(at + 1) : undefined,
        }}
      >
        <DetailList
          items={[
            { label: "Site", value: v.domain ?? "Unidentified" },
            { label: "Destination IP", value: v.destination, mono: true },
            { label: "Source", value: sourceLabel[v.source] },
            { label: "Who", value: v.owner || "Unidentified" },
            { label: "Connection type", value: kindLabel[v.kind] ?? v.kind },
            ...(v.device ? [{ label: "Device", value: v.device }] : []),
            { label: "Client IP", value: v.client, mono: true },
            { label: "Seen", value: num(v.connections) },
            { label: "Traffic", value: v.bytes ? rowBytes(v.bytes) : "—" },
            { label: "First seen", value: new Date(v.firstSeen).toLocaleString() },
            { label: "Last seen", value: new Date(v.lastSeen).toLocaleString() },
          ]}
        />
      </RowDrawer>
    );
  })();

  function clearFilters() {
    setSearch("");
    setKind("*");
    setOwner("*");
    setClient("*");
    setPage(0);
  }

  if (!payload && !error) return <LoadingState label="Loading network activity" layout="chart" />;

  const headline = active
    ? policy?.owners.length
      ? `Collecting for ${policy.owners.length} ${policy.owners.length === 1 ? "person or device" : "people and devices"}`
      : "Collecting for every client"
    : ended
      ? "Collection window ended"
      : "Collection is paused";
  const subline = active
    ? "Records stay on this host for 30 days. Nothing is sent anywhere."
    : ended
      ? "Nothing new is recorded. Set a new end date or record until you turn it off."
      : "Nothing new is recorded. Existing records stay on this host for 30 days.";

  const devices = summary?.clients ?? 0;
  const sites = summary?.destinations ?? 0;

  const collect = policy && (
    <section className="glass site-collect" aria-label="Collection settings">
      <div className="flex flex-wrap items-center gap-2.5">
        <StatusBadge tone={active ? "good" : ended ? "warn" : "default"} dot>
          {active ? "Recording" : ended ? "Ended" : "Paused"}
        </StatusBadge>
        <span className="flex-1" />
        <MonitorButton
          size="sm"
          icon={<SlidersHorizontal aria-hidden="true" />}
          aria-expanded={editingPolicy}
          onClick={() => {
            setDraftPolicy(policy);
            setPolicySearch("");
            setEditingPolicy(!editingPolicy);
          }}
        >
          {editingPolicy ? "Close settings" : "Configure"}
        </MonitorButton>
        <MonitorButton
          size="sm"
          variant={active ? "ghost" : "glass"}
          icon={active ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          disabled={savingPolicy}
          onClick={() =>
            void savePolicy({
              ...policy,
              enabled: !active,
              until: active ? policy.until : null,
            })
          }
        >
          {active ? "Pause collection" : "Start collection"}
        </MonitorButton>
      </div>
      <div>
        <h2 className="site-collect-title">{headline}</h2>
        <p className="text-muted-foreground text-[12px] leading-[21px]">{subline}</p>
      </div>
      <dl className="monitor-facts">
        <dt>Audience</dt>
        <dd title={policy.owners.length ? policy.owners.join(", ") : undefined}>
          {policy.owners.length ? `${policy.owners.length} selected` : "Every client"}
        </dd>
        <dt>Schedule</dt>
        <dd>
          {policy.until
            ? `Until ${new Date(policy.until).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
            : "Until turned off"}
        </dd>
        <dt>Retention</dt>
        <dd>Local · 30 days</dd>
        <dt>Flow collector</dt>
        <dd>
          <span className="inline-flex items-center gap-1.5">
            <StatusDot tone={payload?.collection.flows.running ? "good" : "warn"} />
            {payload?.collection.flows.running ? "Online" : "Offline"}
          </span>
        </dd>
      </dl>
    </section>
  );

  return (
    <div className="site-activity flex flex-col gap-[18px] pb-12">
      <PageIntro
        eyebrow="Site Activity · DNS answers and flow records"
        verdict={
          <>
            {num(devices)} {devices === 1 ? "device" : "devices"} reached{" "}
            <span className="s">
              {num(sites)} {sites === 1 ? "site" : "sites"}
            </span>{" "}
            {isDay ? "today" : `in the last ${windowLabel}`}.
          </>
        }
        lead="Which sites each device reached, from DNS answers and flow records. This view stores destinations only, never page content."
        actions={
          <>
            <a
              className="monitor-btn"
              data-variant="glass"
              data-size="md"
              href={payload ? withToken(`/api/site-activity/export?${exportParams}`) : undefined}
              download
            >
              <Download aria-hidden="true" />
              Export CSV
            </a>
            {busiest && (
              <span className="text-muted-foreground text-[12px]">
                Busiest: <span className="font-mono">{busiest}</span>
                {busiestOwner && ` from ${busiestOwner}`}
              </span>
            )}
          </>
        }
        aside={collect || undefined}
      />

      {error && (
        <div role="alert" className="monitor-note text-destructive" data-tone="bad">
          <AlertTriangle aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {policy && editingPolicy && (
        <section className="monitor-panel site-editor" aria-label="Collection settings editor">
          <div>
            <h3 className="monitor-panel-title">Who to record, and for how long</h3>
            <p className="monitor-panel-desc">Changes apply when you save.</p>
          </div>
          <div className="site-editor-grid">
            <div className="site-editor-card">
              <div>
                <h3>People and devices</h3>
                <p>Record everyone, or only the names you pick.</p>
              </div>
              <button
                type="button"
                className="site-option"
                aria-pressed={!draftPolicy.owners.length}
                onClick={() => setDraftPolicy({ ...draftPolicy, owners: [] })}
              >
                <span>
                  <span className="block font-medium">All clients</span>
                  <span className="text-muted-foreground block text-[12px]">
                    Includes clients without a known name
                  </span>
                </span>
                <StatusDot tone={draftPolicy.owners.length ? "default" : "brand"} />
              </button>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">
                  Named clients{" "}
                  <span className="tabular-nums">
                    {draftPolicy.owners.length}/{availableOwners.length}
                  </span>
                </p>
                <MonitorSearch
                  className="w-full sm:w-48"
                  label="Find a client"
                  placeholder="Find a client"
                  value={policySearch}
                  onChange={setPolicySearch}
                />
              </div>
              <ScrollArea
                className="h-48"
                viewportProps={{ tabIndex: 0, "aria-label": "Named clients to record" }}
              >
                <div className="site-owner-list">
                  {filteredOwners.length ? (
                    filteredOwners.map((name, i) => {
                      const id = `site-owner-${i}`;
                      return (
                        <Checkbox
                          key={name}
                          id={id}
                          className="site-owner"
                          checked={draftPolicy.owners.includes(name)}
                          onCheckedChange={() =>
                            setDraftPolicy((current) => ({
                              ...current,
                              owners: current.owners.includes(name)
                                ? current.owners.filter((item) => item !== name)
                                : [...current.owners, name],
                            }))
                          }
                          label={<span title={name}>{name}</span>}
                        />
                      );
                    })
                  ) : (
                    <p className="col-span-full py-5 text-center">
                      {availableOwners.length ? "No client matches" : "No named clients yet"}
                    </p>
                  )}
                </div>
              </ScrollArea>
              <p>Pick names to record only those clients.</p>
            </div>
            <div className="site-editor-card">
              <div>
                <h3>Collection window</h3>
                <p>Choose when recording stops.</p>
              </div>
              <Segmented
                label="Collection window"
                value={draftPolicy.until === null ? "off" : "date"}
                options={[
                  { value: "off", label: "Until turned off" },
                  { value: "date", label: "End on a date" },
                ]}
                onChange={(v) =>
                  setDraftPolicy({
                    ...draftPolicy,
                    until: v === "off" ? null : (draftPolicy.until ?? Date.now() + 86_400_000),
                  })
                }
              />
              {draftPolicy.until !== null && (
                <DateTimePicker
                  label="Collection end date and time"
                  showTime
                  value={new Date(draftPolicy.until)}
                  onChange={(date) =>
                    setDraftPolicy({ ...draftPolicy, until: date?.getTime() ?? null })
                  }
                />
              )}
            </div>
          </div>
          <div className="site-editor-foot">
            <p className="max-w-xl">
              This controls what this host stores. The router keeps exporting, and the Flow
              collector keeps running.
            </p>
            <div className="flex gap-2">
              <MonitorButton size="sm" variant="ghost" onClick={() => setEditingPolicy(false)}>
                Cancel
              </MonitorButton>
              <MonitorButton
                size="sm"
                disabled={savingPolicy}
                onClick={() => void savePolicy(draftPolicy)}
              >
                {savingPolicy ? "Saving…" : "Save changes"}
              </MonitorButton>
            </div>
          </div>
        </section>
      )}

      <MetricStrip label="Activity metrics" minCell={180}>
        <Metric
          label="Observations"
          value={<Ticker value={summary?.observations ?? 0} format={num} />}
          hint={`Last ${windowLabel}`}
        />
        <Metric
          label="Destinations"
          value={<Ticker value={summary?.destinations ?? 0} format={num} />}
          hint="Unique sites"
        />
        <Metric
          label="Client IPs"
          value={<Ticker value={summary?.clients ?? 0} format={num} />}
          hint={isDay ? "Seen today" : `Seen in the last ${windowLabel}`}
        />
        <Metric
          label="Observed traffic"
          value={<BytesValue value={summary?.bytes ?? 0} />}
          hint="Flow records only"
        />
      </MetricStrip>

      <div className="site-toolbar" role="search" aria-label="Filter activity">
        <MonitorSearch
          className="site-search"
          label="Search site or destination IP"
          placeholder="Search site or destination IP"
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPage(0);
          }}
        />
        <MonitorSelect
          label="Connection type"
          value={kind}
          options={Object.entries(kindLabel).map(([value, label]) => ({ value, label }))}
          onChange={(v) => {
            setKind(v);
            setOwner("*");
            setPage(0);
          }}
        />
        <MonitorSelect
          label="Person or device"
          value={owner}
          options={[
            { value: "*", label: "All people & devices" },
            ...owners.map((name) => ({ value: name, label: name })),
          ]}
          onChange={(v) => {
            setOwner(v);
            setPage(0);
          }}
        />
        <MonitorSelect
          label="Client IP"
          value={client}
          options={[
            { value: "*", label: "All client IPs" },
            ...(payload?.clients ?? []).map((ip) => ({ value: ip, label: ip })),
          ]}
          onChange={(v) => {
            setClient(v);
            setPage(0);
          }}
        />
        <span className="site-period">
          <CalendarDays aria-hidden="true" />
          <MonitorSelect
            label="Report period"
            value={String(windowMs)}
            options={WINDOWS.map((w) => ({ value: String(w.ms), label: w.label }))}
            onChange={(v) => {
              setWindowMs(Number(v));
              setPage(0);
            }}
          />
        </span>
        {filtered && (
          <MonitorButton size="sm" variant="ghost" onClick={clearFilters}>
            Clear
          </MonitorButton>
        )}
      </div>

      <MonitorPanel
        title="Destination map"
        description={
          named.length
            ? `Area follows the chosen measure · top ${named.length} ${named.length === 1 ? "site" : "sites"} for ${selection}, last ${windowLabel}`
            : "Area follows the chosen measure"
        }
        extra={
          <Segmented label="Measure" value={measure} options={MEASURES} onChange={setMeasure} />
        }
      >
        {tiles.length ? (
          <DestinationMap
            tiles={tiles}
            measure={measure}
            animateKey={`${loadedKey}:${measure}`}
            total={measure === "bytes" ? (summary?.bytes ?? 0) : (summary?.observations ?? 0)}
            onSearch={(site) => {
              setSearch(site);
              setPage(0);
            }}
          />
        ) : (
          <MonitorEmpty icon={<Globe2 />} title="No observations for this selection">
            Try a longer period or clear the filters.
          </MonitorEmpty>
        )}
      </MonitorPanel>

      <MonitorPanel
        flush
        title="Destinations"
        description={
          visits.length ? `Newest first · ${num(firstRow)}–${num(lastRow)}` : "Newest first"
        }
      >
        {visits.length ? (
          <>
            <div className="monitor-thead site-grid site-thead" aria-hidden="true">
              <span>Destination</span>
              <span>Who</span>
              <span className="text-right">Seen</span>
              <span className="text-right">Traffic</span>
              <span className="text-right">Last</span>
              <span />
            </div>
            <ScrollArea
              viewportProps={{
                tabIndex: 0,
                "aria-label": "Destinations",
                className: "max-h-[560px]",
              }}
            >
              <div ref={rowsRef}>
                {visits.map((v, i) => (
                  <RowMenu
                    key={visitKey(v, i)}
                    title={v.domain ?? v.destination}
                    sub={`${v.owner || "Unidentified"} · ${v.client} · ${lastSeenLabel(v.lastSeen)}`}
                    onOpen={() => setOpenRow(i)}
                    cells={{
                      site: {
                        value: v.domain ?? "",
                        search: v.domain
                          ? () => {
                              setSearch(v.domain!);
                              setPage(0);
                            }
                          : undefined,
                      },
                      ip: {
                        value: v.destination,
                        kind: "ip",
                        search: () => {
                          setSearch(v.destination);
                          setPage(0);
                        },
                      },
                      who: v.owner
                        ? {
                            value: v.owner,
                            filter: () => {
                              setOwner(v.owner);
                              setPage(0);
                            },
                            clearFilter:
                              owner !== "*"
                                ? () => {
                                    setOwner("*");
                                    setPage(0);
                                  }
                                : undefined,
                          }
                        : { value: "" },
                      client: {
                        value: v.client,
                        kind: "ip",
                        filter: () => {
                          setClient(v.client);
                          setPage(0);
                        },
                        clearFilter:
                          client !== "*"
                            ? () => {
                                setClient("*");
                                setPage(0);
                              }
                            : undefined,
                      },
                      seen: { value: num(v.connections) },
                      traffic: { value: v.bytes ? rowBytes(v.bytes) : "" },
                      last: { value: new Date(v.lastSeen).toLocaleString(), kind: "time" },
                    }}
                    copies={[
                      ...(v.domain ? [{ label: "Site", value: v.domain }] : []),
                      { label: "Destination IP", value: v.destination },
                      { label: "Client IP", value: v.client },
                    ]}
                    row={v}
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      aria-label={`${v.domain ?? v.destination}, ${v.owner || "Unidentified"}, ${lastSeenLabel(v.lastSeen)}`}
                      className="monitor-row site-grid site-row"
                      data-selected={openRow === i || undefined}
                      onClick={() => setOpenRow(i)}
                      onKeyDown={onRowKey(() => setOpenRow(i))}
                    >
                      <span className="site-cell">
                        <span
                          data-col="site"
                          className="site-title"
                          title={v.domain ?? v.destination}
                        >
                          {v.domain ?? "Unidentified"}
                        </span>
                        <span className="site-sub">
                          <span data-col="ip" className="site-mono">
                            {v.destination}
                          </span>
                          <span className="monitor-chip">{sourceLabel[v.source]}</span>
                        </span>
                      </span>
                      <span className="site-cell site-who-cell">
                        <span
                          data-col="who"
                          className="site-who"
                          title={kindLabel[v.kind] ?? v.kind}
                        >
                          {v.owner || "Unidentified"}
                        </span>
                        <span data-col="client" className="site-mono">
                          {v.client}
                        </span>
                      </span>
                      <span data-col="seen" className="site-num">
                        <span className="sr-only">Seen </span>
                        {num(v.connections)}
                      </span>
                      <span data-col="traffic" className="site-num">
                        <span className="sr-only">Traffic </span>
                        {v.bytes ? rowBytes(v.bytes) : "—"}
                      </span>
                      <time
                        data-col="last"
                        className="site-num site-last"
                        dateTime={new Date(v.lastSeen).toISOString()}
                        title={new Date(v.lastSeen).toLocaleString()}
                      >
                        {lastSeenLabel(v.lastSeen)}
                      </time>
                      <RowMore />
                    </div>
                  </RowMenu>
                ))}
              </div>
            </ScrollArea>
          </>
        ) : (
          <MonitorEmpty icon={<Globe2 />} title="No matching destinations">
            Turn on Traffic Flow and DNS mirroring on the router. Web Proxy rows need web-proxy
            logging.
          </MonitorEmpty>
        )}
        <div className="monitor-foot">
          <span className="flex-1">Page {page + 1}</span>
          <MonitorButton
            size="sm"
            variant="ghost"
            icon={<ChevronLeft aria-hidden="true" />}
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </MonitorButton>
          <MonitorButton
            size="sm"
            icon={<ChevronRight aria-hidden="true" />}
            disabled={visits.length < PAGE_SIZE}
            onClick={() => setPage(page + 1)}
          >
            Next
          </MonitorButton>
        </div>
      </MonitorPanel>

      <p className="site-footnote">
        Clients on encrypted DNS, another VPN or hardware-offloaded paths may be missing. One IP can
        host several sites.
      </p>
      {visitDrawer}
    </div>
  );
}
