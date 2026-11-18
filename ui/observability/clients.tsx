/**
 * Clients view: the LAN devices connected to a router (not the routers
 * themselves, which live on the Devices page). Laid out after the Usr-Clients,
 * Usr-Clients-Detail and Usr-Clients-Phone boards.
 *
 * Talks to the dashboard's `/api/clients*` routes, which call the very same
 * RouterOS operations the connected-device MCP tools wrap, so a block/allow/
 * pin from this page and from chat run identical commands. Traffic rates cover
 * EVERY LAN client with no per-device queue: the server reads `/ip accounting`
 * on RouterOS v6, or Kid Control on v7 (where accounting was removed), and
 * normalises both to per-host rates, pushed every second. Rate limits still
 * come from `/queue simple`. Mutations return a refreshed device `view` so the
 * table updates without a second request.
 */
import "./clients.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Lock,
  MoreHorizontal,
  Pin,
  RefreshCw,
  Search,
  Wifi,
} from "lucide-react";
import { api, postJson, withToken } from "./api";
import { LoadingState } from "./loading-state";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorDialog,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  MonitorSearch,
  PageIntro,
  RouterPicker,
  Segmented,
  StatusBadge,
  StatusDot,
  Ticker,
} from "./monitoring-ui";
import { toast } from "./toast-action";
import type { DevicesPayload } from "./types";
import { LineChart, RowSpark, TalkerBars } from "./clients-charts";
import type { TalkerBar } from "./clients-charts";
import { applyTrafficSample, EMPTY_TRAFFIC, trafficX } from "./clients-traffic";
import type { BulkTraffic, IpTraffic, TrafficPoint } from "./clients-traffic";
import type { BulkTrafficPayload } from "../../src/tools/connected-devices";

interface Device {
  mac: string;
  ip: string;
  host: string;
  iface: string;
  server: string;
  status: string;
  static: boolean;
  blocked: boolean;
  lastSeen: string;
  comment: string;
}
interface DevicesView {
  __mikrotikView: "connected-devices";
  devices: Device[];
  counts: { total: number; blocked: number; static: number };
  generatedAt: string;
}
type BulkTrafficSample = BulkTrafficPayload;
interface OpResult {
  ok: boolean;
  message: string;
  view?: DevicesView;
}
interface DailyUsage {
  day: string;
  rx: number;
  tx: number;
}
interface UsagePayload {
  series: DailyUsage[];
  totalRx: number;
  totalTx: number;
}
type Show = "all" | "static" | "blocked";

const BULK_POLL_MS = 1000;
const ROWS = 10;
const PHONE_ROWS = 7;
const USAGE_DAYS = 90;
const DAY_MS = 86_400_000;
const PHONE = "(max-width: 639px)";

/** Rates as the boards write them: 31.4 Mbps, 0.4 Mbps, 96 kbps, 0 bps. */
const rate = (bits: number | null | undefined): string => {
  if (bits == null || !Number.isFinite(bits)) return "—";
  if (bits >= 1e5) return `${(bits / 1e6).toFixed(1)} Mbps`;
  if (bits >= 1e3) return `${Math.round(bits / 1e3)} kbps`;
  return `${Math.round(bits)} bps`;
};
/** Byte totals as the boards write them, in decimal units: 412 GB, 18.4 GB, 61 GB. */
const bytes = (n: number): string => {
  const units = ["B", "kB", "MB", "GB", "TB", "PB"];
  let v = Math.max(0, Number.isFinite(n) ? n : 0);
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  const text = v >= 100 || u === 0 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "");
  return `${text} ${units[u]}`;
};
const shortRate = (bits: number): string =>
  rate(bits).replace(" Mbps", " M").replace(" kbps", " k").replace(" bps", " b");
const nameOf = (d: Device): string => d.host || d.comment || "";
const initials = (name: string): string => {
  const words = name.split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
};
const shortDay = (day: string): string =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function useMedia(query: string): boolean {
  const [match, setMatch] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = (): void => setMatch(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, [query]);
  return match;
}

// ── Charts ──────────────────────────────────────────────────────────────────

/** The live download (teal) / upload (amber) chart. Points sit on observed time, not sample count. */
export function TrafficChart({
  history,
  height = 150,
  grid = true,
  labels = false,
}: {
  history: TrafficPoint[];
  height?: number;
  grid?: boolean;
  labels?: boolean;
}): ReactNode {
  const xs = history.map((_, i) => trafficX(history, i, 1, 0));
  const time = (ts: number | undefined): string =>
    ts == null ? "" : new Date(ts).toLocaleTimeString([], { hour12: false });
  return (
    <LineChart
      label="Client download and upload rate over observed time"
      height={height}
      grid={grid}
      xs={xs}
      drawKey={history.length >= 2}
      series={[
        { values: history.map((p) => p.rx), color: "var(--sig)" },
        { values: history.map((p) => p.tx), color: "var(--warning)" },
      ]}
      labels={labels ? [time(history[0]?.ts), "", "", time(history.at(-1)?.ts)] : undefined}
    />
  );
}

// ── Data hooks ──────────────────────────────────────────────────────────────

/**
 * Live per-client traffic, received over (in order of preference) a WebSocket,
 * an SSE stream, then 1-second HTTP polling as the third fallback. The server
 * runs a single poller per device and pushes each sample to all subscribers, so
 * the router is sampled once per interval no matter how many dashboards are open
 * (which also keeps the `/ip accounting` snapshot from being reset by racing
 * pollers). Every transport delivers the same sample shape through
 * {@link applyTrafficSample}.
 */
