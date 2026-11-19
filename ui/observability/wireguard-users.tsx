/**
 * WireGuard users: the remote-access users of one router. Add a user and get
 * its profile as a QR code and a file, see who has access and until when, and
 * revoke.
 *
 * The profile holds the user's private key. It is shown once, in this browser,
 * and is not kept: closing the panel discards it.
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import { Copy, Download, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api, postJson } from "./api";
import { TextInput } from "./kit";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  MonitorSelect,
  PageIntro,
  RouterPicker,
  StatusBadge,
} from "./monitoring-ui";
import "./monitoring.css";
import "./wireguard-users.css";

interface WgUser {
  user: string;
  interface: string;
  address: string;
  expires: string | null;
  expired: boolean;
  disabled: boolean;
  lastHandshake: string | null;
}
interface UsersPayload {
  device: string;
  interfaces: string[];
  users: WgUser[];
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
  const base = user.replace(/-\d+$/, "").slice(0, 59);
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

export function WireguardUsersView(): ReactNode {
  const [devices, setDevices] = useState<string[]>([]);
  const [defaultDevice, setDefaultDevice] = useState("");
  const [device, setDevice] = useState("");
  const [data, setData] = useState<UsersPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [form, setForm] = useState({ user: "", interface: "", endpoint: "", expires: "", dns: "" });
  const [copied, setCopied] = useState("");
  const formRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api<{ devices: { name: string; disabled?: boolean }[]; defaultDevice: string }>(
      "/api/devices",
    )
      .then((r) => {
        const names = r.devices.filter((d) => !d.disabled).map((d) => d.name);
        setDevices(names);
        setDefaultDevice(r.defaultDevice);
        setDevice(names.includes(r.defaultDevice) ? r.defaultDevice : (names[0] ?? ""));
      })
      .catch(() => setError("Routers could not be loaded. Check the dashboard connection."));
  }, []);

  const load = useCallback(async () => {
    if (!device) return;
    setLoading(true);
    try {
      const next = await api<UsersPayload>(
        `/api/wireguard/users?device=${encodeURIComponent(device)}`,
      );
      setData(next);
      setError("");
      setForm((f) => ({ ...f, interface: f.interface || next.interfaces[0] || "" }));
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [device]);

  useEffect(() => {
    setProfile(null);
    setData(null);
    setForm((f) => ({ ...f, interface: "" }));
    void load();
  }, [load]);

  const act = async (
    key: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ ok?: boolean; message?: string; config?: string; error?: string }> => {
    setBusy(key);
    try {
      const result = await postJson<{
        ok?: boolean;
        message?: string;
        config?: string;
        error?: string;
      }>(path, { device, ...body });
      setError(result.ok === false || result.error ? (result.error ?? result.message ?? "") : "");
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return { ok: false };
    } finally {
      setBusy("");
    }
  };

  const onboard = async (): Promise<void> => {
    const result = await act("add", "/api/wireguard/onboard", form);
    if (result.config) {
      setProfile({ user: form.user, config: result.config });
      setForm((f) => ({ ...f, user: "", expires: "" }));
      setCopied("");
      await load();
    }
  };
  const revoke = async (user: string): Promise<void> => {
    // The first press asks; the second, on the same user, revokes.
    if (confirming !== user) {
      setConfirming(user);
      return;
    }
    setConfirming(null);
    await act(`revoke:${user}`, "/api/wireguard/revoke", { user });
    await load();
  };
  /** Put a user's settings in the form, with a new label, to add one more like it. */
  const duplicate = (user: WgUser): void => {
    setForm((f) => ({
      ...f,
      user: copyLabel(
        user.user,
        (data?.users ?? []).map((u) => u.user),
      ),
      interface: user.interface,
      expires: user.expires ?? "",
    }));
    setCopied(user.user);
    const input = formRef.current?.querySelector("input");
    input?.scrollIntoView?.({ block: "center" });
    input?.focus();
  };
  const expire = async (): Promise<void> => {
    await act("expire", "/api/wireguard/expire", { action: "disable", apply: true });
    await load();
  };

  const users = data?.users ?? [];
  const expired = users.filter((u) => u.expired && !u.disabled).length;
  const qr = useMemo(() => (profile ? qrDataUrl(profile.config) : ""), [profile]);
  const ready = form.user && form.interface && form.endpoint;

  return (
    <section className="wgu grid content-start gap-[18px]">
      <PageIntro
        eyebrow={`WireGuard users · ${device || "no router"}`}
        verdict={data ? `${users.length} remote user(s).` : "Remote access, one user at a time."}
        lead="Add a user and hand over its profile as a QR code or a file. The profile is shown once and is not kept."
        actions={
          <>
            <RouterPicker
              value={device}
              onChange={setDevice}
              routers={devices}
              defaultRouter={defaultDevice}
              label="Router"
            />
            <MonitorButton
              variant="ghost"
              icon={<RefreshCw aria-hidden="true" className={loading ? "animate-spin" : ""} />}
              onClick={() => void load()}
              disabled={loading || !device}
            >
              Refresh
            </MonitorButton>
          </>
        }
      />
      {error && (
        <MonitorNote tone="bad" role="alert">
          {error}
        </MonitorNote>
      )}
      {data && (
        <MetricStrip label="WireGuard users summary">
          <Metric
            label="Users"
            value={String(users.length)}
            hint={`${data.interfaces.length} interface(s)`}
          />
          <Metric
            label="Expired"
            value={String(expired)}
            hint="still enabled"
            tone={expired > 0 ? "warn" : "default"}
          />
          <Metric
            label="Never connected"
            value={String(users.filter((u) => !u.lastHandshake).length)}
            hint="no handshake yet"
          />
        </MetricStrip>
      )}

      <div className="wgu-cols">
        <MonitorPanel
          title="Add a user"
          description={
            copied
              ? `Copied from ${copied}: interface and end date. The server endpoint and DNS are not kept on the router, so check them.`
              : "A free address in the interface's subnet is picked for you."
          }
        >
          {data && data.interfaces.length === 0 ? (
            <MonitorEmpty compact title="This router has no WireGuard interface." />
          ) : (
            <div className="wgu-form" ref={formRef}>
              <label className="wgu-field">
                <span>User label</span>
                <TextInput
                  label="User label"
                  value={form.user}
                  placeholder="alice-phone"
                  maxLength={63}
                  onChange={(user) => setForm({ ...form, user })}
                />
              </label>
              <label className="wgu-field">
                <span>Interface</span>
                <MonitorSelect
                  label="Interface"
                  value={form.interface}
                  onChange={(value) => setForm({ ...form, interface: value })}
                  options={(data?.interfaces ?? []).map((name) => ({ value: name, label: name }))}
                />
              </label>
              <label className="wgu-field">
                <span>Server endpoint</span>
                <TextInput
                  label="Server endpoint"
                  value={form.endpoint}
                  placeholder="vpn.example.net:13231"
                  onChange={(endpoint) => setForm({ ...form, endpoint })}
                />
              </label>
              <label className="wgu-field">
                <span>Expires (optional)</span>
                <TextInput
                  label="Expires (optional)"
                  value={form.expires}
                  placeholder="2026-12-31"
                  maxLength={10}
                  onChange={(expires) => setForm({ ...form, expires })}
                />
              </label>
              <label className="wgu-field">
                <span>DNS (optional)</span>
                <TextInput
                  label="DNS (optional)"
                  value={form.dns}
                  placeholder="10.20.0.1"
                  onChange={(dns) => setForm({ ...form, dns })}
                />
              </label>
              <MonitorButton
                variant="primary"
                icon={<Plus aria-hidden="true" />}
                disabled={!ready || busy === "add"}
                onClick={() => void onboard()}
              >
                Add user
              </MonitorButton>
            </div>
          )}
        </MonitorPanel>

        {profile && (
          <MonitorPanel
            title={`Profile of ${profile.user}`}
            description="Scan it in the WireGuard app, or download the file. It holds the private key and is not shown again."
            extra={
              <MonitorButton size="sm" variant="ghost" onClick={() => setProfile(null)}>
                Discard
              </MonitorButton>
            }
          >
            <div className="wgu-profile">
              <img src={qr} alt={`QR code of the WireGuard profile of ${profile.user}`} />
              <div className="wgu-profile-side">
                <pre>{profile.config.replace(/(PrivateKey = ).+/, "$1(hidden)")}</pre>
                <MonitorButton
                  variant="primary"
                  size="sm"
                  icon={<Download aria-hidden="true" />}
                  onClick={() => saveProfile(profile)}
                >
                  Download {profile.user}.conf
                </MonitorButton>
              </div>
            </div>
          </MonitorPanel>
        )}
      </div>

      <MonitorPanel
        title="Users"
        description="Users added here or with onboard_wireguard_user. Other peers are not listed."
        extra={
          expired > 0 ? (
            <MonitorButton
              size="sm"
              variant="ghost"
              disabled={busy === "expire"}
              onClick={() => void expire()}
            >
              Disable {expired} expired
            </MonitorButton>
          ) : undefined
        }
      >
        {data && users.length === 0 && (
          <MonitorEmpty compact title="No remote user on this router yet." />
        )}
        <div className="wgu-table">
          {users.length > 0 && (
            <div className="wgu-row wgu-head" aria-hidden="true">
              <span>User</span>
              <span>Address</span>
              <span>Interface</span>
              <span>Last handshake</span>
              <span>Access</span>
              <span />
            </div>
          )}
          <ul className="wgu-list">
            {users.map((user) => (
              <li key={`${user.interface}:${user.user}`} className="wgu-row">
                <b>{user.user}</b>
                <span className="mono">{user.address}</span>
                <span className="wgu-muted">{user.interface}</span>
                <span className="wgu-muted">
                  {user.lastHandshake ? `handshake ${user.lastHandshake} ago` : "never connected"}
                </span>
                <span className="wgu-state">
                  {user.disabled ? (
                    <StatusBadge tone="default">disabled</StatusBadge>
                  ) : user.expired ? (
                    <StatusBadge tone="warn">expired {user.expires}</StatusBadge>
                  ) : user.expires ? (
                    <StatusBadge tone="good">until {user.expires}</StatusBadge>
                  ) : (
                    <StatusBadge tone="good">no end date</StatusBadge>
                  )}
                </span>
                <span className="wgu-actions">
                  <MonitorButton
                    size="sm"
                    variant="ghost"
                    icon={<Copy aria-hidden="true" />}
                    aria-label={`Duplicate ${user.user}`}
                    onClick={() => duplicate(user)}
                  >
                    Duplicate
                  </MonitorButton>
                  <MonitorButton
                    size="sm"
                    variant="danger"
                    icon={<Trash2 aria-hidden="true" />}
                    disabled={busy === `revoke:${user.user}`}
                    onClick={() => void revoke(user.user)}
                    onBlur={() => setConfirming(null)}
                  >
                    {confirming === user.user ? "Press again to revoke" : "Revoke"}
                  </MonitorButton>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </MonitorPanel>
    </section>
  );
}
