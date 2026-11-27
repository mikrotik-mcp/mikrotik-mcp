import { useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import { Copy, Download, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { api, postJson } from "./api";
import { format } from "date-fns";
import { DateTimePicker, DetailList, RowDrawer, RowMenu, RowMore, TextInput } from "./kit";
import {
  MonitorButton,
  MonitorDialog,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  MonitorSearch,
  MonitorSelect,
  RouterPicker,
  Segmented,
  StatusBadge,
} from "./monitoring-ui";
import { WireguardTraffic, ratePoint, trafficBytes } from "./wireguard-traffic";
import type { Peer, TrafficSample } from "./wireguard-traffic";
import type { ThroughputPoint } from "./bandwidth-chart";
import "./wireguard-users.css";

interface Inventory extends TrafficSample {
  device: string;
  interfaceOptions: { name: string; disabled: boolean; endpoint: string }[];
}
interface Profile {
  user: string;
  config: string;
}
/** The profile as a QR code: an SVG data URL, drawn in the browser. */
function qrDataUrl(text: string): string {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  return code.createDataURL(5, 12);
}

/** A label for a copy of `user` that no user in `taken` has: "name-2", "name-3"… */
export function copyLabel(user: string, taken: string[]): string {
  const base =
    user
      .replace(/-\d+$/, "")
      .replace(/[^A-Za-z0-9._@-]+/g, "-")
      .replace(/^[^A-Za-z0-9]+|[-.]+$/g, "")
      .slice(0, 57) || "peer";
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}

function saveProfile(profile: Profile): void {
  const url = URL.createObjectURL(new Blob([`${profile.config}\n`], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${profile.user}.conf`;
  link.click();
  URL.revokeObjectURL(url);
}

function handshake(peer: Peer, observedAt: number) {
  if (peer.handshakeAt == null) return peer.lastHandshake || "Not reported";
  const seconds = Math.max(0, Math.floor((observedAt - peer.handshakeAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function WireguardUsersView() {
  const [routers, setRouters] = useState<string[]>([]);
  const [device, setDevice] = useState("");
  const [defaultDevice, setDefault] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void api<{ devices: { name: string; disabled?: boolean }[]; defaultDevice: string }>(
      "/api/devices",
      controller.signal,
    )
      .then((r) => {
        if (controller.signal.aborted) return;
        const names = r.devices.filter((d) => !d.disabled).map((d) => d.name);
        setRouters(names);
        setDefault(r.defaultDevice);
        setDevice(names.includes(r.defaultDevice) ? r.defaultDevice : names[0] || "");
        if (!names.length) setError("Enable a router to view its WireGuard peers.");
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Could not load routers.");
      });
    return () => controller.abort();
  }, []);
  return (
    <PeerWorkspace
      key={device}
      device={device}
      routers={routers}
      defaultDevice={defaultDevice}
      onDevice={setDevice}
      routerError={error}
    />
  );
}

function PeerWorkspace({
  device,
  routers,
  defaultDevice,
  onDevice,
  routerError,
}: {
  device: string;
  routers: string[];
  defaultDevice: string;
  onDevice: (name: string) => void;
  routerError: string;
}) {
  const [data, setData] = useState<Inventory | null>(null);
  const [points, setPoints] = useState<ThroughputPoint[]>([]);
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision((n) => n + 1);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const previous = useRef<Inventory | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "managed">("all");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [form, setForm] = useState<{
    user: string;
    interface: string;
    endpoint: string;
    expires: string;
    dns: string;
    address: string;
  } | null>(null);
  const [copied, setCopied] = useState("");
  const [profile, setProfile] = useState<Profile | null>(null);
  const qr = useMemo(() => (profile ? qrDataUrl(profile.config) : ""), [profile]);

  useEffect(() => {
    if (!device) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      setLoading(true);
      try {
        const next = await api<Inventory>(
          `/api/wireguard/users?device=${encodeURIComponent(device)}`,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (previous.current && next.observedAt > previous.current.observedAt) {
          const point = ratePoint(previous.current, next);
          setPoints((old) =>
            [...old.filter((p) => p.at > next.observedAt - 900_000), point].slice(-64),
          );
        }
        previous.current = next;
        setData(next);
        setLoadError("");
      } catch (e) {
        if (!controller.signal.aborted) setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          timer = setTimeout(read, 15_000);
        }
      }
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [device, revision]);

  const peers = data?.peers ?? [];
  const selected = peers.find((p) => p.id === selectedId);
  const managed = peers.filter((p) => p.managed);
  const expired = managed.filter((p) => p.expired && !p.disabled).length;
  const available = data?.interfaceOptions.filter((i) => !i.disabled) ?? [];
  const openForm = (source?: Peer) => {
    const preferred =
      available.find((i) => i.name === (source?.interface ?? managed[0]?.interface)) ??
      (available.length === 1 ? available[0] : undefined);
    setSelectedId(null);
    setCopied(source?.user ?? "");
    setError("");
    setConfirming(null);
    setForm({
      user: source
        ? copyLabel(
            source.user,
            managed.map((p) => p.user),
          )
        : "",
      interface: preferred?.name ?? "",
      endpoint: preferred?.endpoint ?? "",
      dns: "",
      address: "",
      expires: source?.expires ?? "",
    });
  };
  const act = async (path: string, body: Record<string, unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await postJson<{
        ok?: boolean;
        config?: string;
        error?: string;
        message?: string;
      }>(`/api/wireguard/${path}`, { ...body, device });
      if (!result.ok)
        throw new Error(result.error || result.message || "The router did not confirm the change.");
      if (path === "onboard") {
        if (!result.config)
          throw new Error("The router did not return a profile. Refresh the list before retrying.");
        setProfile({ user: String(body.user), config: result.config });
        setForm(null);
      }
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const submit = () => {
    if (!form) return;
    const user = form.user.trim(),
      endpoint = form.endpoint.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,62}$/.test(user))
      return setError(
        "Enter a peer name using letters, numbers, dots, @, hyphens or underscores (up to 63 characters).",
      );
    if (managed.some((p) => p.user === user)) return setError("This peer name is already in use.");
    if (!available.some((i) => i.name === form.interface))
      return setError("Choose an enabled WireGuard interface.");
    const port = endpoint.match(/^(?:\[[0-9a-f:]+\]|[\w.-]+):(\d{1,5})$/i)?.[1];
    if (!port || Number(port) < 1 || Number(port) > 65535)
      return setError(
        "Enter the public hostname or IP and UDP port, for example vpn.example.net:51820.",
      );
    const address = form.address.trim();
    if (
      address &&
      (!/^\d{1,3}(?:\.\d{1,3}){3}(?:\/32)?$/.test(address) ||
        address
          .split("/")[0]
          .split(".")
          .some((octet) => Number(octet) > 255))
    )
      return setError("Enter one client IPv4 address, optionally followed by /32.");
    void act("onboard", { ...form, user, endpoint, address });
  };
  const visible = (scope === "all" ? peers : managed).filter((p) =>
    [p.user, p.interface, p.address].some((s) =>
      s.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  );
  const recent = peers.filter(
    (p) => !p.disabled && p.handshakeAt != null && data!.observedAt - p.handshakeAt <= 180_000,
  ).length;
  return (
    <section className="wgu">
      <header className="wgu-intro">
        <div>
          <div className="wgu-context">
            <ShieldCheck /> Remote access
          </div>
          <h1>WireGuard peers</h1>
          <p>Monitor tunnel traffic and manage client access.</p>
        </div>
        <div className="wgu-tools">
          <fieldset disabled={busy}>
            <RouterPicker
              routers={routers}
              value={device}
              defaultRouter={defaultDevice}
              onChange={onDevice}
              label="Router"
            />
          </fieldset>
          <MonitorButton
            variant="ghost"
            aria-label="Refresh peer statistics"
            disabled={loading || !device}
            icon={<RefreshCw />}
            onClick={refresh}
          />
          <MonitorButton
            variant="primary"
            icon={<Plus />}
            onClick={() => openForm()}
            disabled={!data || busy}
          >
            Add peer
          </MonitorButton>
        </div>
      </header>
      {(routerError || loadError) && (
        <MonitorNote tone="bad" role="alert">
          {routerError || loadError}
        </MonitorNote>
      )}
      {!form && error && (
        <MonitorNote tone="bad" role="alert">
          {error}
        </MonitorNote>
      )}
      {!data && !routerError && !loadError && (
        <p role="status" className="wgu-muted">
          Reading WireGuard counters…
        </p>
      )}
      {data && (
        <>
          <WireguardTraffic peers={peers} points={points} />
          <MonitorPanel
            title="Peer directory"
            description={`${peers.length} peers · ${recent} with a handshake in the last 3 minutes`}
            flush
            extra={
              expired > 0 ? (
                <MonitorButton
                  size="sm"
                  disabled={busy}
                  onClick={() => void act("expire", { action: "disable", apply: true })}
                >
                  Disable {expired} expired
                </MonitorButton>
              ) : undefined
            }
          >
            <div className="wgu-filter">
              <Segmented
                label="Peer scope"
                value={scope}
                onChange={setScope}
                options={[
                  { value: "all", label: "All peers" },
                  { value: "managed", label: "Managed users" },
                ]}
              />
              <MonitorSearch
                value={query}
                onChange={setQuery}
                label="Search peers"
                placeholder="Search name, interface or IP"
              />
            </div>
            <div className="wgu-scroll">
              <table className="wgu-table">
                <thead>
                  <tr>
                    {[
                      "Peer / interface",
                      "Tunnel address",
                      "Received",
                      "Sent",
                      "Last handshake",
                      "Access",
                      "",
                    ].map((h) => (
                      <th key={h} scope="col">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((p) => (
                    <RowMenu
                      key={p.id}
                      title={p.user}
                      sub={p.interface}
                      row={p}
                      onOpen={() => setSelectedId(p.id)}
                      copies={[{ label: "Tunnel address", value: p.address }]}
                      actions={
                        p.managed
                          ? [
                              {
                                label: "Duplicate",
                                icon: <Copy />,
                                onSelect: () => openForm(p),
                                disabled: busy,
                              },
                              {
                                label: "Revoke access",
                                icon: <Trash2 />,
                                danger: true,
                                onSelect: () => setConfirming(p.user),
                                disabled: busy,
                              },
                            ]
                          : []
                      }
                    >
                      <tr>
                        <th scope="row">
                          <button
                            type="button"
                            className="wgu-peer"
                            aria-label={`Inspect ${p.user}`}
                            onClick={() => setSelectedId(p.id)}
                          >
                            {p.user}
                          </button>
                          <small>{p.interface}</small>
                        </th>
                        <td className="wgu-address" data-label="Tunnel address">
                          {p.address || "—"}
                        </td>
                        <td data-label="Received">{trafficBytes(p.rx)}</td>
                        <td data-label="Sent">{trafficBytes(p.tx)}</td>
                        <td
                          data-label="Last handshake"
                          title={
                            p.handshakeAt != null
                              ? new Date(p.handshakeAt).toLocaleString()
                              : undefined
                          }
                        >
                          {handshake(p, data.observedAt)}
                        </td>
                        <td data-label="Access">
                          <StatusBadge
                            tone={
                              p.disabled
                                ? "default"
                                : p.expired
                                  ? "warn"
                                  : p.managed
                                    ? "good"
                                    : "default"
                            }
                          >
                            {p.disabled
                              ? "Disabled"
                              : p.expired
                                ? "Expired"
                                : p.expires
                                  ? `Until ${p.expires}`
                                  : p.managed
                                    ? "Managed"
                                    : "Router peer"}
                          </StatusBadge>
                        </td>
                        <td>
                          <RowMore />
                        </td>
                      </tr>
                    </RowMenu>
                  ))}
                </tbody>
              </table>
            </div>
            {!visible.length && (
              <MonitorEmpty compact title={query ? "No matching peers" : "No peers in this view"} />
            )}
            <div className="wgu-stamp">
              Updated {new Date(data.observedAt).toLocaleTimeString()} · refreshes every 15 s
            </div>
          </MonitorPanel>
        </>
      )}
      {selected && (
        <RowDrawer
          open
          title={selected.user}
          label={`Peer details: ${selected.user}`}
          meta={`${device} · ${selected.interface}`}
          onClose={() => setSelectedId(null)}
          actions={
            selected.managed && (
              <MonitorButton
                aria-label={`Duplicate ${selected.user}`}
                icon={<Copy />}
                onClick={() => openForm(selected)}
              >
                Duplicate peer
              </MonitorButton>
            )
          }
        >
          <DetailList
            items={[
              { label: "Tunnel address", value: selected.address, mono: true },
              {
                label: "Last handshake",
                value:
                  selected.handshakeAt == null
                    ? "Not reported"
                    : new Date(selected.handshakeAt).toLocaleString(),
              },
              { label: "Received", value: trafficBytes(selected.rx) },
              { label: "Sent", value: trafficBytes(selected.tx) },
              {
                label: "Access",
                value: selected.disabled ? "Disabled" : selected.expired ? "Expired" : "Enabled",
              },
              { label: "Expires", value: selected.expires ?? "No end date" },
            ]}
          />
        </RowDrawer>
      )}
      {form && (
        <MonitorDialog
          open
          title={copied ? "Duplicate peer" : "Add a peer"}
          description={
            copied
              ? `Copied from ${copied}. A new client key will be generated.`
              : "Create a client profile on the selected router."
          }
          width={540}
          closeDisabled={busy}
          onOpenChange={(o) => {
            if (!o && !busy) {
              setForm(null);
              setError("");
            }
          }}
          footer={
            <>
              <MonitorButton
                disabled={busy}
                onClick={() => {
                  setForm(null);
                  setError("");
                }}
              >
                Cancel
              </MonitorButton>
              <MonitorButton
                type="submit"
                form="wgu-create"
                variant="primary"
                icon={<Plus />}
                disabled={busy || !available.length}
              >
                {busy ? "Creating…" : "Create peer"}
              </MonitorButton>
            </>
          }
        >
          <form
            id="wgu-create"
            className="wgu-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <fieldset disabled={busy}>
              <label>
                Peer name
                <TextInput
                  label="Peer name"
                  autoFocus
                  value={form.user}
                  placeholder="alice-phone"
                  maxLength={63}
                  onChange={(user) => setForm({ ...form, user })}
                />
              </label>
              <div className="wgu-field">
                <span>Interface</span>
                <MonitorSelect
                  label="Interface"
                  options={available.map((i) => ({ value: i.name, label: i.name }))}
                  value={form.interface}
                  onChange={(name) => {
                    const old = available.find((i) => i.name === form.interface),
                      next = available.find((i) => i.name === name);
                    setForm({
                      ...form,
                      interface: name,
                      endpoint:
                        !form.endpoint || form.endpoint === old?.endpoint
                          ? (next?.endpoint ?? "")
                          : form.endpoint,
                    });
                  }}
                />
              </div>
              <label>
                Server endpoint
                <TextInput
                  label="Server endpoint"
                  value={form.endpoint}
                  placeholder="vpn.example.net:51820"
                  onChange={(endpoint) => setForm({ ...form, endpoint })}
                />
                <small>Confirm the public hostname and UDP port clients can reach.</small>
              </label>
              <details>
                <summary>Profile options</summary>
                <label>
                  Client IPv4 address
                  <TextInput
                    label="Client IPv4 address"
                    value={form.address}
                    placeholder="Assign automatically"
                    onChange={(address) => setForm({ ...form, address })}
                  />
                </label>
                <label>
                  Expires (optional)
                  <DateTimePicker
                    showTime={false}
                    label="Expires (optional)"
                    placeholder="No end date"
                    value={form.expires ? new Date(`${form.expires}T12:00:00`) : undefined}
                    onChange={(day) =>
                      setForm({ ...form, expires: day ? format(day, "yyyy-MM-dd") : "" })
                    }
                  />
                </label>
                <label>
                  DNS (optional)
                  <TextInput
                    label="DNS (optional)"
                    value={form.dns}
                    placeholder="10.20.0.1"
                    onChange={(dns) => setForm({ ...form, dns })}
                  />
                </label>
              </details>
              {(!available.length || error) && (
                <MonitorNote tone="bad" role="alert">
                  {error ||
                    "This router needs an enabled WireGuard interface before you can create a peer."}
                </MonitorNote>
              )}
            </fieldset>
          </form>
        </MonitorDialog>
      )}
      {profile && (
        <MonitorDialog
          open
          title={`Profile for ${profile.user}`}
          description="Scan with WireGuard or download the file. Closing this profile discards the client private key."
          width={480}
          dismissible={false}
          onOpenChange={(o) => {
            if (!o) setProfile(null);
          }}
          footer={
            <>
              <MonitorButton onClick={() => setProfile(null)}>Done</MonitorButton>
              <MonitorButton
                variant="primary"
                icon={<Download />}
                onClick={() => saveProfile(profile)}
              >
                Download .conf
              </MonitorButton>
            </>
          }
        >
          <div className="wgu-profile">
            <img src={qr} alt={`WireGuard QR code for ${profile.user}`} />
          </div>
        </MonitorDialog>
      )}
      {confirming && (
        <MonitorDialog
          open
          confirm
          title={`Revoke ${confirming}?`}
          description="This removes the peer from the router and disconnects the client."
          onOpenChange={(o) => {
            if (!o) setConfirming(null);
          }}
          footer={
            <>
              <MonitorButton onClick={() => setConfirming(null)}>Cancel</MonitorButton>
              <MonitorButton
                variant="danger"
                onClick={() => {
                  void act("revoke", { user: confirming });
                  setConfirming(null);
                }}
              >
                Revoke access
              </MonitorButton>
            </>
          }
        >
          {" "}
          <p className="wgu-form">The client profile will stop working.</p>
        </MonitorDialog>
      )}
    </section>
  );
}
