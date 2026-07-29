/**
 * Alerts — what is firing, what is configured, and what has happened.
 *
 * The page is ordered by urgency, not by data model: anything firing right now
 * is at the top with its mute action inline, because that is the only thing a
 * person opening this page under pressure cares about. Configuration and
 * history sit below it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api, postJson } from "./api";
import { Badge, Note, Select, Spinner } from "./geist";
// The shadcn Button, not geist's — only this one has the `xs` size and the
// outline/ghost variants this page's dense action rows need.
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { BellOff, CheckCircle2, FlaskConical, Loader2, RefreshCw, Trash2 } from "lucide-react";

type Severity = "low" | "medium" | "high" | "critical";
type RuleStatus = "clear" | "pending" | "firing" | "suppressed" | "muted" | "disabled";

interface AlertRuleRow {
  id: string;
  /** Which device this row is about; `*` for fleet-wide rules. */
  subject: string;
  description?: string;
  when: Record<string, unknown>;
  severity: Severity;
  channels: string[];
  for?: string;
  cooldown: string;
  enabled: boolean;
  mutedUntil?: number;
  status: RuleStatus;
  since: number;
}

interface AlertsPayload {
  configured: boolean;
  rules: AlertRuleRow[];
  active: AlertRuleRow[];
  channels: Record<string, { url?: string; method?: string; configured: boolean }>;
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
  deliveries: { channel: string; ok: boolean; status?: number; error?: string; attempts: number }[];
}

/** Severity → the two visual tokens used everywhere on this page. */
const SEV: Record<Severity, { badge: "secondary" | "accent" | "warning" | "error"; dot: string }> =
  {
    low: { badge: "secondary", dot: "bg-muted-foreground" },
    medium: { badge: "accent", dot: "bg-chart-1" },
    high: { badge: "warning", dot: "bg-warning" },
    critical: { badge: "error", dot: "bg-destructive" },
  };

/** Status → how it should read. `suppressed` is deliberately not alarming. */
const STATUS_HINT: Record<RuleStatus, string> = {
  firing: "Condition is met and has been announced.",
  pending: "Condition is met but has not held long enough to fire (`for`).",
  suppressed: "Re-met inside the cooldown — held quiet so a flap cannot spam.",
  clear: "Condition is not met.",
  muted: "Silenced for now. Still tracking, but says nothing.",
  disabled: "Turned off entirely.",
};

