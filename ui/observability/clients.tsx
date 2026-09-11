/**
 * Clients view — the LAN devices connected to a router (not the routers
 * themselves, which live on the Devices page).
 *
 * Talks to the dashboard's `/api/clients*` routes, which call the very same
 * RouterOS operations the connected-device MCP tools wrap — so a block/allow/
 * pin from this page and from chat run identical commands. Traffic rates cover
 * EVERY LAN client with no per-device queue: the server reads `/ip accounting`
 * on RouterOS v6, or Kid Control on v7 (where accounting was removed), and
 * normalises both to per-host rates shown inline with a mini sparkline, polled
 * every second. Rate limits still come from `/queue simple`. Mutations return a
 * refreshed device `view` so the table updates without a second request.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { RefreshCw, Wifi } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { api, postJson, withToken } from "./api";
import { Panel } from "./atoms";
import { bytes } from "./format";
import { Badge, Button, Input, Note, Select } from "./geist";
import { toast } from "./toast-action";
import type { DevicesPayload } from "./types";
import { UsageHistoryChart } from "./usage-charts";

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
interface BulkTrafficSample {
  ts: number;
  /** How the server obtained traffic; `none` → `note` explains why it's empty. */
  source: "accounting" | "kid-control" | "none";
  note?: string;
  /** Per-IP live rates (bits/sec) + cumulative bytes, normalised across sources. */
  hosts: Record<string, { rxRate: number; txRate: number; rxBytes: number; txBytes: number }>;
  /** Per-IP rate limits from `/queue simple`, for the limits editor. */
  limits: Record<string, { download: string; upload: string }>;
}
interface OpResult {
  ok: boolean;
  message: string;
  view?: DevicesView;
}

/** Per-IP computed traffic state (delta rates + sparkline history). */
interface IpTraffic {
  rxRate: number; // bits/sec, this interval
  txRate: number;
  rxBytes: number; // cumulative for this dashboard session (sum of deltas)
  txBytes: number;
  downloadLimit: string;
  uploadLimit: string;
  history: { rx: number; tx: number }[];
}

/** What `useBulkTraffic` returns: the per-IP map plus the source diagnostic. */
interface BulkTraffic {
  map: Map<string, IpTraffic>;
  source: "accounting" | "kid-control" | "none";
  note?: string;
}

const MAX_SAMPLES = 40;
const MINI_SAMPLES = 30;
const BULK_POLL_MS = 1000;
const SVG_NS = "http://www.w3.org/2000/svg";

const mbps = (bits: number): string => `${(bits / 1e6).toFixed(2)} Mbps`;
const compact = (bits: number): string => {
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)}M`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)}k`;
  return bits > 0 ? `${Math.round(bits)}` : "0";
};

// ── Charts ──────────────────────────────────────────────────────────────────

/** A live Download (green ↓) / Upload (amber ↑) area chart, hand-rolled in SVG. */
function TrafficChart({ history }: { history: { rx: number; tx: number }[] }): ReactNode {
  const W = 520;
  const H = 150;
  const pad = 8;
  const max = Math.max(1, ...history.flatMap((p) => [p.rx, p.tx]));
  const x = (i: number): number => pad + (i * (W - 2 * pad)) / Math.max(1, MAX_SAMPLES - 1);
  const y = (v: number): number => H - pad - (v / max) * (H - 2 * pad);

  const path = (pick: (p: { rx: number; tx: number }) => number): string =>
    history.map((p, i) => `${x(i).toFixed(1)},${y(pick(p)).toFixed(1)}`).join(" ");
  const area = (pick: (p: { rx: number; tx: number }) => number): string => {
    if (history.length < 2) return "";
    const first = x(0).toFixed(1);
    const last = x(history.length - 1).toFixed(1);
    return `${first},${(H - pad).toFixed(1)} ${path(pick)} ${last},${(H - pad).toFixed(1)}`;
  };

  return (
    <svg
      className="block h-[150px] w-full max-w-[520px] rounded-md border border-border bg-background"
      viewBox={`0 0 ${W} ${H}`}
      xmlns={SVG_NS}
      role="img"
    >
      {history.length >= 2 && (
        <>
          <polygon className="fill-success/20 stroke-none" points={area((p) => p.rx)} />
          <polygon className="fill-warning/15 stroke-none" points={area((p) => p.tx)} />
          <polyline className="fill-none stroke-success stroke-2" points={path((p) => p.rx)} />
          <polyline className="fill-none stroke-warning stroke-2" points={path((p) => p.tx)} />
        </>
      )}
    </svg>
  );
}

