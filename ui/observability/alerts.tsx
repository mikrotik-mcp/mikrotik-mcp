/**
 * Alerts: what is firing, what is configured, and what has been sent.
 *
 * After the Mon-Alerts board. The header answers "is anything firing?" and
 * lists what is, with its mute action inline, because that is what a person
 * opening this page under pressure needs. Rules, channels and delivery history
 * follow. "New rule" opens the rule editor (alerts-rule-editor.tsx).
 */
import { LoadingState } from "./loading-state";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { api, postJson } from "./api";
import { DetailBlock, DetailList, RowDrawer, RowMenu, RowMore } from "./kit";
import type { RowAction } from "./kit";
import type { DevicesPayload } from "./types";
import { useNow } from "./use-now";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorDialog,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  PageIntro,
  Segmented,
  StatusBadge,
  StatusDot,
  Ticker,
  useStaggerIn,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { AlertRuleEditor, describeTrigger } from "./alerts-rule-editor";
import type { Trigger } from "../../src/alerts/model";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  Bell,
  BellOff,
  Ellipsis,
  Loader2,
  Plus,
  Power,
  Send,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import "./monitoring.css";
import "./alerts.css";

type Severity = "low" | "medium" | "high" | "critical";
type RuleStatus = "clear" | "pending" | "firing" | "suppressed" | "muted" | "disabled";

interface AlertRuleRow {
  id: string;
  /** Which device this row is about; `*` for fleet-wide rules. */
  subject: string;
  description?: string;
  when: Trigger;
  severity: Severity;
  channels: string[];
  for?: string;
  cooldown: string;
  enabled: boolean;
  mutedUntil?: number;
  status: RuleStatus;
  since: number;
  /** Non-fatal authoring problems, chiefly "this rule can never resolve". */
  warnings?: string[];
}

interface AlertsPayload {
  configured: boolean;
  rules: AlertRuleRow[];
  active: AlertRuleRow[];
  channels: Record<string, { url?: string; method?: string; configured: boolean }>;
}

interface Delivery {
  channel: string;
  ok: boolean;
  status?: number;
  error?: string;
  attempts: number;
}

interface HistoryRow {
  id: string;
  ruleId: string;
  kind: "fire" | "resolve";
  severity: string;
  title: string;
  body: string;
  device?: string;
  ts: number;
  deliveries: Delivery[];
}

/** Severity → the rail colour: critical pink, high amber, medium blue, low faint. */
const SEV_TONE: Record<Severity, Tone> = {
  low: "default",
  medium: "brand",
  high: "warn",
  critical: "bad",
};

/** Status → the word on the pill and its tone. Only firing and pending carry a LED. */
const STATUS_VIEW: Record<RuleStatus, { label: string; tone: Tone }> = {
  firing: { label: "Firing", tone: "bad" },
  pending: { label: "Pending", tone: "warn" },
  suppressed: { label: "In cooldown", tone: "default" },
  clear: { label: "Clear", tone: "good" },
  muted: { label: "Muted", tone: "default" },
  disabled: { label: "Off", tone: "default" },
};

/** Status → the tooltip. `suppressed` is deliberately not alarming. */
const STATUS_HINT: Record<RuleStatus, string> = {
  firing: "The condition is met and has been announced.",
  pending: "The condition is met but has not held long enough to fire.",
  suppressed: "Met again inside the cooldown. Held quiet so a flapping rule cannot spam.",
  clear: "The condition is not met.",
  muted: "Silenced for now. Still tracked, but sends nothing.",
  disabled: "Turned off.",
};

const SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const WINDOWS = [
  { value: "1", label: "1h", text: "1 h" },
  { value: "24", label: "24h", text: "24 h" },
  { value: "168", label: "7d", text: "7 d" },
];

const HISTORY_LIMIT = 50;

/** "20 s", "6 min", "2 h", "3 d". */
function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function rowKey(r: AlertRuleRow): string {
  return `${r.id}\u0000${r.subject}`;
}

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

type Picked = { t: "rule" | "channel" | "send"; key: string } | null;

function deliveryError(d: Delivery): string {
  if (d.status) return `HTTP ${d.status}`;
  return d.error ?? "error";
}

