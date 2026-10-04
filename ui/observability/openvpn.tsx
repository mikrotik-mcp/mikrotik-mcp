import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  Clock3,
  LockKeyhole,
  RefreshCw,
  Search,
  ShieldCheck,
  Unplug,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { api, postJson } from "./api";
import { WorkspaceError } from "./operations-ui";
import { connectionDuration } from "../../src/core/openvpn-sessions-model";
import type { OpenVpnSession, OpenVpnSnapshot } from "../../src/core/openvpn-sessions-model";
import "./openvpn.css";

export function OpenVpnView() {
  const [devices, setDevices] = useState<string[]>([]);
  const [device, setDevice] = useState("");
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
  return (
    <div className="ovpn-workspace">
      <header className="ovpn-intro">
        <div>
          <span className="ovpn-eyebrow">
            <LockKeyhole size={15} /> OPENVPN / LIVE CONNECTIONS
          </span>
          <h2>
            Who's connected<span>to your network.</span>
          </h2>
          <p>
            One connection per row. See who is here, how long they have stayed, and end a session
            when needed.
          </p>
        </div>
        <div className="ovpn-router">
          <label htmlFor="ovpn-router">Router</label>
          <Select value={device} onValueChange={setDevice} disabled={!devices.length}>
            <SelectTrigger id="ovpn-router" aria-label="OpenVPN router">
              <SelectValue placeholder="Select a router" />
            </SelectTrigger>
            <SelectContent>
              {devices.map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <small>Incoming OpenVPN connections only</small>
        </div>
      </header>
      {error && (
        <>
          <WorkspaceError message={error} />
          <Button variant="outline" onClick={() => setRevision((v) => v + 1)}>
            Retry routers
          </Button>
        </>
      )}
      {device ? (
        <OpenVpnConnections key={device} device={device} />
      ) : (
        !error && (
          <div className="ovpn-empty">
            {loaded
              ? "No enabled routers. Add or enable a router in Devices to see its OpenVPN connections."
              : "Loading routers…"}
          </div>
        )
      )}
    </div>
  );
}

export function OpenVpnConnections({ device }: { device: string }) {
  const [sample, setSample] = useState<{ data: OpenVpnSnapshot; receivedAt: number }>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<OpenVpnSession>();
  const [confirmed, setConfirmed] = useState(false);
  const alive = useRef(true);
  const sending = useRef(false);
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
            setSample({ data, receivedAt: Date.now() });
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
  const elapsed = stale || !sample ? 0 : Math.max(0, Math.floor((now - sample.receivedAt) / 1000));
  const sessions = data?.sessions ?? [];
  const matching = sessions.filter((s) =>
    [s.name, s.address, s.callerId, s.sessionId]
      .join(" ")
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const longest = sessions.reduce<number | null>(
    (max, s) => (s.uptimeSeconds === null ? max : Math.max(max ?? 0, s.uptimeSeconds)),
    null,
  );
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
  return (
    <>
      <section className="ovpn-summary" aria-label="OpenVPN connection summary">
        <div>
          <Users size={18} />
          <span>
            Active connections<strong>{data ? sessions.length : "—"}</strong>
          </span>
        </div>
        <div>
          <ShieldCheck size={18} />
          <span>
            Distinct users<strong>{data ? new Set(sessions.map((s) => s.name)).size : "—"}</strong>
          </span>
        </div>
        <div>
          <Clock3 size={18} />
          <span>
            Longest connection
            <strong>{longest === null ? "—" : connectionDuration(longest + elapsed)}</strong>
          </span>
        </div>
      </section>
      <div className="ovpn-toolbar">
        <div className="ovpn-search">
          <Search size={16} />
          <Input
            aria-label="Search OpenVPN connections"
            placeholder="Find a user, source or tunnel IP…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <span className="ovpn-fresh" data-stale={stale}>
          <i />
          {sample
            ? stale
              ? "Last known connections · stale"
              : "Live · 5s refresh"
            : "Waiting for router"}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={loading || busy || !!selected}
          onClick={() => setRevision((v) => v + 1)}
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
        </Button>
      </div>
      <WorkspaceError message={error} />
      {notice && (
        <div className="ovpn-notice" role="status">
          {notice}
        </div>
      )}
      {data && (
        <p className="ovpn-caption">
          {matching.length} of {sessions.length} connections · Router read{" "}
          {new Date(data.observedAt).toLocaleTimeString()}
          {!data.canDisconnect ? " · Read-only access" : ""}
          {stale
            ? " · Times are frozen until the next successful read."
            : " · Times advance between router reads."}
        </p>
      )}
      {!data ? (
        <div className="ovpn-empty">
          <Activity size={26} />
          <strong>{error ? "Connection list unavailable" : "Reading active connections…"}</strong>
          <span>
            {error
              ? "An unreachable router is not an empty connection list."
              : "Reading runtime sessions, not user passwords or history."}
          </span>
        </div>
      ) : matching.length === 0 ? (
        <div className="ovpn-empty">
          <LockKeyhole size={28} />
          <strong>
            {sessions.length ? "No matching connections" : "No active OpenVPN connections"}
          </strong>
          <span>
            {sessions.length
              ? "Try another username or IP address."
              : `No incoming OpenVPN sessions were reported by ${device} at the last read.`}
          </span>
        </div>
      ) : (
        <section className="ovpn-list" aria-label="Active OpenVPN connections">
          {matching.map((session) => (
            <article className="ovpn-session" key={`${session.id}:${session.sessionId}`}>
              <div className="ovpn-person">
                <span className="ovpn-avatar">
                  <LockKeyhole size={20} />
                </span>
                <div>
                  <h3>{session.name}</h3>
                  <small>
                    {session.radius ? "RADIUS authenticated" : "OpenVPN connection"} · {session.id}
                  </small>
                </div>
              </div>
              <div className="ovpn-path">
                <div>
                  <small>Client source</small>
                  <code>{session.callerId || "Not reported"}</code>
                </div>
                <ArrowRight size={16} />
                <div>
                  <small>Tunnel IP</small>
                  <code>{session.address || "Not reported"}</code>
                </div>
              </div>
              <div className="ovpn-duration">
                <small>
                  <Clock3 size={13} /> Connected for
                </small>
                <strong>
                  {connectionDuration(
                    session.uptimeSeconds === null ? null : session.uptimeSeconds + elapsed,
                  )}
                </strong>
                <span>{session.encoding || "Encoding not reported"}</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="ovpn-disconnect"
                aria-label={`Disconnect ${session.name} session ${session.id}`}
                title={
                  !session.disconnectToken
                    ? "Session identity or uptime is missing; disconnect is unavailable."
                    : undefined
                }
                disabled={stale || busy || !data.canDisconnect || !session.disconnectToken}
                onClick={() => choose(session)}
              >
                <Unplug size={14} /> Disconnect
              </Button>
            </article>
          ))}
        </section>
      )}
      <p className="ovpn-footnote">
        <ShieldCheck size={15} /> Disconnect ends only the selected connection. It does not disable
        the account; the client may reconnect.
      </p>
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open && !busy) setSelected(undefined);
        }}
      >
        <DialogContent className="ovpn-dialog" showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>Disconnect this connection?</DialogTitle>
            <DialogDescription>
              Only this OpenVPN session on {device} will be ended. Other connections for the same
              username are not selected.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="ovpn-dialog-scroll">
            {selected && (
              <>
                <dl className="ovpn-confirm-details">
                  <div>
                    <dt>User</dt>
                    <dd>{selected.name}</dd>
                  </div>
                  <div>
                    <dt>Router</dt>
                    <dd>{device}</dd>
                  </div>
                  <div>
                    <dt>Client source</dt>
                    <dd>{selected.callerId || "Not reported"}</dd>
                  </div>
                  <div>
                    <dt>Tunnel IP</dt>
                    <dd>{selected.address || "Not reported"}</dd>
                  </div>
                  <div>
                    <dt>Session</dt>
                    <dd>
                      {selected.id} · {selected.sessionId}
                    </dd>
                  </div>
                </dl>
                <p className="ovpn-notice">
                  If this is your management tunnel, you may lose access to this router. The client
                  can reconnect with its existing credentials.
                </p>
                {selectionExpired && (
                  <p role="alert" className="ovpn-notice">
                    This selection expired. Close this dialog and select the current connection
                    again.
                  </p>
                )}
                <label className="ovpn-consent">
                  <Checkbox
                    checked={confirmed}
                    onCheckedChange={(v) => setConfirmed(v === true)}
                    disabled={busy}
                  />{" "}
                  I want to disconnect this one connection.
                </label>
              </>
            )}
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setSelected(undefined)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!confirmed || busy || selectionExpired}
              onClick={() => void disconnect()}
            >
              {busy ? "Disconnecting…" : "Disconnect connection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
