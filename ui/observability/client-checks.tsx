import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import qrcode from "qrcode-generator";
import { Check, Clock, Copy, ExternalLink, Lock, Plus, RefreshCw, Route, X } from "lucide-react";
import { api } from "./api";
import { LoadingState } from "./loading-state";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorNote,
  MonitorPanel,
  MonitorSelect,
  PageIntro,
  RouterPicker,
  StatusDot,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { Field, TextInput } from "./kit";
import type { DevicesPayload } from "./types";
import { useWorkspaceClock, workspacePost } from "./workspace-ui";
import {
  compareRuns,
  summarizeRun,
  checkConnectionState,
  clientCheckOrigin,
} from "../../src/client-check/model";
import type { PublicCheckSession } from "../../src/client-check/model";
import type { ClientCheckNetwork } from "../../src/client-check/network";
import type { Investigation } from "../../src/investigations/model";
import { LatencyTrace, LinkScene } from "./client-check-graphics";
import type { LinkTone } from "./client-check-graphics";
import "./client-checks.css";

type Session = PublicCheckSession;
type LinkState =
  | "idle"
  | "pending"
  | "connected"
  | "disconnected"
  | "expired"
  | "closed"
  | "unknown";

/** "14:06:21" */
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB");
}
/** "17 Nov, 14:48" */
function dayTime(ms: number): string {
  return new Date(ms).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function fixed(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(1);
}
/** "+21.7", "−38.4" */
function signed(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(1)}`;
}
function withUnit(text: string, unit: string): ReactNode {
  return text === "—" ? (
    text
  ) : (
    <>
      {text}
      <small>{unit}</small>
    </>
  );
}

const LINK: Record<
  LinkState,
  {
    title: string;
    text: string;
    tone: LinkTone;
    dot: Tone;
    mark: "check" | "wait" | "alert" | "stop";
  }
> = {
  idle: {
    title: "Bring your device into view.",
    text: "Create an invitation, then scan it on the phone or laptop you want to check.",
    tone: "muted",
    dot: "default",
    mark: "wait",
  },
  pending: {
    title: "Pending to connect",
    text: "Scan the QR on the affected device. This panel changes as soon as its browser checks in.",
    tone: "brand",
    dot: "brand",
    mark: "wait",
  },
  connected: {
    title: "Connected",
    text: "Your device is here. Start a measurement on its screen when you’re ready.",
    tone: "good",
    dot: "good",
    mark: "check",
  },
  disconnected: {
    title: "Connection interrupted",
    text: "No recent heartbeat. Reopen the invitation or return to its browser tab; sleeping phones may pause updates.",
    tone: "warn",
    dot: "warn",
    mark: "alert",
  },
  expired: {
    title: "Invitation expired",
    text: "Create a fresh invitation to reconnect. Saved measurements remain available.",
    tone: "muted",
    dot: "default",
    mark: "stop",
  },
  closed: {
    title: "Invitation revoked",
    text: "This link can no longer connect. Saved measurements remain available.",
    tone: "muted",
    dot: "default",
    mark: "stop",
  },
  unknown: {
    title: "Connection status unavailable",
    text: "The dashboard cannot refresh presence. The device may still be connected.",
    tone: "warn",
    dot: "warn",
    mark: "alert",
  },
};

function ConnectionPanel({
  session,
  now,
  unavailable,
}: {
  session?: Session;
  now: number;
  unavailable: boolean;
}) {
  const state: LinkState = !session
    ? "idle"
    : unavailable
      ? "unknown"
      : checkConnectionState(session, now);
  const look = LINK[state];
  const connected = state === "connected";
  const footer: string[] = [];
  if (session?.connection)
    footer.push(
      `Last heartbeat ${clock(session.connection.lastSeen)}`,
      "presence is not a speed test",
    );
  if (session && state !== "closed" && state !== "expired")
    footer.push(
      `${footer.length ? "invitation" : "Invitation"} expires in ${Math.max(0, Math.ceil((session.expiresAt - now) / 60000))} min`,
    );
  return (
    <section className="cc-link glass" data-connection-state={state}>
      <div className="cc-link-top">
        <span>Live device link</span>
        <span className="font-mono">{session ? session.id.slice(0, 8) : "Not paired"}</span>
      </div>
      <LinkScene tone={look.tone} mark={look.mark} live={connected} />
      <div role="status" aria-live="polite" aria-atomic="true" className="cc-link-message">
        <h2>
          <StatusDot tone={look.dot} pulse={connected || state === "pending"} />
          {look.title}
        </h2>
        <p>{look.text}</p>
      </div>
      {session?.connection && (
        <div className="cc-link-facts">
          <div>
            <span className="monitor-hint">Latest device · reported by its browser</span>
            <div className="cc-link-device">{session.connection.deviceLabel}</div>
          </div>
          <div>
            <span className="monitor-hint">Address seen by this server</span>
            <div className="cc-link-address">{session.connection.peerAddress}</div>
          </div>
        </div>
      )}
      {footer.length > 0 && (
        <div className="cc-link-foot monitor-hint" aria-live="off">
          <Clock aria-hidden="true" />
          {footer.join(" · ")}
        </div>
      )}
    </section>
  );
}

function Stepper({ labels, active }: { labels: string[]; active: number }) {
  return (
    <ol className="cc-steps" aria-label="Progress">
      {labels.map((label, i) => {
        const state = i < active ? "done" : i === active ? "on" : "todo";
        return (
          <li key={label} data-state={state} aria-current={state === "on" ? "step" : undefined}>
            <span className="cc-step-bar" aria-hidden="true" />
            <span className="cc-step-label">
              <span className="monitor-chip">
                {state === "done" ? <Check aria-label="Done" /> : i + 1}
              </span>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function ClientChecksView() {
  const [initialLoading, setInitialLoading] = useState(true);
  const [devices, setDevices] = useState<string[]>([]),
    [defaultDevice, setDefaultDevice] = useState<string | null>(null),
    [device, setDevice] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    api<DevicesPayload>("/api/devices", abort.signal)
      .then((v) => {
        const enabled = v.devices.filter((d) => !d.disabled).map((d) => d.name);
        setDevices(enabled);
        setDefaultDevice(v.defaultDevice);
        setDevice(enabled.includes(v.defaultDevice) ? v.defaultDevice : (enabled[0] ?? ""));
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => setInitialLoading(false));
    return () => abort.abort();
  }, []);
  return (
    <div className="cc-page">
      <PageIntro
        eyebrow="Client check · endpoint evidence"
        heading="See the other end of the connection."
        lead="Invite a phone or laptop to measure its own path. Compare Wi-Fi and VPN with evidence from the device that is actually affected."
        actions={
          <>
            <span className="monitor-label">Workspace router</span>
            <RouterPicker
              label="Workspace router"
              value={device}
              routers={devices}
              defaultRouter={defaultDevice}
              disabled={!devices.length}
              onChange={setDevice}
            />
          </>
        }
      />
      {error && (
        <MonitorNote tone="bad" role="alert">
          {error}
        </MonitorNote>
      )}
      {initialLoading ? (
        <LoadingState label="Loading workspace routers" layout="form" />
      ) : device ? (
        <Checks key={device} device={device} />
      ) : (
        <MonitorNote>Select a configured router to start.</MonitorNote>
      )}
    </div>
  );
}

function Checks({ device }: { device: string }) {
  const now = useWorkspaceClock();
  const [casesError, setCasesError] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]),
    [cases, setCases] = useState<Investigation[]>([]),
    [selected, setSelected] = useState("");
  const [label, setLabel] = useState("Wi-Fi / VPN comparison"),
    [caseId, setCaseId] = useState(""),
    [origin, setOrigin] = useState(""),
    [link, setLink] = useState("");
  const [network, setNetwork] = useState<ClientCheckNetwork | null>(null),
    [networkError, setNetworkError] = useState(""),
    [presenceUnavailable, setPresenceUnavailable] = useState(false);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [pair, setPair] = useState<string[]>([]);
  const load = useCallback(async () => {
    const data = await api<Session[]>(`/api/client-checks?device=${encodeURIComponent(device)}`);
    setSessions(data);
    setPresenceUnavailable(false);
  }, [device]);
  useEffect(() => {
    const abort = new AbortController();
    api<ClientCheckNetwork>("/api/client-checks/network", abort.signal)
      .then((value) => {
        setNetwork(value);
        setOrigin((current) => {
          if (current) return current;
          try {
            return clientCheckOrigin(location.origin);
          } catch {
            return value.candidates[0]?.origin ?? "";
          }
        });
      })
      .catch((e) => {
        if (!abort.signal.aborted) setNetworkError(e.message);
      });
    api<Session[]>(`/api/client-checks?device=${encodeURIComponent(device)}`, abort.signal)
      .then(setSessions)
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    api<{ cases: Investigation[] }>(
      `/api/investigations?device=${encodeURIComponent(device)}`,
      abort.signal,
    )
      .then((d) => setCases(d.cases ?? []))
      .catch((e) => {
        if (!abort.signal.aborted) setCasesError(e.message);
      });
    return () => abort.abort();
  }, [device]);
  useEffect(() => {
    if (!selected) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await api<Session[]>(
          `/api/client-checks?device=${encodeURIComponent(device)}`,
          abort.signal,
        );
        if (!abort.signal.aborted) {
          setSessions(data);
          setPresenceUnavailable(false);
        }
      } catch {
        if (!abort.signal.aborted) setPresenceUnavailable(true);
      }
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [selected, device]);
  const current = sessions.find((s) => s.id === selected),
    runs = current?.runs ?? [];
  const a = runs.find((r) => r.id === pair[0]),
    b = runs.find((r) => r.id === pair[1]),
    comparison = a && b ? compareRuns(a, b) : null;
  async function create() {
    setBusy(true);
    setError("");
    try {
      const base = clientCheckOrigin(origin);
      const s = await workspacePost<Session & { clientPath: string }>(
        "/api/client-checks",
        device,
        { label, minutes: 15, ...(caseId ? { caseId } : {}) },
      );
      setLink(base + s.clientPath);
      setSelected(s.id);
      setSessions((items) => [s, ...items]);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const qr = useMemo(() => {
    if (!link) return "";
    const code = qrcode(0, "M");
    code.addData(link);
    code.make();
    return code.createDataURL(4, 0);
  }, [link]);
  const candidates = network?.candidates ?? [];
  const knownOrigin = candidates.some((c) => c.origin === origin);
  const connected =
    !!current && checkConnectionState(current, now) === "connected" && !presenceUnavailable;
  return (
    <>
      <Stepper
        labels={["Invite a device", "Run on Wi-Fi and VPN", "Compare evidence"]}
        active={runs.length > 1 ? 2 : link ? 1 : 0}
      />
      {error && (
        <MonitorNote tone="bad" role="alert">
          {error}
        </MonitorNote>
      )}
      {casesError && (
        <MonitorNote tone="bad" role="alert">
          Could not load investigations: {casesError}
        </MonitorNote>
      )}
      <div className="cc-columns">
        <div className="cc-column">
          <MonitorPanel
            title="A private test invitation"
            description={
              network?.localOnly
                ? "Local-only listener. Restart with --dashboard-host 0.0.0.0 to allow devices on your network."
                : "Choose an address your device can reach. Use the same LAN or VPN and allow this port in the computer’s firewall."
            }
            bodyClassName="cc-stack"
          >
            {networkError && (
              <MonitorNote tone="bad" role="alert">
                Could not detect server addresses: {networkError}. Enter this host’s reachable
                address below.
              </MonitorNote>
            )}
            <Field label="Session name" className="monitor-fl">
              <TextInput value={label} maxLength={80} onChange={setLabel} />
            </Field>
            <div className="monitor-fl">
              <span className="monitor-label">This server’s reachable address</span>
              {candidates.length > 0 && (
                <div className="cc-select" data-mono={knownOrigin || undefined}>
                  <MonitorSelect
                    label="Detected server address"
                    value={knownOrigin ? origin : ""}
                    onChange={setOrigin}
                    options={[
                      { value: "", label: "Custom address / HTTPS proxy" },
                      ...candidates.map((c) => ({
                        value: c.origin,
                        label: `${c.origin} · ${c.name}`,
                      })),
                    ]}
                  />
                </div>
              )}
              {!knownOrigin && (
                <TextInput
                  className="cc-mono"
                  label="Test server origin"
                  value={origin}
                  onChange={setOrigin}
                  placeholder="http://192.168.1.10:9091"
                />
              )}
              <span className="monitor-hint">
                Use this MCP host’s LAN or VPN address. Localhost and wildcard addresses do not
                work.
              </span>
            </div>
            <div className="monitor-fl">
              <span className="monitor-label">Linked investigation</span>
              <div className="cc-select">
                <MonitorSelect
                  label="Linked investigation"
                  value={caseId}
                  onChange={setCaseId}
                  options={[
                    { value: "", label: "No linked investigation" },
                    ...cases.map((c) => ({ value: c.id, label: `${c.service} · ${c.client}` })),
                  ]}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <MonitorButton
                variant="primary"
                disabled={busy || !label.trim() || !origin.trim()}
                onClick={() => void create()}
                icon={<Plus aria-hidden="true" />}
              >
                {busy ? "Creating…" : "Create invitation"}
              </MonitorButton>
            </div>
            {link && (
              <div className="cc-invite">
                <div className="cc-qr" data-connected={connected}>
                  <img
                    src={qr}
                    width="132"
                    height="132"
                    alt="Scan to open the private Client Check invitation"
                  />
                </div>
                <div className="cc-invite-side">
                  <Field label="Private invitation URL" className="monitor-fl">
                    <TextInput
                      className="cc-mono"
                      aria-label="Private invitation URL"
                      readOnly
                      value={link}
                      onChange={() => {}}
                    />
                  </Field>
                  <div className="flex flex-wrap items-center gap-2">
                    <MonitorButton
                      size="sm"
                      icon={<Copy aria-hidden="true" />}
                      onClick={() =>
                        navigator.clipboard
                          .writeText(link)
                          .catch(() =>
                            setError(
                              "Clipboard unavailable. Copy the invitation from the field below.",
                            ),
                          )
                      }
                    >
                      Copy link
                    </MonitorButton>
                    <a
                      className="monitor-btn"
                      data-variant="ghost"
                      data-size="sm"
                      href={link}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink aria-hidden="true" />
                      Open test
                    </a>
                  </div>
                </div>
              </div>
            )}
            <MonitorNote tone="warn" icon={<Lock aria-hidden="true" />}>
              Share this link only with the person running the test. Use a trusted LAN, VPN or
              HTTPS: plain HTTP does not protect the invitation in transit.
            </MonitorNote>
          </MonitorPanel>
          <MonitorPanel
            title="Measured path"
            extra={
              <MonitorButton
                size="sm"
                variant="ghost"
                icon={<RefreshCw aria-hidden="true" />}
                onClick={() => void load().catch((e) => setError(e.message))}
              >
                Refresh
              </MonitorButton>
            }
          >
            <MonitorNote>
              This is HTTP transfer performance to the host above. A local host measures LAN or VPN
              access, not your internet plan. DNS, PMTU and app availability are not measured. A
              reverse proxy changes which IPv4/IPv6 connection this server sees.
            </MonitorNote>
          </MonitorPanel>
        </div>
        <div className="cc-column">
          <ConnectionPanel session={current} now={now} unavailable={presenceUnavailable} />
          <MonitorPanel title="Session history" flush>
            <div className="cc-select cc-history-select">
              <MonitorSelect
                label="Check session"
                value={selected}
                onChange={(v) => {
                  setSelected(v);
                  setPair([]);
                  setLink("");
                }}
                options={[
                  { value: "", label: "Choose a session" },
                  ...sessions.map((s) => ({
                    value: s.id,
                    label: `${s.label} · ${s.runs.length} runs · ${s.status === "open" && s.expiresAt < now ? "expired" : s.status}`,
                  })),
                ]}
              />
            </div>
            {current && (
              <>
                <div className="cc-history-meta">
                  <Route aria-hidden="true" />
                  <span>
                    {current.caseId ? "Linked to investigation" : "Standalone check"} · expires{" "}
                    {dayTime(current.expiresAt)}
                  </span>
                  <span className="flex-1" />
                  <MonitorButton
                    size="sm"
                    variant="ghost"
                    icon={<X aria-hidden="true" />}
                    disabled={current.status !== "open" || busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await workspacePost("/api/client-checks/close", device, { id: current.id });
                        setLink("");
                        await load();
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Revoke invitation
                  </MonitorButton>
                </div>
                {!runs.length && (
                  <div className="cc-history-empty">
                    <MonitorNote>
                      No measurements saved yet. Connecting a device only reports presence; a test
                      starts when the person accepts it on that device.
                    </MonitorNote>
                  </div>
                )}
                {runs.map((r) => {
                  const stats = summarizeRun(r);
                  const on = pair.includes(r.id);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      className="monitor-row cc-run"
                      aria-pressed={on}
                      data-selected={on || undefined}
                      title={r.endpoint}
                      onClick={() =>
                        setPair((p) =>
                          p.includes(r.id) ? p.filter((id) => id !== r.id) : [...p.slice(-1), r.id],
                        )
                      }
                    >
                      <span className="p">
                        {r.label} · {r.path}
                      </span>
                      <span className="cc-mono text-muted-foreground">
                        {r.family} · {stats.complete ? "complete" : "partial"}
                      </span>
                      <span className="cc-run-stats">
                        ↓ {fixed(stats.downloadMbps)} Mbps · ↑ {fixed(stats.uploadMbps)} Mbps ·{" "}
                        {fixed(stats.idleMs)} ms idle
                      </span>
                      <span className="cc-run-time">{clock(r.receivedAt)}</span>
                    </button>
                  );
                })}
                {runs.length > 0 && (
                  <div className="monitor-foot">Pick two runs to compare them.</div>
                )}
              </>
            )}
          </MonitorPanel>
        </div>
      </div>
      {comparison && a && b && (
        <MonitorPanel
          title={`${a.label} → ${b.label}`}
          description="Two runs from the same session."
          bodyClassName="cc-stack"
        >
          {comparison.comparable && "second" in comparison ? (
            <>
              <MetricStrip label="Run comparison">
                <Metric
                  label="Download change"
                  value={withUnit(signed(comparison.downloadChangeMbps), "Mbps")}
                  hint={`${b.label} run vs ${a.label} run`}
                  tone={(comparison.downloadChangeMbps ?? 0) < 0 ? "warn" : "default"}
                />
                <Metric
                  label="Idle latency change"
                  value={withUnit(signed(comparison.latencyChangeMs), "ms")}
                  hint="second run minus first"
                />
                <Metric
                  label="Second run · loaded latency"
                  value={withUnit(fixed(comparison.second!.loadedMs), "ms")}
                  hint="median under load"
                />
                <Metric
                  label="Second run · jitter"
                  value={withUnit(fixed(comparison.second!.jitterMs), "ms")}
                  hint="idle samples"
                />
              </MetricStrip>
              <p className="cc-compare-note">
                Both runs are complete and use the same endpoint
                {a.family === b.family ? " and IP family" : ""}, so they are comparable. Positive
                latency change means the second run was slower.
              </p>
              <div className="cc-traces">
                {[a, b].map((run) => (
                  <LatencyTrace
                    key={run.id}
                    label={run.label}
                    idleMs={run.idleMs}
                    loadedMs={run.loadedMs}
                    maximum={Math.max(1, ...a.idleMs, ...a.loadedMs, ...b.idleMs, ...b.loadedMs)}
                  />
                ))}
              </div>
            </>
          ) : (
            <MonitorNote>
              {"reason" in comparison ? comparison.reason : "Not comparable"}
            </MonitorNote>
          )}
        </MonitorPanel>
      )}
    </>
  );
}
