import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, SyntheticEvent } from "react";
import {
  Check,
  ChevronRight,
  Globe,
  LoaderCircle,
  Play,
  RefreshCw,
  Search,
  TriangleAlert,
  Wifi,
} from "lucide-react";
import { api, postJson } from "./api";
import { LoadingState } from "./loading-state";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorEmpty,
  MonitorPanel,
  PageIntro,
  RouterPicker,
  Segmented,
  StatusBadge,
  StatusDot,
  Ticker,
  useStaggerIn,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import {
  Checkbox,
  DetailBlock,
  DetailList,
  Field,
  NumberInput,
  RowDrawer,
  RowMenu,
  RowMore,
  Select,
  TextInput,
  tipProps,
} from "./kit";
import type { Tone as KitTone } from "./kit";
import type { Comparison, Diagnosis, Finding, HomeClient, PolicyPlan } from "../../src/home/model";
import "./home-internet.css";

type Tab = "diagnosis" | "people" | "paths";

const STATE_LABEL: Record<Finding["state"], string> = {
  observed: "Observed",
  suspected: "Suspected",
  unknown: "Unknown",
};

// Teal = measured now, amber = fits the evidence, grey = could not check.
const STATE_TONE: Record<Finding["state"], Tone> = {
  observed: "good",
  suspected: "warn",
  unknown: "default",
};

const POLICY_STATUS: Record<PolicyPlan["status"], { label: string; tone: Tone }> = {
  preview: { label: "Preview", tone: "default" },
  applying: { label: "Applying", tone: "warn" },
  scheduled: { label: "Scheduled", tone: "brand" },
  active: { label: "Active", tone: "warn" },
  uncertain: { label: "Uncertain", tone: "bad" },
  undone: { label: "Undone", tone: "default" },
};

const count = (n: number): string => String(Math.round(n));

const KIT_TONE: Record<Tone, KitTone> = {
  good: "ok",
  warn: "warn",
  bad: "bad",
  brand: "acc",
  default: "off",
};

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

/** A row's own buttons and fields act there; they do not open the row's details. */
const keepInRow = {
  onClick: (e: SyntheticEvent) => e.stopPropagation(),
  onKeyDown: (e: SyntheticEvent) => e.stopPropagation(),
};

type Picked = { t: "new" | "client" | "path" | "policy"; key: string } | null;

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

