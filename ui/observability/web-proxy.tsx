import { useEffect, useRef, useState } from "react";
import { Plus, Router, Settings2, Trash2 } from "lucide-react";
import { api, postJson } from "./api";
import { Checkbox, DetailList, Field, Segmented, Switch, TextInput } from "./kit";
import { TrafficChart } from "./interfaces";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorDialog,
  MonitorEmpty,
  MonitorPanel,
  MonitorSelect,
  PageIntro,
  RouterPicker,
  StatusBadge,
  formatBytes,
} from "./monitoring-ui";
import type { DevicesPayload } from "./types";
import type { ProxyRange, ProxyHistory } from "../../src/observability/web-proxy-history";

const ranges = [
  { value: "15m", label: "15 min" },
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
] as const;
type Settings = { settings: Record<string, string>; canEdit: boolean };
type Rule = {
  id: string | null;
  action: string;
  src?: string;
  dst?: string;
  host?: string;
  port?: string;
  localPort?: string;
  method?: string;
  path?: string;
  redirect?: string;
  comment?: string;
  hits?: number;
  disabled?: boolean;
};
type Rules = { rules: Rule[]; canAdd: boolean; canRemove: boolean };
type History = ReturnType<ProxyHistory["report"]>;
function useProxyRead<T>(url: string, revision: number, interval: number) {
  const [result, setResult] = useState<{ url: string; data?: T; error?: string }>({ url });
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const data = await api<T>(url, controller.signal);
        if (!controller.signal.aborted) setResult({ url, data });
      } catch (e) {
        if (!controller.signal.aborted)
          setResult((previous) => ({
            url,
            data: previous.url === url ? previous.data : undefined,
            error: e instanceof Error ? e.message : "Could not read router.",
          }));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(read, interval);
      }
    }
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [url, revision, interval]);
  return result.url === url ? result : { url };
}
export function WebProxyView({ devices }: { devices: DevicesPayload | null }) {
  const [choice, setChoice] = useState("");
  const names = devices?.devices.filter((d) => !d.disabled).map((d) => d.name) ?? [];
  const device = names.includes(choice)
    ? choice
    : (names.find((n) => n === devices?.defaultDevice) ?? names[0]);
  if (!device) return <MonitorEmpty title={devices ? "No enabled routers" : "Loading routers"} />;
  return (
    <ProxyWorkspace
      key={device}
      device={device}
      picker={
        <RouterPicker
          routers={names}
          defaultRouter={devices?.defaultDevice}
          value={device}
          onChange={setChoice}
          label="Proxy router"
        />
      }
    />
  );
}

type Editor =
  | {
      kind: "settings";
      original: Record<string, string>;
      enabled: boolean;
      port: string;
      src: string;
      anonymous: boolean;
      confirmed: boolean;
    }
  | { kind: "add"; action: string; src: string; dst: string; comment: string; before: string }
  | { kind: "remove"; rule: Rule };
function matchSummary(r: Rule) {
  return (
    [
      r.src && `From ${r.src}`,
      r.dst && `To ${r.dst}`,
      r.host,
      r.path,
      r.method,
      r.port && `Port ${r.port}`,
      r.localPort && `Listener ${r.localPort}`,
      r.redirect && `Redirect to ${r.redirect}`,
    ]
      .filter(Boolean)
      .join(" · ") || "Any request"
  );
}