/** Tiny inline sparkline (rx + tx stacked areas) for a client row. */
function MiniSparkline({ history }: { history: { rx: number; tx: number }[] }): ReactNode {
  const W = 80;
  const H = 18;
  const pad = 1;
  const cls = "block h-[18px] w-20 shrink-0 rounded-[3px] bg-muted/40";
  if (history.length < 2) return <svg className={cls} viewBox={`0 0 ${W} ${H}`} />;
  const max = Math.max(1, ...history.flatMap((p) => [p.rx, p.tx]));
  const x = (i: number): number => pad + (i * (W - 2 * pad)) / Math.max(1, MINI_SAMPLES - 1);
  const y = (v: number): number => H - pad - (v / max) * (H - 2 * pad);
  const pts = (pick: (p: { rx: number; tx: number }) => number): string =>
    history.map((p, i) => `${x(i).toFixed(1)},${y(pick(p)).toFixed(1)}`).join(" ");
  const filled = (pick: (p: { rx: number; tx: number }) => number): string => {
    const first = x(0).toFixed(1);
    const last = x(history.length - 1).toFixed(1);
    const base = (H - pad).toFixed(1);
    return `${first},${base} ${pts(pick)} ${last},${base}`;
  };
  return (
    <svg className={cls} viewBox={`0 0 ${W} ${H}`} xmlns={SVG_NS}>
      <polygon className="fill-success/20 stroke-none" points={filled((p) => p.rx)} />
      <polygon className="fill-warning/15 stroke-none" points={filled((p) => p.tx)} />
      <polyline
        className="fill-none stroke-success stroke-1"
        vectorEffect="non-scaling-stroke"
        points={pts((p) => p.rx)}
      />
      <polyline
        className="fill-none stroke-warning stroke-1"
        vectorEffect="non-scaling-stroke"
        points={pts((p) => p.tx)}
      />
    </svg>
  );
}

// ── Limits editor ───────────────────────────────────────────────────────────

/** Set/clear a device's download & upload rate limits (a `/queue simple`). */
function LimitsEditor({
  ip,
  deviceName,
  current,
  onSaved,
}: {
  ip: string;
  deviceName: string;
  current: { download: string; upload: string };
  onSaved: () => void;
}): ReactNode {
  const [dl, setDl] = useState(current.download);
  const [ul, setUl] = useState(current.upload);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Adopt the live (fetched) limits until the user starts editing.
  useEffect(() => {
    if (!dirty) {
      setDl(current.download);
      setUl(current.upload);
    }
  }, [current.download, current.upload, dirty]);

  const apply = useCallback(
    async (download: string, upload: string): Promise<void> => {
      setBusy(true);
      setMsg(null);
      try {
        const r = await postJson<OpResult>("/api/clients/limits", {
          ip,
          device: deviceName,
          download,
          upload,
        });
        setMsg(r.message);
        if (r.ok) {
          setDirty(false);
          onSaved();
          toast.success(download || upload ? "Rate limits applied" : "Rate limits removed");
        } else {
          toast.error(r.message || "Rate limits failed");
        }
      } catch (e) {
        setMsg(e instanceof Error ? e.message : String(e));
        toast.error(e instanceof Error ? e.message : "Rate limits failed");
      } finally {
        setBusy(false);
      }
    },
    [ip, deviceName, onSaved],
  );

  const hasLimit = Boolean(current.download || current.upload);
  return (
    <div className="mt-3.5 max-w-[520px] border-t border-border pt-3">
      <div className="mb-2 flex items-baseline gap-3">
        <span className="text-[13px] font-semibold">Rate limits</span>
        <span className="text-muted-foreground text-[11px]">
          current: ↓ {current.download || "unlimited"} · ↑ {current.upload || "unlimited"}
        </span>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-[3px] text-[11.5px]">
          <span className="text-muted-foreground text-[11px]">↓ Download</span>
          <Input
            className="w-[150px]"
            placeholder="10M · blank = unlimited"
            value={dl}
            onChange={(e) => {
              setDirty(true);
              setDl(e.target.value);
            }}
          />
        </label>
        <label className="flex flex-col gap-[3px] text-[11.5px]">
          <span className="text-muted-foreground text-[11px]">↑ Upload</span>
          <Input
            className="w-[150px]"
            placeholder="2M · blank = unlimited"
            value={ul}
            onChange={(e) => {
              setDirty(true);
              setUl(e.target.value);
            }}
          />
        </label>
        <Button size="sm" type="accent" loading={busy} onClick={() => void apply(dl, ul)}>
          Apply
        </Button>
        <Button
          size="sm"
          ghost
          disabled={busy || !hasLimit}
          onClick={() => {
            setDl("");
            setUl("");
            void apply("", "");
          }}
        >
          Remove
        </Button>
      </div>
      {msg && <div className="mt-1.5 text-muted-foreground text-xs">{msg}</div>}
    </div>
  );
}