/** Render a trigger as the one line a person can actually scan. */
function describeTrigger(when: Record<string, unknown>): string {
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

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function AlertsView(): ReactNode {
  const [data, setData] = useState<AlertsPayload | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [hours, setHours] = useState("24");

  const load = useCallback(async () => {
    try {
      setData(await api<AlertsPayload>("/api/alerts"));
    } catch {
      setMsg("could not load alerts");
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const res = await api<{ history: HistoryRow[] }>(`/api/alerts/history?hours=${hours}`);
      setHistory(res.history);
    } catch {
      /* history is supplementary — never blank the page over it */
    }
  }, [hours]);

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
          ? `${channel}: delivered in ${r.durationMs}ms`
          : `${channel}: ${r.error ?? `HTTP ${r.status}`}`,
      );
    });

  /** Firing first, then by severity — the page is ordered by urgency. */
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

  if (!data) return <Spinner />;

  if (!data.configured) {
    return (
      <div className="grid gap-3">
        <Note>
          Alerting is not configured. Add an <code>alerts</code> block with at least one channel to
          your config file, then reload — see <code>docs/alerting.md</code>.
        </Note>
      </div>
    );
  }

  const firing = data.active;

  return (
    <div className="grid gap-5">
      {msg && <Note>{msg}</Note>}

      {/* Firing right now — the only thing that matters when opening under pressure. */}
      {firing.length > 0 ? (
        <section className="border-destructive/40 bg-destructive/5 grid gap-2 rounded-lg border p-3">
          <div className="flex items-center gap-2 text-[13px] font-semibold">
            <span className="bg-destructive size-2 animate-pulse rounded-full" />
            {firing.length} alert{firing.length === 1 ? "" : "s"} firing
          </div>
          {firing.map((r) => (
            <div
              key={`${r.id}\u0000${r.subject}`}
              className="flex flex-wrap items-center gap-2 text-xs"
            >
              <Badge type={SEV[r.severity].badge}>{r.severity}</Badge>
              <b className="font-medium">{r.description ?? r.id}</b>
              {r.subject !== "*" && <Badge type="secondary">{r.subject}</Badge>}
              <span className="text-muted-foreground">since {ago(r.since)}</span>
              <span className="flex-1" />
              <Button
                size="xs"
                variant="outline"
                disabled={busy !== null}
                onClick={() => void mute(r.id, "1h")}
              >
                {busy === `mute:${r.id}` ? <Loader2 className="animate-spin" /> : <BellOff />} Mute
                1h
              </Button>
            </div>
          ))}
        </section>
      ) : (
        <section className="border-success/30 bg-success/5 flex items-center gap-2 rounded-lg border p-3 text-[13px]">
          <CheckCircle2 className="text-success size-4" /> Nothing firing.
        </section>
      )}

      {/* Channels — where alerts go, and proof they work. */}
      <section className="grid gap-2">
        <h3 className="text-[13px] font-semibold">Channels</h3>
        {Object.keys(data.channels).length === 0 ? (
          <Note>No channels configured — no alert can be delivered.</Note>
        ) : (
          <div className="flex flex-wrap gap-2">
            {Object.entries(data.channels).map(([name, c]) => (
              <div
                key={name}
                className="bg-card flex items-center gap-2 rounded-lg border px-3 py-2 text-xs"
              >
                <b className="font-medium">{name}</b>
                {/* Never the full URL — the path is the credential. */}
                <code className="text-muted-foreground text-[10px]">{c.url ?? "—"}</code>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => void testChannel(name)}
                  title="Send a real test message to this destination"
                >
                  {busy === `test:${name}` ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <FlaskConical />
                  )}{" "}
                  Test
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Rules — ordered by urgency, not by config order. */}
      <section className="grid gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-semibold">Rules ({ordered.length})</h3>
          <span className="flex-1" />
          <Button size="xs" variant="outline" onClick={() => void load()}>
            <RefreshCw /> Refresh
          </Button>
        </div>
        {ordered.length === 0 ? (
          <Note>No rules configured.</Note>
        ) : (
          <div className="grid gap-2">
            {ordered.map((r) => (
              <div
                key={`${r.id}\u0000${r.subject}`}
                className={cn(
                  "bg-card grid gap-1.5 rounded-lg border px-3 py-2.5",
                  r.status === "firing" && "border-destructive/50",
                  (r.status === "muted" || r.status === "disabled") && "opacity-55",
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn("size-2 shrink-0 rounded-full", SEV[r.severity].dot)} />
                  <b className="text-[13px] font-medium">{r.description ?? r.id}</b>
                  <code className="text-muted-foreground text-[10px]">{r.id}</code>
                  {/* A rule tracking several devices renders one card per device,
                      so "firing" always names what it is firing about. */}
                  {r.subject !== "*" && <Badge type="accent">{r.subject}</Badge>}
                  <span
                    className="text-muted-foreground text-[10px] uppercase"
                    title={STATUS_HINT[r.status]}
                  >
                    {r.status}
                  </span>
                  <span className="flex-1" />
                  {r.channels.map((c) => (
                    <Badge key={c} type="secondary">
                      {c}
                    </Badge>
                  ))}
                </div>
                <div className="text-muted-foreground font-mono text-[11px]">
                  {describeTrigger(r.when)}
                </div>
                <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-[10px]">
                  <span>for {r.for ?? "0s"}</span>
                  <span>cooldown {r.cooldown}</span>
                  {r.mutedUntil && (
                    <span>muted until {new Date(r.mutedUntil).toLocaleTimeString()}</span>
                  )}
                  <span className="flex-1" />
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => void toggle(r)}
                  >
                    {r.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => void mute(r.id, r.mutedUntil ? "0s" : "1h")}
                  >
                    <BellOff /> {r.mutedUntil ? "Un-mute" : "Mute 1h"}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => void remove(r.id)}
                  >
                    <Trash2 /> Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* History — fired/resolved pairs, so flapping is visible as a pattern. */}
      <section className="grid gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-semibold">History</h3>
          <Select
            value={hours}
            onValueChange={setHours}
            aria-label="History window"
            options={[
              { value: "1", label: "last hour" },
              { value: "24", label: "last 24h" },
              { value: "168", label: "last 7d" },
            ]}
          />
        </div>
        {history.length === 0 ? (
          <Note>Nothing in this window.</Note>
        ) : (
          <div className="grid gap-1">
            {history.map((h) => (
              <div
                key={h.id}
                className="bg-card grid grid-cols-[auto_auto_1fr_auto] items-center gap-2 rounded-md border px-2.5 py-1.5 text-[11px]"
              >
                <span className="text-muted-foreground font-mono">
                  {new Date(h.ts).toLocaleTimeString(undefined, { hour12: false })}
                </span>
                <Badge
                  type={h.kind === "resolve" ? "secondary" : SEV[h.severity as Severity].badge}
                >
                  {h.kind === "resolve" ? "resolved" : h.severity}
                </Badge>
                <span className="truncate">
                  {h.title}
                  {h.device ? ` · ${h.device}` : ""}
                </span>
                <span
                  className={cn(
                    "font-mono text-[10px]",
                    h.deliveries.every((d) => d.ok) ? "text-muted-foreground" : "text-destructive",
                  )}
                  title={h.deliveries
                    .map((d) => `${d.channel}: ${d.ok ? "ok" : (d.error ?? d.status)}`)
                    .join("\n")}
                >
                  {h.deliveries.filter((d) => d.ok).length}/{h.deliveries.length} delivered
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
