import { LoadingState } from "./loading-state";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Globe2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import { api, withToken } from "./api";
import { bytes, num } from "./format";
import {
  formatBytes,
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

/** The map is a 12-column grid of 44px rows, five rows tall, like the board. */
const MAP_COLS = 12;
const MAP_ROWS = 5;
/** A map cell is about twice as wide as it is tall. */
const CELL_ASPECT = 2;
/** At most this many named tiles; the rest of the top sites share one tile. */
const MAP_TILES = 9;
/** Tile tint by rank, strongest first. The shared "Other" tile uses 6%. */
const TINTS = [45, 35, 28, 22, 18, 16, 12, 12, 8];

type Tile = {
  name: string;
  value: number;
  tint: number;
  col: string;
  row: string;
};
type Rect = { x0: number; y0: number; x1: number; y1: number };

/**
 * Ordered treemap in horizontal bands, read like the board's grid: left to
 * right, top to bottom. Each band takes sites while that keeps its tiles
 * closer to square. Returns one rectangle per value inside `w` x `h`.
 */
function bands(values: number[], w: number, h: number): Rect[] {
  const total = values.reduce((sum, v) => sum + v, 0);
  if (!total) return [];
  const areas = values.map((v) => (v / total) * w * h);
  const worst = (band: number[]): number => {
    const sum = band.reduce((a, b) => a + b, 0);
    return Math.max(
      (w * w * Math.max(...band)) / (sum * sum),
      (sum * sum) / (w * w * Math.min(...band)),
    );
  };
  const rects: Rect[] = [];
  let y = 0;
  let i = 0;
  while (i < areas.length) {
    const band = [areas[i]];
    let j = i + 1;
    while (j < areas.length && worst([...band, areas[j]]) <= worst(band)) {
      band.push(areas[j]);
      j++;
    }
    const sum = band.reduce((a, b) => a + b, 0);
    const bottom = j >= areas.length ? h : y + sum / w;
    let x = 0;
    band.forEach((area, k) => {
      const right = k === band.length - 1 ? w : x + (area / sum) * w;
      rects.push({ x0: x, y0: y, x1: right, y1: bottom });
      x = right;
    });
    y = bottom;
    i = j;
  }
  return rects;
}

/**
 * Lays the top sites out on the map grid. Each tile snaps to whole cells; when
 * a site is too small for a cell it joins the "Other" tile.
 */
function mapTiles(groups: { name: string; value: number }[]): Tile[] {
  for (let named = Math.min(MAP_TILES, groups.length); named >= 0; named--) {
    const rest = groups.slice(named);
    const items = groups.slice(0, named).map((g, i) => ({ ...g, tint: TINTS[i] }));
    const restValue = rest.reduce((sum, g) => sum + g.value, 0);
    if (rest.length && restValue > 0)
      items.push({ name: `Other ${num(rest.length)}`, value: restValue, tint: 6 });
    const rects = bands(
      items.map((t) => t.value),
      MAP_COLS * CELL_ASPECT,
      MAP_ROWS,
    );
    const tiles = items.map((t, i) => {
      const r = rects[i];
      const c0 = Math.round(r.x0 / CELL_ASPECT);
      const c1 = Math.round(r.x1 / CELL_ASPECT);
      const r0 = Math.round(r.y0);
      const r1 = Math.round(r.y1);
      return {
        ...t,
        ok: c1 > c0 && r1 > r0,
        col: `${c0 + 1} / ${c1 + 1}`,
        row: `${r0 + 1} / ${r1 + 1}`,
      };
    });
    if (tiles.every((t) => t.ok)) return tiles.map(({ ok: _ok, ...t }) => t);
  }
  return [];
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
  const mapRef = useRef<HTMLDivElement>(null);

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
  useStaggerIn(mapRef, "[data-tile]", `${loadedKey}:${measure}`);

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
  // The server sends the top 30 sites. The biggest get their own tile; the
  // rest of those 30 share the "Other" tile.
  const tiles = mapTiles(
    topGroups.map((g) => ({ name: g.label, value: g[measure] })).filter((g) => g.value > 0),
  );

  const windowLabel = WINDOWS.find((w) => w.ms === windowMs)?.label ?? "24 hours";
  const selection =
    owner !== "*"
      ? owner
      : client !== "*"
        ? client
        : kind !== "*"
          ? (kindLabel[kind] ?? kind)
          : "all clients";
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

  return (
    <div className="flex flex-col gap-6 pb-12">
      <PageIntro>Which sites each device reached, from DNS answers and flow records.</PageIntro>

      {error && (
        <div role="alert" className="monitor-note text-destructive" data-tone="bad">
          <AlertTriangle aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {policy && (
        <section className="monitor-panel site-collect" aria-label="Collection settings">
          <div className="monitor-panel-head">
            <StatusBadge tone={active ? "good" : ended ? "warn" : "default"}>
              {active ? "Recording" : ended ? "Ended" : "Paused"}
            </StatusBadge>
            <div className="site-collect-copy">
              <h2 className="monitor-panel-title">{headline}</h2>
              <p className="monitor-panel-desc">{subline}</p>
            </div>
            <MonitorButton
              size="sm"
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
          <div className="site-facts">
            <div className="site-fact">
              <span className="site-fact-label">Audience</span>
              <span
                className="site-fact-value"
                title={policy.owners.length ? policy.owners.join(", ") : undefined}
              >
                {policy.owners.length ? `${policy.owners.length} selected` : "Every client"}
              </span>
            </div>
            <div className="site-fact">
              <span className="site-fact-label">Schedule</span>
              <span className="site-fact-value">
                {policy.until
                  ? `Until ${new Date(policy.until).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
                  : "Until turned off"}
              </span>
            </div>
            <div className="site-fact">
              <span className="site-fact-label">Retention</span>
              <span className="site-fact-value">Local · 30 days</span>
            </div>
            <div className="site-fact">
              <span className="site-fact-label">Flow collector</span>
              <span className="site-fact-value">
                <StatusDot tone={payload?.collection.flows.running ? "good" : "warn"} />
                {payload?.collection.flows.running ? "Online" : "Offline"}
              </span>
            </div>
          </div>

          {editingPolicy && (
            <div className="site-editor">
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
                      <span className="block font-[510]">All clients</span>
                      <span className="block text-[12px] text-muted-foreground">
                        Includes clients without a known name
                      </span>
                    </span>
                    <StatusDot tone={draftPolicy.owners.length ? "default" : "brand"} />
                  </button>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-[510]">
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
                            <div key={name} className="site-owner">
                              <Checkbox
                                id={id}
                                checked={draftPolicy.owners.includes(name)}
                                onCheckedChange={() =>
                                  setDraftPolicy((current) => ({
                                    ...current,
                                    owners: current.owners.includes(name)
                                      ? current.owners.filter((item) => item !== name)
                                      : [...current.owners, name],
                                  }))
                                }
                              />
                              <label htmlFor={id} title={name}>
                                {name}
                              </label>
                            </div>
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
                      aria-label="Collection end date and time"
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
            </div>
          )}
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
          hint={windowMs === WINDOWS[0].ms ? "Seen today" : `Seen in the last ${windowLabel}`}
        />
        <Metric
          label="Observed traffic"
          value={<Ticker value={summary?.bytes ?? 0} format={formatBytes} />}
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
        <MonitorSelect
          label="Report period"
          value={String(windowMs)}
          options={WINDOWS.map((w) => ({ value: String(w.ms), label: w.label }))}
          onChange={(v) => {
            setWindowMs(Number(v));
            setPage(0);
          }}
        />
        {filtered && (
          <MonitorButton size="sm" variant="ghost" onClick={clearFilters}>
            Clear
          </MonitorButton>
        )}
        <a
          className="monitor-btn"
          data-variant="glass"
          data-size="sm"
          href={payload ? withToken(`/api/site-activity/export?${exportParams}`) : undefined}
          download
        >
          Export CSV
        </a>
      </div>

      <MonitorPanel
        title="Destination map"
        description={
          topGroups.length
            ? `Area follows the chosen measure · top ${topGroups.length} sites for ${selection}`
            : "Area follows the chosen measure"
        }
        extra={
          <Segmented label="Measure" value={measure} options={MEASURES} onChange={setMeasure} />
        }
      >
        {tiles.length ? (
          <div
            ref={mapRef}
            className="site-map"
            role="img"
            aria-label={`Map of the top destinations by ${measure === "bytes" ? "traffic bytes" : "observations"}`}
          >
            {tiles.map((t) => (
              <div
                key={t.name}
                data-tile=""
                className="site-tile"
                title={`${t.name}: ${formatMeasure(t.value, measure)}`}
                style={{
                  gridColumn: t.col,
                  gridRow: t.row,
                  background: `color-mix(in srgb, var(--chart-1) ${t.tint}%, transparent)`,
                }}
              >
                <span className="site-tile-name">{t.name}</span>
                <span className="site-tile-value">{formatMeasure(t.value, measure)}</span>
              </div>
            ))}
          </div>
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
            </div>
            <ScrollArea
              viewportProps={{
                tabIndex: 0,
                "aria-label": "Destinations",
                className: "max-h-[560px]",
              }}
            >
              <div ref={rowsRef} role="list">
                {visits.map((v, i) => (
                  <div
                    key={`${v.client}:${v.destination}:${v.domain}:${i}`}
                    role="listitem"
                    className="monitor-row site-grid site-row"
                  >
                    <span className="site-cell">
                      <span className="site-title" title={v.domain ?? v.destination}>
                        {v.domain ?? "Unidentified"}
                      </span>
                      <span className="site-sub">
                        <span className="site-mono">{v.destination}</span>
                        <span className="monitor-badge site-src">{sourceLabel[v.source]}</span>
                      </span>
                    </span>
                    <span className="site-cell">
                      <span className="site-who" title={kindLabel[v.kind] ?? v.kind}>
                        {v.owner || "Unidentified"}
                      </span>
                      <span className="site-mono">{v.client}</span>
                    </span>
                    <span className="site-num">
                      <span className="sr-only">Seen </span>
                      {num(v.connections)}
                    </span>
                    <span className="site-num">
                      <span className="sr-only">Traffic </span>
                      {v.bytes ? rowBytes(v.bytes) : "—"}
                    </span>
                    <time
                      className="site-num site-last"
                      dateTime={new Date(v.lastSeen).toISOString()}
                      title={new Date(v.lastSeen).toLocaleString()}
                    >
                      {lastSeenLabel(v.lastSeen)}
                    </time>
                  </div>
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
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </MonitorButton>
          <MonitorButton
            size="sm"
            disabled={visits.length < PAGE_SIZE}
            onClick={() => setPage(page + 1)}
          >
            Next
          </MonitorButton>
        </div>
      </MonitorPanel>

      <p className="site-footnote">
        {payload?.note ?? "This view stores destinations only. It does not capture page content."}{" "}
        Clients on encrypted DNS, another VPN or hardware-offloaded paths may be missing. One IP can
        host several sites.
      </p>
    </div>
  );
}