// ── Detail panel (selected device) ──────────────────────────────────────────

/** Detail panel for the selected device: live ↓/↑ rates, chart, totals, limits. */
function DeviceDetail({
  device,
  deviceName,
  traffic,
}: {
  device: Device;
  deviceName: string;
  traffic: IpTraffic | undefined;
}): ReactNode {
  const hasTraffic = traffic !== undefined;
  return (
    <div className="mt-3.5 border-t border-border pt-3.5">
      <div className="mb-2.5 flex flex-wrap items-baseline gap-3">
        <span className="text-sm font-semibold">{device.host || device.comment || device.ip}</span>
        <span className="text-muted-foreground text-[11px]">
          {device.ip || "no IP"} · {device.mac} · {device.iface || "?"} · {device.status}
        </span>
      </div>
      {!hasTraffic ? (
        <Note type="secondary" label="No traffic yet">
          No traffic seen for <code>{device.ip}</code> yet. Rates appear here as soon as the device
          sends or receives.
        </Note>
      ) : (
        <>
          <div className="mb-2 flex gap-[18px] tabular-nums">
            <span className="font-semibold text-success">↓ {mbps(traffic.rxRate)}</span>
            <span className="font-semibold text-warning">↑ {mbps(traffic.txRate)}</span>
          </div>
          <TrafficChart history={traffic.history} />
          <div className="mt-2 text-muted-foreground text-xs tabular-nums">
            total ↓ {bytes(traffic.rxBytes)} · ↑ {bytes(traffic.txBytes)}
          </div>
        </>
      )}
      {device.ip && (
        <LimitsEditor
          ip={device.ip}
          deviceName={deviceName}
          current={{
            download: traffic?.downloadLimit ?? "",
            upload: traffic?.uploadLimit ?? "",
          }}
          onSaved={() => {}}
        />
      )}
      {device.ip && (
        <div className="mt-4">
          <div className="mb-2 text-xs font-semibold text-muted-foreground">
            Usage history · last 3 months
          </div>
          <UsageHistoryChart
            endpoint={`/api/usage/client?ip=${encodeURIComponent(device.ip)}${
              deviceName ? `&device=${encodeURIComponent(deviceName)}` : ""
            }&days=90`}
            days={90}
          />
        </div>
      )}
    </div>
  );
}

// ── Bulk traffic hook ───────────────────────────────────────────────────────

const EMPTY_TRAFFIC: BulkTraffic = { map: new Map(), source: "accounting" };

