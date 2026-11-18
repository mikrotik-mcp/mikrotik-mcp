import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
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

function ChevronIcon() {
  return (
    <svg className="home-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

interface PickerItem {
  value: string;
  label: string;
  /** Shown after the label in mono, e.g. the device's IPv4. */
  detail?: string;
}

/**
 * The board's `.select`: the closed value is drawn here, and a transparent
 * native select on top takes clicks and keys.
 */
function Picker({
  label,
  value,
  items,
  onChange,
  disabled = false,
  mono = false,
  icon,
  className,
}: {
  label: string;
  value: string;
  items: PickerItem[];
  onChange: (v: string) => void;
  disabled?: boolean;
  /** The whole value in mono (router names). */
  mono?: boolean;
  icon?: ReactNode;
  className?: string;
}) {
  const current = items.find((i) => i.value === value);
  return (
    <label className={cn("home-field", className)}>
      <span className="home-label">{label}</span>
      <span className="home-select" data-disabled={disabled || undefined}>
        {icon}
        <span className="home-select-value">
          {current ? (
            <span className={mono ? "home-mono" : undefined}>
              {current.label}
              {current.detail && <span className="home-mono home-mut"> {current.detail}</span>}
            </span>
          ) : (
            <span className="home-mut">Choose…</span>
          )}
        </span>
        <ChevronIcon />
        <select
          aria-label={label}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          {!current && <option value="">Choose…</option>}
          {items.map((i) => (
            <option key={i.value} value={i.value}>
              {i.detail ? `${i.label} ${i.detail}` : i.label}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}

/** The board's `.field`: a plain text input in a hairline box. */
function Field({
  label,
  value,
  onChange,
  icon,
  ...rest
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  icon?: ReactNode;
  type?: string;
  min?: number;
  max?: number;
  maxLength?: number;
  placeholder?: string;
}) {
  return (
    <label className="home-field">
      <span className="home-label">{label}</span>
      <span className="home-input">
        {icon}
        <input
          {...rest}
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </span>
    </label>
  );
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
    <div className="home-chain" ref={root}>
      {head}
      {hops.map((h, i) => (
        <div key={h.key} className="home-hop">
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
            <span className="home-hop-sub" title={h.title}>
              {h.sub}
            </span>
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
            <span className="monitor-bar" aria-hidden="true">
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
          <label className="home-consent">
            <Checkbox checked={approved} onCheckedChange={(v) => setApproved(v === true)} />
            <span>I reviewed this device, route and duration. Open connections may drop.</span>
          </label>
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
                <Picker
                  label="Device"
                  icon={<Wifi className="home-icon" aria-hidden="true" />}
                  value={client}
                  items={options}
                  onChange={setClient}
                  disabled={!!busy}
                />
                <Field
                  label="Website or IPv4"
                  icon={<Globe className="home-icon" aria-hidden="true" />}
                  value={target}
                  onChange={setTarget}
                  placeholder="example.com"
                />
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
                  </div>
                  {newClients.map((c) => (
                    <div key={c.mac} className="monitor-row home-new-row">
                      <span className="home-two">
                        <span className="p home-mono truncate">{clientName(c)}</span>
                        <span className="home-two-sub truncate">
                          <span className="home-mono">{c.mac}</span>
                          {c.ip ? ` · ${c.ip}` : privateMac(c.mac) ? " · private MAC" : ""}
                        </span>
                      </span>
                      <MonitorButton
                        size="sm"
                        disabled={!!busy}
                        onClick={() => {
                          setEditing(c.mac);
                          chooseClient(c.mac);
                          setTab("people");
                        }}
                      >
                        Name
                      </MonitorButton>
                    </div>
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
              <Picker
                label="Device"
                value={client}
                items={options}
                onChange={chooseClient}
                disabled={!!busy}
              />
              <Picker
                label="Change"
                value={action === "route" ? "pause" : action}
                items={[
                  { value: "pause", label: "Pause routed access" },
                  { value: "priority", label: "Meeting priority" },
                ]}
                onChange={(v) => {
                  setAction(v as "pause" | "priority");
                  resetPreview();
                }}
                disabled={!!busy}
              />
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
                <Picker
                  label="What matters most"
                  value={goal}
                  items={[
                    { value: "calls", label: "Stable calls" },
                    { value: "gaming", label: "Responsive gaming" },
                    { value: "download", label: "Downloads (measurements only)" },
                  ]}
                  onChange={setGoal}
                />
                <Field
                  label="IPv4 to probe on every path"
                  value={pathTarget}
                  onChange={setPathTarget}
                />
              </div>
              <fieldset className="home-tables">
                <legend className="home-label">Paths to compare, up to three</legend>
                {tables.length > 0 ? (
                  <div className="home-table-options">
                    {tables.map((t) => (
                      <label key={t} className="home-table-option">
                        <Checkbox
                          checked={selectedTables.includes(t)}
                          disabled={!selectedTables.includes(t) && selectedTables.length >= 3}
                          onCheckedChange={(checked) =>
                            setSelectedTables((v) =>
                              checked ? [...v, t] : v.filter((x) => x !== t),
                            )
                          }
                        />
                        <span className="home-mono">{t}</span>
                      </label>
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
                </div>
                {comparison.paths.map((p) => (
                  <div
                    key={p.table}
                    className="monitor-row home-path-grid home-path"
                    data-selected={routeTable === p.table || undefined}
                  >
                    <span className="min-w-0">
                      <span className="home-name">
                        <span className="home-mono">{p.table}</span>
                        {comparison.recommended === p.table && (
                          <StatusBadge tone="good">Best in this small sample</StatusBadge>
                        )}
                      </span>
                      <span className="home-detail">{p.note}</span>
                    </span>
                    <Stat label="Loss" value={p.loss === null ? null : `${p.loss.toFixed(0)}%`} />
                    <Stat
                      label="Avg RTT"
                      value={p.latency === null ? null : `${p.latency.toFixed(1)} ms`}
                    />
                    <Stat
                      label="RTT range"
                      value={p.spread === null ? null : `${p.spread.toFixed(1)} ms`}
                    />
                    <MonitorButton
                      size="sm"
                      onClick={() => {
                        setRouteTable(p.table);
                        resetPreview();
                      }}
                    >
                      Choose for preview
                    </MonitorButton>
                  </div>
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
              <Picker
                label="Device"
                value={client}
                items={options}
                onChange={chooseClient}
                disabled={!!busy}
              />
              <Picker
                label="Routing table"
                value={routeTable}
                items={tables.map((t) => ({ value: t, label: t }))}
                onChange={(v) => {
                  setRouteTable(v);
                  resetPreview();
                }}
                disabled={!!busy}
              />
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
              return (
                <div
                  key={p.id}
                  className="monitor-row home-policy"
                  data-failed={p.error || p.status === "uncertain" ? true : undefined}
                >
                  <StatusDot tone={expired ? "warn" : status.tone} />
                  <span className="min-w-0">
                    <span className="home-name">
                      {clientName(byMac.get(p.input.mac))} · {p.input.action}
                      {p.input.table ? ` → ${p.input.table}` : ""}
                    </span>
                    <span className="home-detail">
                      {p.ip} ·{" "}
                      {p.status === "undone"
                        ? "Undone"
                        : expired
                          ? "Expiry passed, cleanup not verified"
                          : `${status.label}, saved status`}
                      {p.endsAt ? ` · until ${new Date(p.endsAt).toLocaleString()}` : ""}
                    </span>
                    {p.error && <span className="home-temp-error">{p.error}</span>}
                  </span>
                  {p.status !== "undone" &&
                    (undo?.id === p.id && undo.from === "history" ? (
                      <UndoConfirm
                        busy={!!busy}
                        onCancel={() => setUndo(undefined)}
                        onConfirm={() => confirmUndo(p.id)}
                      />
                    ) : (
                      <MonitorButton
                        variant="danger"
                        size="sm"
                        disabled={!!busy}
                        onClick={() => setUndo({ id: p.id, from: "history" })}
                      >
                        Undo / reconcile
                      </MonitorButton>
                    ))}
                </div>
              );
            })
          )}
        </MonitorPanel>
      </div>
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
        <div key={`${f.area}-${f.title}`} className="monitor-row home-finding">
          <span className="home-finding-state">
            <StatusBadge tone={STATE_TONE[f.state]} dot={false}>
              {STATE_LABEL[f.state]}
            </StatusBadge>
          </span>
          <span className="home-finding-body">
            <span className="home-name">{f.title}</span>
            <span className="home-detail">{f.detail}</span>
            {f.next && <span className="home-detail home-next">Next: {f.next}</span>}
          </span>
          <span className="home-finding-area">{f.area}</span>
        </div>
      ))}
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

function Stat({ label, value }: { label: string; value: string | null }): ReactNode {
  return (
    <span className="home-stat">
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
      <Field
        label="Duration, minutes"
        type="number"
        min={5}
        max={120}
        value={minutes}
        onChange={setMinutes}
      />
      <Field
        label="Start in, minutes"
        type="number"
        min={0}
        max={1440}
        value={delay}
        onChange={setDelay}
      />
    </div>
  );
}

function ClientRow({
  client: c,
  disabled,
  selected,
  editing,
  onEdit,
  onSave,
  onChoose,
}: {
  client: HomeClient;
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
    <div className="monitor-row home-client" data-selected={selected || undefined}>
      <span className="min-w-0">
        <span className="home-name">
          {clientName(c)}
          {!c.acknowledged && <StatusBadge tone="warn">New</StatusBadge>}
        </span>
        <span className="home-detail">
          {c.person || "No person assigned"} · {c.ip || "No IPv4"}
        </span>
        <span className="home-mono-line">
          {c.mac} · {c.present ? "Bound at last scan" : "Not bound at last scan"} ·{" "}
          {new Date(c.lastSeen).toLocaleString()}
        </span>
      </span>
      <span className="home-actions">
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
      {editing && (
        <div className="home-form home-client-edit">
          <Field label="Friendly name" maxLength={80} value={name} onChange={setName} />
          <Field label="Person" maxLength={80} value={person} onChange={setPerson} />
        </div>
      )}
    </div>
  );
}
