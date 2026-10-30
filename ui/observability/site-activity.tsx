import { useEffect, useState } from "react";
import {
  Activity,
  CalendarClock,
  Check,
  Download,
  Globe2,
  Infinity as InfinityIcon,
  Network,
  Search,
  Settings2,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { Tooltip, Treemap } from "recharts";
import type { TreemapNode } from "recharts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import { api, withToken } from "./api";
import { cn } from "@/lib/utils";

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
const WINDOWS = [
  { label: "24 hours", ms: 86_400_000 },
  { label: "7 days", ms: 7 * 86_400_000 },
  { label: "30 days", ms: 30 * 86_400_000 },
];
const sourceLabel: Record<Visit["source"], string> = {
  "dns+flow": "DNS + traffic",
  flow: "IP only",
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
const palette = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];
const formatTreeValue = (value: number, metric: "observations" | "bytes") =>
  metric === "bytes"
    ? `${(value / 1_048_576).toFixed(1)} MiB`
    : `${value.toLocaleString()} observations`;
function SiteTile({
  x,
  y,
  width,
  height,
  name,
  value,
  index,
  depth,
  total,
  metric,
}: TreemapNode & { total: number; metric: "observations" | "bytes" }) {
  if (depth === 0) return <g />;
  const label = String(name ?? "");
  return (
    <g>
      <rect
        x={x + 2}
        y={y + 2}
        width={Math.max(0, width - 4)}
        height={Math.max(0, height - 4)}
        rx={9}
        fill={palette[index % palette.length]}
        opacity={0.92}
      />
      {width > 85 && height > 38 && (
        <>
          <text x={x + 12} y={y + 23} fill="white" fontSize={12} fontWeight={650}>
            {label.length > Math.floor(width / 8)
              ? `${label.slice(0, Math.max(4, Math.floor(width / 8) - 1))}…`
              : label}
          </text>
          {height > 62 && (
            <text x={x + 12} y={y + 43} fill="white" fontSize={11} opacity={0.85}>
              {formatTreeValue(Number(value), metric)} ·{" "}
              {total ? Math.round((Number(value) / total) * 100) : 0}%
            </text>
          )}
        </>
      )}
    </g>
  );
}

export function SiteActivityView() {
  const [client, setClient] = useState("*");
  const [owner, setOwner] = useState("*");
  const [kind, setKind] = useState("*");
  const [search, setSearch] = useState("");
  const [windowMs, setWindowMs] = useState(WINDOWS[0].ms);
  const [page, setPage] = useState(0);
  const [metric, setMetric] = useState<"observations" | "bytes">("observations");
  const [payload, setPayload] = useState<ActivityPayload | null>(null);
  const [error, setError] = useState("");
  const [editingPolicy, setEditingPolicy] = useState(false);
  const [draftPolicy, setDraftPolicy] = useState<SitePolicy>({
    enabled: true,
    owners: [],
    until: null,
  });
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [policySearch, setPolicySearch] = useState("");
  async function savePolicy(next: SitePolicy) {
    setSavingPolicy(true);
    try {
      const response = await fetch(withToken("/api/site-activity/policy"), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!response.ok) throw new Error("Could not save Site Activity settings");
      const saved = (await response.json()) as SitePolicy;
      setPayload((current) => (current ? { ...current, policy: saved } : current));
      setEditingPolicy(false);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save settings");
    } finally {
      setSavingPolicy(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      const to = Date.now();
      const params = new URLSearchParams({
        from: String(to - windowMs),
        to: String(to),
        client: client === "*" ? "" : client,
        owner: owner === "*" ? "" : owner,
        kind: kind === "*" ? "" : kind,
        search,
        offset: String(page * 100),
      });
      try {
        const result = await api<ActivityPayload>(
          `/api/site-activity?${params}`,
          controller.signal,
        );
        setPayload(result);
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
  const groups = (summary?.groups ?? [])
    .map((g) => ({ name: g.label, value: g[metric] }))
    .filter((g) => g.value > 0);
  const total = metric === "bytes" ? (summary?.bytes ?? 0) : (summary?.observations ?? 0);
  const exportParams = new URLSearchParams({
    from: String((payload?.to ?? 0) - windowMs),
    to: String(payload?.to ?? 0),
    client: client === "*" ? "" : client,
    owner: owner === "*" ? "" : owner,
    kind: kind === "*" ? "" : kind,
    search,
  });
  return (
    <div className="space-y-6 pb-12">
      <div className="rounded-3xl border border-border bg-gradient-to-br from-card via-card to-blue-500/10 p-6 md:p-8">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.2em] text-blue-400">
          <Globe2 size={15} /> Network / site activity
        </div>
        <div className="mt-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
              Where the network goes.
            </h2>
            <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
              Per-client destinations from observed traffic, DNS replies and Web Proxy connections.
              Stored on this MCP host for 30 days.
            </p>
          </div>
          <span
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs",
              payload?.collection.flows.running
                ? "border-emerald-500/30 text-emerald-400"
                : "border-amber-500/30 text-amber-400",
            )}
          >
            {payload?.collection.flows.running ? "Flow collector online" : "Flow collector offline"}
          </span>
        </div>
      </div>
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400"
        >
          {error}
        </div>
      )}
      {policy && (
        <section
          className="overflow-hidden rounded-3xl border border-blue-400/20 bg-card shadow-[0_18px_50px_-36px_rgba(59,130,246,0.6)]"
          aria-label="Site Activity collection settings"
        >
          <div className="flex flex-col gap-6 border-b border-border/70 bg-gradient-to-r from-blue-500/[0.12] via-card to-card px-5 py-6 md:flex-row md:items-center md:justify-between md:px-7">
            <div className="flex items-start gap-4">
              <div
                className={cn(
                  "grid size-12 shrink-0 place-items-center rounded-2xl border",
                  active
                    ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-400"
                    : "border-border bg-background text-muted-foreground",
                )}
              >
                <Activity size={22} />
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-blue-400">
                  Collection control
                </p>
                <h3 className="mt-1 text-xl font-semibold tracking-tight">
                  {active
                    ? "Site Activity is live"
                    : policy.enabled
                      ? "Collection window ended"
                      : "Collection is paused"}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Choose whose destinations are recorded on this MCP host.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 md:justify-end">
              <span
                className={cn(
                  "mr-1 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium",
                  active
                    ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-400"
                    : "border-border bg-background text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    active ? "bg-emerald-400" : "bg-muted-foreground",
                  )}
                />
                {active ? "Recording" : "Not recording"}
              </span>
              <button
                type="button"
                aria-expanded={editingPolicy}
                onClick={() => {
                  setDraftPolicy(policy);
                  setPolicySearch("");
                  setEditingPolicy(!editingPolicy);
                }}
                className="inline-flex items-center gap-2 rounded-xl border border-border bg-background/70 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-blue-400"
              >
                <Settings2 size={15} />
                {editingPolicy ? "Close settings" : "Configure"}
              </button>
              <button
                type="button"
                disabled={savingPolicy}
                onClick={() =>
                  void savePolicy({
                    ...policy,
                    enabled: !active,
                    until: active ? policy.until : null,
                  })
                }
                className={cn(
                  "rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-blue-400 disabled:opacity-50",
                  active
                    ? "border border-border bg-background/70 hover:bg-accent"
                    : "bg-blue-400 text-slate-950 hover:bg-blue-300",
                )}
              >
                {active ? "Pause collection" : "Start collection"}
              </button>
            </div>
          </div>
          <div className="grid divide-y divide-border/70 md:grid-cols-3 md:divide-x md:divide-y-0">
            <div className="flex items-center gap-3 px-5 py-4 md:px-7">
              <UsersRound size={17} className="shrink-0 text-blue-400" />
              <div>
                <p className="text-[11px] text-muted-foreground">Audience</p>
                <p className="mt-0.5 text-sm font-medium">
                  {policy.owners.length
                    ? `${policy.owners.length} selected identities`
                    : "Every client"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3 px-5 py-4 md:px-7">
              <CalendarClock size={17} className="shrink-0 text-blue-400" />
              <div>
                <p className="text-[11px] text-muted-foreground">Schedule</p>
                <p className="mt-0.5 text-sm font-medium">
                  {policy.until ? new Date(policy.until).toLocaleString() : "Until turned off"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3 px-5 py-4 md:px-7">
              <ShieldCheck size={17} className="shrink-0 text-blue-400" />
              <div>
                <p className="text-[11px] text-muted-foreground">Retention</p>
                <p className="mt-0.5 text-sm font-medium">Local · 30 days</p>
              </div>
            </div>
          </div>
          {editingPolicy && (
            <div className="border-t border-border bg-background/40 p-5 md:p-7">
              <div className="mb-5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-blue-400">
                  Define collection
                </p>
                <h4 className="mt-1 text-lg font-semibold">Who to watch, and for how long</h4>
              </div>
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,1fr)]">
                <div className="min-w-0 rounded-2xl border border-border bg-card p-4 md:p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h5 className="font-semibold">People & devices</h5>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Select everyone or named clients.
                      </p>
                    </div>
                    <UsersRound size={18} className="text-blue-400" />
                  </div>
                  <button
                    type="button"
                    aria-pressed={!draftPolicy.owners.length}
                    onClick={() => setDraftPolicy({ ...draftPolicy, owners: [] })}
                    className={cn(
                      "mt-4 flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-blue-400",
                      !draftPolicy.owners.length
                        ? "border-blue-400/60 bg-blue-400/10"
                        : "border-border hover:bg-accent",
                    )}
                  >
                    <span>
                      <span className="block font-medium">All clients</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        Includes clients without a known name
                      </span>
                    </span>
                    {!draftPolicy.owners.length && <Check size={18} className="text-blue-400" />}
                  </button>
                  <div className="mt-4 flex items-center justify-between gap-3">
                    <p className="text-xs font-medium text-muted-foreground">
                      Named clients{" "}
                      <span className="ml-1 tabular-nums">
                        {draftPolicy.owners.length}/{availableOwners.length}
                      </span>
                    </p>
                    <div className="relative max-w-48 flex-1">
                      <Search
                        size={14}
                        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                      />
                      <input
                        aria-label="Find a client for collection"
                        value={policySearch}
                        onChange={(e) => setPolicySearch(e.target.value)}
                        placeholder="Find a client"
                        className="w-full rounded-lg border border-border bg-background py-1.5 pl-8 pr-2 text-xs outline-none focus:border-blue-400"
                      />
                    </div>
                  </div>
                  <ScrollArea
                    className="mt-2 h-48"
                    viewportProps={{ tabIndex: 0, "aria-label": "Named clients for collection" }}
                  >
                    <div className="grid gap-1 pr-3 sm:grid-cols-2">
                      {filteredOwners.length ? (
                        filteredOwners.map((name) => (
                          <button
                            key={name}
                            type="button"
                            aria-pressed={draftPolicy.owners.includes(name)}
                            onClick={() =>
                              setDraftPolicy((current) => ({
                                ...current,
                                owners: current.owners.includes(name)
                                  ? current.owners.filter((item) => item !== name)
                                  : [...current.owners, name],
                              }))
                            }
                            className={cn(
                              "flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-blue-400",
                              draftPolicy.owners.includes(name)
                                ? "border-blue-400/40 bg-blue-400/10"
                                : "border-transparent hover:border-border hover:bg-accent",
                            )}
                          >
                            <span
                              className={cn(
                                "grid size-4 shrink-0 place-items-center rounded border",
                                draftPolicy.owners.includes(name)
                                  ? "border-blue-400 bg-blue-400 text-slate-950"
                                  : "border-muted-foreground/50",
                              )}
                            >
                              {draftPolicy.owners.includes(name) && <Check size={12} />}
                            </span>
                            <span className="truncate">{name}</span>
                          </button>
                        ))
                      ) : (
                        <p className="col-span-full py-5 text-center text-xs text-muted-foreground">
                          {availableOwners.length
                            ? "No matching clients"
                            : "No named clients found yet"}
                        </p>
                      )}
                    </div>
                  </ScrollArea>
                  <p className="mt-3 text-xs text-muted-foreground">
                    Selecting names records only those recognized identities.
                  </p>
                </div>
                <div className="rounded-2xl border border-border bg-card p-4 md:p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h5 className="font-semibold">Collection window</h5>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Choose when recording stops.
                      </p>
                    </div>
                    <CalendarClock size={18} className="text-blue-400" />
                  </div>
                  <div className="mt-4 grid gap-2">
                    <button
                      type="button"
                      aria-pressed={draftPolicy.until === null}
                      onClick={() => setDraftPolicy({ ...draftPolicy, until: null })}
                      className={cn(
                        "flex items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-blue-400",
                        draftPolicy.until === null
                          ? "border-blue-400/60 bg-blue-400/10"
                          : "border-border hover:bg-accent",
                      )}
                    >
                      <InfinityIcon size={17} className="text-blue-400" />
                      <span className="flex-1 font-medium">Until turned off</span>
                      {draftPolicy.until === null && <Check size={17} className="text-blue-400" />}
                    </button>
                    <button
                      type="button"
                      aria-pressed={draftPolicy.until !== null}
                      onClick={() =>
                        setDraftPolicy({
                          ...draftPolicy,
                          until: draftPolicy.until ?? Date.now() + 86_400_000,
                        })
                      }
                      className={cn(
                        "flex items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-blue-400",
                        draftPolicy.until !== null
                          ? "border-blue-400/60 bg-blue-400/10"
                          : "border-border hover:bg-accent",
                      )}
                    >
                      <CalendarClock size={17} className="text-blue-400" />
                      <span className="flex-1 font-medium">End on a date</span>
                      {draftPolicy.until !== null && <Check size={17} className="text-blue-400" />}
                    </button>
                  </div>
                  {draftPolicy.until !== null && (
                    <div className="mt-4">
                      <DateTimePicker
                        aria-label="Collection end date and time"
                        value={new Date(draftPolicy.until)}
                        onChange={(date) =>
                          setDraftPolicy({ ...draftPolicy, until: date?.getTime() ?? null })
                        }
                      />
                    </div>
                  )}
                </div>
              </div>
              <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
                <p className="max-w-xl text-xs text-muted-foreground">
                  These settings control storage on this host. Router exports and the separate Flow
                  collector continue.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingPolicy(false)}
                    className="rounded-xl px-4 py-2.5 text-sm hover:bg-accent"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={savingPolicy}
                    onClick={() => void savePolicy(draftPolicy)}
                    className="rounded-xl bg-blue-400 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-blue-300 disabled:opacity-50"
                  >
                    {savingPolicy ? "Saving…" : "Save changes"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      )}
      <div className="grid gap-3 md:grid-cols-4">
        {[
          { label: "Observations", value: summary?.observations ?? 0, Icon: Activity },
          { label: "Destinations", value: summary?.destinations ?? 0, Icon: Globe2 },
          { label: "Client IPs", value: summary?.clients ?? 0, Icon: Network },
          {
            label: "Observed MiB",
            value: ((summary?.bytes ?? 0) / 1_048_576).toFixed(1),
            Icon: ShieldCheck,
          },
        ].map(({ label, value, Icon }) => (
          <div key={label} className="rounded-2xl border border-border bg-card p-5">
            <Icon size={18} className="text-blue-400" />
            <div className="mt-4 text-2xl font-semibold tabular-nums">{value}</div>
            <div className="text-xs text-muted-foreground">{label} in selected range</div>
          </div>
        ))}
      </div>
      <div className="grid gap-3 rounded-2xl border border-border bg-card p-4 md:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))]">
        <label className="relative min-w-56 flex-1">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <span className="sr-only">Search domain or destination IP</span>
          <input
            className="w-full rounded-xl border border-border bg-background py-2 pl-9 pr-3 text-sm outline-none focus:border-blue-400"
            placeholder="Search site or destination IP"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <Select
          value={kind}
          onValueChange={(v) => {
            setKind(v);
            setOwner("*");
            setPage(0);
          }}
        >
          <SelectTrigger aria-label="Connection type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(kindLabel).map(([key, label]) => (
              <SelectItem key={key} value={key}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={owner}
          onValueChange={(v) => {
            setOwner(v);
            setPage(0);
          }}
        >
          <SelectTrigger aria-label="Person or device">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="*">All people & devices</SelectItem>
            {owners.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={client}
          onValueChange={(v) => {
            setClient(v);
            setPage(0);
          }}
        >
          <SelectTrigger aria-label="Client IP">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="*">All client IPs</SelectItem>
            {payload?.clients.map((ip) => (
              <SelectItem key={ip} value={ip}>
                {ip}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={String(windowMs)}
          onValueChange={(v) => {
            setWindowMs(Number(v));
            setPage(0);
          }}
        >
          <SelectTrigger aria-label="Report period">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WINDOWS.map((w) => (
              <SelectItem key={w.ms} value={String(w.ms)}>
                {w.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex justify-end">
        <a
          href={payload ? withToken(`/api/site-activity/export?${exportParams}`) : undefined}
          download
          className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2 text-sm hover:bg-accent"
        >
          <Download size={15} /> Export filtered CSV
        </a>
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,4fr)_minmax(0,6fr)]">
        <section className="min-w-0 rounded-2xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold">Destination map</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Area reflects the selected metric · top 30 destinations
              </p>
            </div>
            <Select value={metric} onValueChange={(v) => setMetric(v as typeof metric)}>
              <SelectTrigger aria-label="Treemap metric" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="observations">Observations</SelectItem>
                <SelectItem value="bytes">Traffic bytes</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {groups.length ? (
            <div
              className="mt-5 h-[440px] w-full"
              role="img"
              aria-label="Treemap of observed destinations"
            >
              <Treemap
                style={{ width: "100%", height: "100%" }}
                data={groups}
                dataKey="value"
                nameKey="name"
                aspectRatio={2.5}
                content={(node) => <SiteTile {...node} total={total} metric={metric} />}
                isAnimationActive={false}
              >
                <Tooltip
                  content={({ active, payload }) =>
                    active && payload?.length ? (
                      <div className="rounded-lg border border-border bg-card p-3 text-xs shadow-xl">
                        <strong>{String(payload[0].name)}</strong>
                        <div className="mt-1">
                          {formatTreeValue(Number(payload[0].value), metric)} ·{" "}
                          {total ? Math.round((Number(payload[0].value) / total) * 100) : 0}%
                        </div>
                      </div>
                    ) : null
                  }
                />
              </Treemap>
            </div>
          ) : (
            <div className="grid h-[440px] place-items-center text-sm text-muted-foreground">
              No observations for this selection
            </div>
          )}
        </section>
        <div className="overflow-hidden rounded-2xl border border-border bg-card">
          <div className="border-b border-border px-5 py-4">
            <h3 className="text-sm font-semibold">Observed destinations</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Identity is matched near the observation time.
            </p>
          </div>
          {visits.length ? (
            <ScrollArea
              className="h-[540px]"
              viewportProps={{ tabIndex: 0, "aria-label": "Observed destinations" }}
            >
              <div className="divide-y divide-border">
                {visits.map((v, i) => (
                  <article
                    key={`${v.client}:${v.destination}:${v.domain}:${i}`}
                    className="grid gap-2 px-5 py-3 md:grid-cols-[minmax(0,1fr)_auto]"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">{v.domain ?? v.destination}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {v.domain && v.destination ? `${v.destination} · ` : ""}
                        {sourceLabel[v.source]}
                      </div>
                    </div>
                    <div className="text-xs md:text-right">
                      <div className="font-medium">
                        {v.owner || "Unidentified"}{" "}
                        <span className="text-muted-foreground">
                          · {kindLabel[v.kind] ?? v.kind}
                        </span>
                      </div>
                      <div className="mt-1 font-mono text-muted-foreground">{v.client}</div>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {v.connections.toLocaleString()} observations
                      {v.bytes ? ` · ${(v.bytes / 1_048_576).toFixed(1)} MiB` : ""}
                    </div>
                    <time
                      className="text-xs text-muted-foreground md:text-right"
                      dateTime={new Date(v.lastSeen).toISOString()}
                    >
                      {new Date(v.lastSeen).toLocaleString()}
                    </time>
                  </article>
                ))}
              </div>
            </ScrollArea>
          ) : (
            <div className="px-5 py-14 text-center text-sm text-muted-foreground">
              No matching observations yet. Traffic Flow and DNS mirroring must be enabled on the
              router; Web Proxy needs web-proxy logging.
            </div>
          )}
          <div className="flex items-center justify-between border-t border-border px-5 py-3">
            <button
              className="text-sm disabled:opacity-40"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </button>
            <span className="text-xs text-muted-foreground">Page {page + 1}</span>
            <button
              className="text-sm disabled:opacity-40"
              disabled={visits.length < 100}
              onClick={() => setPage(page + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        {payload?.note ?? "This view stores destinations only; it does not capture page content."}{" "}
        Clients using encrypted DNS, another VPN or hardware-offloaded paths may be missing. An IP
        can host several sites.
      </p>
    </div>
  );
}