/**
 * Fold one server sample into the traffic map. The server normalises both
 * RouterOS sources — `/ip accounting` (v6) and Kid Control (v7) — into live rates
 * (bits/sec) plus cumulative bytes per IP, so this just carries the sparkline
 * history forward: a zero is pushed for an idle host so its line decays smoothly
 * instead of vanishing, and idle hosts with no rate limit are pruned once their
 * whole window is quiet, keeping the map from growing without bound.
 */
function applyTrafficSample(old: BulkTraffic, sample: BulkTrafficSample): BulkTraffic {
  const ids = new Set<string>([
    ...old.map.keys(),
    ...Object.keys(sample.hosts),
    ...Object.keys(sample.limits),
  ]);
  const next = new Map<string, IpTraffic>();
  for (const ip of ids) {
    const h = sample.hosts[ip];
    const rxRate = h?.rxRate ?? 0;
    const txRate = h?.txRate ?? 0;
    const ex = old.map.get(ip);
    const history = [...(ex?.history ?? []), { rx: rxRate, tx: txRate }].slice(-MINI_SAMPLES);
    const lim = sample.limits[ip];
    if (!lim && !history.some((p) => p.rx > 0 || p.tx > 0)) continue;
    next.set(ip, {
      rxRate,
      txRate,
      rxBytes: h?.rxBytes ?? ex?.rxBytes ?? 0,
      txBytes: h?.txBytes ?? ex?.txBytes ?? 0,
      downloadLimit: lim?.download ?? "",
      uploadLimit: lim?.upload ?? "",
      history,
    });
  }
  return { map: next, source: sample.source, note: sample.note };
}

/**
 * Live per-client traffic, received over — in order of preference — a WebSocket,
 * an SSE stream, then 1-second HTTP polling as the third fallback. The server
 * runs a single poller per device and pushes each sample to all subscribers, so
 * the router is sampled once per interval no matter how many dashboards are open
 * (which also keeps the `/ip accounting` snapshot from being reset by racing
 * pollers). Every transport delivers the same sample shape through
 * {@link applyTrafficSample}.
 */
function useBulkTraffic(deviceName: string): BulkTraffic {
  const [traffic, setTraffic] = useState<BulkTraffic>(EMPTY_TRAFFIC);

  useEffect(() => {
    setTraffic(EMPTY_TRAFFIC);
  }, [deviceName]);

  useEffect(() => {
    if (!deviceName) return;
    let closed = false;
    let ws: WebSocket | null = null;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const q = `traffic=${encodeURIComponent(deviceName)}`;

    const onSample = (sample: BulkTrafficSample): void => {
      if (!closed) setTraffic((old) => applyTrafficSample(old, sample));
    };

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
        } catch {
          /* transient poll error */
        }
      };
      void poll();
      pollTimer = setInterval(() => void poll(), BULK_POLL_MS);
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
        // Never established → give up on SSE and fall to polling. If it had
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
        if (opened) setTimeout(connectWs, 2000); // was working — reconnect
        else connectSse(); // never opened — fall to SSE
      };
    };

    connectWs();
    return () => {
      closed = true;
      ws?.close();
      es?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [deviceName]);

  return traffic;
}

// ── Main view ───────────────────────────────────────────────────────────────