/** The second sentence of the verdict: what the loudest firing rule is about. */
function headline(r: AlertRuleRow): string {
  const who = r.subject !== "*" ? r.subject : null;
  if ("event" in r.when && r.when.event === "device_state" && r.when.to && who)
    return `${who} is ${r.when.to}.`;
  return who ? `${r.id} on ${who}.` : `${r.id}.`;
}

/** The second line of a firing row: the rule's own words, else where and what. */
function firingText(r: AlertRuleRow): string {
  if (r.description) return r.description;
  const what = describeTrigger(r.when);
  return r.subject !== "*" ? `${r.subject} · ${what}` : what;
}

export function AlertsView(): ReactNode {
  const [data, setData] = useState<AlertsPayload | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [hours, setHours] = useState("24");
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<{ id: string } | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [devices, setDevices] = useState<string[]>([]);
  const [picked, setPicked] = useState<Picked>(null);
  const now = useNow(10_000);

  const firingRef = useRef<HTMLDivElement>(null);
  const rulesRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    () =>
      api<AlertsPayload>("/api/alerts")
        .then((res) => {
          setData(res);
          setCheckedAt(Date.now());
        })
        .catch(() => setMsg("Could not load alerts.")),
    [],
  );

  const loadHistory = useCallback(
    () =>
      api<{ history: HistoryRow[] }>(`/api/alerts/history?hours=${hours}`)
        .then((res) => setHistory(res.history))
        .catch(() => {
          /* history is supplementary; never blank the page over it */
        }),
    [hours],
  );

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  // Device names for the rule editor's Device field; only once it opens.
  useEffect(() => {
    if (!editorOpen || devices.length > 0) return;
    api<DevicesPayload>("/api/devices")
      .then((res) => setDevices(res.devices.map((d) => d.name)))
      .catch(() => {
        /* the field still takes typed names */
      });
  }, [editorOpen, devices.length]);

  const act = useCallback(
    async (key: string, fn: () => Promise<unknown>) => {
      setBusy(key);
      try {
        await fn();
        await Promise.all([load(), loadHistory()]);
      } finally {
        setBusy(null);
      }
    },
    [load, loadHistory],
  );

  const mute = (id: string, duration: string): Promise<void> =>
    act(`mute:${id}`, () =>
      fetch(`/api/alerts/rules/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mute: duration }),
      }),
    );

  const toggle = (r: AlertRuleRow): Promise<void> =>
    act(`toggle:${r.id}`, () =>
      fetch(`/api/alerts/rules/${encodeURIComponent(r.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !r.enabled }),
      }),
    );

  const remove = (id: string): Promise<void> =>
    act(`del:${id}`, () =>
      fetch(`/api/alerts/rules/${encodeURIComponent(id)}`, { method: "DELETE" }),
    );

  const testChannel = (channel: string): Promise<void> =>
    act(`test:${channel}`, async () => {
      const r = await postJson<{
        ok?: boolean;
        error?: string;
        status?: number;
        durationMs?: number;
      }>("/api/alerts/test", { channel });
      setMsg(
        r.ok
          ? `${channel}: delivered in ${r.durationMs} ms.`
          : `${channel}: ${r.error ?? `HTTP ${r.status}`}`,
      );
    });

  /** Firing first, then by severity. */
  const ordered = useMemo(() => {
    const rank: Record<RuleStatus, number> = {
      firing: 0,
      pending: 1,
      suppressed: 2,
      muted: 3,
      clear: 4,
      disabled: 5,
    };
    return [...(data?.rules ?? [])].sort(
      (a, b) => rank[a.status] - rank[b.status] || SEV_RANK[a.severity] - SEV_RANK[b.severity],
    );
  }, [data]);

  /** Firing rows, loudest first. */
  const firing = useMemo(
    () =>
      [...(data?.active ?? [])].sort(
        (a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.since - b.since,
      ),
    [data],
  );

  /** One entry per rule id; a rule tracking several devices has a row per device. */
  const uniqueRules = useMemo(() => {
    const byId = new Map<string, AlertRuleRow>();
    for (const r of data?.rules ?? []) if (!byId.has(r.id)) byId.set(r.id, r);
    return [...byId.values()];
  }, [data]);

  /** One line per delivery attempt, newest first as the server sends them. */
  const sends = useMemo(
    () =>
      history.flatMap((h): { key: string; h: HistoryRow; d: Delivery | null }[] =>
        h.deliveries.length > 0
          ? h.deliveries.map((d, i) => ({ key: `${h.id}:${i}`, h, d }))
          : [{ key: h.id, h, d: null }],
      ),
    [history],
  );

  /** The newest delivery per channel in the current window. */
  const lastByChannel = useMemo(() => {
    const out = new Map<string, { ts: number; d: Delivery }>();
    for (const h of history) {
      for (const d of h.deliveries) {
        const seen = out.get(d.channel);
        if (!seen || h.ts > seen.ts) out.set(d.channel, { ts: h.ts, d });
      }
    }
    return out;
  }, [history]);

  const firingKey = firing.map(rowKey).join("|");
  const rulesKey = ordered.map(rowKey).join("|");
  useStaggerIn(firingRef, ".alerts-firing-row", firingKey);
  useStaggerIn(rulesRef, ".monitor-row", rulesKey);

  const windowText = WINDOWS.find((w) => w.value === hours)?.text ?? `${hours} h`;
  const eyebrow = "Alerts · Slack, Discord, ntfy, webhook, MCP";
  const note = msg && (
    <MonitorNote role="status">
      <span className="flex items-start gap-2">
        <span className="min-w-0 flex-1">{msg}</span>
        <MonitorButton
          variant="ghost"
          size="sm"
          aria-label="Dismiss"
          icon={<X aria-hidden="true" />}
          onClick={() => setMsg(null)}
        />
      </span>
    </MonitorNote>
  );

  if (!data) {
    if (msg) {
      return (
        <div className="alerts-page">
          <PageIntro eyebrow={eyebrow} verdict={<em>Alerts did not load.</em>} />
          {note}
        </div>
      );
    }
    return <LoadingState label="Loading alerts" />;
  }

  if (!data.configured) {
    return (
      <div className="alerts-page">
        <PageIntro
          eyebrow={eyebrow}
          verdict="Alerting is off."
          lead="Rules that reach out when something needs a person. Each one fires once, then says when it stopped."
        />
        <section className="monitor-panel">
          <MonitorEmpty icon={<BellOff />} title="Alerting is off">
            Add an <code>alerts</code> block with at least one channel to your config file, then
            reload. The Alerting guide on the docs site has examples.
          </MonitorEmpty>
        </section>
      </div>
    );
  }

  const checked =
    checkedAt === null
      ? null
      : now - checkedAt < 10_000
        ? "Checked just now"
        : `Checked ${span(now - checkedAt)} ago`;

  // KPI figures.
  const enabledCount = uniqueRules.filter((r) => r.enabled).length;
  const muted = uniqueRules.filter((r) => r.mutedUntil && r.mutedUntil > now);
  const off = uniqueRules.filter((r) => !r.enabled);
  const quiet = uniqueRules.filter((r) => !r.enabled || (r.mutedUntil && r.mutedUntil > now));
  // The board names the mute first: it is the one that ends on its own.
  const mutedText =
    muted.length === 1
      ? `1 muted until ${clock(muted[0].mutedUntil ?? now)}`
      : muted.length > 1
        ? `${muted.length} muted`
        : null;
  const quietHint = mutedText ?? (off.length > 0 ? `${off.length} off` : "All rules on");
  const deliveries = history.flatMap((h) => h.deliveries);
  const delivered = deliveries.filter((d) => d.ok).length;
  const failed = deliveries.length - delivered;
  const firstSince = firing.length > 0 ? Math.min(...firing.map((r) => r.since)) : null;

  const rulesPerChannel = (name: string): number =>
    uniqueRules.filter((r) => r.channels.includes(name)).length;
  const count = (n: number): string => String(Math.round(n));

  /** The row menu's and the drawer's actions for a rule: the same ones the row offers. */
  const ruleActions = (r: AlertRuleRow): RowAction[] => {
    const isMuted = !!r.mutedUntil;
    return [
      {
        label: isMuted ? "Unmute" : "Mute 1 h",
        icon: <BellOff aria-hidden="true" />,
        disabled: busy !== null,
        onSelect: () => void mute(r.id, isMuted ? "0s" : "1h"),
      },
      {
        label: r.enabled ? "Disable" : "Enable",
        icon: <Power aria-hidden="true" />,
        disabled: busy !== null,
        onSelect: () => void toggle(r),
      },
      {
        label: "Remove",
        icon: <Trash2 aria-hidden="true" />,
        danger: true,
        disabled: busy !== null,
        onSelect: () => setConfirmRemove({ id: r.id }),
      },
    ];
  };
  const channelText = (c: AlertsPayload["channels"][string]): string =>
    c.configured ? (c.url?.replace(/^[a-z]+:\/\//i, "") ?? "Set up") : "Not set up";
  const lastText = (last: { ts: number; d: Delivery } | undefined): string =>
    !last
      ? "Nothing sent"
      : last.d.ok
        ? `sent ${span(now - last.ts)} ago`
        : `failed ${span(now - last.ts)} ago`;
  const sendResult = (d: Delivery | null): string =>
    !d ? "Not sent" : d.ok ? "Delivered" : `Failed · ${deliveryError(d)}`;
  const shownSends = sends.slice(0, HISTORY_LIMIT);
  const channelNames = Object.keys(data.channels);
  const togglePick = (t: "rule" | "channel" | "send", key: string): void => setPicked({ t, key });
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
  const actionButtons = (list: RowAction[]): ReactNode =>
    list.map((a, i) => (
      <MonitorButton
        key={i}
        size="sm"
        variant={a.danger ? "danger" : undefined}
        icon={a.icon}
        disabled={a.disabled}
        onClick={a.onSelect}
      >
        {a.label}
      </MonitorButton>
    ));

  const drawer = ((): ReactNode => {
    if (!picked) return null;
    const close = (): void => setPicked(null);
    if (picked.t === "rule") {
      const r = ordered.find((x) => rowKey(x) === picked.key);
      if (!r) return null;
      const status = STATUS_VIEW[r.status];
      const tone =
        status.tone === "bad"
          ? "bad"
          : status.tone === "warn"
            ? "warn"
            : status.tone === "good"
              ? "ok"
              : "off";
      return (
        <RowDrawer
          open
          onClose={close}
          label={`Rule details: ${r.id}`}
          storageKey="alerts"
          rowKey={`rule:${picked.key}`}
          status={{
            tone,
            label:
              r.status === "muted" && r.mutedUntil
                ? `Muted to ${clock(r.mutedUntil)}`
                : status.label,
          }}
          title={<span className="alerts-mono">{r.id}</span>}
          meta={STATUS_HINT[r.status]}
          nav={navOver(ordered.map(rowKey))}
          actions={actionButtons(ruleActions(r))}
        >
          {r.description && <p className="text-fg-secondary text-[13px]">{r.description}</p>}
          <DetailList
            items={[
              { label: "When", value: describeTrigger(r.when), mono: true },
              ...(r.subject !== "*" ? [{ label: "Device", value: r.subject, mono: true }] : []),
              { label: "Severity", value: r.severity },
              { label: "Holds for", value: r.for ?? "Fires immediately" },
              { label: "Cooldown", value: r.cooldown },
              { label: "Channels", value: r.channels.join(", ") || "No channels" },
              ...(r.status !== "clear" && r.status !== "disabled"
                ? [{ label: "Since", value: `${clock(r.since)} (${span(now - r.since)} ago)` }]
                : []),
              ...(r.mutedUntil ? [{ label: "Muted until", value: clock(r.mutedUntil) }] : []),
              { label: "Enabled", value: r.enabled ? "Yes" : "No" },
            ]}
          />
          {(r.warnings ?? []).length > 0 && (
            <DetailBlock label="Warnings">
              {(r.warnings ?? []).map((w) => (
                <span key={w} className="alerts-warning">
                  <TriangleAlert aria-hidden="true" /> {w}
                </span>
              ))}
            </DetailBlock>
          )}
        </RowDrawer>
      );
    }
    if (picked.t === "channel") {
      const c = data.channels[picked.key];
      if (!c) return null;
      const last = lastByChannel.get(picked.key);
      const tone = !c.configured ? "warn" : last && !last.d.ok ? "bad" : "ok";
      const n = rulesPerChannel(picked.key);
      return (
        <RowDrawer
          open
          onClose={close}
          label={`Channel details: ${picked.key}`}
          storageKey="alerts"
          rowKey={`channel:${picked.key}`}
          status={{
            tone,
            label: !c.configured
              ? "Not set up"
              : last && !last.d.ok
                ? "Last send failed"
                : "Set up",
          }}
          title={picked.key}
          meta={`${n} rule${n === 1 ? "" : "s"}`}
          nav={navOver(channelNames)}
          primary={
            <MonitorButton
              size="sm"
              variant="primary"
              disabled={busy !== null}
              icon={
                busy === `test:${picked.key}` ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Send aria-hidden="true" />
                )
              }
              onClick={() => void testChannel(picked.key)}
            >
              Send test
            </MonitorButton>
          }
        >
          <DetailList
            items={[
              // Never the full URL: the path is the credential.
              { label: "Address", value: channelText(c), mono: true },
              ...(c.method ? [{ label: "Method", value: c.method, mono: true }] : []),
              { label: "Rules", value: String(n) },
              { label: "Last send", value: lastText(last) },
              ...(last && !last.d.ok ? [{ label: "Error", value: deliveryError(last.d) }] : []),
            ]}
          />
        </RowDrawer>
      );
    }
    const s = shownSends.find((x) => x.key === picked.key);
    if (!s) return null;
    const { h, d } = s;
    return (
      <RowDrawer
        open
        onClose={close}
        label={`Delivery details: ${h.ruleId}`}
        storageKey="alerts"
        rowKey={`send:${picked.key}`}
        status={{ tone: !d ? "off" : d.ok ? "ok" : "bad", label: sendResult(d) }}
        title={h.title || h.ruleId}
        meta={`${new Date(h.ts).toLocaleString(undefined, { hour12: false })} · ${d?.channel ?? "No channel"}`}
        nav={navOver(shownSends.map((x) => x.key))}
      >
        <DetailList
          items={[
            { label: "Rule", value: h.ruleId, mono: true },
            ...(h.device ? [{ label: "Device", value: h.device, mono: true }] : []),
            { label: "Kind", value: h.kind === "resolve" ? "Resolved" : "Fired" },
            { label: "Severity", value: h.severity },
            { label: "Channel", value: d?.channel ?? "No channel" },
            ...(d ? [{ label: "Attempts", value: String(d.attempts) }] : []),
            ...(d?.status != null
              ? [{ label: "HTTP status", value: String(d.status), mono: true }]
              : []),
          ]}
        />
        {h.body && (
          <DetailBlock label="Message">
            <pre className="monitor-pre break-words">{h.body}</pre>
          </DetailBlock>
        )}
      </RowDrawer>
    );
  })();

  const verdict =
    firing.length > 0 ? (
      <>
        <em>
          {firing.length} rule{firing.length === 1 ? "" : "s"} firing.
        </em>{" "}
        {headline(firing[0])}
      </>
    ) : (
      <>
        <span className="s">Nothing firing.</span> {enabledCount} rule
        {enabledCount === 1 ? "" : "s"} on.
      </>
    );
  const lead = `Rules that reach out when something needs a person. Each one fires once, then says when it stopped.${
    mutedText ? ` ${mutedText}.` : ""
  }`;

  const firingCard = (
    <div className="glass alerts-firing" aria-label="Firing now">
      <div className="alerts-firing-head">
        <StatusDot tone={firing.length > 0 ? "bad" : "good"} pulse />
        <span className="alerts-firing-label">Firing now</span>
        {checked && <span className="alerts-small">{checked}</span>}
      </div>
      <div ref={firingRef} className="contents">
        {firing.length === 0 ? (
          <div className="alerts-firing-row">
            <span className="alerts-small">Nothing is firing.</span>
          </div>
        ) : (
          firing.map((r) => (
            <div key={rowKey(r)} className="alerts-firing-row">
              <span className="alerts-firing-bar" data-tone={SEV_TONE[r.severity]} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="alerts-mono text-foreground truncate">{r.id}</span>
                <span className="alerts-small truncate">{firingText(r)}</span>
              </span>
              <span className="alerts-small tabular-nums">{span(now - r.since)}</span>
              <MonitorButton
                size="sm"
                disabled={busy !== null}
                icon={
                  busy === `mute:${r.id}` ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Bell aria-hidden="true" />
                  )
                }
                onClick={() => void mute(r.id, "1h")}
              >
                Mute 1 h
              </MonitorButton>
            </div>
          ))
        )}
      </div>
    </div>
  );

  return (
    <div className="alerts-page">
      <PageIntro
        eyebrow={eyebrow}
        verdict={verdict}
        lead={lead}
        actions={
          <MonitorButton
            variant="primary"
            icon={<Plus aria-hidden="true" />}
            onClick={() => setEditorOpen(true)}
          >
            New rule
          </MonitorButton>
        }
        aside={firingCard}
      />
      {note}

      <MetricStrip label="Alert summary" minCell={180}>
        <Metric
          label="Firing"
          tone={firing.length > 0 ? "bad" : "default"}
          value={<Ticker value={firing.length} format={count} />}
          hint={firstSince !== null ? `since ${clock(firstSince)}` : "Nothing firing"}
        />
        <Metric
          label="Rules"
          value={<Ticker value={uniqueRules.length} format={count} />}
          hint={`${enabledCount} on`}
        />
        <Metric
          label="Muted or off"
          value={<Ticker value={quiet.length} format={count} />}
          hint={quietHint}
        />
        <Metric
          label="Deliveries"
          tone={failed > 0 ? "warn" : "default"}
          value={<Ticker value={deliveries.length} format={count} />}
          hint={
            failed > 0
              ? `${delivered} delivered in ${windowText}, ${failed} failed`
              : deliveries.length > 0
                ? `All delivered in ${windowText}`
                : `Nothing sent in ${windowText}`
          }
        />
      </MetricStrip>

      <MonitorPanel
        title="Rules"
        description="Saved in the alerts block of your config file. Mute, disable or remove from the row."
        extra={
          <MonitorButton
            size="sm"
            icon={<Plus aria-hidden="true" />}
            onClick={() => setEditorOpen(true)}
          >
            New rule
          </MonitorButton>
        }
        flush
      >
        {ordered.length === 0 ? (
          <MonitorEmpty compact icon={<Bell />} title="No rules">
            Add one with New rule, or in the <code>alerts</code> block of your config file.
          </MonitorEmpty>
        ) : (
          <div ref={rulesRef}>
            <div className="monitor-thead alerts-rule-grid" aria-hidden="true">
              <span />
              <span>Rule</span>
              <span>When</span>
              <span>Status</span>
              <span />
              <span />
            </div>
            {ordered.map((r) => {
              const status = STATUS_VIEW[r.status];
              const isMuted = !!r.mutedUntil;
              const label =
                r.status === "muted" && r.mutedUntil
                  ? `Muted to ${clock(r.mutedUntil)}`
                  : status.label;
              // The one action that fits the rule's state; the rest go in the menu.
              const primary: "enable" | "unmute" | "mute" | "disable" = !r.enabled
                ? "enable"
                : isMuted
                  ? "unmute"
                  : r.status === "clear"
                    ? "disable"
                    : "mute";
              const meta = [
                r.subject !== "*" ? r.subject : null,
                r.severity,
                r.for ? `for ${r.for}` : "immediately",
                `cooldown ${r.cooldown}`,
                r.channels.join(", ") || "no channels",
              ]
                .filter(Boolean)
                .join(" · ");
              const toggles = primary === "enable" || primary === "disable";
              const primaryBusy = busy === (toggles ? `toggle:${r.id}` : `mute:${r.id}`);
              const loud = status.tone === "bad" || status.tone === "warn";
              const key = rowKey(r);
              return (
                <RowMenu
                  key={key}
                  title={r.id}
                  sub={`${label} · ${r.severity}`}
                  onOpen={() => togglePick("rule", key)}
                  cells={{
                    rule: { value: r.id },
                    when: { value: describeTrigger(r.when) },
                    status: { value: label },
                  }}
                  copies={[{ label: "Rule ID", value: r.id }]}
                  row={r}
                  actions={ruleActions(r)}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={`${r.id}, ${label}`}
                    className="monitor-row alerts-rule-grid"
                    data-selected={(picked?.t === "rule" && picked.key === key) || undefined}
                    onClick={() => togglePick("rule", key)}
                    onKeyDown={onRowKey(() => togglePick("rule", key))}
                  >
                    <span className="alerts-rail" data-tone={SEV_TONE[r.severity]} />
                    <span data-col="rule" className="flex min-w-0 flex-col gap-0.5">
                      <span
                        className="alerts-mono text-foreground truncate font-medium"
                        title={r.description}
                      >
                        {r.id}
                      </span>
                      <span className="alerts-small truncate">{meta}</span>
                      {/* A rule that can never resolve looks healthy until it has been
                        stuck red for a week, so say so here. */}
                      {(r.warnings ?? []).map((w) => (
                        <span key={w} className="alerts-warning">
                          <TriangleAlert aria-hidden="true" /> {w}
                        </span>
                      ))}
                    </span>
                    <span
                      data-col="when"
                      className="alerts-mono text-fg-secondary truncate"
                      title={describeTrigger(r.when)}
                    >
                      {describeTrigger(r.when)}
                    </span>
                    <span data-col="status" title={STATUS_HINT[r.status]}>
                      <StatusBadge tone={status.tone} dot={loud}>
                        {label}
                      </StatusBadge>
                    </span>
                    {/* The row's own buttons act here; they do not open the details. */}
                    <span
                      className="alerts-rule-actions"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <MonitorButton
                        variant="ghost"
                        size="sm"
                        disabled={busy !== null}
                        icon={primaryBusy ? <Loader2 className="animate-spin" /> : undefined}
                        onClick={() =>
                          void (toggles
                            ? toggle(r)
                            : mute(r.id, primary === "unmute" ? "0s" : "1h"))
                        }
                      >
                        {primary === "enable"
                          ? "Enable"
                          : primary === "disable"
                            ? "Disable"
                            : primary === "unmute"
                              ? "Unmute"
                              : "Mute"}
                      </MonitorButton>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="monitor-icon-btn"
                            disabled={busy !== null}
                            aria-label={`More actions for ${r.id}`}
                          >
                            <Ellipsis aria-hidden="true" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {!(primary === "mute" || primary === "unmute") && (
                            <DropdownMenuItem
                              onSelect={() => void mute(r.id, isMuted ? "0s" : "1h")}
                            >
                              <BellOff /> {isMuted ? "Unmute" : "Mute 1 h"}
                            </DropdownMenuItem>
                          )}
                          {!toggles && (
                            <DropdownMenuItem onSelect={() => void toggle(r)}>
                              <Power /> {r.enabled ? "Disable" : "Enable"}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => setConfirmRemove({ id: r.id })}
                          >
                            <Trash2 /> Remove
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </span>
                    <RowMore />
                  </div>
                </RowMenu>
              );
            })}
          </div>
        )}
      </MonitorPanel>

      <div className="alerts-split">
        <MonitorPanel title="Channels" description="Where alerts go" flush>
          {Object.keys(data.channels).length === 0 ? (
            <MonitorEmpty compact icon={<Send />} title="No channels">
              No alert can be delivered until you add one.
            </MonitorEmpty>
          ) : (
            <>
              <div className="monitor-thead alerts-channel-grid" aria-hidden="true">
                <span>Channel</span>
                <span>Last</span>
                <span />
                <span />
              </div>
              {Object.entries(data.channels).map(([name, c]) => {
                const last = lastByChannel.get(name);
                const tone: Tone = !c.configured ? "warn" : last && !last.d.ok ? "bad" : "good";
                const n = rulesPerChannel(name);
                return (
                  <RowMenu
                    key={name}
                    title={name}
                    sub={`${channelText(c)} · ${n} rule${n === 1 ? "" : "s"}`}
                    onOpen={() => togglePick("channel", name)}
                    cells={{
                      channel: { value: name },
                      last: { value: lastText(last) },
                    }}
                    copies={[{ label: "Channel name", value: name }]}
                    actions={[
                      {
                        label: "Send test",
                        icon: <Send aria-hidden="true" />,
                        disabled: busy !== null,
                        onSelect: () => void testChannel(name),
                      },
                    ]}
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      aria-label={`${name}, ${lastText(last)}`}
                      className="monitor-row alerts-channel-grid"
                      data-selected={(picked?.t === "channel" && picked.key === name) || undefined}
                      onClick={() => togglePick("channel", name)}
                      onKeyDown={onRowKey(() => togglePick("channel", name))}
                    >
                      <span data-col="channel" className="flex min-w-0 items-center gap-2.5">
                        <StatusDot tone={tone} />
                        <span className="flex min-w-0 flex-col">
                          <span className="p truncate">{name}</span>
                          {/* Never the full URL: the path is the credential. */}
                          <span className="alerts-small truncate">
                            {channelText(c)} · {n} rule
                            {n === 1 ? "" : "s"}
                          </span>
                        </span>
                      </span>
                      <span data-col="last" className="alerts-small truncate">
                        {lastText(last)}
                      </span>
                      <MonitorButton
                        variant="ghost"
                        size="sm"
                        disabled={busy !== null}
                        icon={
                          busy === `test:${name}` ? <Loader2 className="animate-spin" /> : undefined
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          void testChannel(name);
                        }}
                        onKeyDown={(e) => e.stopPropagation()}
                        title="Send a real test message to this channel"
                      >
                        Send test
                      </MonitorButton>
                      <RowMore />
                    </div>
                  </RowMenu>
                );
              })}
            </>
          )}
        </MonitorPanel>

        <MonitorPanel
          title="Delivery history"
          description="What was sent and whether it arrived"
          extra={
            <Segmented
              label="History window"
              value={hours}
              onChange={setHours}
              options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))}
            />
          }
          flush
        >
          {sends.length === 0 ? (
            <MonitorEmpty compact title="Nothing sent">
              No alert fired in the last {windowText}.
            </MonitorEmpty>
          ) : (
            <>
              <div className="monitor-thead alerts-history-grid" aria-hidden="true">
                <span>When</span>
                <span>Alert</span>
                <span>Channel</span>
                <span>Result</span>
                <span />
              </div>
              {shownSends.map(({ key, h, d }) => (
                <RowMenu
                  key={key}
                  title={h.ruleId}
                  sub={`${span(now - h.ts)} ago · ${d?.channel ?? "No channel"}`}
                  onOpen={() => togglePick("send", key)}
                  cells={{
                    when: {
                      value: new Date(h.ts).toLocaleString(undefined, { hour12: false }),
                      kind: "time",
                    },
                    alert: { value: h.ruleId },
                    channel: { value: d?.channel ?? "" },
                    result: { value: sendResult(d) },
                  }}
                  copies={[{ label: "Rule ID", value: h.ruleId }]}
                  row={{ ...h, deliveries: d ? [d] : [] }}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={`${h.ruleId}, ${sendResult(d)}, ${span(now - h.ts)} ago`}
                    className="monitor-row alerts-history-grid"
                    data-failed={(d && !d.ok) || undefined}
                    data-selected={(picked?.t === "send" && picked.key === key) || undefined}
                    onClick={() => togglePick("send", key)}
                    onKeyDown={onRowKey(() => togglePick("send", key))}
                  >
                    <span
                      data-col="when"
                      className="alerts-mono text-muted-foreground truncate"
                      title={new Date(h.ts).toLocaleString(undefined, { hour12: false })}
                    >
                      {span(now - h.ts)}
                    </span>
                    <span data-col="alert" className="p truncate">
                      {h.ruleId}
                      {h.device ? ` · ${h.device}` : ""}
                      {h.kind === "resolve" ? " · resolved" : ""}
                    </span>
                    <span data-col="channel" className="text-muted-foreground truncate">
                      {d?.channel ?? "No channel"}
                    </span>
                    <span
                      data-col="result"
                      className={cn(
                        "truncate text-[12px] font-medium",
                        !d ? "text-muted-foreground" : d.ok ? "text-success" : "text-destructive",
                      )}
                      title={d ? `${d.attempts} attempt${d.attempts === 1 ? "" : "s"}` : undefined}
                    >
                      {sendResult(d)}
                    </span>
                    <RowMore />
                  </div>
                </RowMenu>
              ))}
              {sends.length > HISTORY_LIMIT && (
                <div className="monitor-foot">
                  Showing the newest {HISTORY_LIMIT} of {sends.length}
                </div>
              )}
            </>
          )}
        </MonitorPanel>
      </div>

      <MonitorDialog
        open={confirmRemove !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmRemove(null);
        }}
        confirm
        title={`Remove ${confirmRemove?.id ?? ""}?`}
        description="The server stops checking this rule now. It comes back after a restart if it is still in your config file."
        footer={
          <>
            <span className="flex-1" />
            <MonitorButton variant="ghost" onClick={() => setConfirmRemove(null)}>
              Cancel
            </MonitorButton>
            <MonitorButton
              variant="danger"
              icon={<Trash2 aria-hidden="true" />}
              onClick={() => {
                if (confirmRemove) void remove(confirmRemove.id);
                setConfirmRemove(null);
              }}
            >
              Remove rule
            </MonitorButton>
          </>
        }
      >
        {null}
      </MonitorDialog>

      {drawer}

      <AlertRuleEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        channels={data.channels}
        devices={devices}
        onSaved={() => void Promise.all([load(), loadHistory()])}
      />
    </div>
  );
}
