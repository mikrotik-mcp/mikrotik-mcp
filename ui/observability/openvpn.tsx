import { LoadingState } from "./loading-state";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Activity, Globe, Lock, LockKeyhole, Power, RefreshCw, TriangleAlert } from "lucide-react";
import { api, postJson, withToken } from "./api";
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
  Ticker,
  formatBytes,
  useStaggerIn,
} from "./monitoring-ui";
import { OpenVpnRadar } from "./openvpn-graphics";
import type { OvpnRadarStatus } from "./openvpn-graphics";
import { connectionDuration, openVpnTrafficRate } from "../../src/core/openvpn-sessions-model";
import type { OpenVpnSession, OpenVpnSnapshot } from "../../src/core/openvpn-sessions-model";
import "./openvpn.css";
import { OpenVpnHistory } from "./openvpn-history";

type OvpnView = "live" | "history";

const VIEWS: { value: OvpnView; label: string }[] = [
  { value: "live", label: "Live connections" },
  { value: "history", label: "History & insights" },
];

/** The board's flag chip: the country flag and code, or LAN for a private source. */
function CountryChip({ session }: { session: OpenVpnSession }) {
  const geo = session.sourceGeo;
  const [failedCode, setFailedCode] = useState("");
  const code = geo?.countryCode?.toLowerCase() ?? "";
  const resolved = geo?.status === "resolved" && /^[a-z]{2}$/.test(code);
  const country = geo?.country || code.toUpperCase();
  const label = resolved
    ? `${country} · approximate source-IP location`
    : geo?.status === "pending"
      ? "Looking up source-IP country"
      : geo?.status === "private"
        ? "Private or non-public source IP · no country lookup"
        : "Source-IP country unavailable";
  return (
    <span
      className="monitor-chip ovpn-country"
      data-known={resolved || undefined}
      role="img"
      aria-label={label}
      title={label}
    >
      {resolved ? (
        failedCode === code ? (
          <Globe aria-hidden="true" />
        ) : (
          <img
            src={withToken(`/api/flag/${code}`)}
            width={16}
            height={16}
            alt=""
            loading="lazy"
            onError={() => setFailedCode(code)}
          />
        )
      ) : geo?.status === "private" ? (
        <Lock aria-hidden="true" />
      ) : (
        <Globe aria-hidden="true" />
      )}
      {resolved ? code.toUpperCase() : geo?.status === "private" ? "LAN" : "—"}
    </span>
  );
}

function networkOf(session: OpenVpnSession) {
  const geo = session.sourceGeo;
  const known = geo?.status === "resolved" && !!(geo.asnOrganization || geo.asn);
  const name = known
    ? [geo.asnOrganization, geo.asn].filter(Boolean).join(" · ")
    : geo?.status === "pending"
      ? "Looking up network…"
      : geo?.status === "private"
        ? "Private network"
        : "Network unavailable";
  const title = known
    ? [geo.asnOrganization, geo.asn, "Source-IP network organization"].filter(Boolean).join(" · ")
    : name;
  return { known, name, title };
}

/** Flag chip, source IP and the network organization under it. */
function ClientSource({ session }: { session: OpenVpnSession }) {
  const network = networkOf(session);
  return (
    <span className="ovpn-client-source">
      <span className="ovpn-source-address">
        <CountryChip session={session} />
        <span className="ovpn-mono ovpn-tx" dir="ltr">
          {session.callerId || "Not reported"}
        </span>
      </span>
      <span className="ovpn-source-network" data-known={network.known} title={network.title}>
        {network.name}
      </span>
    </span>
  );
}

const initials = (name: string) => {
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  return (
    parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : (parts[0] ?? "?").slice(0, 2)
  ).toUpperCase();
};

/** ok: RADIUS user, acc: local account, warn: no traffic counters reported yet. */
const toneOf = (s: OpenVpnSession) =>
  s.downloadBytes == null && s.uploadBytes == null ? "warn" : s.radius ? "ok" : "acc";