/** Connected LAN devices for one router: usage charts, block/allow, pin/relabel IP. */
export function ClientsView(): ReactNode {
  const [routers, setRouters] = useState<DevicesPayload | null>(null);
  const [deviceName, setDeviceName] = useState<string>("");
  const [view, setView] = useState<DevicesView | null>(null);
  const [selected, setSelected] = useState<string | null>(null); // MAC
  const [busy, setBusy] = useState<string | null>(null); // MAC currently mutating
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // Inline editor for "Set IP" / "Label" (no native prompt — see no-alert lint).
  const [edit, setEdit] = useState<{ mac: string; field: "ip" | "label"; value: string } | null>(
    null,
  );

  // Bulk traffic: polls every 1s; server picks /ip accounting (v6) or Kid Control (v7).
  const { map: trafficMap, source: trafficSource, note: trafficNote } = useBulkTraffic(deviceName);

  // Discover the configured routers so the user can pick which one to inspect.
  useEffect(() => {
    void api<DevicesPayload>("/api/devices")
      .then((r) => {
        setRouters(r);
        setDeviceName((cur) => cur || r.defaultDevice || r.devices[0]?.name || "");
      })
      .catch(() => setRouters({ server: "", defaultDevice: "", devices: [] }));
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      const q = deviceName ? `?device=${encodeURIComponent(deviceName)}` : "";
      setView(await api<DevicesView>(`/api/clients${q}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [deviceName]);

  // Load on device change, then refresh the list lightly (status can change).
  useEffect(() => {
    setView(null);
    setSelected(null);
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

  const openEdit = useCallback((d: Device, field: "ip" | "label"): void => {
    setSelected(d.mac);
    setEdit({ mac: d.mac, field, value: field === "ip" ? d.ip : d.comment || d.host });
  }, []);
  const saveEdit = useCallback(async (): Promise<void> => {
    if (!edit) return;
    const v = edit.value.trim();
    if (edit.field === "ip") {
      if (v) await act("set-ip", edit.mac, { ip: v });
    } else {
      await act("label", edit.mac, { label: v });
    }
    setEdit(null);
  }, [edit, act]);

  const shown = useMemo(() => {
    const list = view?.devices ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (d) =>
        d.ip.toLowerCase().includes(q) ||
        d.mac.toLowerCase().includes(q) ||
        d.host.toLowerCase().includes(q) ||
        d.comment.toLowerCase().includes(q),
    );
  }, [view, filter]);

  const selectedDevice = useMemo(
    () => view?.devices.find((d) => d.mac === selected) ?? null,
    [view, selected],
  );

  const routerOptions = routers?.devices ?? [];
  const counts = view?.counts;

  return (
    <section className="grid content-start gap-[18px]">
      <Panel
        title="Connected clients"
        className="reveal"
        extra={
          <div className="flex items-center gap-2">
            {routerOptions.length > 1 && (
              <Select
                value={deviceName}
                onValueChange={setDeviceName}
                aria-label="Router"
                options={routerOptions.map((d) => ({
                  value: d.name,
                  label: `${d.name}${d.isDefault ? " (default)" : ""}`,
                }))}
              />
            )}
            <Input
              className="w-[200px]"
              placeholder="Filter IP / MAC / name…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <Button size="sm" ghost icon={<RefreshCw />} onClick={() => void load()}>
              Refresh
            </Button>
          </div>
        }
      >
        {counts && (
          <div className="mb-2.5 text-muted-foreground text-xs">
            {counts.total} total · {counts.static} static · {counts.blocked} blocked
          </div>
        )}

        {error && (
          <Note type="error" className="mb-2.5">
            {error}
          </Note>
        )}

        {trafficSource === "none" && trafficNote && (
          <Note type="warning" label="Traffic unavailable" className="mb-2.5">
            {trafficNote} The Traffic column needs per-host counters — <code>/ip accounting</code>{" "}
            on RouterOS v6, or Kid Control on v7.
          </Note>
        )}

        {!view ? (
          <div className="text-muted-foreground text-[11px]">loading connected devices…</div>
        ) : shown.length === 0 ? (
          <div className="grid justify-items-center gap-2 rounded-lg border border-dashed border-border px-4 py-[54px] text-center">
            <Wifi className="size-7 text-muted-foreground opacity-80" />
            <p className="m-0 font-semibold text-foreground">No connected devices</p>
            <p className="m-0 max-w-[460px] text-muted-foreground text-xs">
              Nothing in this router's DHCP-lease or ARP table{filter ? " matches the filter" : ""}.
            </p>
          </div>
        ) : (
          <Table className="text-[13px]">
            <TableHeader>
              <TableRow>
                <TableHead>IP</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>MAC</TableHead>
                <TableHead>Iface</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Traffic</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((d) => {
                const isSel = d.mac === selected;
                const isBusy = busy === d.mac;
                const t = d.ip ? trafficMap.get(d.ip) : undefined;
                const strike = d.blocked && "text-muted-foreground line-through";
                return (
                  <TableRow
                    key={d.mac}
                    data-state={isSel ? "selected" : undefined}
                    className="cursor-pointer"
                    onClick={() => setSelected(isSel ? null : d.mac)}
                  >
                    <TableCell className={cn("max-w-[120px] truncate", strike)}>
                      {d.ip || "—"}
                    </TableCell>
                    <TableCell className={cn("max-w-[200px] truncate", strike)}>
                      {d.host || d.comment || "(unknown)"}
                    </TableCell>
                    <TableCell className="font-mono text-[11.5px] text-muted-foreground">
                      {d.mac}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-[11px]">
                      {d.iface || ""}
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-1.5">
                        {d.static && <Badge type="secondary">static</Badge>}
                        {d.blocked ? (
                          <Badge type="error">blocked</Badge>
                        ) : (
                          <span className="text-muted-foreground text-[11px]">{d.status}</span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell>
                      {t ? (
                        <span className="flex items-center gap-1 overflow-hidden tabular-nums">
                          <span className="flex min-w-[48px] flex-col whitespace-nowrap leading-tight">
                            <span className="text-success">↓{compact(t.rxRate)}</span>
                            <span className="text-warning">↑{compact(t.txRate)}</span>
                          </span>
                          <MiniSparkline history={t.history} />
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-[11px]">{d.ip ? "—" : ""}</span>
                      )}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <span className="flex justify-end gap-1.5">
                        {d.blocked ? (
                          <Button
                            size="sm"
                            type="success"
                            ghost
                            loading={isBusy}
                            onClick={() => void act("allow", d.mac)}
                          >
                            Allow
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            type="error"
                            ghost
                            loading={isBusy}
                            onClick={() => void act("block", d.mac)}
                          >
                            Block
                          </Button>
                        )}
                        {!d.static && (
                          <Button
                            size="sm"
                            ghost
                            loading={isBusy}
                            onClick={() => void act("pin", d.mac)}
                          >
                            Pin IP
                          </Button>
                        )}
                        <Button size="sm" ghost disabled={isBusy} onClick={() => openEdit(d, "ip")}>
                          Set IP
                        </Button>
                        <Button
                          size="sm"
                          ghost
                          disabled={isBusy}
                          onClick={() => openEdit(d, "label")}
                        >
                          Label
                        </Button>
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        {edit && selectedDevice?.mac === edit.mac && (
          <div className="mt-3.5 flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2.5">
            <span className="text-[13px] text-muted-foreground">
              {edit.field === "ip" ? "Reserve IP for" : "Label for"}{" "}
              <b>{selectedDevice.host || selectedDevice.mac}</b>:
            </span>
            <Input
              className="w-[220px]"
              autoFocus
              value={edit.value}
              placeholder={edit.field === "ip" ? "e.g. 192.168.88.50" : "e.g. Ali phone"}
              onChange={(e) => setEdit({ ...edit, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveEdit();
                if (e.key === "Escape") setEdit(null);
              }}
            />
            <Button
              size="sm"
              type="accent"
              loading={busy === edit.mac}
              onClick={() => void saveEdit()}
            >
              Save
            </Button>
            <Button size="sm" ghost onClick={() => setEdit(null)}>
              Cancel
            </Button>
          </div>
        )}

        {selectedDevice && (
          <a
            className="inline-flex rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
            href={(() => {
              const url = new URL(location.href);
              url.searchParams.set("investigationDevice", deviceName);
              url.searchParams.set("investigationClient", selectedDevice.ip || selectedDevice.mac);
              url.hash = "investigations";
              return url.toString();
            })()}
          >
            Investigate this client and service
          </a>
        )}
        {selectedDevice && (
          <DeviceDetail
            device={selectedDevice}
            deviceName={deviceName}
            traffic={selectedDevice.ip ? trafficMap.get(selectedDevice.ip) : undefined}
          />
        )}
      </Panel>
    </section>
  );
}