function ago(at: number, now: number): string {
  const min = Math.floor((now - at) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} h ago`;
  return new Date(at).toLocaleDateString();
}

function inMinutes(at: number, now: number): string {
  const min = Math.max(0, Math.ceil((at - now) / 60_000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

function lasts(minutes: number): string {
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
}

/** How much of a temporary change has run, 0 to 100. */
function elapsed(p: PolicyPlan, now: number): number {
  const start = p.startsAt ?? p.createdAt;
  if (!p.endsAt || p.endsAt <= start) return 0;
  return Math.max(0, Math.min(100, ((now - start) / (p.endsAt - start)) * 100));
}

/** Locally administered MACs are the random ones phones use for privacy. */
function privateMac(mac: string): boolean {
  return /^.[26ae]/i.test(mac);
}

function clientName(c: HomeClient | undefined): string {
  return c?.name || c?.hostname || "Unnamed device";
}

interface PickerItem {
  value: string;
  label: string;
  /** Shown after the label in mono, e.g. the device's IPv4. */
  detail?: string;
}

/** Picker items as kit options: the detail (an IPv4) rides as meta. */
function pickerOptions(items: PickerItem[]) {
  return items.map((i) => ({ value: i.value, label: i.label, meta: i.detail }));
}

/** The routers the page can work on, and which one is in use. */
interface RouterChoice {
  routers: string[];
  defaultRouter: string;
  device: string;
  onDevice: (name: string) => void;
}

export function HomeInternetView() {
  const [initialLoading, setInitialLoading] = useState(true);
  const [devices, setDevices] = useState<string[]>([]),
    [defaultRouter, setDefaultRouter] = useState(""),
    [device, setDevice] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void api<{ devices: { name: string }[]; defaultDevice: string }>("/api/devices")
      .then((r) => {
        if (!cancelled) {
          setDevices(r.devices.map((d) => d.name));
          setDefaultRouter(r.defaultDevice);
          setDevice(r.defaultDevice || r.devices[0]?.name || "");
        }
      })
      .catch(() => {
        if (!cancelled)
          setError("Could not load routers. Check the dashboard connection and reload.");
      })
      .finally(() => setInitialLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);
  const choice: RouterChoice = { routers: devices, defaultRouter, device, onDevice: setDevice };
  return (
    <div className="home-internet">
      {device ? (
        <Workspace key={device} choice={choice} />
      ) : (
        <>
          <PageIntro
            eyebrow="Home Internet"
            verdict="Find what slows a device down."
            lead="Checks are read-only. The router changes only after you review a preview."
            actions={
              <RouterPicker
                value={device}
                onChange={setDevice}
                routers={devices}
                defaultRouter={defaultRouter}
                disabled={!devices.length}
              />
            }
          />
          {error && (
            <p role="alert" className="monitor-note" data-tone="bad">
              <TriangleAlert className="text-destructive" />
              {error}
            </p>
          )}
          {initialLoading && <LoadingState label="Loading home network" layout="cards" />}
        </>
      )}
    </div>
  );
}

const PATH_LABEL: Record<string, string> = {
  DNS: "Router DNS",
  Internet: "Internet path · main",
};
// The area's cause, as the header names it.
const CAUSE_LABEL: Record<string, string> = {
  "Wi-Fi": "Wi-Fi signal",
  Router: "Router load",
  Internet: "The internet path",
  Bandwidth: "A bandwidth limit",
};
// Order of the hops from the device out to the internet.
const PATH_ORDER = ["Wi-Fi", "Router", "DNS", "Internet", "Bandwidth"];

const HOP_COLOR: Record<Finding["state"], string> = {
  observed: "var(--sig)",
  suspected: "var(--warning)",
  unknown: "var(--text-faint)",
};

const HOP_TONE: Record<Finding["state"], Tone> = {
  observed: "good",
  suspected: "warn",
  unknown: "default",
};

/** The first sentence of a finding's detail, for the one-line hop. */
function firstSentence(text: string): string {
  const end = text.indexOf(". ");
  return end === -1 ? text.replace(/\.$/, "") : text.slice(0, end);
}

interface Hop {
  key: string;
  label: ReactNode;
  sub: ReactNode;
  title: string;
  state: Finding["state"];
}

/** The header graphic: the device, each checked hop, then the app. */
function PathChain({
  diagnosis,
  client,
  device,
  target,
}: {
  diagnosis: Diagnosis | undefined;
  client: HomeClient | undefined;
  device: string;
  target: string;
}): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  useStaggerIn(root, ".home-hop", diagnosis?.at);
  const head = (
    <div className="home-chain-head">
      <span className="home-label">Path from the device to {diagnosis?.target ?? target}</span>
      {diagnosis && <span className="home-mono home-mut">checked {clock(diagnosis.at)}</span>}
    </div>
  );
  if (!diagnosis)
    return (
      <div className="home-chain">
        {head}
        <MonitorEmpty compact icon={<Search />} title="No check yet">
          Pick a device and a website, then press Check connection.
        </MonitorEmpty>
      </div>
    );
  const rank = (area: string) => {
    const i = PATH_ORDER.indexOf(area);
    return i === -1 ? PATH_ORDER.length : i;
  };
  const hops: Hop[] = [
    {
      key: "device",
      label: client ? clientName(client) : diagnosis.client,
      sub: (
        <>
          <span className="home-mono">{diagnosis.client}</span>
          {client ? (client.present ? " · lease bound" : " · no lease at the last scan") : ""}
        </>
      ),
      title: diagnosis.client,
      state: client?.present ? "observed" : "unknown",
    },
    ...[...diagnosis.findings]
      .sort((a, b) => rank(a.area) - rank(b.area))
      .map((f) => ({
        key: f.area,
        label: f.area === "Router" ? device : (PATH_LABEL[f.area] ?? f.area),
        sub: firstSentence(f.detail),
        title: f.detail,
        state: f.state,
      })),
    {
      key: "app",
      label: "App on the device",
      sub: "Not checked from the router",
      title: "The router cannot see inside the app.",
      state: "unknown",
    },
  ];
  return (
    <div className="home-chain kit-tips" ref={root}>
      {head}
      {hops.map((h, i) => (
        <div
          key={h.key}
          className="home-hop"
          {...tipProps(() => ({
            title: h.label,
            led: KIT_TONE[HOP_TONE[h.state]],
            rows: [
              { label: "State", value: STATE_LABEL[h.state] },
              { label: "Detail", value: h.title },
            ],
          }))}
        >
          {i < hops.length - 1 && (
            <span
              className="home-hop-line"
              style={{ background: HOP_COLOR[hops[i + 1].state] }}
              aria-hidden="true"
            />
          )}
          <span
            className="home-hop-node"
            style={{ boxShadow: `inset 0 0 0 1.5px ${HOP_COLOR[h.state]}` }}
            aria-hidden="true"
          >
            <StatusDot tone={HOP_TONE[h.state]} />
          </span>
          <span className="home-hop-text">
            <span className="home-hop-label">{h.label}</span>
            <span className="home-hop-sub">{h.sub}</span>
          </span>
          <StatusBadge tone={STATE_TONE[h.state]} dot={false}>
            {STATE_LABEL[h.state]}
          </StatusBadge>
        </div>
      ))}
    </div>
  );
}

/** Findings plus the app on the device, which the router never checks. */
function tallies(diagnosis: Diagnosis) {
  const count = (state: Finding["state"]) =>
    diagnosis.findings.filter((f) => f.state === state).length;
  const observed = count("observed");
  const suspected = count("suspected");
  const unknown = count("unknown") + 1;
  const total = observed + suspected + unknown;
  return {
    total,
    text: `The router checked ${total} ${total === 1 ? "thing" : "things"}: ${observed} observed, ${suspected} suspected, ${unknown} it could not check.`,
  };
}

/** The header's answer line for the last check. */
function verdictLine(diagnosis: Diagnosis | undefined, name: string): ReactNode {
  if (!diagnosis) return "Find what slows a device down.";
  const causes = diagnosis.findings.filter((f) => f.state === "suspected");
  const cause = (f: Finding, lower: boolean) => {
    const text = CAUSE_LABEL[f.area] ?? f.area;
    return (
      <span key={f.area} className="w">
        {lower ? text.charAt(0).toLowerCase() + text.slice(1) : text}
      </span>
    );
  };
  if (causes.length === 0)
    return (
      <>
        {name} is slow. <span className="s">Nothing the router checked</span> looks wrong.
      </>
    );
  if (causes.length === 1)
    return (
      <>
        {name} is slow. {cause(causes[0], false)} is the likely cause.
      </>
    );
  return (
    <>
      {name} is slow. {cause(causes[0], false)} and {cause(causes[1], true)}
      {causes.length > 2 ? " and more" : ""} may be the cause.
    </>
  );
}

function Workspace({ choice }: { choice: RouterChoice }) {
  const { device } = choice;
  const [tab, setTab] = useState<Tab>("diagnosis");
  const [clients, setClients] = useState<HomeClient[]>([]),
    [policies, setPolicies] = useState<PolicyPlan[]>([]),
    [tables, setTables] = useState<string[]>([]),
    [scanned, setScanned] = useState(false);
  const [client, setClient] = useState(""),
    [target, setTarget] = useState("example.com"),
    [pathTarget, setPathTarget] = useState("1.1.1.1");
  const [selectedTables, setSelectedTables] = useState<string[]>([]),
    [goal, setGoal] = useState("calls");
  const [diagnosis, setDiagnosis] = useState<Diagnosis>(),
    [comparison, setComparison] = useState<Comparison>();
  const [action, setAction] = useState<"pause" | "priority" | "route">("pause"),
    [routeTable, setRouteTable] = useState(""),
    [minutes, setMinutes] = useState("30"),
    [delay, setDelay] = useState("0");
  const [preview, setPreview] = useState<PolicyPlan>(),
    [approved, setApproved] = useState(false),
    [undo, setUndo] = useState<{ id: string; from: "panel" | "history" }>(),
    [editing, setEditing] = useState<string>();
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const query = `?device=${encodeURIComponent(device)}`;
  const [now, setNow] = useState(() => Date.now());
  const [picked, setPicked] = useState<Picked>(null);
  const reportRef = useRef<HTMLDivElement>(null);
  const pathsRef = useRef<HTMLDivElement>(null);
  useStaggerIn(reportRef, ".home-finding", diagnosis?.at);
  useStaggerIn(pathsRef, ".home-path", comparison?.at);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  async function load() {
    const r = await api<{ clients: HomeClient[]; policies: PolicyPlan[] }>(
      `/api/home-internet${query}`,
    );
    setClients(r.clients);
    setPolicies(r.policies);
  }
  useEffect(() => {
    const controller = new AbortController();
    void api<{ clients: HomeClient[]; policies: PolicyPlan[] }>(
      `/api/home-internet${query}`,
      controller.signal,
    )
      .then((r) => {
        if (!controller.signal.aborted) {
          setClients(r.clients);
          setPolicies(r.policies);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Could not load the saved household. Retry with Refresh saved data.");
      });
    return () => controller.abort();
  }, [query]);
  async function request<T>(path: string, data: unknown): Promise<T> {
    const r = await postJson<T & { error?: string }>(`/api/home-internet/${path}${query}`, data);
    if (r.error) throw new Error(r.error);
    return r;
  }
  async function run(label: string, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed. No success has been confirmed.");
    } finally {
      setBusy("");
    }
  }
  const byMac = new Map(clients.map((c) => [c.mac, c]));
  const selected = byMac.get(client);
  const options = clients
    .filter((c) => c.ip)
    .map((c) => ({ value: c.mac, label: clientName(c), detail: c.ip }));
  const newClients = clients.filter((c) => !c.acknowledged);
  const bound = clients.filter((c) => c.present).length;
  const lastScan = clients.reduce((max, c) => Math.max(max, c.lastSeen), 0);
  const history = policies.filter((p) => p.status !== "preview");
  const live = history.filter((p) => p.status !== "undone" && !(p.endsAt && now > p.endsAt));
  const current = live[0];
  const soonest = live.reduce<number | undefined>(
    (min, p) => (p.endsAt && (min === undefined || p.endsAt < min) ? p.endsAt : min),
    undefined,
  );
  const resetPreview = () => {
    setPreview(undefined);
    setApproved(false);
  };
  const discover = () =>
    void run("Discovering household", async () => {
      const r = await request<{ clients: HomeClient[]; tables: string[] }>("refresh", {});
      setClients(r.clients);
      setTables(r.tables);
      setScanned(true);
      setSelectedTables((v) => v.filter((t) => r.tables.includes(t)));
      setNotice(
        "DHCP inventory updated. New-device notices start after the first baseline scan. No router settings changed.",
      );
    });
  const confirmUndo = (id: string) =>
    void run("Restoring the previous policy", async () => {
      await request("undo", { id, confirm: true });
      setUndo(undefined);
      await load();
      setNotice("Undo committed.");
    });
  const showHistory = () => {
    const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    document
      .getElementById("home-history")
      ?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  };
  const chooseClient = (mac: string) => {
    setClient(mac);
    resetPreview();
  };
  const nameClient = (mac: string) => {
    setEditing(mac);
    chooseClient(mac);
    setTab("people");
  };
  const choosePath = (table: string) => {
    setRouteTable(table);
    resetPreview();
  };
  const policyState = (p: PolicyPlan): string =>
    p.status === "undone"
      ? "Undone"
      : !!p.endsAt && now > p.endsAt
        ? "Expiry passed, cleanup not verified"
        : `${POLICY_STATUS[p.status].label}, saved status`;
  const clientItems = (c: HomeClient) => [
    { label: "Name", value: clientName(c) },
    { label: "Person", value: c.person || "No person assigned" },
    { label: "MAC address", value: c.mac, mono: true },
    { label: "IP address", value: c.ip || "No IPv4", mono: true },
    ...(c.hostname ? [{ label: "Host name", value: c.hostname, mono: true }] : []),
    { label: "Lease", value: c.present ? "Bound at last scan" : "Not bound at last scan" },
    { label: "First seen", value: new Date(c.firstSeen).toLocaleString() },
    { label: "Last seen", value: new Date(c.lastSeen).toLocaleString() },
    { label: "Acknowledged", value: c.acknowledged ? "Yes" : "No, new on the network" },
  ];
  const navOver = (keys: string[]) => {
    if (!picked) return undefined;
    const at = keys.indexOf(picked.key);
    if (at < 0) return undefined;
    return {
      index: at,
      total: keys.length,
      onPrev: at > 0 ? () => setPicked({ t: picked.t, key: keys[at - 1]! }) : undefined,
      onNext:
        at < keys.length - 1 ? () => setPicked({ t: picked.t, key: keys[at + 1]! }) : undefined,
    };
  };
  const drawer = ((): ReactNode => {
    if (!picked) return null;
    const close = () => setPicked(null);
    if (picked.t === "new" || picked.t === "client") {
      const list = picked.t === "new" ? newClients : clients;
      const c = list.find((x) => x.mac === picked.key);
      if (!c) return null;
      return (
        <RowDrawer
          open
          onClose={close}
          label={`Device details: ${clientName(c)}`}
          storageKey="home-internet"
          rowKey={`${picked.t}:${c.mac}`}
          status={c.acknowledged ? undefined : { tone: "warn", label: "New" }}
          title={clientName(c)}
          meta={`${c.person || "No person assigned"} · ${c.ip || "No IPv4"}`}
          nav={navOver(list.map((x) => x.mac))}
          actions={
            <MonitorButton
              variant="ghost"
              size="sm"
              disabled={!!busy}
              onClick={() => {
                close();
                nameClient(c.mac);
              }}
            >
              {picked.t === "new" ? "Name" : "Name / acknowledge"}
            </MonitorButton>
          }
          primary={
            <MonitorButton size="sm" disabled={!!busy} onClick={() => chooseClient(c.mac)}>
              {client === c.mac ? "Selected" : "Manage device"}
            </MonitorButton>
          }
        >
          <DetailList items={clientItems(c)} />
        </RowDrawer>
      );
    }
    if (picked.t === "path") {
      const p = comparison?.paths.find((x) => x.table === picked.key);
      if (!p || !comparison) return null;
      return (
        <RowDrawer
          open
          onClose={close}
          label={`Path details: ${p.table}`}
          storageKey="home-internet"
          rowKey={`path:${p.table}`}
          status={
            comparison.recommended === p.table
              ? { tone: "ok", label: "Best in this small sample" }
              : undefined
          }
          title={<span className="home-mono">{p.table}</span>}
          meta={`${comparison.target} · checked ${clock(comparison.at)}`}
          nav={navOver(comparison.paths.map((x) => x.table))}
          primary={
            <MonitorButton size="sm" onClick={() => choosePath(p.table)}>
              Choose for preview
            </MonitorButton>
          }
        >
          <p className="home-detail">{p.note}</p>
          <DetailList
            items={[
              { label: "Loss", value: p.loss === null ? "Unknown" : `${p.loss.toFixed(0)}%` },
              {
                label: "Avg RTT",
                value: p.latency === null ? "Unknown" : `${p.latency.toFixed(1)} ms`,
              },
              {
                label: "RTT range",
                value: p.spread === null ? "Unknown" : `${p.spread.toFixed(1)} ms`,
              },
            ]}
          />
        </RowDrawer>
      );
    }
    const p = history.find((x) => x.id === picked.key);
    if (!p) return null;
    const expired = p.status !== "undone" && !!p.endsAt && now > p.endsAt;
    return (
      <RowDrawer
        open
        onClose={close}
        label={`Change details: ${clientName(byMac.get(p.input.mac))}`}
        storageKey="home-internet"
        rowKey={`policy:${p.id}`}
        status={{
          tone: expired ? "warn" : KIT_TONE[POLICY_STATUS[p.status].tone],
          label: policyState(p),
        }}
        title={
          <>
            {clientName(byMac.get(p.input.mac))} · {p.input.action}
            {p.input.table ? ` → ${p.input.table}` : ""}
          </>
        }
        meta={p.ip}
        nav={navOver(history.map((x) => x.id))}
        actions={
          p.status !== "undone" ? (
            <MonitorButton
              variant="danger"
              size="sm"
              disabled={!!busy}
              onClick={() => {
                close();
                setUndo({ id: p.id, from: "history" });
              }}
            >
              Undo / reconcile
            </MonitorButton>
          ) : undefined
        }
      >
        <DetailList
          items={[
            { label: "Action", value: p.input.action },
            ...(p.input.table
              ? [{ label: "Routing table", value: p.input.table, mono: true }]
              : []),
            { label: "IP address", value: p.ip, mono: true },
            { label: "Started", value: clock(p.startsAt ?? p.createdAt) },
            { label: "Lasts", value: lasts(p.input.minutes) },
            ...(p.endsAt ? [{ label: "Until", value: new Date(p.endsAt).toLocaleString() }] : []),
            { label: "Status", value: policyState(p) },
            ...(p.error ? [{ label: "Error", value: p.error }] : []),
          ]}
        />
        {p.commands.length > 0 && (
          <DetailBlock label="Commands" aside={String(p.commands.length)}>
            <pre className="monitor-pre break-words">{p.commands.join("\n")}</pre>
          </DetailBlock>
        )}
        {p.undo.length > 0 && (
          <DetailBlock label="Undo" aside={String(p.undo.length)}>
            <pre className="monitor-pre break-words">{p.undo.join("\n")}</pre>
          </DetailBlock>
        )}
      </RowDrawer>
    );
  })();

  const temporaryPanel = (
    <MonitorPanel
      title="Temporary change"
      description="Saved status, not live proof"
      extra={
        current && (
          <StatusBadge
            tone={current.status === "active" ? "good" : POLICY_STATUS[current.status].tone}
            dot
          >
            {POLICY_STATUS[current.status].label}
          </StatusBadge>
        )
      }
      bodyClassName={current ? "home-temp" : undefined}
    >
      {current ? (
        <>
          <p className="home-temp-line">
            <PolicySentence policy={current} client={byMac.get(current.input.mac)} />
          </p>
          <dl className="home-temp-times">
            <div className="glass">
              <dt>Started</dt>
              <dd>{clock(current.startsAt ?? current.createdAt)}</dd>
            </div>
            <div className="glass">
              <dt>Lasts</dt>
              <dd>{lasts(current.input.minutes)}</dd>
            </div>
            <div className="glass">
              <dt>Ends in</dt>
              <dd className="home-warn">
                {current.endsAt ? inMinutes(current.endsAt, now) : "Unknown"}
              </dd>
            </div>
          </dl>
          {current.endsAt && (
            <span
              className="monitor-bar"
              aria-label={`${Math.round(elapsed(current, now))}% of the change has run`}
              {...tipProps(() => ({
                title: "Temporary change",
                sub: clientName(byMac.get(current.input.mac)),
                rows: [
                  {
                    label: "Elapsed",
                    value: `${Math.round(elapsed(current, now))}%`,
                    color: "var(--warning)",
                  },
                  { label: "Lasts", value: lasts(current.input.minutes) },
                  {
                    label: "Ends in",
                    value: current.endsAt ? inMinutes(current.endsAt, now) : "Unknown",
                  },
                ],
              }))}
            >
              <span
                data-tone="warn"
                // Elapsed share of the change; data-driven, so not a utility class.
                style={{ width: `${elapsed(current, now)}%` }}
              />
            </span>
          )}
          {current.error && <p className="home-temp-error">{current.error}</p>}
          {undo?.id === current.id && undo.from === "panel" ? (
            <UndoConfirm
              busy={!!busy}
              onCancel={() => setUndo(undefined)}
              onConfirm={() => confirmUndo(current.id)}
            />
          ) : (
            <div className="home-actions">
              <MonitorButton
                variant="danger"
                size="sm"
                disabled={!!busy}
                onClick={() => setUndo({ id: current.id, from: "panel" })}
              >
                Undo now
              </MonitorButton>
              <MonitorButton
                variant="ghost"
                size="sm"
                icon={<ChevronRight />}
                onClick={showHistory}
              >
                View history
              </MonitorButton>
            </div>
          )}
          {live.length > 1 && (
            <p className="home-hint">{live.length - 1} more in the history below.</p>
          )}
        </>
      ) : (
        <MonitorEmpty compact title="No temporary change">
          Your router configuration stays as it is.
        </MonitorEmpty>
      )}
    </MonitorPanel>
  );

  const duration = (
    <Duration
      minutes={minutes}
      delay={delay}
      setMinutes={(v) => {
        setMinutes(v);
        resetPreview();
      }}
      setDelay={(v) => {
        setDelay(v);
        resetPreview();
      }}
    />
  );

  const checked = clients.find((c) => c.ip === diagnosis?.client);
  const checkedName = checked ? clientName(checked) : (diagnosis?.client ?? "");

  return (
    <>
      <PageIntro
        eyebrow={`Home Internet · ${device}`}
        verdict={verdictLine(diagnosis, checkedName)}
        lead={
          diagnosis
            ? `${tallies(diagnosis).text} Nothing on the router changed.`
            : "Checks are read-only. The router changes only after you review a preview."
        }
        actions={
          <>
            <RouterPicker
              value={device}
              onChange={choice.onDevice}
              routers={choice.routers}
              defaultRouter={choice.defaultRouter}
            />
            <MonitorButton variant="primary" icon={<Search />} disabled={!!busy} onClick={discover}>
              Discover devices & paths
            </MonitorButton>
            <MonitorButton
              variant="ghost"
              icon={<RefreshCw />}
              disabled={!!busy}
              onClick={() => void run("Loading saved data", load)}
            >
              Refresh saved data
            </MonitorButton>
            <span className="home-last-scan">
              {lastScan ? `Last scan ${ago(lastScan, now)}` : "Not scanned yet"}
            </span>
          </>
        }
        aside={
          <div className="glass overflow-hidden">
            <PathChain diagnosis={diagnosis} client={checked} device={device} target={target} />
          </div>
        }
      />

      <MetricStrip label="Home summary" minCell={200} className="home-kpis">
        <Metric
          label="Devices"
          value={<Ticker value={clients.length} format={count} />}
          hint={clients.length ? `${bound} with a DHCP lease` : "Run discovery first"}
        />
        <Metric
          label="New devices"
          tone={newClients.length ? "warn" : "default"}
          value={<Ticker value={newClients.length} format={count} />}
          hint={newClients.length ? "Not named yet" : "None since the last scan"}
        />
        <Metric
          label="Routing tables"
          value={scanned ? <Ticker value={tables.length} format={count} /> : "—"}
          hint={
            scanned ? (
              tables.length ? (
                <span className="font-mono">{tables.join(", ")}</span>
              ) : (
                "None ready"
              )
            ) : (
              "Run discovery first"
            )
          }
        />
        <Metric
          label="Temporary changes"
          value={<Ticker value={live.length} format={count} />}
          hint={soonest ? `Ends in ${inMinutes(soonest, now)}` : "None active"}
        />
      </MetricStrip>

      <div className="home-tabs">
        <Segmented
          label="Section"
          value={tab}
          onChange={setTab}
          options={[
            { value: "diagnosis", label: "Find the slowdown" },
            {
              value: "people",
              label: (
                <>
                  Your household{" "}
                  {newClients.length > 0 && (
                    <span className="home-tab-badge">{newClients.length} new</span>
                  )}
                </>
              ),
            },
            { value: "paths", label: "Choose a path" },
          ]}
        />
        <span className="home-tabs-spacer" />
        <span className="home-last-scan">Scans run only when you ask</span>
      </div>

      {(busy || error || notice) && (
        <div className="home-notes">
          {busy && (
            <p className="monitor-note" role="status">
              <LoaderCircle className="home-spin text-muted-foreground" />
              {busy}…
            </p>
          )}
          {error && (
            <p className="monitor-note" data-tone="bad" role="alert">
              <TriangleAlert className="text-destructive" />
              {error}
            </p>
          )}
          {notice && (
            <p className="monitor-note" role="status">
              <Check className="text-success" />
              {notice}
            </p>
          )}
        </div>
      )}

      {preview && (
        <MonitorPanel
          aria-label="Review temporary change"
          tone="warn"
          title="Review before anything changes"
          description={
            <>
              {preview.device} · <span className="home-mono">{preview.input.mac}</span> ·{" "}
              {preview.ip} · {preview.input.action}
              {preview.input.table ? ` → ${preview.input.table}` : ""}
            </>
          }
          extra={<StatusBadge tone="warn">Preview</StatusBadge>}
          bodyClassName="home-review"
        >
          <p>
            Starts{" "}
            {preview.input.startInMinutes
              ? `in ${preview.input.startInMinutes} minutes`
              : "after you confirm"}
            ; lasts {preview.input.minutes} minutes. The preview expires at{" "}
            {new Date(preview.previewExpiresAt).toLocaleTimeString()}.
          </p>
          {preview.warnings.length > 0 && (
            <ul className="home-warnings">
              {preview.warnings.map((w) => (
                <li key={w}>
                  <TriangleAlert className="text-warning" />
                  {w}
                </li>
              ))}
            </ul>
          )}
          <details className="home-commands">
            <summary>Exact RouterOS changes and rollback</summary>
            <pre>
              {preview.commands.join("\n")}
              {"\n\n# Undo only this policy\n"}
              {preview.undo.join("\n")}
            </pre>
          </details>
          <Checkbox
            tone="warn"
            checked={approved}
            onCheckedChange={setApproved}
            label="I reviewed this device, route and duration. Open connections may drop."
          />
          <div className="home-actions">
            <MonitorButton disabled={!!busy} onClick={resetPreview}>
              Discard preview
            </MonitorButton>
            <MonitorButton
              variant="primary"
              disabled={!!busy || !approved || now > preview.previewExpiresAt}
              onClick={() =>
                void run("Applying approved policy", async () => {
                  const result = await request<PolicyPlan>("apply", {
                    id: preview.id,
                    confirm: true,
                  });
                  resetPreview();
                  await load();
                  setNotice(
                    `Change ${result.status}. Snapshot before the change: ${result.snapshot ?? "not returned"}. The router removes it on expiry; check the device to confirm.`,
                  );
                })
              }
            >
              Apply this temporary change
            </MonitorButton>
          </div>
        </MonitorPanel>
      )}

      {tab === "diagnosis" && (
        <div className="home-cols">
          <div className="home-main" ref={reportRef}>
            <MonitorPanel
              title="Check a slow connection"
              description="Looks at the router, DNS, Wi-Fi and a few small probes. Nothing is changed."
            >
              <div className="home-form home-check-form">
                <Field label="Device" className="home-field">
                  <Select
                    label="Device"
                    leading={<Wifi className="home-icon" aria-hidden="true" />}
                    value={client}
                    options={pickerOptions(options)}
                    showMeta
                    onChange={setClient}
                    disabled={!!busy}
                  />
                </Field>
                <Field label="Website or IPv4" className="home-field">
                  <TextInput
                    label="Website or IPv4"
                    icon={<Globe className="home-icon" aria-hidden="true" />}
                    value={target}
                    onChange={setTarget}
                    placeholder="example.com"
                  />
                </Field>
                <MonitorButton
                  variant="primary"
                  icon={<Play />}
                  disabled={!!busy || !selected?.ip || !target}
                  onClick={() =>
                    void run("Checking the connection", async () => {
                      setDiagnosis(undefined);
                      setDiagnosis(
                        await request<Diagnosis>("diagnose", { client: selected!.ip, target }),
                      );
                    })
                  }
                >
                  Check connection
                </MonitorButton>
              </div>
              {!clients.length && (
                <p className="home-hint home-hint-gap">
                  Start with Discover devices & paths. To check a device with no DHCP record, use{" "}
                  <a href="#investigations">Investigations</a>.
                </p>
              )}
            </MonitorPanel>

            <Report
              diagnosis={diagnosis}
              client={clients.find((c) => c.ip === diagnosis?.client)}
              onCompare={() => setTab("paths")}
            />
          </div>

          <div className="home-side">
            {temporaryPanel}
            <MonitorPanel
              title="New on the network"
              description="Name them so reports read better"
              flush
            >
              {newClients.length === 0 ? (
                <MonitorEmpty compact title="Nothing new">
                  {lastScan
                    ? "No new devices since the last scan."
                    : "Run discovery to list devices."}
                </MonitorEmpty>
              ) : (
                <>
                  <div className="monitor-thead home-new-row">
                    <span>Device</span>
                    <span />
                    <span />
                  </div>
                  {newClients.map((c) => (
                    <RowMenu
                      key={c.mac}
                      title={clientName(c)}
                      sub={c.ip ? `${c.mac} · ${c.ip}` : c.mac}
                      onOpen={() => setPicked({ t: "new", key: c.mac })}
                      cells={{
                        device: { value: clientName(c) },
                        mac: { value: c.mac, kind: "id" },
                      }}
                      copies={[
                        { label: "MAC address", value: c.mac },
                        ...(c.ip ? [{ label: "IP address", value: c.ip }] : []),
                      ]}
                      row={c}
                      actions={[
                        { label: "Name", disabled: !!busy, onSelect: () => nameClient(c.mac) },
                      ]}
                    >
                      <div
                        role="button"
                        tabIndex={0}
                        aria-label={`${clientName(c)}, new on the network`}
                        className="monitor-row home-new-row"
                        data-selected={(picked?.t === "new" && picked.key === c.mac) || undefined}
                        onClick={() => setPicked({ t: "new", key: c.mac })}
                        onKeyDown={onRowKey(() => setPicked({ t: "new", key: c.mac }))}
                      >
                        <span className="home-two">
                          <span data-col="device" className="p home-mono truncate">
                            {clientName(c)}
                          </span>
                          <span className="home-two-sub truncate">
                            <span data-col="mac" className="home-mono">
                              {c.mac}
                            </span>
                            {c.ip ? ` · ${c.ip}` : privateMac(c.mac) ? " · private MAC" : ""}
                          </span>
                        </span>
                        <MonitorButton
                          size="sm"
                          disabled={!!busy}
                          {...keepInRow}
                          onClick={(e) => {
                            e.stopPropagation();
                            nameClient(c.mac);
                          }}
                        >
                          Name
                        </MonitorButton>
                        <RowMore />
                      </div>
                    </RowMenu>
                  ))}
                </>
              )}
            </MonitorPanel>
          </div>
        </div>
      )}

      {tab === "people" && (
        <div className="home-cols">
          <div className="home-main">
            <MonitorPanel
              title="Household devices"
              description="Names stay in this dashboard. Scans run only when you ask, and private (random) MACs can show up as new."
              flush
            >
              {clients.length === 0 ? (
                <MonitorEmpty title="No household list yet">
                  Discover devices to take the first baseline.
                </MonitorEmpty>
              ) : (
                clients.map((c) => (
                  <ClientRow
                    key={c.mac}
                    client={c}
                    open={picked?.t === "client" && picked.key === c.mac}
                    onOpen={() => setPicked({ t: "client", key: c.mac })}
                    disabled={!!busy}
                    editing={editing === c.mac}
                    onEdit={() => setEditing(c.mac)}
                    onSave={(name, person) =>
                      void run("Saving device name", async () => {
                        await request("name", { mac: c.mac, name, person });
                        await load();
                        setEditing(undefined);
                        setNotice("Name saved here. New-device notice cleared.");
                      })
                    }
                    onChoose={() => chooseClient(c.mac)}
                    selected={client === c.mac}
                  />
                ))
              )}
            </MonitorPanel>
          </div>
          <div className="home-side">
            {temporaryPanel}
            <MonitorPanel
              title="Quiet time or meeting priority"
              description="Pause a device or put it first in an existing queue for a while. Needs a static DHCP lease. IPv6 and FastTrack limits are checked before the preview."
              bodyClassName="home-stack"
            >
              <Field label="Device" className="home-field">
                <Select
                  label="Device"
                  value={client}
                  options={pickerOptions(options)}
                  showMeta
                  onChange={chooseClient}
                  disabled={!!busy}
                />
              </Field>
              <Field label="Change" className="home-field">
                <Select
                  label="Change"
                  value={action === "route" ? "pause" : action}
                  options={pickerOptions([
                    { value: "pause", label: "Pause routed access" },
                    { value: "priority", label: "Meeting priority" },
                  ])}
                  showMeta
                  onChange={(v) => {
                    setAction(v as "pause" | "priority");
                    resetPreview();
                  }}
                  disabled={!!busy}
                />
              </Field>
              {duration}
              <MonitorButton
                variant="primary"
                disabled={!!busy || !selected}
                onClick={() =>
                  void run("Checking policy prerequisites", async () => {
                    resetPreview();
                    setPreview(
                      await request<PolicyPlan>("preview", {
                        mac: client,
                        action: action === "route" ? "pause" : action,
                        minutes: Number(minutes),
                        startInMinutes: Number(delay),
                      }),
                    );
                  })
                }
              >
                Review temporary change
              </MonitorButton>
            </MonitorPanel>
          </div>
        </div>
      )}

      {tab === "paths" && (
        <div className="home-cols">
          <div className="home-main" ref={pathsRef}>
            <MonitorPanel
              title="Compare paths"
              description="Up to three routing tables, five small probes each. No traffic moves and nothing large downloads."
              bodyClassName="home-stack"
            >
              <div className="home-form">
                <Field label="What matters most" className="home-field">
                  <Select
                    label="What matters most"
                    value={goal}
                    options={pickerOptions([
                      { value: "calls", label: "Stable calls" },
                      { value: "gaming", label: "Responsive gaming" },
                      { value: "download", label: "Downloads (measurements only)" },
                    ])}
                    showMeta
                    onChange={setGoal}
                  />
                </Field>
                <Field label="IPv4 to probe on every path" className="home-field">
                  <TextInput
                    label="IPv4 to probe on every path"
                    value={pathTarget}
                    onChange={setPathTarget}
                  />
                </Field>
              </div>
              <fieldset className="home-tables">
                <legend className="home-label">Paths to compare, up to three</legend>
                {tables.length > 0 ? (
                  <div className="home-table-options">
                    {tables.map((t) => (
                      <Checkbox
                        key={t}
                        className="home-table-option"
                        checked={selectedTables.includes(t)}
                        disabled={!selectedTables.includes(t) && selectedTables.length >= 3}
                        onCheckedChange={(checked) =>
                          setSelectedTables((v) => (checked ? [...v, t] : v.filter((x) => x !== t)))
                        }
                        label={<span className="home-mono">{t}</span>}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="home-hint">
                    Run Discover devices & paths to load the router's routing tables.
                  </p>
                )}
              </fieldset>
              <div>
                <MonitorButton
                  variant="primary"
                  disabled={!!busy || !selectedTables.length}
                  onClick={() =>
                    void run("Comparing internet paths", async () => {
                      setComparison(undefined);
                      setComparison(
                        await request<Comparison>("compare", {
                          tables: selectedTables,
                          target: pathTarget,
                          goal,
                        }),
                      );
                    })
                  }
                >
                  Compare paths
                </MonitorButton>
              </div>
            </MonitorPanel>

            {comparison && (
              <MonitorPanel
                title="Path comparison"
                description={`${comparison.target} · checked ${clock(comparison.at)}`}
                flush
              >
                <p className="home-summary">{comparison.explanation}</p>
                <div className="monitor-thead home-path-grid" aria-hidden="true">
                  <span>Path</span>
                  <span>Loss</span>
                  <span>Avg RTT</span>
                  <span>RTT range</span>
                  <span />
                  <span />
                </div>
                {comparison.paths.map((p) => (
                  <RowMenu
                    key={p.table}
                    title={p.table}
                    sub={p.note}
                    onOpen={() => setPicked({ t: "path", key: p.table })}
                    cells={{
                      path: { value: p.table },
                      loss: { value: p.loss === null ? "" : `${p.loss.toFixed(0)}%` },
                      avg: {
                        value: p.latency === null ? "" : `${p.latency.toFixed(1)} ms`,
                        kind: "duration",
                      },
                      range: {
                        value: p.spread === null ? "" : `${p.spread.toFixed(1)} ms`,
                        kind: "duration",
                      },
                    }}
                    copies={[{ label: "Routing table", value: p.table }]}
                    row={p}
                    actions={[{ label: "Choose for preview", onSelect: () => choosePath(p.table) }]}
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      aria-label={`${p.table}, ${p.note}`}
                      className="monitor-row home-path-grid home-path"
                      data-selected={routeTable === p.table || undefined}
                      onClick={() => setPicked({ t: "path", key: p.table })}
                      onKeyDown={onRowKey(() => setPicked({ t: "path", key: p.table }))}
                    >
                      <span data-col="path" className="min-w-0">
                        <span className="home-name">
                          <span className="home-mono">{p.table}</span>
                          {comparison.recommended === p.table && (
                            <StatusBadge tone="good">Best in this small sample</StatusBadge>
                          )}
                        </span>
                        <span className="home-detail">{p.note}</span>
                      </span>
                      <Stat
                        col="loss"
                        label="Loss"
                        value={p.loss === null ? null : `${p.loss.toFixed(0)}%`}
                      />
                      <Stat
                        col="avg"
                        label="Avg RTT"
                        value={p.latency === null ? null : `${p.latency.toFixed(1)} ms`}
                      />
                      <Stat
                        col="range"
                        label="RTT range"
                        value={p.spread === null ? null : `${p.spread.toFixed(1)} ms`}
                      />
                      <MonitorButton
                        size="sm"
                        {...keepInRow}
                        onClick={(e) => {
                          e.stopPropagation();
                          choosePath(p.table);
                        }}
                      >
                        Choose for preview
                      </MonitorButton>
                      <RowMore />
                    </div>
                  </RowMenu>
                ))}
              </MonitorPanel>
            )}
          </div>
          <div className="home-side">
            {temporaryPanel}
            <MonitorPanel
              title="Try a path for one device"
              description="Only an existing, ready routing table. IPv6 keeps its route; local and private addresses stay direct."
              bodyClassName="home-stack"
            >
              <Field label="Device" className="home-field">
                <Select
                  label="Device"
                  value={client}
                  options={pickerOptions(options)}
                  showMeta
                  onChange={chooseClient}
                  disabled={!!busy}
                />
              </Field>
              <Field label="Routing table" className="home-field">
                <Select
                  label="Routing table"
                  value={routeTable}
                  options={pickerOptions(tables.map((t) => ({ value: t, label: t })))}
                  showMeta
                  onChange={(v) => {
                    setRouteTable(v);
                    resetPreview();
                  }}
                  disabled={!!busy}
                />
              </Field>
              {duration}
              <MonitorButton
                variant="primary"
                disabled={!!busy || !client || !routeTable}
                onClick={() =>
                  void run("Preparing path preview", async () => {
                    resetPreview();
                    setPreview(
                      await request<PolicyPlan>("preview", {
                        mac: client,
                        action: "route",
                        table: routeTable,
                        minutes: Number(minutes),
                        startInMinutes: Number(delay),
                      }),
                    );
                  })
                }
              >
                Review path change
              </MonitorButton>
            </MonitorPanel>
          </div>
        </div>
      )}

      <div id="home-history" className="home-history">
        <MonitorPanel
          title="Temporary change history"
          description="Saved status, not live proof. After a change expires, use Undo / reconcile to check cleanup. Nothing restores the full config."
          flush
        >
          {history.length === 0 ? (
            <MonitorEmpty compact title="No applied changes">
              Your router configuration stays as it is.
            </MonitorEmpty>
          ) : (
            history.map((p) => {
              const expired = p.status !== "undone" && !!p.endsAt && now > p.endsAt;
              const status = POLICY_STATUS[p.status];
              const what = `${clientName(byMac.get(p.input.mac))} · ${p.input.action}${p.input.table ? ` → ${p.input.table}` : ""}`;
              return (
                <RowMenu
                  key={p.id}
                  title={what}
                  sub={`${p.ip} · ${policyState(p)}`}
                  onOpen={() => setPicked({ t: "policy", key: p.id })}
                  cells={{
                    change: { value: what },
                  }}
                  copies={[
                    { label: "Change ID", value: p.id },
                    { label: "IP address", value: p.ip },
                  ]}
                  row={p}
                  actions={
                    p.status !== "undone"
                      ? [
                          {
                            label: "Undo / reconcile",
                            danger: true,
                            disabled: !!busy,
                            onSelect: () => setUndo({ id: p.id, from: "history" }),
                          },
                        ]
                      : undefined
                  }
                >
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={`${what}, ${policyState(p)}`}
                    className="monitor-row home-policy"
                    data-failed={p.error || p.status === "uncertain" ? true : undefined}
                    data-selected={(picked?.t === "policy" && picked.key === p.id) || undefined}
                    onClick={() => setPicked({ t: "policy", key: p.id })}
                    onKeyDown={onRowKey(() => setPicked({ t: "policy", key: p.id }))}
                  >
                    <StatusDot tone={expired ? "warn" : status.tone} />
                    <span data-col="change" className="min-w-0">
                      <span className="home-name">
                        {clientName(byMac.get(p.input.mac))} · {p.input.action}
                        {p.input.table ? ` → ${p.input.table}` : ""}
                      </span>
                      <span className="home-detail">
                        {p.ip} · {policyState(p)}
                        {p.endsAt ? ` · until ${new Date(p.endsAt).toLocaleString()}` : ""}
                      </span>
                      {p.error && <span className="home-temp-error">{p.error}</span>}
                    </span>
                    {p.status !== "undone" &&
                      (undo?.id === p.id && undo.from === "history" ? (
                        <div className="contents" {...keepInRow}>
                          <UndoConfirm
                            busy={!!busy}
                            onCancel={() => setUndo(undefined)}
                            onConfirm={() => confirmUndo(p.id)}
                          />
                        </div>
                      ) : (
                        <MonitorButton
                          variant="danger"
                          size="sm"
                          disabled={!!busy}
                          {...keepInRow}
                          onClick={(e) => {
                            e.stopPropagation();
                            setUndo({ id: p.id, from: "history" });
                          }}
                        >
                          Undo / reconcile
                        </MonitorButton>
                      ))}
                    <RowMore />
                  </div>
                </RowMenu>
              );
            })
          )}
        </MonitorPanel>
      </div>
      {drawer}
    </>
  );
}

function Report({
  diagnosis,
  client,
  onCompare,
}: {
  diagnosis: Diagnosis | undefined;
  client: HomeClient | undefined;
  onCompare: () => void;
}): ReactNode {
  const [picked, onPick] = useState<string | null>(null);
  if (!diagnosis)
    return (
      <MonitorPanel
        title="Connection report"
        description="Run a check to see what the router finds."
      >
        <MonitorEmpty compact title="No check yet">
          Pick a device and a website, then press Check connection.
        </MonitorEmpty>
      </MonitorPanel>
    );
  const suspected = diagnosis.findings.find((f) => f.state === "suspected");
  const findingKey = (f: Finding): string => `${f.area}-${f.title}`;
  // Likely causes first, as on the board; the sort keeps the API's order otherwise.
  const rows: Finding[] = [
    ...diagnosis.findings.filter((f) => f.state === "suspected"),
    ...diagnosis.findings.filter((f) => f.state !== "suspected"),
    {
      area: "Device",
      state: "unknown",
      title: "App health on the device",
      detail: "The router cannot see inside the app. Check the app itself if the rest is clean.",
      next: "",
    },
  ];
  return (
    <MonitorPanel
      title="Connection report"
      description={`${client ? clientName(client) : diagnosis.client} to ${diagnosis.target} · checked ${clock(diagnosis.at)}`}
      extra={
        suspected && (
          <StatusBadge tone="warn" dot={false}>
            Suspected: {suspected.area}
          </StatusBadge>
        )
      }
      flush
    >
      <p className="home-summary">
        {tallies(diagnosis).text} App health on the device is not verified.
      </p>
      {rows.map((f) => (
        <RowMenu
          key={findingKey(f)}
          title={f.title}
          sub={`${STATE_LABEL[f.state]} · ${f.area}`}
          onOpen={() => onPick(findingKey(f))}
          cells={{
            state: { value: STATE_LABEL[f.state] },
            finding: { value: f.title },
            area: { value: f.area },
          }}
          copies={[{ label: "Detail", value: f.detail, hint: "" }]}
          row={f}
        >
          <div
            role="button"
            tabIndex={0}
            aria-label={`${f.title}, ${STATE_LABEL[f.state]}`}
            className="monitor-row home-finding"
            data-selected={picked === findingKey(f) || undefined}
            onClick={() => onPick(findingKey(f))}
            onKeyDown={onRowKey(() => onPick(findingKey(f)))}
          >
            <span data-col="state" className="home-finding-state">
              <StatusBadge tone={STATE_TONE[f.state]} dot={false}>
                {STATE_LABEL[f.state]}
              </StatusBadge>
            </span>
            <span data-col="finding" className="home-finding-body">
              <span className="home-name">{f.title}</span>
              <span className="home-detail">{f.detail}</span>
              {f.next && <span className="home-detail home-next">Next: {f.next}</span>}
            </span>
            <span data-col="area" className="home-finding-area">
              {f.area}
            </span>
            <RowMore />
          </div>
        </RowMenu>
      ))}
      {(() => {
        const at = rows.findIndex((f) => findingKey(f) === picked);
        const f = rows[at];
        if (!f) return null;
        return (
          <RowDrawer
            open
            onClose={() => onPick(null)}
            label={`Finding details: ${f.title}`}
            storageKey="home-internet"
            rowKey={findingKey(f)}
            status={{ tone: KIT_TONE[STATE_TONE[f.state]], label: STATE_LABEL[f.state] }}
            title={f.title}
            meta={`${f.area} · ${client ? clientName(client) : diagnosis.client} to ${diagnosis.target}`}
            nav={{
              index: at,
              total: rows.length,
              onPrev: at > 0 ? () => onPick(findingKey(rows[at - 1]!)) : undefined,
              onNext: at < rows.length - 1 ? () => onPick(findingKey(rows[at + 1]!)) : undefined,
            }}
          >
            <p className="home-detail">{f.detail}</p>
            {f.next && <p className="home-detail home-next">Next: {f.next}</p>}
          </RowDrawer>
        );
      })()}
      <div className="monitor-foot home-report-foot">
        <span className="home-legend">
          Observed = measured now. Suspected = fits the evidence. Unknown = could not check.
        </span>
        <button type="button" className="home-link" onClick={onCompare}>
          Compare paths for this device
        </button>
      </div>
    </MonitorPanel>
  );
}

function Stat({
  label,
  value,
  col,
}: {
  label: string;
  value: string | null;
  col?: string;
}): ReactNode {
  return (
    <span className="home-stat" data-col={col}>
      <span className="home-stat-label">{label}</span>
      <span className={value === null ? "home-mut" : undefined}>{value ?? "Unknown"}</span>
    </span>
  );
}

function PolicySentence({
  policy,
  client,
}: {
  policy: PolicyPlan;
  client: HomeClient | undefined;
}): ReactNode {
  const who = (
    <>
      <b>{clientName(client)}</b> <span className="home-mono home-mut">{policy.ip}</span>
    </>
  );
  if (policy.input.action === "route")
    return (
      <>
        Traffic for {who} goes through <span className="home-mono">{policy.input.table}</span>.
      </>
    );
  if (policy.input.action === "priority") return <>Meeting priority is on for {who}.</>;
  return <>Routed access is paused for {who}.</>;
}

function UndoConfirm({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactNode {
  return (
    <div className="home-undo" role="group" aria-label="Confirm undo">
      <span>Remove only this change's objects and restore its earlier queue priority?</span>
      <div className="home-actions">
        <MonitorButton size="sm" onClick={onCancel}>
          Cancel
        </MonitorButton>
        <MonitorButton variant="danger" size="sm" disabled={busy} onClick={onConfirm}>
          Confirm undo
        </MonitorButton>
      </div>
    </div>
  );
}

function Duration({
  minutes,
  delay,
  setMinutes,
  setDelay,
}: {
  minutes: string;
  delay: string;
  setMinutes: (s: string) => void;
  setDelay: (s: string) => void;
}) {
  return (
    <div className="home-duration">
      <Field label="Duration, minutes" className="home-field">
        <NumberInput
          label="Duration, minutes"
          min={5}
          max={120}
          allowEmpty
          value={minutes === "" ? null : Number(minutes)}
          onChange={(n) => setMinutes(n == null ? "" : String(n))}
        />
      </Field>
      <Field label="Start in, minutes" className="home-field">
        <NumberInput
          label="Start in, minutes"
          min={0}
          max={1440}
          allowEmpty
          value={delay === "" ? null : Number(delay)}
          onChange={(n) => setDelay(n == null ? "" : String(n))}
        />
      </Field>
    </div>
  );
}

function ClientRow({
  client: c,
  open,
  onOpen,
  disabled,
  selected,
  editing,
  onEdit,
  onSave,
  onChoose,
}: {
  client: HomeClient;
  open: boolean;
  onOpen: () => void;
  disabled: boolean;
  selected: boolean;
  editing: boolean;
  onEdit: () => void;
  onSave: (name: string, person: string) => void;
  onChoose: () => void;
}) {
  const [name, setName] = useState(c.name),
    [person, setPerson] = useState(c.person);
  return (
    <RowMenu
      title={clientName(c)}
      sub={`${c.person || "No person assigned"} · ${c.ip || "No IPv4"}`}
      onOpen={onOpen}
      cells={{
        device: { value: clientName(c) },
        mac: { value: c.mac, kind: "id" },
      }}
      copies={[
        { label: "MAC address", value: c.mac },
        ...(c.ip ? [{ label: "IP address", value: c.ip }] : []),
      ]}
      row={c}
      actions={[
        {
          label: editing ? "Save & acknowledge" : "Name / acknowledge",
          disabled,
          onSelect: () => (editing ? onSave(name, person) : onEdit()),
        },
        { label: selected ? "Selected" : "Manage device", disabled, onSelect: onChoose },
      ]}
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={`${clientName(c)}, ${c.ip || "no IPv4"}`}
        className="monitor-row home-client"
        data-selected={selected || open || undefined}
        onClick={onOpen}
        onKeyDown={onRowKey(onOpen)}
      >
        <span className="min-w-0">
          <span data-col="device" className="home-name">
            {clientName(c)}
            {!c.acknowledged && <StatusBadge tone="warn">New</StatusBadge>}
          </span>
          <span className="home-detail">
            {c.person || "No person assigned"} · {c.ip || "No IPv4"}
          </span>
          <span data-col="mac" className="home-mono-line">
            {c.mac} · {c.present ? "Bound at last scan" : "Not bound at last scan"} ·{" "}
            {new Date(c.lastSeen).toLocaleString()}
          </span>
        </span>
        <span className="home-actions" {...keepInRow}>
          <MonitorButton
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => (editing ? onSave(name, person) : onEdit())}
          >
            {editing ? "Save & acknowledge" : "Name / acknowledge"}
          </MonitorButton>
          <MonitorButton size="sm" disabled={disabled} onClick={onChoose}>
            {selected ? "Selected" : "Manage device"}
          </MonitorButton>
        </span>
        <RowMore />
        {editing && (
          <div className="home-form home-client-edit" {...keepInRow}>
            <Field label="Friendly name" className="home-field">
              <TextInput label="Friendly name" maxLength={80} value={name} onChange={setName} />
            </Field>
            <Field label="Person" className="home-field">
              <TextInput label="Person" maxLength={80} value={person} onChange={setPerson} />
            </Field>
          </div>
        )}
      </div>
    </RowMenu>
  );
}