function ProxyWorkspace({ device, picker }: { device: string; picker: React.ReactNode }) {
  const [range, setRange] = useState<ProxyRange>("15m");
  const [revision, setRevision] = useState(0);
  const [form, setForm] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const path = (section: string) =>
    `/api/web-proxy/${section}?device=${encodeURIComponent(device)}`;
  const settings = useProxyRead<Settings>(path("settings"), revision, 60000);
  const access = useProxyRead<Rules>(path("rules"), revision, 60000);
  const history = useProxyRead<History>(`${path("history")}&range=${range}`, revision, 15000);
  const s = settings.data?.settings;
  const h = history.data,
    latest = h?.latest;
  const fresh = latest && !history.error && h.to - latest.ts < 45000;
  const enabled = s?.enabled === "yes";
  const open = (draft: Editor) => {
    setError("");
    setNotice("");
    setForm(draft);
  };
  async function save() {
    if (!form || lock.current) return;
    let args: Record<string, unknown> = {};
    if (form.kind === "settings") {
      const original = form.original;
      if (form.port !== original.port) {
        const port = Number(form.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535)
          return setError("Enter a port between 1 and 65535.");
        args.port = port;
      }
      if (form.src.trim() !== original["src-address"]) args.src_address = form.src.trim();
      if (form.anonymous !== (original.anonymous === "yes")) args.anonymous = form.anonymous;
      if (form.enabled !== (original.enabled === "yes")) {
        args.enabled = form.enabled;
        if (form.enabled && !form.confirmed)
          return setError("Confirm the listener firewall restrictions before enabling.");
        if (form.enabled) args.confirm_firewall_ready = true;
      }
      if (!Object.keys(args).length) {
        setForm(null);
        return;
      }
    } else if (form.kind === "add") {
      args = { action: form.action };
      if (form.src.trim()) args.src_address = form.src.trim();
      if (form.dst.trim()) args.dst_address = form.dst.trim();
      if (form.comment.trim()) args.comment = form.comment.trim();
      if (form.before) args.place_before = form.before;
    } else args = { rule_id: form.rule.id };
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await postJson<{ ok?: boolean; error?: string }>(path(form.kind), args);
      if (!response.ok) throw new Error(response.error ?? "The router did not confirm the change.");
      setForm(null);
      setNotice(`Changes saved on ${device}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      lock.current = false;
      setBusy(false);
      setRevision((v) => v + 1);
    }
  }
  return (
    <section className="grid min-w-0 gap-5">
      <PageIntro
        eyebrow="Users & VPN"
        heading="HTTP Proxy"
        lead={s ? `Listener on port ${s.port} · outgoing source ${s["src-address"]}` : undefined}
        actions={
          <>
            {picker}
            {s && settings.data?.canEdit && (
              <MonitorButton
                icon={<Settings2 />}
                onClick={() =>
                  open({
                    kind: "settings",
                    original: s,
                    enabled,
                    anonymous: s.anonymous === "yes",
                    port: s.port ?? "",
                    src: s["src-address"] ?? "",
                    confirmed: false,
                  })
                }
              >
                Settings
              </MonitorButton>
            )}
          </>
        }
      />
      {notice && <p role="status">{notice}</p>}
      {settings.error && <p role="alert">{settings.error}</p>}
      <MonitorPanel
        title="Proxy traffic"
        description="Received from upstream servers and sent to clients."
        extra={
          <Segmented
            label="Traffic time range"
            value={range}
            options={ranges}
            onChange={setRange}
          />
        }
      >
        <MetricStrip minCell={145} label="Usage in selected range">
          <Metric label="Received" value={h?.coveredMs ? formatBytes(h.received) : "—"} />
          <Metric label="Sent" value={h?.coveredMs ? formatBytes(h.sent) : "—"} />
          <Metric label="Requests" value={h?.coveredMs ? h.requests.toLocaleString() : "—"} />
          <Metric label="Clients connected now" value={fresh ? (latest.clients ?? "—") : "—"} />
        </MetricStrip>
        <div className="my-4 flex flex-wrap gap-5 text-xs text-muted-foreground">
          <span>
            <b style={{ color: "var(--sig)" }}>━</b> RX · received
          </span>
          <span>
            <b style={{ color: "var(--brand)" }}>━</b> TX · sent
          </span>
        </div>
        {h?.coveredMs ? (
          <TrafficChart
            points={h.points}
            name={`${device} HTTP Proxy`}
            windowLabel={range}
            formatTime={
              range === "7d"
                ? (ts) =>
                    new Date(ts).toLocaleString(undefined, {
                      weekday: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                : undefined
            }
          />
        ) : (
          <MonitorEmpty
            compact
            title={
              history.error
                ? "Traffic history unavailable"
                : !h
                  ? "Loading traffic history"
                  : "Waiting for traffic samples"
            }
          >
            History starts when the dashboard records two counter readings.
          </MonitorEmpty>
        )}
        {history.error && <p role="alert">{history.error}</p>}
        {h && (
          <div className="monitor-foot">
            {latest ? `Last reading ${new Date(latest.ts).toLocaleString()} · ` : ""}
            {fresh ? "Sampling" : "Awaiting a fresh reading"} ·{" "}
            {Math.round((100 * h.coveredMs) / (h.to - h.from))}% of selected range observed
          </div>
        )}
      </MonitorPanel>
      <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(230px,1fr)_minmax(0,2fr)]">
        <MonitorPanel
          title="Listener"
          extra={
            s && (
              <StatusBadge tone={enabled ? "good" : "default"}>
                {enabled ? "Enabled" : "Disabled"}
              </StatusBadge>
            )
          }
        >
          {s && (
            <DetailList
              items={[
                { label: "Port", value: s.port },
                { label: "Outgoing source", value: s["src-address"] },
                { label: "Anonymous", value: s.anonymous },
                { label: "Cache limit", value: s["max-cache-size"] },
                {
                  label: "Parent proxy",
                  value: s["parent-proxy"] === "::" ? "None" : s["parent-proxy"],
                },
              ]}
            />
          )}
        </MonitorPanel>
        <MonitorPanel
          title="Proxy access rules"
          description="RouterOS evaluates these rules in order."
          extra={
            access.data?.canAdd && (
              <MonitorButton
                icon={<Plus />}
                onClick={() =>
                  open({ kind: "add", action: "deny", src: "", dst: "", comment: "", before: "" })
                }
              >
                Add rule
              </MonitorButton>
            )
          }
        >
          {access.error && <p role="alert">{access.error}</p>}
          {access.data?.rules.length === 0 && (
            <MonitorEmpty compact title="No access rules">
              Unmatched proxy requests are allowed.
            </MonitorEmpty>
          )}
          <ol className="divide-y divide-line">
            {access.data?.rules.map((r, i) => (
              <li key={r.id ?? i} className="flex items-center gap-3 py-3">
                <span className="text-xs text-muted-foreground">{i + 1}</span>
                <div className="min-w-0 flex-1 break-words">
                  <strong className="text-sm">{matchSummary(r)}</strong>
                  {r.comment && <div className="text-xs text-muted-foreground">{r.comment}</div>}
                </div>
                <StatusBadge tone={r.disabled ? "default" : r.action === "deny" ? "warn" : "good"}>
                  {r.disabled ? "Disabled" : r.action}
                </StatusBadge>
                {access.data?.canRemove && r.id && (
                  <MonitorButton
                    size="sm"
                    icon={<Trash2 />}
                    aria-label={`Remove rule ${i + 1}`}
                    onClick={() => open({ kind: "remove", rule: r })}
                  />
                )}
              </li>
            ))}
          </ol>
        </MonitorPanel>
      </div>
      {form && (
        <MonitorDialog
          open
          title={
            form.kind === "settings"
              ? "Proxy settings"
              : form.kind === "add"
                ? "Add access rule"
                : "Remove access rule?"
          }
          description={
            <span className="inline-flex items-center gap-1.5">
              <Router size={14} aria-hidden="true" />
              {device}
            </span>
          }
          onOpenChange={(v) => {
            if (!v && !busy) setForm(null);
          }}
          closeDisabled={busy}
          footer={
            <div className="flex w-full justify-end gap-2">
              <MonitorButton disabled={busy} onClick={() => setForm(null)}>
                Cancel
              </MonitorButton>
              <MonitorButton
                variant={form.kind === "remove" ? "danger" : "primary"}
                disabled={busy}
                onClick={() => void save()}
              >
                {busy ? "Saving…" : form.kind === "remove" ? "Remove rule" : "Save changes"}
              </MonitorButton>
            </div>
          }
        >
          <div className="monitor-dialog-body grid gap-5">
            {form.kind === "settings" && (
              <>
                <Switch
                  className="w-full flex-row-reverse justify-between"
                  label="Enable HTTP proxy"
                  disabled={busy}
                  checked={form.enabled}
                  onCheckedChange={(enabled) => setForm({ ...form, enabled })}
                />
                {form.enabled && form.original.enabled !== "yes" && (
                  <Checkbox
                    label="I verified IPv4 and IPv6 firewall restrictions for this listener."
                    checked={form.confirmed}
                    onCheckedChange={(confirmed) => setForm({ ...form, confirmed })}
                  />
                )}
                <div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                  <Field label="Listener port">
                    <TextInput
                      mono
                      inputMode="numeric"
                      disabled={busy}
                      value={form.port}
                      onChange={(port) => setForm({ ...form, port })}
                    />
                  </Field>
                  <Field label="Outgoing source address">
                    <TextInput
                      mono
                      disabled={busy}
                      value={form.src}
                      onChange={(src) => setForm({ ...form, src })}
                    />
                  </Field>
                </div>
                <div className="border-t border-line pt-4">
                  <Switch
                    className="w-full flex-row-reverse justify-between"
                    label="Anonymous mode"
                    disabled={busy}
                    checked={form.anonymous}
                    onCheckedChange={(anonymous) => setForm({ ...form, anonymous })}
                  />
                </div>
              </>
            )}
            {form.kind === "add" && (
              <>
                <MonitorSelect
                  label="Action"
                  value={form.action}
                  onChange={(action) => setForm({ ...form, action })}
                  options={[
                    { value: "deny", label: "Deny" },
                    { value: "allow", label: "Allow" },
                  ]}
                />
                <Field label="Source address">
                  <TextInput
                    value={form.src}
                    placeholder="Any"
                    onChange={(src) => setForm({ ...form, src })}
                  />
                </Field>
                <Field label="Destination address">
                  <TextInput
                    value={form.dst}
                    placeholder="Any"
                    onChange={(dst) => setForm({ ...form, dst })}
                  />
                </Field>
                <Field label="Comment">
                  <TextInput
                    value={form.comment}
                    onChange={(comment) => setForm({ ...form, comment })}
                  />
                </Field>
                <MonitorSelect
                  label="Insert rule"
                  value={form.before || "last"}
                  onChange={(v) => setForm({ ...form, before: v === "last" ? "" : v })}
                  options={[
                    { value: "last", label: "At the end" },
                    ...(access.data?.rules.flatMap((r, i) =>
                      r.id ? [{ value: r.id, label: `Before ${i + 1} · ${matchSummary(r)}` }] : [],
                    ) ?? []),
                  ]}
                />
              </>
            )}
            {form.kind === "remove" && (
              <p>
                {form.rule.action} · {matchSummary(form.rule)}
              </p>
            )}
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
          </div>
        </MonitorDialog>
      )}
    </section>
  );
}