/** "6d 22h", "19h 40m", "42m". */
function shortDuration(seconds: number) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor(seconds / 3600) % 24;
  const m = Math.floor(seconds / 60) % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

const roundCount = (n: number) => String(Math.round(n));

const shortDate = (at: number) =>
  new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function RouterControls({
  view,
  onView,
  device,
  devices,
  defaultDevice,
  onDevice,
}: {
  view: OvpnView;
  onView: (view: OvpnView) => void;
  device: string;
  devices: string[];
  defaultDevice: string;
  onDevice: (device: string) => void;
}) {
  return (
    <>
      <Segmented value={view} options={VIEWS} onChange={onView} label="OpenVPN views" />
      <RouterPicker
        value={device}
        onChange={onDevice}
        routers={devices}
        defaultRouter={defaultDevice}
        disabled={!devices.length}
        label="OpenVPN router"
      />
    </>
  );
}

export function OpenVpnView() {
  const [view, setView] = useState<OvpnView>("live");
  const [devices, setDevices] = useState<string[]>([]);
  const [device, setDevice] = useState("");
  const [defaultDevice, setDefaultDevice] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void api<{ devices: { name: string; disabled?: boolean }[]; defaultDevice: string }>(
      "/api/devices",
      abort.signal,
    )
      .then((r) => {
        if (abort.signal.aborted) return;
        const names = r.devices.filter((d) => !d.disabled).map((d) => d.name);
        setDevices(names);
        setDefaultDevice(r.defaultDevice);
        setDevice(names.includes(r.defaultDevice) ? r.defaultDevice : (names[0] ?? ""));
        setError("");
        setLoaded(true);
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setError("Routers could not be loaded. Check the dashboard connection and retry.");
          setLoaded(true);
        }
      });
    return () => abort.abort();
  }, [revision]);
  const controls = (
    <RouterControls
      view={view}
      onView={setView}
      device={device}
      devices={devices}
      defaultDevice={defaultDevice}
      onDevice={setDevice}
    />
  );
  const routerError = error && (
    <MonitorNote tone="bad" role="alert" icon={<TriangleAlert aria-hidden="true" />}>
      <span className="ovpn-note-row">
        <span>{error}</span>
        <MonitorButton size="sm" onClick={() => setRevision((v) => v + 1)}>
          Retry routers
        </MonitorButton>
      </span>
    </MonitorNote>
  );
  if (device)
    return (
      <div className="ovpn-page">
        {view === "live" ? (
          <OpenVpnConnections key={device} device={device} controls={controls} />
        ) : (
          <OpenVpnHistory key={device} device={device} controls={controls} />
        )}
        {routerError}
      </div>
    );
  return (
    <div className="ovpn-page">
      <PageIntro
        eyebrow="OpenVPN · live connections"
        verdict={loaded ? "No router to read." : "Loading routers…"}
        lead="See who is here, where they connect from and how long they have stayed. End a single session when you need to."
        actions={controls}
      />
      {routerError}
      {!error && loaded && (
        <MonitorEmpty icon={<LockKeyhole />} title="No enabled routers">
          Add or enable a router in Devices to see its OpenVPN connections.
        </MonitorEmpty>
      )}
    </div>
  );
}

