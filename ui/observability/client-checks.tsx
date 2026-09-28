import { useCallback, useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import {
  Copy,
  ExternalLink,
  Smartphone,
  Server,
  Plus,
  RefreshCw,
  Link2,
  Check,
  Radio,
  WifiOff,
  Clock3,
} from "lucide-react";
import { api } from "./api";
import { Button, Input, Select } from "./geist";
import {
  WorkspaceFrame,
  Notice,
  Metric,
  Steps,
  workspaceCard,
  workspaceNote,
  workspacePost,
  useWorkspaceClock,
} from "./workspace-ui";
import {
  compareRuns,
  summarizeRun,
  checkConnectionState,
  clientCheckOrigin,
} from "../../src/client-check/model";
import type { PublicCheckSession, CheckRun } from "../../src/client-check/model";
import type { ClientCheckNetwork } from "../../src/client-check/network";
import type { Investigation } from "../../src/investigations/model";
import "./client-checks.css";

type Session = PublicCheckSession;
function ConnectionPanel({
  session,
  now,
  unavailable,
}: {
  session?: Session;
  now: number;
  unavailable: boolean;
}) {
  const state = !session ? "idle" : unavailable ? "unknown" : checkConnectionState(session, now);
  const connected = state === "connected";
  const title = {
    idle: "Bring your device into view.",
    pending: "Pending to connect",
    connected: "Connected",
    disconnected: "Connection interrupted",
    expired: "Invitation expired",
    closed: "Invitation revoked",
    unknown: "Connection status unavailable",
  }[state];
  const description = {
    idle: "Create an invitation, then scan it on the phone or laptop you want to check.",
    pending:
      "Scan the QR on the affected device. This panel changes as soon as its browser checks in.",
    connected: "Your device is here. Start a measurement on its screen when you’re ready.",
    disconnected:
      "No recent heartbeat. Reopen the invitation or return to its browser tab; sleeping phones may pause updates.",
    expired: "Create a fresh invitation to reconnect. Saved measurements remain available.",
    closed: "This link can no longer connect. Saved measurements remain available.",
    unknown: "The dashboard cannot refresh presence. The device may still be connected.",
  }[state];
  const Icon = connected
    ? Check
    : state === "disconnected" || state === "unknown"
      ? WifiOff
      : state === "expired" || state === "closed"
        ? Clock3
        : Radio;
  return (
    <div className={`${workspaceCard} check-connection`} data-connection-state={state}>
      <div className="flex items-center justify-between gap-3 text-[10px] uppercase tracking-[.16em] text-muted-foreground">
        <span>Live device link</span>
        <span className="font-mono">{session ? session.id.slice(0, 8) : "Not paired"}</span>
      </div>
      <div className="check-link-scene" aria-hidden="true">
        <div className="check-link-node">
          <Smartphone size={26} />
          <span>YOUR DEVICE</span>
        </div>
        <div className="check-link-wire">
          <i />
          <i />
          <i />
          <span className="check-link-seal">
            <Icon size={18} />
          </span>
        </div>
        <div className="check-link-node">
          <Server size={26} />
          <span>MCP HOST</span>
        </div>
      </div>
      <div role="status" aria-live="polite" aria-atomic="true">
        <div key={state} className="check-link-message">
          <h3 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <span className="check-link-dot" />
            {title}
          </h3>
          <p className={`mt-2 ${workspaceNote}`}>{description}</p>
        </div>
      </div>
      {session?.connection && (
        <div className="mt-5 grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
          <div>
            <p className={workspaceNote}>Latest device · browser-reported type</p>
            <p className="mt-1 text-sm font-medium">{session.connection.deviceLabel}</p>
          </div>
          <div>
            <p className={workspaceNote}>Address seen by this server</p>
            <p className="mt-1 break-all font-mono text-xs">{session.connection.peerAddress}</p>
          </div>
          <p className={`sm:col-span-2 ${workspaceNote}`}>
            Last heartbeat {new Date(session.connection.lastSeen).toLocaleTimeString()} · presence
            is not a speed test
          </p>
        </div>
      )}
      {session && state !== "closed" && state !== "expired" && (
        <div
          className="mt-4 flex items-center gap-2 font-mono text-[10px] text-muted-foreground"
          aria-live="off"
        >
          <Clock3 size={12} />
          Invitation expires in {Math.max(0, Math.ceil((session.expiresAt - now) / 60000))} min
        </div>
      )}
    </div>
  );
}
function LatencyTrace({ run, maximum }: { run: CheckRun; maximum: number }) {
  const phases = [
    { label: "Idle", values: run.idleMs, color: "var(--color-brand)" },
    { label: "Loaded", values: run.loadedMs, color: "var(--color-chart-2)" },
  ];
  return (
    <figure className="min-w-0 rounded-xl border border-border bg-background p-4">
      <figcaption className="mb-3 text-xs font-medium">
        {run.label} · HTTP latency samples
      </figcaption>
      <svg
        role="img"
        aria-label={`${run.label}: idle and loaded HTTP latency, shared scale 0 to ${maximum.toFixed(1)} milliseconds`}
        viewBox="0 0 400 130"
        className="h-32 w-full"
      >
        <path d="M34 12V108H388 M34 60H388" fill="none" stroke="var(--color-border)" />
        <text x="0" y="15" fontSize="9" fill="currentColor">
          {maximum.toFixed(0)}
        </text>
        <text x="15" y="110" fontSize="9" fill="currentColor">
          0
        </text>
        {phases.map(({ label, values, color }) => (
          <polyline
            key={label}
            fill="none"
            stroke={color}
            strokeWidth="2"
            points={values
              .map(
                (v, i) =>
                  `${34 + (i * 350) / Math.max(1, values.length - 1)},${108 - (v / maximum) * 94}`,
              )
              .join(" ")}
          />
        ))}
        <text x="180" y="127" fontSize="9" fill="currentColor">
          Sample index
        </text>
      </svg>
      <div className="flex gap-4 text-[10px] text-muted-foreground">
        {phases.map((p) => (
          <span key={p.label} className="flex items-center gap-1">
            <i className="size-2 rounded-full" style={{ background: p.color }} />
            {p.label} · {p.values.length} samples
          </span>
        ))}
      </div>
    </figure>
  );
}
export function ClientChecksView() {
  return (
    <WorkspaceFrame
      title="See the other end of the connection."
      description="Invite a phone or laptop to measure its own path. Compare Wi-Fi and VPN with evidence from the device that is actually affected."
      eyebrow="CLIENT CHECK / ENDPOINT EVIDENCE"
    >
      {(d) => <Checks device={d} />}
    </WorkspaceFrame>
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
    return code.createDataURL(5, 12);
  }, [link]);
  return (
    <div className="grid gap-5">
      <Steps
        labels={["Invite a device", "Run on Wi-Fi / VPN", "Compare evidence"]}
        active={runs.length > 1 ? 2 : link ? 1 : 0}
      />
      {error && <Notice error>{error}</Notice>}
      {casesError && <Notice error>Could not load investigations: {casesError}</Notice>}
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(280px,.8fr)_minmax(0,1.4fr)]">
        <section className={`${workspaceCard} grid gap-5`}>
          <div>
            <h3 className="font-semibold">A private test invitation</h3>
            <p className={`mt-2 ${workspaceNote}`}>
              15 minutes · six runs · up to 20 MiB per run. The invitation cannot access your
              dashboard.
            </p>
          </div>
          {network && (
            <div className="rounded-xl border border-border bg-background p-3 text-xs">
              <span className="flex items-center gap-2 font-medium">
                <Server size={14} />
                Server listening on{" "}
                <code>
                  {network.bindHost}:{network.port}
                </code>
              </span>
              <p className={`mt-2 ${workspaceNote}`}>
                {network.localOnly
                  ? "Local-only listener. Restart with --dashboard-host 0.0.0.0 to allow devices on your network."
                  : "Choose an address reachable from your device. Use the same LAN/VPN and allow this port in the computer’s firewall."}
              </p>
            </div>
          )}
          {networkError && (
            <Notice error>
              Could not detect server addresses: {networkError}. Enter this host’s reachable address
              below.
            </Notice>
          )}
          <label className="grid gap-2 text-xs">
            Session name
            <Input value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className="grid gap-2 text-xs">
            This server’s reachable address
            {!!network?.candidates.length && (
              <Select
                aria-label="Detected server address"
                value={network.candidates.some((c) => c.origin === origin) ? origin : ""}
                onValueChange={setOrigin}
                options={[
                  { value: "", label: "Custom address / HTTPS proxy" },
                  ...network.candidates.map((c) => ({
                    value: c.origin,
                    label: `${c.name} · ${c.address}`,
                  })),
                ]}
              />
            )}
            <Input
              aria-label="Test server origin"
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              placeholder="http://192.168.1.10:9091"
            />
            <span className={workspaceNote}>
              Use this MCP host’s LAN/VPN address. Localhost and wildcard addresses cannot be used
              in a phone invitation.
            </span>
          </label>
          <Select
            aria-label="Linked investigation"
            value={caseId}
            onValueChange={setCaseId}
            options={[
              { value: "", label: "No linked investigation" },
              ...cases.map((c) => ({ value: c.id, label: `${c.service} · ${c.client}` })),
            ]}
          />
          <Button
            disabled={busy || !label.trim() || !origin.trim()}
            onClick={() => void create()}
            icon={<Plus size={14} />}
          >
            {busy ? "Creating…" : "Create invitation"}
          </Button>
          {link && (
            <div className="grid justify-items-center gap-3 rounded-xl border border-border bg-background p-4">
              <div
                className="check-qr-frame"
                data-connected={
                  current &&
                  checkConnectionState(current, now) === "connected" &&
                  !presenceUnavailable
                }
              >
                <img
                  className="rounded-lg"
                  src={qr}
                  width="180"
                  height="180"
                  alt="Scan to open the private Client Check invitation"
                />
                <span className="check-qr-check" aria-hidden="true">
                  <Check size={15} />
                </span>
              </div>
              <span className={workspaceNote}>Scan on the affected device</span>
              <div className="flex flex-wrap gap-2">
                <Button
                  ghost
                  size="sm"
                  icon={<Copy size={13} />}
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
                </Button>
                <a
                  className="inline-flex items-center gap-1 text-xs text-brand underline"
                  href={link}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open test
                  <ExternalLink size={12} />
                </a>
              </div>
              <Input aria-label="Private invitation URL" readOnly value={link} />
            </div>
          )}
          <Notice>
            Only share this link with the person running the test. Use trusted LAN/VPN or HTTPS;
            HTTP does not protect the invitation in transit.
          </Notice>
        </section>
        <section className="grid min-w-0 gap-5">
          <ConnectionPanel session={current} now={now} unavailable={presenceUnavailable} />
          <div className={workspaceCard}>
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-semibold">Measured path</h3>
              <Button
                size="sm"
                ghost
                icon={<RefreshCw size={13} />}
                onClick={() => void load().catch((e) => setError(e.message))}
              >
                Refresh
              </Button>
            </div>
            <div className="mt-4">
              <Notice>
                This is HTTP transfer performance to the host above. A local host measures LAN/VPN
                access, not your internet plan. DNS, PMTU and application availability are not
                measured. IPv4/IPv6 indicates the connection this server observed; a reverse proxy
                changes that perspective.
              </Notice>
            </div>
          </div>
          <div className={workspaceCard}>
            <h3 className="mb-4 font-semibold">Session history</h3>
            <Select
              aria-label="Check session"
              value={selected}
              onValueChange={(v) => {
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
            {current && (
              <div className="mt-4 grid gap-4">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    {current.caseId ? (
                      <>
                        <Link2 size={12} className="inline" /> Linked to investigation
                      </>
                    ) : (
                      "Standalone check"
                    )}{" "}
                    · expires {new Date(current.expiresAt).toLocaleString()}
                  </span>
                  <Button
                    size="sm"
                    ghost
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
                  </Button>
                </div>
                {!runs.length && (
                  <Notice>
                    No measurements saved yet. Connecting a device only reports presence; a test
                    starts when the person accepts it on that device.
                  </Notice>
                )}
                {runs.map((r) => {
                  const stats = summarizeRun(r);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      aria-pressed={pair.includes(r.id)}
                      onClick={() =>
                        setPair((p) =>
                          p.includes(r.id) ? p.filter((id) => id !== r.id) : [...p.slice(-1), r.id],
                        )
                      }
                      className={`w-full rounded-xl border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring ${pair.includes(r.id) ? "border-brand bg-brand/10" : "border-border hover:bg-accent"}`}
                    >
                      <div className="flex flex-wrap justify-between gap-2 text-xs">
                        <strong>
                          {r.label} · {r.path}
                        </strong>
                        <span className="font-mono text-muted-foreground">
                          {r.family} · {stats.complete ? "complete" : "partial"}
                        </span>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        ↓ {stats.downloadMbps?.toFixed(1) ?? "—"} Mbps · ↑{" "}
                        {stats.uploadMbps?.toFixed(1) ?? "—"} Mbps ·{" "}
                        {stats.idleMs?.toFixed(1) ?? "—"} ms
                      </p>
                      <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">
                        {r.endpoint} · {new Date(r.receivedAt).toLocaleString()}
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </div>
      {comparison && (
        <section className={workspaceCard}>
          <h3 className="mb-4 font-semibold">
            {a!.label} → {b!.label}
          </h3>
          {comparison.comparable && "second" in comparison ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Metric
                  label="Download change"
                  value={comparison.downloadChangeMbps ?? null}
                  unit="Mbps"
                />
                <Metric
                  label="Idle latency change"
                  value={comparison.latencyChangeMs ?? null}
                  unit="ms"
                />
                <Metric
                  label="Second run · loaded latency"
                  value={comparison.second!.loadedMs}
                  unit="ms"
                />
                <Metric label="Second run · jitter" value={comparison.second!.jitterMs} unit="ms" />
              </div>
              <p className={`mt-4 ${workspaceNote}`}>{comparison.note}</p>
              <div className="mt-5 grid gap-4 md:grid-cols-2">
                {[a!, b!].map((run) => (
                  <LatencyTrace
                    key={run.id}
                    run={run}
                    maximum={Math.max(
                      1,
                      ...a!.idleMs,
                      ...a!.loadedMs,
                      ...b!.idleMs,
                      ...b!.loadedMs,
                    )}
                  />
                ))}
              </div>
            </>
          ) : (
            <Notice>{"reason" in comparison ? comparison.reason : "Not comparable"}</Notice>
          )}
        </section>
      )}
    </div>
  );
}