function useBulkTraffic(deviceName: string): BulkTraffic {
  const [traffic, setTraffic] = useState<BulkTraffic>(EMPTY_TRAFFIC);
  const [trafficDevice, setTrafficDevice] = useState(deviceName);
  if (trafficDevice !== deviceName) {
    setTrafficDevice(deviceName);
    setTraffic(EMPTY_TRAFFIC);
  }

  useEffect(() => {
    if (!deviceName) return;
    let closed = false;
    let ws: WebSocket | null = null;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    const q = `traffic=${encodeURIComponent(deviceName)}`;

    const onSample = (sample: BulkTrafficSample): void => {
      if (!closed) setTraffic((old) => applyTrafficSample(old, sample));
    };
    const unavailable = (note: string): void =>
      onSample({
        ts: Date.now(),
        source: "none",
        hosts: {},
        limits: {},
        note,
      });

    // 3rd fallback: 1-second HTTP polling.
    const startPolling = (): void => {
      if (closed || pollTimer) return;
      const poll = async (): Promise<void> => {
        try {
          onSample(
            await api<BulkTrafficSample>(
              `/api/clients/traffic-bulk?device=${encodeURIComponent(deviceName)}`,
            ),
          );
        } catch (error) {
          onSample({
            ts: Date.now(),
            source: "none",
            hosts: {},
            limits: {},
            note: error instanceof Error ? error.message : "Traffic request failed",
          });
        }
        if (!closed) pollTimer = setTimeout(() => void poll(), BULK_POLL_MS);
      };
      void poll();
    };

    // 2nd: Server-Sent Events.
    const connectSse = (): void => {
      if (closed) return;
      es = new EventSource(withToken(`/api/sse?${q}`));
      let opened = false;
      es.onopen = () => {
        opened = true;
      };
      es.addEventListener("traffic", (ev) => {
        try {
          onSample(JSON.parse((ev as MessageEvent).data) as BulkTrafficSample);
        } catch {
          /* ignore */
        }
      });
      es.onerror = () => {
        unavailable("Traffic stream interrupted. Reconnecting; rates are unavailable.");
        // Never established: give up on SSE and fall to polling. If it had
        // opened, leave EventSource to auto-reconnect on its own.
        if (!opened && es) {
          es.close();
          es = null;
          startPolling();
        }
      };
    };

    // 1st: WebSocket.
    const connectWs = (): void => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(withToken(`${proto}://${location.host}/api/stream?${q}`));
      let opened = false;
      ws.onopen = () => {
        opened = true;
      };
      ws.onerror = () => ws?.close();
      ws.onmessage = (m) => {
        try {
          const msg = JSON.parse(m.data) as { type: string; sample?: BulkTrafficSample };
          if (msg.type === "traffic" && msg.sample) onSample(msg.sample);
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        unavailable("Traffic stream interrupted. Reconnecting; rates are unavailable.");
        if (opened) setTimeout(connectWs, 2000); // was working: reconnect
        else connectSse(); // never opened: fall to SSE
      };
    };

    connectWs();
    return () => {
      closed = true;
      ws?.close();
      es?.close();
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [deviceName]);

  return traffic;
}

type UsageState =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; data: UsagePayload };

/** Daily usage for one client over the last 3 months, refreshed every 30 seconds. */
function useClientUsage(ip: string, deviceName: string): UsageState {
  const endpoint = ip
    ? `/api/usage/client?ip=${encodeURIComponent(ip)}${
        deviceName ? `&device=${encodeURIComponent(deviceName)}` : ""
      }&days=${USAGE_DAYS}`
    : "";
  const [usage, setUsage] = useState<UsageState>({ state: "loading" });
  const [loaded, setLoaded] = useState(endpoint);
  if (loaded !== endpoint) {
    setLoaded(endpoint);
    setUsage({ state: "loading" });
  }
  useEffect(() => {
    if (!endpoint) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    const refresh = (): void => {
      void api<UsagePayload>(endpoint, abort.signal)
        .then((data) => {
          if (alive) setUsage({ state: "ready", data });
        })
        .catch(() => {
          if (alive) setUsage({ state: "error" });
        })
        .finally(() => {
          if (alive) timer = setTimeout(refresh, 30_000);
        });
    };
    refresh();
    return () => {
      alive = false;
      abort.abort();
      clearTimeout(timer);
    };
  }, [endpoint]);
  return usage;
}

interface UsageSummary {
  rx: number[];
  tx: number[];
  labels: string[];
  totalRx: number;
  totalTx: number;
  peak: number;
  recorded: number;
}

/** Fills the 90-day window with zeros so gaps don't squeeze the time axis. */
function summarize(data: UsagePayload): UsageSummary {
  const map = new Map(data.series.map((d) => [d.day, d]));
  const now = new Date();
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days: DailyUsage[] = [];
  for (let i = USAGE_DAYS - 1; i >= 0; i--) {
    const k = dayKey(end - i * DAY_MS);
    days.push(map.get(k) ?? { day: k, rx: 0, tx: 0 });
  }
  const at = (f: number): string => shortDay(days[Math.round(f * (days.length - 1))]!.day);
  return {
    rx: days.map((d) => d.rx),
    tx: days.map((d) => d.tx),
    labels: [at(0), at(1 / 3), at(2 / 3), at(1)],
    totalRx: data.totalRx,
    totalTx: data.totalTx,
    peak: Math.max(0, ...data.series.map((d) => d.rx + d.tx)),
    recorded: data.series.length,
  };
}

function UsageFallback({ usage }: { usage: UsageState }): ReactNode {
  if (usage.state === "loading") return <LoadingState label="Loading usage" layout="chart" />;
  if (usage.state === "error")
    return (
      <p role="status" className="clients-hint text-destructive">
        Could not load usage history. Retrying automatically.
      </p>
    );
  return (
    <p className="clients-hint">
      No measured history yet. History needs two samples from a per-device counter, normally one
      minute apart. Usage from before recording began can't be rebuilt; it's kept about three
      months.
    </p>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function Rates({ t }: { t: IpTraffic }): ReactNode {
  return (
    <span className="clients-rates clients-mono">
      <span className="text-success">↓ {rate(t.rxRate)}</span>
      <span className="text-warning">↑ {rate(t.txRate)}</span>
    </span>
  );
}

function investigateHref(deviceName: string, d: Device): string {
  const url = new URL(location.href);
  url.searchParams.set("investigationDevice", deviceName);
  url.searchParams.set("investigationClient", d.ip || d.mac);
  url.hash = "investigations";
  return url.toString();
}

/** The client drawer: block, pin, reserve IP, label, rate limits and usage. */
function ClientDrawer({
  device,
  deviceName,
  traffic,
  limits,
  usage,
  busy,
  onClose,
  act,
}: {
  device: Device;
  deviceName: string;
  traffic: IpTraffic | undefined;
  limits: { download: string; upload: string };
  usage: UsageState;
  busy: boolean;
  onClose: () => void;
  act: (path: string, mac: string, extra?: Record<string, unknown>) => Promise<void>;
}): ReactNode {
  const [ip, setIp] = useState(device.ip);
  const [label, setLabel] = useState(device.comment || device.host);
  const [dl, setDl] = useState(limits.download);
  const [ul, setUl] = useState(limits.upload);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Adopt the live (fetched) limits until the user starts editing.
  if (!dirty && (dl !== limits.download || ul !== limits.upload)) {
    setDl(limits.download);
    setUl(limits.upload);
  }

  const applyLimits = async (download: string, upload: string): Promise<void> => {
    setSaving(true);
    setMsg(null);
    try {
      const r = await postJson<OpResult>("/api/clients/limits", {
        ip: device.ip,
        device: deviceName,
        download,
        upload,
      });
      setMsg(r.message);
      if (r.ok) {
        setDirty(false);
        toast.success(download || upload ? "Rate limits applied" : "Rate limits removed");
      } else {
        toast.error(r.message || "Rate limits failed");
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      toast.error(e instanceof Error ? e.message : "Rate limits failed");
    } finally {
      setSaving(false);
    }
  };

  const name = nameOf(device) || "(unknown)";
  const tone = device.blocked ? "bad" : traffic ? "ok" : "acc";
  const hasLimit = Boolean(limits.download || limits.upload);
  const summary =
    usage.state === "ready" && usage.data.series.length > 0 ? summarize(usage.data) : null;

  return (
    <MonitorDialog
      open
      onOpenChange={(open) => !open && onClose()}
      variant="drawer"
      title="Client"
      description={`Actions apply to ${deviceName || "the router"} as soon as you press them.`}
      footer={
        device.ip ? (
          <>
            <MonitorButton
              variant="ghost"
              disabled={saving || !hasLimit}
              onClick={() => {
                setDl("");
                setUl("");
                void applyLimits("", "");
              }}
            >
              Remove limit
            </MonitorButton>
            <span className="flex-1" />
            <MonitorButton
              variant="primary"
              icon={<Check aria-hidden="true" />}
              disabled={saving}
              onClick={() => void applyLimits(dl, ul)}
            >
              Apply limits
            </MonitorButton>
          </>
        ) : undefined
      }
    >
      <div className="monitor-dialog-body clients-drawer">
        <div className="clients-who">
          <span className="clients-avatar" data-tone={tone} data-size="lg" aria-hidden="true">
            {initials(nameOf(device)) || "?"}
          </span>
          <span className="clients-stack">
            <b className="clients-who-name">{name}</b>
            <span className="clients-mono text-muted-foreground">
              {device.ip || "no IP"} · {device.mac}
            </span>
          </span>
          <span className="flex-1" />
          {device.static && (
            <StatusBadge tone="brand" dot={false}>
              static
            </StatusBadge>
          )}
          {device.blocked ? (
            <StatusBadge tone="bad">blocked</StatusBadge>
          ) : (
            <StatusBadge tone={device.status === "bound" ? "good" : "default"}>
              {device.status || "unknown"}
            </StatusBadge>
          )}
        </div>

        <dl className="monitor-facts">
          <dt>Interface</dt>
          <dd className="clients-mono">{device.iface || "—"}</dd>
          <dt>Lease</dt>
          <dd>
            {device.status || "unknown"} · {device.static ? "static" : "dynamic"}
          </dd>
          <dt>Router</dt>
          <dd className="clients-mono">{deviceName}</dd>
        </dl>

        {traffic ? (
          <div className="glass clients-live-box">
            <div className="clients-live-rates">
              <span className="clients-num text-success">↓ {rate(traffic.rxRate)}</span>
              <span className="clients-num text-warning">↑ {rate(traffic.txRate)}</span>
              <span className="flex-1" />
              <span className="clients-mono text-faint">live</span>
            </div>
            <TrafficChart history={traffic.history} height={70} grid={false} />
          </div>
        ) : (
          <MonitorNote>
            No counter was returned for <code>{device.ip || device.mac}</code>. This is missing
            data, not zero use.
          </MonitorNote>
        )}

        <div className="clients-group">
          <span className="clients-label">Access</span>
          <div className="clients-two">
            {device.blocked ? (
              <MonitorButton
                icon={<Check aria-hidden="true" />}
                disabled={busy}
                onClick={() => void act("allow", device.mac)}
              >
                Allow client
              </MonitorButton>
            ) : (
              <MonitorButton
                variant="danger"
                icon={<Lock aria-hidden="true" />}
                disabled={busy}
                onClick={() => void act("block", device.mac)}
              >
                Block client
              </MonitorButton>
            )}
            {device.static ? (
              <span className="clients-pinned">
                <Pin aria-hidden="true" />
                IP pinned · static lease
              </span>
            ) : (
              <MonitorButton
                icon={<Pin aria-hidden="true" />}
                disabled={busy}
                onClick={() => void act("pin", device.mac)}
              >
                Pin IP
              </MonitorButton>
            )}
          </div>
          <span className="clients-hint">
            Block takes effect on the router right away. Allow lifts it.
          </span>
        </div>

        <div className="clients-group">
          <span className="clients-label">Reserve IP</span>
          <form
            className="clients-inline"
            onSubmit={(e) => {
              e.preventDefault();
              if (ip.trim()) void act("set-ip", device.mac, { ip: ip.trim() });
            }}
          >
            <input
              className="monitor-input clients-mono flex-1"
              aria-label="Reserved IP"
              placeholder="e.g. 192.168.88.50"
              value={ip}
              onChange={(e) => setIp(e.target.value)}
            />
            <MonitorButton type="submit" variant="primary" disabled={busy || !ip.trim()}>
              Save
            </MonitorButton>
          </form>
          <span className="clients-hint">
            Sets a fixed lease for this MAC. The client gets it on its next renewal.
          </span>
        </div>

        <div className="clients-group">
          <span className="clients-label">Label</span>
          <form
            className="clients-inline"
            onSubmit={(e) => {
              e.preventDefault();
              void act("label", device.mac, { label: label.trim() });
            }}
          >
            <input
              className="monitor-input flex-1"
              aria-label="Label"
              placeholder="e.g. Ali phone"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <MonitorButton type="submit" disabled={busy}>
              Save
            </MonitorButton>
          </form>
        </div>

        {device.ip && (
          <div className="clients-group">
            <div className="clients-baseline">
              <span className="clients-label">Rate limits</span>
              <span className="flex-1" />
              <span className="clients-hint">
                current: ↓ {limits.download || "unlimited"} · ↑ {limits.upload || "unlimited"}
              </span>
            </div>
            <div className="clients-two">
              <label className="clients-fl">
                <span className="clients-label">↓ Download</span>
                <input
                  className="monitor-input"
                  placeholder="10M · blank = unlimited"
                  value={dl}
                  onChange={(e) => {
                    setDirty(true);
                    setDl(e.target.value);
                  }}
                />
              </label>
              <label className="clients-fl">
                <span className="clients-label">↑ Upload</span>
                <input
                  className="monitor-input"
                  placeholder="2M · blank = unlimited"
                  value={ul}
                  onChange={(e) => {
                    setDirty(true);
                    setUl(e.target.value);
                  }}
                />
              </label>
            </div>
            {msg && <span className="clients-hint">{msg}</span>}
          </div>
        )}

        {device.ip && (
          <div className="clients-group">
            <div className="clients-baseline">
              <span className="clients-label">Usage · last 3 months</span>
              <span className="flex-1" />
              {summary && (
                <span className="clients-mono text-muted-foreground">
                  ↓ {bytes(summary.totalRx)} · ↑ {bytes(summary.totalTx)}
                </span>
              )}
            </div>
            {summary ? (
              <>
                <LineChart
                  label="Recorded daily download and upload"
                  height={90}
                  grid={false}
                  drawKey={device.ip}
                  series={[
                    { values: summary.rx, color: "var(--sig)" },
                    { values: summary.tx, color: "var(--warning)" },
                  ]}
                />
                <span className="clients-hint">
                  {summary.recorded} recorded days · peak day {bytes(summary.peak)}
                </span>
              </>
            ) : (
              <UsageFallback usage={usage} />
            )}
          </div>
        )}

        <a className="clients-link" href={investigateHref(deviceName, device)}>
          <Search aria-hidden="true" />
          Investigate this client and service
        </a>
      </div>
    </MonitorDialog>
  );
}

// ── Main view ───────────────────────────────────────────────────────────────

/** Connected LAN devices for one router: live traffic, block/allow, pin/relabel IP, limits. */
export function ClientsView(): ReactNode {
  const [routers, setRouters] = useState<DevicesPayload | null>(null);
  const [deviceName, setDeviceName] = useState<string>("");
  const [view, setView] = useState<DevicesView | null>(null);
  const [picked, setSelected] = useState<string | null>(null); // MAC the user chose
  const [drawer, setDrawer] = useState<string | null>(null); // MAC in the drawer
  const [busy, setBusy] = useState<string | null>(null); // MAC currently mutating
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [showAll, setShowAll] = useState(false);
  const [trend, setTrend] = useState<{ total: number[]; down: number[] }>({ total: [], down: [] });
  const phone = useMedia(PHONE);

  // Bulk traffic: pushed every 1s; the server reads /ip accounting (v6) or Kid Control (v7).
  const {
    map: trafficMap,
    source: trafficSource,
    note: trafficNote,
    limits: trafficLimits,
  } = useBulkTraffic(deviceName);
  const trafficRef = useRef(trafficMap);
  useEffect(() => {
    trafficRef.current = trafficMap;
  }, [trafficMap]);

  // Discover the configured routers so the user can pick which one to inspect.
  useEffect(() => {
    void api<DevicesPayload>("/api/devices")
      .then((r) => {
        setRouters(r);
        setDeviceName((cur) => cur || r.defaultDevice || r.devices[0]?.name || "");
      })
      .catch(() => setRouters({ server: "", defaultDevice: "", devices: [] }));
  }, []);

  const load = useCallback((): Promise<void> => {
    const q = deviceName ? `?device=${encodeURIComponent(deviceName)}` : "";
    return api<DevicesView>(`/api/clients${q}`)
      .then((next) => {
        setView(next);
        setError(null);
        // KPI trends: one point per inventory read (every 15 seconds).
        let down = 0;
        for (const t of trafficRef.current.values()) down += t.rxRate ?? 0;
        setTrend((old) => ({
          total: [...old.total, next.counts.total].slice(-12),
          down: [...old.down, down].slice(-12),
        }));
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [deviceName]);

  // Load on device change, then refresh the list lightly (status can change).
  const [viewDevice, setViewDevice] = useState(deviceName);
  if (viewDevice !== deviceName) {
    setViewDevice(deviceName);
    setView(null);
    setSelected(null);
    setDrawer(null);
    setTrend({ total: [], down: [] });
  }
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const act = useCallback(
    async (path: string, mac: string, extra?: Record<string, unknown>): Promise<void> => {
      setBusy(mac);
      setError(null);
      try {
        const r = await postJson<OpResult>(`/api/clients/${path}`, {
          mac,
          device: deviceName,
          ...extra,
        });
        if (r.view) setView(r.view);
        else await load();
        const label =
          path === "block"
            ? "Client blocked"
            : path === "allow"
              ? "Client allowed"
              : path === "pin"
                ? "IP pinned"
                : path === "set-ip"
                  ? "IP set"
                  : path === "label"
                    ? "Client labeled"
                    : "Done";
        if (!r.ok) {
          setError(r.message);
          toast.error(r.message || `${label} failed`);
        } else {
          toast.success(label);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        toast.error(e instanceof Error ? e.message : "Action failed");
      } finally {
        setBusy(null);
      }
    },
    [deviceName, load],
  );

  const devices = useMemo(() => view?.devices ?? [], [view]);

  // Filtered by the search box and the All / Static / Blocked switch, busiest first.
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = devices.filter(
      (d) =>
        (show === "all" || (show === "static" ? d.static : d.blocked)) &&
        (!q ||
          d.ip.toLowerCase().includes(q) ||
          d.mac.toLowerCase().includes(q) ||
          d.host.toLowerCase().includes(q) ||
          d.comment.toLowerCase().includes(q)),
    );
    return list
      .map((d, i) => ({ d, i, r: d.ip ? (trafficMap.get(d.ip)?.rxRate ?? -1) : -1 }))
      .sort((a, b) => b.r - a.r || a.i - b.i)
      .map((x) => x.d);
    // trafficMap changes every second; the order follows it.
  }, [devices, filter, show, trafficMap]);

  const limit = phone ? PHONE_ROWS : ROWS;
  const rows = showAll ? shown : shown.slice(0, limit);

  // A listed client is always selected, so the live chart shows a row you can see:
  // the busiest one at first, and again when a filter hides the one you chose.
  const selected = shown.some((d) => d.mac === picked) ? picked : (shown[0]?.mac ?? null);

  const selectedDevice = devices.find((d) => d.mac === selected) ?? null;
  const drawerDevice = devices.find((d) => d.mac === drawer) ?? null;
  const usageDevice = drawerDevice ?? selectedDevice;
  const usage = useClientUsage(usageDevice?.ip ?? "", deviceName);
  const counts = view?.counts;

  let down = 0;
  let up = 0;
  for (const t of trafficMap.values()) {
    down += t.rxRate ?? 0;
    up += t.txRate ?? 0;
  }
  const hasCounters = trafficMap.size > 0;

  const blockedNames = (() => {
    const blocked = devices.filter((d) => d.blocked);
    const named = blocked.map(nameOf).filter(Boolean);
    const unknown = blocked.length - named.length;
    const parts = [...named];
    if (unknown > 0) parts.push(unknown === 1 ? "one unknown" : `${unknown} unknown`);
    if (parts.length === 0) return "No clients blocked";
    if (parts.length === 1) return parts[0]!;
    return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  })();

  const talkers: TalkerBar[] = (() => {
    const names = new Map(devices.map((d) => [d.ip, nameOf(d) || d.ip]));
    const list = [...trafficMap.entries()]
      .map(([ip, t]) => {
        const r = t.rxRate ?? 0;
        const u = t.txRate ?? 0;
        return { ip, label: names.get(ip) ?? ip, up: u > r, v: Math.max(r, u) };
      })
      .filter((x) => x.v > 0)
      .sort((a, b) => b.v - a.v)
      .slice(0, 5);
    const top = list[0]?.v ?? 1;
    return list.map((x) => ({
      key: x.ip,
      label: x.label,
      pct: (x.v / top) * 100,
      value: `${shortRate(x.v)}${x.up ? " ↑" : ""}`,
      tone: x.up ? "warn" : "good",
    }));
  })();

  const routerNames = routers?.devices.map((d) => d.name) ?? [];
  const source = trafficSource === "kid-control" ? "Kid Control" : "IP accounting";
  const live = trafficSource !== "none" && !trafficNote;

  const search = (className: string): ReactNode => (
    <MonitorSearch
      className={className}
      label="Filter clients"
      placeholder="Filter by IP, MAC or name"
      value={filter}
      onChange={(v) => {
        setFilter(v);
        setShowAll(false);
      }}
    />
  );

  const showSwitch = (
    <Segmented<Show>
      label="Show clients"
      value={show}
      onChange={(v) => {
        setShow(v);
        setShowAll(false);
      }}
      options={[
        { value: "all", label: "All" },
        { value: "static", label: "Static" },
        { value: "blocked", label: "Blocked" },
      ]}
    />
  );

  const openDrawer = (d: Device): void => {
    setSelected(d.mac);
    setDrawer(d.mac);
  };

  const selTraffic = selectedDevice?.ip ? trafficMap.get(selectedDevice.ip) : undefined;
  const usageSummary =
    usage.state === "ready" && usage.data.series.length > 0 ? summarize(usage.data) : null;

  return (
    <div className="clients-page">
      <PageIntro
        eyebrow={
          <>
            Connected clients<span className="clients-wide"> · {deviceName}</span>
          </>
        }
        verdict={
          counts ? (
            <>
              <Ticker value={counts.total} format={(n) => String(Math.round(n))} />
              <span className="clients-wide"> devices</span> on the LAN.
              {counts.blocked > 0 && (
                <>
                  {" "}
                  <em>{counts.blocked} blocked.</em>
                </>
              )}
            </>
          ) : error ? (
            "Clients can't be read right now."
          ) : (
            "Reading clients…"
          )
        }
        lead={
          <span className="clients-wide-block">
            Read from the router's DHCP leases and ARP table every 15 seconds.
            {trafficSource !== "none" &&
              ` Traffic is per device, live every second, from ${source}.`}
          </span>
        }
        actions={
          <>
            <RouterPicker
              value={deviceName}
              onChange={setDeviceName}
              routers={routerNames}
              defaultRouter={routers?.defaultDevice}
              disabled={routerNames.length < 2}
            />
            {search("clients-search clients-wide-flex")}
            <MonitorButton
              variant="ghost"
              icon={<RefreshCw aria-hidden="true" />}
              aria-label="Refresh"
              className="clients-refresh"
              onClick={() => void load()}
            >
              <span className="clients-wide">Refresh</span>
            </MonitorButton>
          </>
        }
        aside={
          <div className="glass clients-busiest">
            <div className="clients-busiest-head">
              <StatusDot tone={live ? "good" : "default"} pulse={live} />
              <b>Busiest right now</b>
              <span className="flex-1" />
              <span className="clients-mono text-muted-foreground">↓ download, live</span>
            </div>
            {talkers.length > 0 ? (
              <TalkerBars items={talkers} />
            ) : (
              <p className="clients-hint">No client is moving traffic right now.</p>
            )}
            <span className="clients-hint">
              Device counters only. These are not WAN, tunnel or billing totals.
            </span>
          </div>
        }
      />

      <MetricStrip label="Client summary" className="clients-kpis clients-wide-grid">
        <Metric
          label="Connected"
          value={
            counts ? <Ticker value={counts.total} format={(n) => String(Math.round(n))} /> : "—"
          }
          hint="in DHCP leases or ARP"
          spark={trend.total}
        />
        <Metric label="Static leases" value={counts?.static ?? "—"} hint="IP pinned to the MAC" />
        <Metric
          label="Blocked"
          value={counts?.blocked ?? "—"}
          hint={blockedNames}
          tone={counts && counts.blocked > 0 ? "warn" : "default"}
        />
        <Metric
          label="Live download"
          value={
            hasCounters ? (
              <>
                {(down / 1e6).toFixed(1)}
                <small>Mbps</small>
              </>
            ) : (
              "—"
            )
          }
          hint={hasCounters ? `↑ ${rate(up)} upload` : "No device counters"}
          spark={trend.down}
        />
      </MetricStrip>
      <MetricStrip label="Client summary" className="clients-kpis clients-phone-grid">
        <Metric
          label="Connected"
          value={counts?.total ?? "—"}
          hint={counts ? `${counts.static} static` : undefined}
        />
        <Metric
          label="Live ↓"
          value={
            hasCounters ? (
              <>
                {Math.round(down / 1e6)}
                <small>Mbps</small>
              </>
            ) : (
              "—"
            )
          }
          hint="device counters"
        />
      </MetricStrip>

      {error && (
        <MonitorNote tone="bad" role="alert">
          {error}
        </MonitorNote>
      )}
      {trafficNote ? (
        <MonitorNote tone="warn">
          <b>Traffic unavailable.</b> {trafficNote} The Traffic column needs per-host counters:{" "}
          <code>/ip accounting</code> on RouterOS v6, or Kid Control on v7.
        </MonitorNote>
      ) : (
        trafficSource !== "none" && (
          <MonitorNote className="clients-wide-flex">
            Live device counters from <b>{source}</b>: ↓ download and ↑ upload, IPv4 and IPv6
            together. Router counters can reset, so these are not billing totals.
          </MonitorNote>
        )
      )}

      <div className="clients-phone-flex clients-phone-tools">
        {search("w-full")}
        {showSwitch}
      </div>

      <MonitorPanel
        title="Clients"
        description="Select a row to see its traffic and limits. Blocked clients are struck through."
        className="clients-table-panel"
        flush
        extra={showSwitch}
      >
        {!view ? (
          <div className="px-[18px] pb-4">
            <LoadingState label="Loading connected devices" />
          </div>
        ) : shown.length === 0 ? (
          <MonitorEmpty icon={<Wifi />} title="No connected devices">
            Nothing in this router's DHCP leases or ARP table
            {filter || show !== "all" ? " matches" : ""}.
          </MonitorEmpty>
        ) : (
          <div role="table" aria-label="Connected clients">
            <div role="row" className="monitor-thead clients-grid">
              <span role="columnheader">Client</span>
              <span role="columnheader">MAC</span>
              <span role="columnheader">Iface</span>
              <span role="columnheader">Status</span>
              <span role="columnheader">Traffic</span>
              <span role="columnheader">
                <span className="sr-only">Actions</span>
              </span>
            </div>
            {rows.map((d) => {
              const isSel = d.mac === selected;
              const isBusy = busy === d.mac;
              const t = d.ip ? trafficMap.get(d.ip) : undefined;
              const name = nameOf(d);
              const moving = t != null && ((t.rxRate ?? 0) > 0 || (t.txRate ?? 0) > 0);
              return (
                <div
                  key={d.mac}
                  role="row"
                  tabIndex={0}
                  aria-selected={isSel}
                  className="monitor-row clients-grid clients-row"
                  data-selected={isSel || undefined}
                  data-failed={d.blocked || undefined}
                  data-blocked={d.blocked || undefined}
                  onClick={() => (phone ? openDrawer(d) : setSelected(d.mac))}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      if (phone) openDrawer(d);
                      else setSelected(d.mac);
                    }
                  }}
                >
                  <span role="cell" className="clients-client">
                    <StatusDot tone={d.blocked ? "bad" : moving ? "good" : "default"} />
                    <span className="clients-stack">
                      <span className="clients-name">
                        <span
                          className={name ? "p clients-trunc" : "clients-unknown clients-trunc"}
                        >
                          {name || "(unknown)"}
                        </span>
                        {d.static && (
                          <span className="clients-phone-inline">
                            <StatusBadge tone="brand" dot={false}>
                              static
                            </StatusBadge>
                          </span>
                        )}
                      </span>
                      <span className="clients-mono clients-sub clients-trunc">
                        {d.ip || "no IP"}
                        <span className="clients-phone-inline"> · {d.iface || "?"}</span>
                      </span>
                    </span>
                  </span>
                  <span
                    role="cell"
                    className="clients-mono text-fg-secondary clients-trunc clients-wide-cell"
                  >
                    {d.mac}
                  </span>
                  <span
                    role="cell"
                    className="clients-mono text-muted-foreground clients-trunc clients-wide-cell"
                  >
                    {d.iface || ""}
                  </span>
                  <span role="cell" className="clients-status clients-wide-cell">
                    {d.static && (
                      <StatusBadge tone="brand" dot={false}>
                        static
                      </StatusBadge>
                    )}
                    {d.blocked ? (
                      <StatusBadge tone="bad">blocked</StatusBadge>
                    ) : (
                      <span className="clients-sub">{d.status}</span>
                    )}
                  </span>
                  <span role="cell" className="clients-traffic">
                    {t ? (
                      <>
                        <Rates t={t} />
                        <RowSpark
                          className="clients-wide-inline"
                          values={t.history.map((p) => p.rx)}
                        />
                      </>
                    ) : d.blocked ? (
                      <>
                        <span className="text-faint clients-wide-inline">—</span>
                        <span className="clients-phone-inline">
                          <StatusBadge tone="bad">blocked</StatusBadge>
                        </span>
                      </>
                    ) : (
                      <span className="clients-sub">{d.ip ? "No counter" : ""}</span>
                    )}
                  </span>
                  {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- stops row selection; the buttons inside handle keys */}
                  <span
                    role="cell"
                    className="clients-actions clients-wide-flex"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {d.blocked ? (
                      <MonitorButton
                        size="sm"
                        icon={<Check aria-hidden="true" />}
                        disabled={isBusy}
                        onClick={() => void act("allow", d.mac)}
                      >
                        Allow
                      </MonitorButton>
                    ) : (
                      <MonitorButton
                        size="sm"
                        variant="danger"
                        disabled={isBusy}
                        onClick={() => void act("block", d.mac)}
                      >
                        Block
                      </MonitorButton>
                    )}
                    {!d.static && (
                      <MonitorButton
                        size="sm"
                        icon={<Pin aria-hidden="true" />}
                        disabled={isBusy}
                        onClick={() => void act("pin", d.mac)}
                      >
                        Pin IP
                      </MonitorButton>
                    )}
                    <button
                      type="button"
                      className="monitor-icon-btn"
                      aria-label="More actions"
                      title="More actions"
                      onClick={() => openDrawer(d)}
                    >
                      <MoreHorizontal aria-hidden="true" />
                    </button>
                  </span>
                </div>
              );
            })}
            <div className="monitor-foot">
              {counts && (
                <span className="clients-wide-inline">
                  {counts.total} total · {counts.static} static · {counts.blocked} blocked
                </span>
              )}
              <span className="flex-1 clients-wide-inline" />
              <span>
                <span className="clients-wide-inline">Showing </span>
                {rows.length} of {shown.length}
                <span className="clients-wide-inline"> · sorted by live download</span>
              </span>
              <span className="flex-1 clients-phone-inline" />
              {rows.length < shown.length && (
                <MonitorButton
                  size="sm"
                  variant="ghost"
                  icon={<ChevronDown aria-hidden="true" />}
                  onClick={() => setShowAll(true)}
                >
                  Show all
                </MonitorButton>
              )}
            </div>
          </div>
        )}
      </MonitorPanel>

      {selectedDevice && (
        <section className="clients-detail clients-wide-grid">
          <MonitorPanel
            title={`${nameOf(selectedDevice) || selectedDevice.ip || selectedDevice.mac} · live traffic`}
            description={`${selectedDevice.ip || "no IP"} · ${selectedDevice.mac} · ${selectedDevice.iface || "?"} · ${selectedDevice.status}`}
            extra={
              <a
                className="clients-link clients-link-sm"
                href={investigateHref(deviceName, selectedDevice)}
              >
                <Search aria-hidden="true" />
                Investigate this client
              </a>
            }
          >
            {selTraffic ? (
              <>
                <div className="clients-big-rates">
                  <span className="clients-stack">
                    <span className="clients-label">↓ Download</span>
                    <span className="clients-big text-success">
                      {selTraffic.rxRate == null ? "—" : (selTraffic.rxRate / 1e6).toFixed(1)}{" "}
                      <small>Mbps</small>
                    </span>
                  </span>
                  <span className="clients-stack">
                    <span className="clients-label">↑ Upload</span>
                    <span className="clients-big text-warning">
                      {selTraffic.txRate == null ? "—" : (selTraffic.txRate / 1e6).toFixed(1)}{" "}
                      <small>Mbps</small>
                    </span>
                  </span>
                  <span className="flex-1" />
                  <span className="clients-mono text-muted-foreground">
                    Router totals ↓ {bytes(selTraffic.rxBytes)} · ↑ {bytes(selTraffic.txBytes)}
                  </span>
                </div>
                {selTraffic.history.length >= 2 ? (
                  <TrafficChart history={selTraffic.history} labels />
                ) : (
                  <p className="clients-hint">Waiting for two valid rate samples…</p>
                )}
              </>
            ) : (
              <MonitorNote>
                No counter was returned for <code>{selectedDevice.ip || selectedDevice.mac}</code>.
                This is missing data, not zero use. Check the traffic notice above.
              </MonitorNote>
            )}
          </MonitorPanel>
          <MonitorPanel
            title="Usage history · last 3 months"
            description="Daily totals from the usage sampler. Kept about three months."
            extra={
              <span className="monitor-legend">
                <span>
                  <i style={{ background: "var(--sig)" }} />
                  download
                </span>
                <span>
                  <i style={{ background: "var(--warning)" }} />
                  upload
                </span>
              </span>
            }
          >
            {usageSummary ? (
              <>
                <div className="clients-usage-stats">
                  <span>
                    <b className="text-success clients-num">↓ {bytes(usageSummary.totalRx)}</b> down
                  </span>
                  <span>
                    <b className="text-warning clients-num">↑ {bytes(usageSummary.totalTx)}</b> up
                  </span>
                  <span>
                    peak day{" "}
                    <b className="clients-num text-foreground">{bytes(usageSummary.peak)}</b>
                  </span>
                  <span>{usageSummary.recorded} recorded days</span>
                </div>
                <LineChart
                  label="Recorded daily download and upload"
                  height={150}
                  drawKey={selectedDevice.ip}
                  labels={usageSummary.labels}
                  series={[
                    { values: usageSummary.rx, color: "var(--sig)" },
                    { values: usageSummary.tx, color: "var(--warning)" },
                  ]}
                />
              </>
            ) : selectedDevice.ip ? (
              <UsageFallback usage={usage} />
            ) : (
              <p className="clients-hint">This client has no IP, so there is no usage to show.</p>
            )}
          </MonitorPanel>
        </section>
      )}

      {drawerDevice && (
        <ClientDrawer
          key={drawerDevice.mac}
          device={drawerDevice}
          deviceName={deviceName}
          traffic={drawerDevice.ip ? trafficMap.get(drawerDevice.ip) : undefined}
          limits={{
            download: trafficLimits[drawerDevice.ip]?.download ?? "",
            upload: trafficLimits[drawerDevice.ip]?.upload ?? "",
          }}
          usage={usage}
          busy={busy === drawerDevice.mac}
          onClose={() => setDrawer(null)}
          act={act}
        />
      )}
    </div>
  );
}