export function OpenVpnConnections({
  device,
  controls,
}: {
  device: string;
  /** The view switch and router picker, shown under the lead. */
  controls?: ReactNode;
}) {
  const [sample, setSample] = useState<{ data: OpenVpnSnapshot; receivedAt: number }>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<OpenVpnSession>();
  const [counts, setCounts] = useState<number[]>([]);
  const sampleRef = useRef<{ data: OpenVpnSnapshot; receivedAt: number } | undefined>(undefined);
  const [confirmed, setConfirmed] = useState(false);
  const alive = useRef(true);
  const sending = useRef(false);
  const rowsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    alive.current = true;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (busy || selected) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      if (!document.hidden) {
        setLoading(true);
        try {
          const data = await api<OpenVpnSnapshot>(
            `/api/openvpn/sessions?device=${encodeURIComponent(device)}`,
            AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
          );
          if (!abort.signal.aborted) {
            const previous = sampleRef.current;
            const interval =
              previous?.data.device === data.device
                ? (data.observedAt - previous.data.observedAt) / 1000
                : 0;
            for (const session of data.sessions) {
              const earlier = previous?.data.sessions.find(
                (item) =>
                  item.id === session.id &&
                  item.sessionId === session.sessionId &&
                  item.name === session.name,
              );
              session.downloadBytesPerSecond = openVpnTrafficRate(
                session,
                earlier,
                interval,
                "downloadBytes",
              );
              session.uploadBytesPerSecond = openVpnTrafficRate(
                session,
                earlier,
                interval,
                "uploadBytes",
              );
            }
            sampleRef.current = { data, receivedAt: Date.now() };
            setSample({ data, receivedAt: Date.now() });
            setCounts((c) => [...c, data.sessions.length].slice(-12));
            setError("");
            setNow(Date.now());
          }
        } catch (e) {
          if (!abort.signal.aborted)
            setError(e instanceof Error ? e.message : "Router unavailable. Refresh to try again.");
        } finally {
          if (!abort.signal.aborted) setLoading(false);
        }
      }
      if (!abort.signal.aborted) timer = setTimeout(() => void read(), 5000);
    };
    void read();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [device, revision, busy, selected]);
  const data = sample?.data;
  const stale = !!error || !sample || now - sample.receivedAt > 15000;
  // Leave room for the short server cache and request transit time before token expiry.
  const selectionExpired = !!selected && (!sample || now - sample.receivedAt >= 55000);
  const secondsLeft = sample ? Math.max(0, Math.ceil((sample.receivedAt + 55000 - now) / 1000)) : 0;
  const elapsed = stale || !sample ? 0 : Math.max(0, Math.floor((now - sample.receivedAt) / 1000));
  const sessions = data?.sessions ?? [];
  const matching = sessions.filter((s) =>
    [
      s.name,
      s.address,
      s.callerId,
      s.sessionId,
      s.sourceGeo?.country,
      s.sourceGeo?.countryCode,
      s.sourceGeo?.asn,
      s.sourceGeo?.asnOrganization,
    ]
      .join(" ")
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  useStaggerIn(rowsRef, ".ovpn-session", `${device}:${query}:${!!data}`);
  const longest = sessions.reduce<OpenVpnSession | null>(
    (max, s) =>
      s.uptimeSeconds === null || (max && (max.uptimeSeconds ?? 0) >= s.uptimeSeconds) ? max : s,
    null,
  );
  const perUser = new Map<string, OpenVpnSession[]>();
  for (const s of sessions) perUser.set(s.name, [...(perUser.get(s.name) ?? []), s]);
  const users = perUser.size;
  const multi = [...perUser].filter(([, list]) => list.length > 1);
  const radarNodes = [...perUser].map(([name, list]) => ({
    label: name,
    sessions: list.length,
    status: (list.some((s) => toneOf(s) === "warn") ? "warn" : "ok") as OvpnRadarStatus,
  }));
  const others = selected
    ? sessions.filter((s) => s.name === selected.name && s.id !== selected.id).length
    : 0;
  function choose(session: OpenVpnSession) {
    setConfirmed(false);
    setNotice("");
    setSelected(session);
  }
  async function disconnect() {
    if (!selected?.disconnectToken || !confirmed || selectionExpired || sending.current) return;
    sending.current = true;
    setBusy(true);
    setNotice("");
    try {
      const result = await postJson<{ status?: string; message?: string; error?: string }>(
        `/api/openvpn/disconnect?device=${encodeURIComponent(device)}`,
        { token: selected.disconnectToken, confirm: true },
      );
      if (alive.current)
        setNotice(
          result.error ??
            result.message ??
            "No confirmation received. Refresh to check the current connection; do not retry automatically.",
        );
    } catch {
      if (alive.current)
        setNotice(
          "Connection interrupted before confirmation. Refresh to check the router; the request will not be replayed.",
        );
    } finally {
      sending.current = false;
      if (alive.current) {
        setBusy(false);
        setSelected(undefined);
        setRevision((v) => v + 1);
      }
    }
  }
  const verdict = !data ? (
    error ? (
      <>
        Connections <em>can't be read</em> right now.
      </>
    ) : (
      "Reading OpenVPN connections…"
    )
  ) : users === 0 ? (
    "Nobody is connected right now."
  ) : (
    <>
      {users} {users === 1 ? "person" : "people"} connected{" "}
      {stale ? <span className="w">at the last read.</span> : <span className="s">right now.</span>}
    </>
  );
  const fresh = !sample ? (
    <StatusBadge quiet>Waiting for router</StatusBadge>
  ) : stale ? (
    <StatusBadge tone="warn">Last known connections · stale</StatusBadge>
  ) : (
    <StatusBadge tone="good" pulse>
      Live · 5s refresh
    </StatusBadge>
  );
  return (
    <>
      <PageIntro
        eyebrow="OpenVPN · live connections"
        verdict={verdict}
        lead="See who is here, where they connect from and how long they have stayed. End a single session when you need to."
        actions={
          <>
            {controls}
            <span className="monitor-hint ovpn-scope-hint">Incoming OpenVPN connections only.</span>
          </>
        }
        aside={
          <div className="glass ovpn-radar-box">
            <OpenVpnRadar nodes={radarNodes} />
          </div>
        }
      />
      <MetricStrip label="OpenVPN connection summary" className="ovpn-summary ovpn-kpis-3">
        <Metric
          label="Active connections"
          value={data ? <Ticker value={sessions.length} format={roundCount} /> : "—"}
          hint={
            !data
              ? "Waiting for the router"
              : multi.length === 1
                ? `${multi[0][0]} has ${multi[0][1].length === 2 ? "two" : multi[0][1].length} sessions`
                : multi.length
                  ? `${multi.length} users have more than one session`
                  : "one session per user"
          }
          spark={counts.length > 1 ? counts : undefined}
        />
        <Metric
          label="Distinct users"
          value={data ? <Ticker value={users} format={roundCount} /> : "—"}
          hint="by username"
        />
        <Metric
          label="Longest connection"
          value={
            longest?.uptimeSeconds == null ? "—" : shortDuration(longest.uptimeSeconds + elapsed)
          }
          hint={
            longest?.uptimeSeconds == null || !data
              ? "No uptime reported"
              : `${longest.name} · since ${shortDate(data.observedAt - longest.uptimeSeconds * 1000)}`
          }
        />
      </MetricStrip>
      {error && (
        <MonitorNote tone="bad" role="alert" icon={<TriangleAlert aria-hidden="true" />}>
          {error}
        </MonitorNote>
      )}
      {notice && <MonitorNote role="status">{notice}</MonitorNote>}
      <MonitorPanel
        title="Active connections"
        description="One row per session. Country and network describe the source IP, not the person."
        flush
        className="ovpn-sessions-panel"
      >
        <div className="ovpn-toolbar">
          <MonitorSearch
            className="ovpn-search"
            label="Search OpenVPN connections"
            placeholder="Find a user, IP, country or network"
            value={query}
            onChange={setQuery}
          />
          {fresh}
          <MonitorButton
            disabled={loading || busy || !!selected}
            onClick={() => setRevision((v) => v + 1)}
            icon={<RefreshCw aria-hidden="true" className={loading ? "animate-spin" : ""} />}
          >
            Refresh
          </MonitorButton>
        </div>
        {!data && !error ? (
          <LoadingState label="Reading active connections" layout="cards" />
        ) : !data ? (
          <MonitorEmpty icon={<Activity />} title="Connection list unavailable">
            An unreachable router is not an empty connection list.
          </MonitorEmpty>
        ) : matching.length === 0 ? (
          <MonitorEmpty
            icon={<LockKeyhole />}
            title={sessions.length ? "No matching connections" : "No active OpenVPN connections"}
          >
            {sessions.length
              ? "Try another user, IP, country, network organization or ASN."
              : `No incoming OpenVPN sessions were reported by ${device} at the last read.`}
          </MonitorEmpty>
        ) : (
          <div ref={rowsRef} role="table" aria-label="Active OpenVPN connections">
            <div role="row" className="monitor-thead ovpn-grid ovpn-thead">
              <span role="columnheader">Person</span>
              <span role="columnheader">Client source → tunnel</span>
              <span role="columnheader">Connected for</span>
              <span role="columnheader">Traffic</span>
              <span role="columnheader">
                <span className="sr-only">Actions</span>
              </span>
            </div>
            {matching.map((session) => {
              const tone = toneOf(session);
              return (
                <div
                  role="row"
                  className="monitor-row ovpn-grid ovpn-session"
                  key={`${session.id}:${session.sessionId}`}
                >
                  <span role="cell" className="ovpn-person">
                    <span className="ovpn-avatar" data-tone={tone} aria-hidden="true">
                      {initials(session.name)}
                    </span>
                    <span className="ovpn-stack ovpn-stack-2">
                      <span className="p ovpn-trunc">{session.name}</span>
                      <span className="ovpn-sub ovpn-trunc">
                        {session.radius ? "RADIUS authenticated" : "OpenVPN connection"} ·{" "}
                        <span className="ovpn-mono">{session.id}</span>
                      </span>
                    </span>
                  </span>
                  <span role="cell" className="ovpn-path">
                    <ClientSource session={session} />
                    <svg
                      className="ovpn-path-arrow"
                      viewBox="0 0 70 12"
                      width="70"
                      height="12"
                      aria-hidden="true"
                    >
                      <line
                        x1="2"
                        y1="6"
                        x2="62"
                        y2="6"
                        stroke="var(--sig)"
                        strokeOpacity=".7"
                        strokeWidth="1.5"
                        strokeDasharray="3 4"
                      />
                      <path d="M60 2l6 4-6 4" fill="none" stroke="var(--sig)" strokeWidth="1.5" />
                    </svg>
                    <span className="ovpn-stack">
                      <span className="ovpn-mono ovpn-tx ovpn-trunc">
                        {session.address || "Not reported"}
                      </span>
                      <span className="ovpn-sub">Tunnel IP</span>
                    </span>
                  </span>
                  <span role="cell" className="ovpn-stack">
                    <span className="ovpn-mono ovpn-tx ovpn-num">
                      {connectionDuration(
                        session.uptimeSeconds === null ? null : session.uptimeSeconds + elapsed,
                      )}
                    </span>
                    <span className="ovpn-sub ovpn-trunc">
                      {session.encoding || "Encoding not reported"}
                    </span>
                  </span>
                  <span
                    role="cell"
                    className="ovpn-stack ovpn-traffic"
                    aria-label={`${session.name} session traffic`}
                  >
                    {session.downloadBytes == null && session.uploadBytes == null ? (
                      <>
                        <span className="ovpn-sub">↓ Measuring…</span>
                        <span className="ovpn-sub">↑ Measuring…</span>
                      </>
                    ) : (
                      <>
                        <span className="ovpn-mono ovpn-trunc">
                          <span className="ovpn-down">
                            ↓{" "}
                            {session.downloadBytes == null
                              ? "Unavailable"
                              : formatBytes(session.downloadBytes)}
                          </span>{" "}
                          <span className="ovpn-faint">
                            ·{" "}
                            {session.downloadBytesPerSecond == null
                              ? "Measuring…"
                              : `${formatBytes(session.downloadBytesPerSecond)}/s`}
                          </span>
                        </span>
                        <span className="ovpn-mono ovpn-trunc">
                          <span className="ovpn-up">
                            ↑{" "}
                            {session.uploadBytes == null
                              ? "Unavailable"
                              : formatBytes(session.uploadBytes)}
                          </span>{" "}
                          <span className="ovpn-faint">
                            ·{" "}
                            {session.uploadBytesPerSecond == null
                              ? "Measuring…"
                              : `${formatBytes(session.uploadBytesPerSecond)}/s`}
                          </span>
                        </span>
                      </>
                    )}
                  </span>
                  <span role="cell" className="ovpn-action">
                    <MonitorButton
                      variant="danger"
                      size="sm"
                      className="ovpn-disconnect"
                      icon={<Power aria-hidden="true" />}
                      aria-label={`Disconnect ${session.name} session ${session.id}`}
                      title={
                        !session.disconnectToken
                          ? "Session identity or uptime is missing; disconnect is unavailable."
                          : undefined
                      }
                      disabled={stale || busy || !data.canDisconnect || !session.disconnectToken}
                      onClick={() => choose(session)}
                    >
                      Disconnect
                    </MonitorButton>
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <div className="monitor-foot">
          {data && (
            <span>
              {matching.length} of {sessions.length} connections · router read{" "}
              {new Date(data.observedAt).toLocaleTimeString()}
              {!data.canDisconnect ? " · read-only access" : ""}
              {stale
                ? " · times are frozen until the next successful read"
                : " · times advance between router reads"}
            </span>
          )}
          <span className="flex-1" />
          <span>Disconnect ends one session. It does not disable the account.</span>
        </div>
      </MonitorPanel>
      <MonitorDialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open && !busy) setSelected(undefined);
        }}
        closeDisabled={busy}
        dismissible={!busy}
        title="Disconnect this connection?"
        description={
          selected
            ? `Only this session on ${device} ends.${
                others === 1
                  ? ` ${selected.name} has another session that stays connected.`
                  : others > 1
                    ? ` ${selected.name} has ${others} other sessions that stay connected.`
                    : ""
              }`
            : undefined
        }
        footer={
          <>
            <span className="monitor-hint">
              {selectionExpired
                ? "This selection expired."
                : `This selection expires after ${secondsLeft} seconds.`}
            </span>
            <span className="flex-1" />
            <MonitorButton variant="ghost" disabled={busy} onClick={() => setSelected(undefined)}>
              Cancel
            </MonitorButton>
            <MonitorButton
              variant="danger"
              icon={<Power aria-hidden="true" />}
              disabled={!confirmed || busy || selectionExpired}
              onClick={() => void disconnect()}
            >
              {busy ? "Disconnecting…" : "Disconnect connection"}
            </MonitorButton>
          </>
        }
      >
        {selected && (
          <div className="monitor-dialog-body ovpn-dialog-body">
            <dl className="monitor-facts ovpn-facts">
              <dt>User</dt>
              <dd className="ovpn-user">{selected.name}</dd>
              <dt>Router</dt>
              <dd className="ovpn-mono">{device}</dd>
              <dt>Client source</dt>
              <dd>
                <ClientSource session={selected} />
              </dd>
              <dt>Tunnel IP</dt>
              <dd className="ovpn-mono">{selected.address || "Not reported"}</dd>
              <dt>Session</dt>
              <dd className="ovpn-mono">
                {selected.id} · {selected.sessionId}
              </dd>
            </dl>
            <MonitorNote tone="warn" icon={<TriangleAlert aria-hidden="true" />}>
              If this is your management tunnel, you may lose access to this router. The client can
              reconnect with its existing credentials.
            </MonitorNote>
            {selectionExpired && (
              <MonitorNote tone="bad" role="alert" icon={<TriangleAlert aria-hidden="true" />}>
                This selection expired. Close this dialog and select the current connection again.
              </MonitorNote>
            )}
            <label className="monitor-check">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              I want to disconnect this one connection.
            </label>
          </div>
        )}
      </MonitorDialog>
    </>
  );
}
