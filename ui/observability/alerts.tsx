/**
 * Alerts: what is firing, what is configured, and what has been sent.
 *
 * The page is ordered by urgency. Anything firing right now sits at the top
 * with its mute action inline, because that is what a person opening this page
 * under pressure needs. Rules, channels and delivery history follow.
 */
import { LoadingState } from "./loading-state";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, postJson } from "./api";
import type { Trigger } from "../../src/alerts/model";
import { useNow } from "./use-now";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorEmpty,
  MonitorPanel,
  PageIntro,
  Segmented,
  StatusBadge,
  StatusDot,
  Ticker,
  useStaggerIn,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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

/** Severity → the rail and dot tone used on this page. */
const SEV_TONE: Record<Severity, Tone> = {
  low: "default",
  medium: "brand",
  high: "warn",
  critical: "bad",
};

/** Status → the word on the badge and how loud it is. */
const STATUS_VIEW: Record<RuleStatus, { label: string; tone: Tone }> = {
  firing: { label: "Firing", tone: "bad" },
  pending: { label: "Pending", tone: "warn" },
  suppressed: { label: "In cooldown", tone: "default" },
  clear: { label: "OK", tone: "good" },
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

const WINDOWS = [
  { value: "1", label: "1h", text: "1 h" },
  { value: "24", label: "24h", text: "24 h" },
  { value: "168", label: "7d", text: "7 d" },
];

const HISTORY_LIMIT = 50;

/** Render a trigger as the one line a person can scan. */
function describeTrigger(when: Trigger): string {
  if ("metric" in when) {
    const bound = when.above !== undefined ? `> ${String(when.above)}` : `< ${String(when.below)}`;
    return `${String(when.metric)} ${bound} over ${String(when.window)}${
      when.minCalls ? ` (min ${String(when.minCalls)} calls)` : ""
    }`;
  }
  if ("absence" in when) {
    return `no ${String(when.absence)} within ${String(when.within)}`;
  }
  const parts: string[] = [`on ${String(when.event)}`];
  if (when.to) parts.push(`→ ${String(when.to)}`);
  if (Array.isArray(when.risk)) parts.push(`risk ${when.risk.join("/")}`);
  if (Array.isArray(when.device)) parts.push(`device ${when.device.join("/")}`);
  if (Array.isArray(when.tool)) parts.push(`tool ${when.tool.join("/")}`);
  if (when.isError !== undefined) parts.push(when.isError ? "errors only" : "successes only");
  return parts.join(" · ");
}

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

/** Today's sends show the time; older ones show the date. */
function when(ts: number, now: number): string {
  const d = new Date(ts);
  if (d.toDateString() === new Date(now).toDateString()) return clock(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ruleName(r: AlertRuleRow): string {
  return r.description ?? r.id;
}

function rowKey(r: AlertRuleRow): string {
  return `${r.id}\u0000${r.subject}`;
}

function deliveryError(d: Delivery): string {
  if (d.status) return `HTTP ${d.status}`;
  return d.error ?? "error";
}

export function AlertsView(): ReactNode {
  const [data, setData] = useState<AlertsPayload | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [hours, setHours] = useState("24");
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<{ id: string; name: string } | null>(null);
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
      clear: 3,
      muted: 4,
      disabled: 5,
    };
    const sev: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    return [...(data?.rules ?? [])].sort(
      (a, b) => rank[a.status] - rank[b.status] || sev[a.severity] - sev[b.severity],
    );
  }, [data]);

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

  const firingKey = (data?.active ?? []).map(rowKey).join("|");
  const rulesKey = ordered.map(rowKey).join("|");
  useStaggerIn(firingRef, ".monitor-row", firingKey);
  useStaggerIn(rulesRef, ".monitor-row", rulesKey);

  const windowText = WINDOWS.find((w) => w.value === hours)?.text ?? `${hours} h`;
  const intro = (
    <PageIntro>Rules that reach out on Slack, Discord, ntfy, a webhook or MCP.</PageIntro>
  );
  const note = msg && (
    <div className="monitor-note" role="status">
      <span className="min-w-0 flex-1">{msg}</span>
      <MonitorButton
        variant="ghost"
        size="sm"
        aria-label="Dismiss"
        icon={<X aria-hidden="true" />}
        onClick={() => setMsg(null)}
      />
    </div>
  );

  if (!data) {
    if (msg) {
      return (
        <div className="alerts-page">
          {intro}
          {note}
        </div>
      );
    }
    return <LoadingState label="Loading alerts" />;
  }

  if (!data.configured) {
    return (
      <div className="alerts-page">
        {intro}
        <section className="monitor-panel">
          <MonitorEmpty icon={<BellOff />} title="Alerting is off">
            Add an <code>alerts</code> block with at least one channel to your config file, then
            reload. The Alerting guide on the docs site has examples.
          </MonitorEmpty>
        </section>
      </div>
    );
  }

  const firing = data.active;
  const checked =
    checkedAt === null
      ? null
      : now - checkedAt < 10_000
        ? "Checked just now"
        : `Checked ${span(now - checkedAt)} ago`;

  // KPI figures.
  const firingBySev = (["critical", "high", "medium", "low"] as const)
    .map((s) => ({ s, n: firing.filter((r) => r.severity === s).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${x.n} ${x.s}`)
    .join(", ");
  const enabledCount = uniqueRules.filter((r) => r.enabled).length;
  const muted = uniqueRules.filter((r) => r.mutedUntil && r.mutedUntil > now);
  const off = uniqueRules.filter((r) => !r.enabled);
  const quiet = uniqueRules.filter((r) => !r.enabled || (r.mutedUntil && r.mutedUntil > now));
  // The board names the mute first: it is the one that ends on its own.
  const quietHint =
    muted.length === 1
      ? `1 muted until ${clock(muted[0].mutedUntil ?? now)}`
      : muted.length > 1
        ? `${muted.length} muted`
        : off.length > 0
          ? `${off.length} off`
          : "All rules on";
  const deliveries = history.flatMap((h) => h.deliveries);
  const delivered = deliveries.filter((d) => d.ok).length;
  const failed = deliveries.length - delivered;

  const channelNames = Object.keys(data.channels);
  const rulesPerChannel = (name: string): number =>
    uniqueRules.filter((r) => r.channels.includes(name)).length;
  const count = (n: number): string => String(Math.round(n));

  return (
    <div className="alerts-page">
      {intro}
      {note}

      {firing.length > 0 ? (
        <MonitorPanel
          className="alerts-firing"
          tone="bad"
          aria-label="Firing now"
          title={
            <span className="alerts-firing-title">
              <StatusDot tone="bad" />
              <span>
                <Ticker value={firing.length} format={count} /> firing now
              </span>
            </span>
          }
          extra={checked && <span className="text-muted-foreground text-[12px]">{checked}</span>}
          flush
        >
          <div ref={firingRef}>
            {firing.map((r) => (
              <div key={rowKey(r)} className="monitor-row alerts-firing-row">
                <span className="min-w-0">
                  <span className="text-foreground block font-[510]">{ruleName(r)}</span>
                  <span className="alerts-meta">
                    {r.subject !== "*" && `${r.subject} · `}
                    {describeTrigger(r.when)} · {r.severity}
                  </span>
                </span>
                <span className="text-muted-foreground text-[12px] tabular-nums">
                  for {span(now - r.since)}
                </span>
                <MonitorButton
                  size="sm"
                  disabled={busy !== null}
                  icon={busy === `mute:${r.id}` ? <Loader2 className="animate-spin" /> : undefined}
                  onClick={() => void mute(r.id, "1h")}
                >
                  Mute 1 h
                </MonitorButton>
              </div>
            ))}
          </div>
        </MonitorPanel>
      ) : (
        <section className="alerts-calm" role="status" aria-label="Firing now">
          <StatusDot tone="good" />
          <h2 className="alerts-calm-title">Nothing firing</h2>
          <span className="flex-1" />
          {checked && <span className="text-muted-foreground text-[12px]">{checked}</span>}
        </section>
      )}

      <MetricStrip label="Alert summary" minCell={180}>
        <Metric
          label="Firing"
          tone={firing.length > 0 ? "bad" : "default"}
          value={<Ticker value={firing.length} format={count} />}
          hint={firing.length > 0 ? firingBySev : "Nothing firing"}
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
          value={
            // The edge mark carries the warning; the figure stays plain, as on the board.
            <span className="text-emphasis">
              <Ticker value={delivered} format={count} />
              {" / "}
              <Ticker value={deliveries.length} format={count} />
            </span>
          }
          hint={
            failed > 0 ? (
              <span className="text-warning">
                {failed} failed in {windowText}
              </span>
            ) : deliveries.length > 0 ? (
              `All delivered in ${windowText}`
            ) : (
              `Nothing sent in ${windowText}`
            )
          }
        />
      </MetricStrip>

      <MonitorPanel title="Rules" description="From the alerts block in your config file" flush>
        {ordered.length === 0 ? (
          <MonitorEmpty compact icon={<Bell />} title="No rules">
            Add rules to the <code>alerts</code> block in your config file.
          </MonitorEmpty>
        ) : (
          <div ref={rulesRef}>
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
              return (
                <div key={rowKey(r)} className="monitor-row alerts-rule-row">
                  <span className="alerts-rail" data-tone={SEV_TONE[r.severity]} />
                  <span className="alerts-rule-name min-w-0">
                    <span className="text-foreground flex items-center gap-2 font-[510]">
                      <span className="truncate">{ruleName(r)}</span>
                    </span>
                    <span className="alerts-meta">{meta}</span>
                    {/* A rule that can never resolve looks healthy until it has been
                        stuck red for a week, so say so here. */}
                    {(r.warnings ?? []).map((w) => (
                      <span key={w} className="alerts-warning">
                        <TriangleAlert aria-hidden="true" /> {w}
                      </span>
                    ))}
                  </span>
                  <span className="alerts-rule-when" title={describeTrigger(r.when)}>
                    {describeTrigger(r.when)}
                  </span>
                  <span className="alerts-rule-status" title={STATUS_HINT[r.status]}>
                    <StatusBadge tone={status.tone}>{label}</StatusBadge>
                  </span>
                  <span className="alerts-rule-actions">
                    <MonitorButton
                      variant="ghost"
                      size="sm"
                      disabled={busy !== null}
                      icon={primaryBusy ? <Loader2 className="animate-spin" /> : undefined}
                      onClick={() =>
                        void (toggles ? toggle(r) : mute(r.id, primary === "unmute" ? "0s" : "1h"))
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
                        <MonitorButton
                          variant="ghost"
                          size="sm"
                          disabled={busy !== null}
                          aria-label={`More actions for ${ruleName(r)}`}
                          icon={<Ellipsis aria-hidden="true" strokeWidth={1.5} />}
                        />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {!(primary === "mute" || primary === "unmute") && (
                          <DropdownMenuItem onSelect={() => void mute(r.id, isMuted ? "0s" : "1h")}>
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
                          onSelect={() => setConfirmRemove({ id: r.id, name: ruleName(r) })}
                        >
                          <Trash2 /> Remove
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </MonitorPanel>

      <div className="alerts-split">
        <MonitorPanel
          className="alerts-channels"
          title="Channels"
          description="Where alerts go"
          flush
        >
          {channelNames.length === 0 ? (
            <MonitorEmpty compact icon={<Send />} title="No channels">
              No alert can be delivered until you add one.
            </MonitorEmpty>
          ) : (
            Object.entries(data.channels).map(([name, c]) => {
              const last = lastByChannel.get(name);
              const tone: Tone = !c.configured ? "warn" : last && !last.d.ok ? "bad" : "good";
              const n = rulesPerChannel(name);
              return (
                <div key={name} className="monitor-row alerts-channel-row">
                  <span className="min-w-0">
                    <span className="text-foreground flex items-center gap-2">
                      <StatusDot tone={tone} />
                      <span className="truncate">{name}</span>
                    </span>
                    {/* Never the full URL: the path is the credential. */}
                    <span className="alerts-meta pl-[15px]">
                      {c.configured ? (c.url ?? "No URL") : "Not set up"} · {n} rule
                      {n === 1 ? "" : "s"}
                    </span>
                  </span>
                  <span className="alerts-channel-last text-muted-foreground text-[12px]">
                    {!last
                      ? "Nothing sent"
                      : last.d.ok
                        ? `sent ${span(now - last.ts)} ago`
                        : `failed ${when(last.ts, now)}`}
                  </span>
                  <MonitorButton
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    icon={
                      busy === `test:${name}` ? <Loader2 className="animate-spin" /> : undefined
                    }
                    onClick={() => void testChannel(name)}
                    title="Send a real test message to this channel"
                  >
                    Send test
                  </MonitorButton>
                </div>
              );
            })
          )}
        </MonitorPanel>

        <MonitorPanel
          className="alerts-history"
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
              {sends.slice(0, HISTORY_LIMIT).map(({ key, h, d }) => (
                <div
                  key={key}
                  className="monitor-row alerts-history-row"
                  data-failed={(d && !d.ok) || undefined}
                >
                  <span
                    className="alerts-history-time"
                    title={new Date(h.ts).toLocaleString(undefined, { hour12: false })}
                  >
                    {when(h.ts, now)}
                  </span>
                  <span className="alerts-history-rule text-foreground truncate">
                    {h.title}
                    {h.device ? ` · ${h.device}` : ""}
                    {h.kind === "resolve" && (
                      <span className="text-muted-foreground"> · resolved</span>
                    )}
                  </span>
                  <span className="alerts-history-channel text-muted-foreground truncate text-[12px]">
                    {d?.channel ?? "No channel"}
                  </span>
                  <span
                    className={cn(
                      "alerts-history-result text-[12px] font-[510]",
                      !d ? "text-muted-foreground" : d.ok ? "text-success" : "text-destructive",
                    )}
                    title={d ? `${d.attempts} attempt${d.attempts === 1 ? "" : "s"}` : undefined}
                  >
                    {!d ? "Not sent" : d.ok ? "Delivered" : `Failed · ${deliveryError(d)}`}
                  </span>
                </div>
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

      <AlertDialog
        open={confirmRemove !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {confirmRemove?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The server stops checking this rule now. It comes back after a restart if it is still
              in your config file.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (confirmRemove) void remove(confirmRemove.id);
              }}
            >
              Remove rule
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
