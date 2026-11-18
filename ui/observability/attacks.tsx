/**
 * Attacks view: who is attacking the fleet right now, and what to do about it.
 * Laid out after the approved Sec-Attacks boards (desktop, block confirm, phone).
 *
 *   • **Posture note**: loud when the feature is watching but not acting, so
 *     nobody believes they are protected when they are only being observed.
 *   • **Verdict and kill chain**: how many attackers, whether one got in, and
 *     how far the week's incidents got.
 *   • **Incident list**: newest first, each opening into the stages, the advice
 *     and every raw log line behind it. An incident that cannot show its work
 *     should not be acted on, so the evidence is one click away.
 *   • **Top attackers and sources**: the same attacker seen across several
 *     routers, which no single device can show.
 *   • **Response log**: every block, why it happened and when it lapses, each
 *     with an Unblock. A firewall entry nobody can explain is worse than none.
 *   • **Detectors that could not run**, and the one thing that fixes each.
 *     Silence must never read as safety.
 *   • **Charts**: computed from the incidents already on the page. No extra
 *     request, and no chart that can disagree with the list under it.
 *   • **Schedule an audit**: detection answers "is someone attacking me now";
 *     a scheduled audit answers "did my posture get worse". The shortcut writes
 *     to the existing Schedules feature rather than growing a second scheduler.
 */
import "./monitoring.css";
import "./security.css";
import { LoadingState } from "./loading-state";
import type { ReactNode } from "react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  Lock,
  RefreshCw,
  Server,
  ShieldCheck,
} from "lucide-react";
import { api, postJson } from "./api";
import { useNow } from "./use-now";
import { toast } from "./toast-action";
import type {
  AttackIncident,
  AttackResponse,
  AttackSource,
  AttackUnavailable,
  AttacksPayload,
} from "./types";
import {
  Donut,
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorDialog,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  MonitorSelect,
  PageIntro,
  StatusBadge,
  StatusDot,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { KillChain, PressureBars } from "./security-charts";
import type { PressureDay } from "./security-charts";
import { cn } from "@/lib/utils";

const STAGES = ["recon", "attempt", "breach", "persistence"] as const;

/** Worst first, so the donut reads the same way the incident list does. */
const CONFIDENCE_ORDER = ["confirmed", "high", "medium", "low"] as const;

/** The schedules people actually want, in the words they'd use. */
const CRON_PRESETS = [
  { cron: "0 3 * * *", label: "Every day at 03:00" },
  { cron: "0 */6 * * *", label: "Every 6 hours" },
  { cron: "0 * * * *", label: "Every hour" },
  { cron: "0 8 * * 1", label: "Mondays at 08:00" },
] as const;

const DAY = 86_400_000;

const pad2 = (n: number): string => String(n).padStart(2, "0");
const monthDay = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const hhmm = (ms: number): string => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
/** "Nov 17, 00:02": a row's last-seen time. */
const stamp = (ms: number): string => `${monthDay(ms)}, ${hhmm(ms)}`;
/** "Nov 16 23:58:02": a raw log line's time. */
const logStamp = (ms: number): string =>
  `${monthDay(ms)} ${hhmm(ms)}:${pad2(new Date(ms).getSeconds())}`;

function startOfDay(ms: number): number {
  // Local midnight, not `floor(ms / DAY)`: that floors to UTC, and every bar
  // would sit under the wrong label for anyone whose offset is not zero.
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function relative(ms: number, now: number): string {
  const minutes = Math.round(Math.abs(now - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

/** "1h" → "1 hour". Anything else is shown as RouterOS wrote it. */
function humanTimeout(timeout: string): string {
  const m = /^(\d+)([smhdw])$/.exec(timeout.trim());
  if (!m) return timeout;
  const n = Number(m[1]);
  const unit = { s: "second", m: "minute", h: "hour", d: "day", w: "week" }[m[2]] ?? "";
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function severityTone(severity: string): Tone {
  if (severity === "critical" || severity === "high") return "bad";
  if (severity === "medium") return "warn";
  return "default";
}

function SeverityPill({ severity }: { severity: string }): ReactNode {
  return (
    <StatusBadge tone={severityTone(severity)} dot={false}>
      {severity}
    </StatusBadge>
  );
}

/** The boards' `.risk` tag for how sure a finding is. */
function ConfidenceTag({ confidence }: { confidence: string }): ReactNode {
  const risk =
    confidence === "confirmed" ? "destructive" : confidence === "high" ? "write" : undefined;
  return (
    <span className="monitor-risk" data-risk={risk}>
      {confidence}
    </span>
  );
}

/** A pill with an LED: "blocked". */
function BlockedPill(): ReactNode {
  return <StatusBadge tone="good">blocked</StatusBadge>;
}

/** The kill chain, with everything reached so far in pink. */
function StageTrack({ stage }: { stage: string }): ReactNode {
  const reached = STAGES.indexOf(stage as (typeof STAGES)[number]);
  return (
    <div className="sec-stages">
      {STAGES.map((s, i) => (
        <span key={s} className="sec-stages">
          <StatusBadge tone={i <= reached ? "bad" : "default"} dot={false}>
            {s}
          </StatusBadge>
          {i < STAGES.length - 1 && <span className="sec-faint">›</span>}
        </span>
      ))}
    </div>
  );
}

/** Colours a raw log line: a failed login pink, a successful one teal. */
function lineClass(message: string): string | undefined {
  if (/fail|denied|invalid/i.test(message)) return "r";
  if (/logged in|login success/i.test(message)) return "a";
  if (/^user \S+: \//.test(message)) return "k";
  return undefined;
}

/** What the right-hand cell offers for an incident. */
function IncidentAction({
  incident,
  busy,
  onRespond,
}: {
  incident: AttackIncident;
  busy: boolean;
  onRespond: (id: string) => void;
}): ReactNode {
  if (incident.blocked) return <BlockedPill />;
  if (!incident.source) return <span className="sec-faint text-[12px]">no address</span>;
  if (incident.spoofableOnly)
    return (
      <StatusBadge tone="warn" dot={false}>
        spoofable
      </StatusBadge>
    );
  return (
    <MonitorButton
      variant="danger"
      size="sm"
      icon={<Lock aria-hidden="true" />}
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={(e) => {
        e.stopPropagation();
        onRespond(incident.id);
      }}
    >
      Block…
    </MonitorButton>
  );
}

function IncidentDetail({ incident }: { incident: AttackIncident }): ReactNode {
  const tone = severityTone(incident.severity);
  return (
    <div
      className="sec-inc-detail"
      data-tone={tone === "bad" || tone === "warn" ? tone : undefined}
    >
      <div>
        {incident.spoofableOnly && (
          <MonitorNote tone="warn" icon={<AlertTriangle aria-hidden="true" />}>
            Every signal here rests on a source address that can be forged. It cannot be blocked on
            its own, and blocking it by hand may punish whoever the attacker chose to name.
          </MonitorNote>
        )}
        <div className="monitor-fl">
          <span className="monitor-label">How far it got</span>
          <StageTrack stage={incident.stage} />
        </div>
        <div className="monitor-fl">
          <span className="monitor-label">What to do</span>
          <ul className="sec-todo">
            {incident.recommendations.map((r) => (
              <li key={r}>
                <span className="sec-acc">→</span> {r}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div>
        <span className="monitor-label">
          Evidence ({incident.evidence.length}) · detectors:{" "}
          <span className="sec-mono">{incident.detectors.join(", ")}</span>
        </span>
        <pre className="monitor-pre sec-evidence">
          {incident.evidence.slice(0, 60).map((e, i) => (
            <Fragment key={`${e.ts ?? 0}-${i}`}>
              {e.ts ? logStamp(e.ts) : "??"} [{e.device}]{" "}
              <span className={lineClass(e.message)}>{e.message}</span>
              {"\n"}
            </Fragment>
          ))}
        </pre>
      </div>
    </div>
  );
}

function IncidentRow({
  incident,
  onRespond,
  busy,
  now,
}: {
  incident: AttackIncident;
  onRespond: (id: string) => void;
  busy: boolean;
  now: number;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const failed = incident.confidence === "confirmed";
  const toggle = (): void => setOpen((o) => !o);
  const caret = (
    <button
      type="button"
      className="sec-caret"
      aria-expanded={open}
      aria-label={`${open ? "Hide" : "Show"} details: ${incident.narrative}`}
      onClick={(e) => {
        e.stopPropagation();
        toggle();
      }}
    >
      {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
    </button>
  );
  const source = incident.source ? (
    <span className="sec-mono p">{incident.source}</span>
  ) : (
    <span className="sec-mut">(config change)</span>
  );
  const action = <IncidentAction incident={incident} busy={busy} onRespond={onRespond} />;
  const today = startOfDay(incident.lastTs) === startOfDay(now);
  return (
    <>
      <div
        className={cn("monitor-row sec-inc-cols sec-inc-row sec-wide", failed && "sec-fail")}
        data-selected={open || undefined}
        data-failed={failed || undefined}
        onClick={toggle}
      >
        {caret}
        <span>
          <SeverityPill severity={incident.severity} />
        </span>
        <span>
          <ConfidenceTag confidence={incident.confidence} />
        </span>
        {source}
        <span className="sec-trunc sec-mut">{incident.narrative}</span>
        <span className="sec-mono sec-mut sec-trunc">{incident.devices.join(", ")}</span>
        <span className="sec-mono sec-mut">{stamp(incident.lastTs)}</span>
        <span className="sec-end">{action}</span>
      </div>
      <div
        className={cn("monitor-row sec-card sec-phone sec-inc-row", failed && "sec-fail")}
        data-selected={open || undefined}
        data-failed={failed || undefined}
        onClick={toggle}
      >
        <span className="sec-card-line">
          <SeverityPill severity={incident.severity} />
          <ConfidenceTag confidence={incident.confidence} />
          <span className="sec-sp" />
          <span className="sec-mono sec-faint">
            {today ? hhmm(incident.lastTs) : monthDay(incident.lastTs)}
          </span>
        </span>
        {source}
        <span className="sec-tx2 text-[13px]">{incident.narrative}</span>
        <span className="sec-card-line sec-card-foot">
          <span className="sec-mono sec-mut sec-trunc flex-1">{incident.devices.join(", ")}</span>
          {action}
        </span>
      </div>
      {open && <IncidentDetail incident={incident} />}
    </>
  );
}

/** The scope picker from the board: server icon, the choice, a chevron. */
function ScopePicker({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}): ReactNode {
  const current = options.find((o) => o.value === value)?.label ?? "";
  return (
    <span className="monitor-router">
      <Server aria-hidden="true" />
      <span className="truncate">{current}</span>
      <ChevronDown aria-hidden="true" />
      <select
        aria-label="Which devices to scan"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

interface PendingBlock {
  id: string;
  source: string;
  devices: string[];
  timeout: string;
  action?: string;
  list?: string;
  reason?: string;
}

function BlockDialog({
  pending,
  incident,
  geo,
  busy,
  onConfirm,
  onCancel,
}: {
  pending: PendingBlock | null;
  incident: AttackIncident | undefined;
  geo: AttackSource["geo"] | undefined;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactNode {
  const where = [
    geo ? `${geo.countryCode} · ${geo.city ?? geo.country}` : null,
    incident?.severity,
    incident?.confidence,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <MonitorDialog
      open={pending != null}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
      title="Block this address?"
      description="This adds the source to an address list on each router below. Nothing is applied until you press Block it."
      width={560}
      closeDisabled={busy}
      footer={
        <>
          <span className="sec-sp" />
          <MonitorButton variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </MonitorButton>
          <MonitorButton
            variant="danger"
            icon={<Lock aria-hidden="true" />}
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            Block it
          </MonitorButton>
        </>
      }
    >
      {pending && (
        <div className="monitor-dialog-body sec-dialog-body">
          <div className="sec-block-head">
            <StatusDot tone="bad" pulse />
            <span className="sec-col">
              <span className="sec-block-ip">{pending.source}</span>
              {where && <span className="sec-mut text-[12px]">{where}</span>}
            </span>
            <span className="sec-sp" />
            <StatusBadge tone="bad" dot={false}>
              {pending.action ?? "block"}
            </StatusBadge>
          </div>
          <dl className="monitor-facts sec-facts">
            <dt>Routers</dt>
            <dd className="sec-mono">{pending.devices.join(", ")}</dd>
            {pending.list ? (
              <>
                <dt>Address list</dt>
                <dd className="sec-mono">{pending.list}</dd>
              </>
            ) : null}
            <dt>Expires</dt>
            <dd>
              {pending.timeout ? (
                <>
                  <b className="sec-tx">after {humanTimeout(pending.timeout)}</b>{" "}
                  <span className="sec-mut">· then the address is let back in</span>
                </>
              ) : (
                <>
                  <b className="sec-tx">never</b>{" "}
                  <span className="sec-warn">· this block does not expire</span>
                </>
              )}
            </dd>
            <dt>Reason</dt>
            <dd>{pending.reason || incident?.narrative}</dd>
          </dl>
          <MonitorNote tone="good" icon={<Check aria-hidden="true" />}>
            The safety checks passed: the address is not spoofable, and it is not this server, a
            router or anything the server depends on.
          </MonitorNote>
          <span className="monitor-hint">
            You can undo this from the Response log with Unblock.
          </span>
        </div>
      )}
    </MonitorDialog>
  );
}

function ResponseRow({
  response,
  onUnblock,
}: {
  response: AttackResponse;
  onUnblock: (address: string) => void;
}): ReactNode {
  const tone: Tone = !response.ok ? "bad" : response.revokedAt ? "default" : "good";
  return (
    <div className="monitor-row sec-resp-cols">
      <StatusDot tone={tone} />
      <span className="sec-mono p sec-trunc">{response.source}</span>
      <span className="sec-mono sec-mut">{response.action}</span>
      <span className="sec-col">
        <span className="sec-trunc sec-tx2">{response.reason}</span>
        <span className="sec-mono sec-faint">
          {monthDay(response.ts)} {hhmm(response.ts)} ·{" "}
          {response.timeout ? `for ${response.timeout}` : "PERMANENT"}
        </span>
      </span>
      <span className="sec-end">
        {!response.ok ? (
          <span className="sec-bad text-[12px]">failed</span>
        ) : response.revokedAt ? (
          <StatusBadge dot={false}>revoked</StatusBadge>
        ) : (
          <MonitorButton size="sm" onClick={() => onUnblock(response.source)}>
            Unblock
          </MonitorButton>
        )}
      </span>
    </div>
  );
}

export function AttacksView(): ReactNode {
  const [payload, setPayload] = useState<AttacksPayload | null>(null);
  const [sources, setSources] = useState<AttackSource[]>([]);
  const [unavailable, setUnavailable] = useState<AttackUnavailable[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  /** A dry-run plan awaiting an explicit yes. */
  const [pending, setPending] = useState<PendingBlock | null>(null);
  const [scanning, setScanning] = useState(false);
  /** "" = every device · "__online" = only the reachable ones · else one name. */
  const [scope, setScope] = useState("");
  const [deviceList, setDeviceList] = useState<{ name: string; reachable: boolean | null }[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [schedulable, setSchedulable] = useState<{ tool: string; summary: string }[]>([]);
  const [jobCount, setJobCount] = useState(0);
  const [auditTool, setAuditTool] = useState("");
  const [auditCron, setAuditCron] = useState<string>(CRON_PRESETS[0].cron);
  const [scheduling, setScheduling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((): Promise<void> => {
    return Promise.all([
      api<AttacksPayload>("/api/attacks?hours=168"),
      api<{ sources: AttackSource[] }>("/api/attacks/sources"),
      api<{ devices: { name: string; reachable: boolean | null }[] }>("/api/attacks/devices"),
      api<{
        jobs: { id: string }[];
        schedulable: { tool: string; summary: string }[];
      }>("/api/schedules"),
    ])
      .then(([main, src, devs, sched]) => {
        setPayload(main);
        setSources(src.sources ?? []);
        setDeviceList(devs.devices ?? []);
        setSchedulable(sched.schedulable ?? []);
        setJobCount(sched.jobs?.length ?? 0);
        setAuditTool((current) => current || (sched.schedulable?.[0]?.tool ?? ""));
        setError(main.error ?? null);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const scan = async (): Promise<void> => {
    setScanning(true);
    try {
      const body =
        scope === "" ? {} : scope === "__online" ? { onlineOnly: true } : { devices: [scope] };
      const res = await postJson<{
        unavailable: AttackUnavailable[];
        incidents: AttackIncident[];
        devices: { device: string; ok: boolean; events: number; error?: string }[];
        skipped: string[];
      }>("/api/attacks/scan", body);

      setUnavailable(res.unavailable ?? []);
      setSkipped(res.skipped ?? []);
      const read = (res.devices ?? []).filter((d) => d.ok).length;
      const failed = (res.devices ?? []).filter((d) => !d.ok);
      toast.success(
        `Scanned ${read} device(s) — ${res.incidents?.length ?? 0} incident(s)${
          failed.length > 0 ? ` · ${failed.length} unreachable` : ""
        }`,
      );
      await load();
    } catch (e) {
      toast.error(`Scan failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setScanning(false);
    }
  };

  const respond = async (id: string, confirm: boolean): Promise<void> => {
    setBusy(id);
    try {
      const res = await postJson<{
        refused?: boolean;
        guard?: boolean;
        reason?: string;
        dryRun?: boolean;
        escalated?: boolean;
        ok?: boolean;
        plan?: {
          source: string;
          devices: string[];
          timeout: string;
          action?: string;
          list?: string;
          reason?: string;
        };
      }>(`/api/attacks/${encodeURIComponent(id)}/respond`, { confirm });

      if (res.refused) {
        // A guard refusal is not a setting: say which one stopped it.
        toast.error(`${res.guard ? "Refused by a guard" : "Not applied"}: ${res.reason}`);
      } else if (res.escalated) {
        toast.error(`Escalated, not blocked: ${res.reason}`);
      } else if (res.dryRun && res.plan) {
        // Nothing was changed; show exactly what would be, and wait for a yes.
        setPending({ id, ...res.plan });
      } else if (res.ok) {
        setPending(null);
        toast.success("Blocked");
        await load();
      } else {
        toast.error("The block did not apply on any device");
        await load();
      }
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const scheduleAudit = async (): Promise<void> => {
    if (!auditTool) return;
    setScheduling(true);
    try {
      // Writes to the existing Schedules feature: same endpoint, same guards,
      // same READ-only enforcement. This page is a shortcut, not a second
      // scheduler with its own idea of the rules.
      const target = scope === "" || scope === "__online" ? "all" : scope;
      const suffix = target === "all" ? "fleet" : target;
      const res = await postJson<{ job?: { id: string }; error?: string }>("/api/schedules", {
        id: `${auditTool.replace(/_/g, "-")}-${suffix}`.slice(0, 60),
        cron: auditCron,
        tool: auditTool,
        devices: target === "all" ? "all" : [target],
        notifyOn: ["new", "worsened"],
      });
      if (res.error) toast.error(res.error);
      else {
        toast.success(
          `Scheduled ${auditTool} — the first run is only a baseline, comparisons start with the second`,
        );
        await load();
      }
    } catch (e) {
      toast.error(`Could not schedule: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setScheduling(false);
    }
  };

  const unblock = async (address: string): Promise<void> => {
    try {
      const res = await fetch(`/api/attacks/responses/${encodeURIComponent(address)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success(`Unblocked ${address}`);
      await load();
    } catch (e) {
      toast.error(`Unblock failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const now = useNow(60_000);
  const incidents = useMemo(() => payload?.incidents ?? [], [payload]);
  const responses = payload?.responses ?? [];
  // A device that has never been probed counts as reachable here, matching the
  // server: never probed is not the same as known-offline.
  const onlineCount = deviceList.filter((d) => d.reachable !== false).length;
  const totals = useMemo(
    () => ({
      confirmed: incidents.filter((i) => i.confidence === "confirmed").length,
      critical: incidents.filter((i) => i.severity === "critical").length,
      sources: new Set(incidents.map((i) => i.source).filter(Boolean)).size,
      blocks: (payload?.responses ?? []).filter((r) => r.ok && !r.revokedAt).length,
    }),
    [incidents, payload],
  );

  // Seven local days, oldest first; every day gets a bucket, even an empty one,
  // so a quiet week and a busy one never look the same.
  const days = useMemo(() => {
    const today = startOfDay(now);
    const list = Array.from({ length: 7 }, (_, i) => startOfDay(today - (6 - i) * DAY));
    const pressure: PressureDay[] = list.map((t) => ({
      label: monthDay(t),
      confirmed: 0,
      high: 0,
      other: 0,
    }));
    const critical = list.map(() => 0);
    const seen = list.map(() => new Set<string>());
    for (const incident of incidents) {
      // Bucketed by when it started: the day something began is what a trend shows.
      const i = list.indexOf(startOfDay(incident.firstTs));
      if (i < 0) continue;
      if (incident.confidence === "confirmed") pressure[i].confirmed++;
      else if (incident.confidence === "high") pressure[i].high++;
      else pressure[i].other++;
      if (incident.severity === "critical") critical[i]++;
      if (incident.source) seen[i].add(incident.source);
    }
    // Distinct attackers so far, day by day.
    const running = new Set<string>();
    const attackers = seen.map((s) => {
      for (const x of s) running.add(x);
      return running.size;
    });
    return { pressure, critical, attackers };
  }, [incidents, now]);

  const stageCounts = STAGES.map((name) => ({
    name,
    count: incidents.filter((i) => i.stage === name).length,
  }));

  const scopeOptions = [
    { value: "", label: `All devices (${deviceList.length})` },
    { value: "__online", label: `Only reachable (${onlineCount})` },
    ...deviceList.map((d) => ({
      value: d.name,
      label:
        d.name + (d.reachable === false ? " (offline)" : d.reachable === null ? " (unprobed)" : ""),
    })),
  ];
  const scopeText = scope === "" || scope === "__online" ? "all devices" : scope;

  if (!payload && !error) return <LoadingState label="Loading threat evidence" layout="cards" />;

  const posture = payload?.posture;
  const firstBreach = incidents.find((i) => i.confidence === "confirmed" && i.source);
  const gotIn =
    totals.confirmed === 0 ? (
      <span className="s">None got in.</span>
    ) : (
      <em>{totals.confirmed === 1 ? "One got in." : `${totals.confirmed} got in.`}</em>
    );
  const verdict =
    incidents.length === 0 ? (
      <span className="s">No attacks this week.</span>
    ) : (
      <>
        {plural(totals.sources, "attacker")} this week. {gotIn}
      </>
    );
  const phoneVerdict =
    incidents.length === 0 ? (
      <span className="s">No attacks.</span>
    ) : (
      <>
        {plural(totals.sources, "attacker")}. {gotIn}
      </>
    );

  const scanButton = (
    <MonitorButton
      variant="primary"
      icon={<RefreshCw aria-hidden="true" />}
      disabled={scanning}
      aria-busy={scanning || undefined}
      onClick={() => void scan()}
    >
      Scan now
    </MonitorButton>
  );
  const pendingIncident = incidents.find((i) => i.id === pending?.id);
  const sorted = [...sources].sort((a, b) => b.incidents - a.incidents).slice(0, 6);
  const maxIncidents = Math.max(1, ...sorted.map((s) => s.incidents));

  return (
    <div className="sec-page">
      {posture &&
        (!posture.enabled ? (
          <MonitorNote icon={<Eye aria-hidden="true" />}>
            <b>Attack detection is off.</b> Nothing is being watched. Turn it on in the{" "}
            <span className="sec-mono">attacks</span> config block.
          </MonitorNote>
        ) : posture.mode === "detect" ? (
          <MonitorNote tone="warn" icon={<Eye aria-hidden="true" />}>
            <b>Detect-only.</b>{" "}
            <span className="sec-wide">
              Attacks are recorded and alerted on, but nothing is blocked on its own. Set{" "}
              <span className="sec-mono">mode: "respond"</span> in the{" "}
              <span className="sec-mono">attacks</span> config block once a week of this looks right
              to you.
            </span>
            <span className="sec-phone-i">Nothing is blocked on its own.</span>
          </MonitorNote>
        ) : (
          <MonitorNote tone="good" icon={<ShieldCheck aria-hidden="true" />}>
            <b>Responding.</b> Automatic blocks are armed for {posture.autoRespondTo.join(", ")} at{" "}
            {posture.minConfidence} confidence or above. Spoofable evidence is never acted on.
          </MonitorNote>
        ))}

      <div className="sec-wide">
        <PageIntro
          eyebrow="Attacks · last 7 days"
          verdict={verdict}
          lead={
            <>
              Incidents are built from every router's log.
              {firstBreach && (
                <>
                  {" "}
                  <span className="sec-mono">{firstBreach.source}</span>: {firstBreach.narrative}.
                </>
              )}
            </>
          }
          actions={
            <>
              <ScopePicker value={scope} onChange={setScope} options={scopeOptions} />
              {scanButton}
              <MonitorButton
                variant="ghost"
                icon={<Calendar aria-hidden="true" />}
                onClick={() => {
                  window.location.hash = "schedules";
                }}
              >
                Open Schedules
              </MonitorButton>
              <span className="monitor-hint sec-hero-hint">
                Scanning reads recent logs and correlates them. It changes nothing on the routers.
              </span>
            </>
          }
          aside={
            <div className="glass sec-hero-aside">
              <KillChain stages={stageCounts} caption="HOW FAR THEY GOT · 7 DAYS" />
            </div>
          }
        />
      </div>
      <div className="sec-phone sec-phone-head">
        <p className="monitor-eyebrow">Attacks · 7 days</p>
        <h1>{phoneVerdict}</h1>
      </div>

      <MetricStrip label="Attack totals" className="sec-wide">
        <Metric
          label="Confirmed"
          value={totals.confirmed}
          hint="someone got in"
          tone={totals.confirmed > 0 ? "bad" : "good"}
        />
        <Metric
          label="Critical"
          value={totals.critical}
          hint="incidents"
          tone={totals.critical > 0 ? "bad" : "default"}
          spark={days.critical}
        />
        <Metric
          label="Attackers"
          value={totals.sources}
          hint="distinct sources, 7 days"
          spark={days.attackers}
        />
        <Metric label="Blocked" value={totals.blocks} hint="blocks in force now" tone="good" />
      </MetricStrip>
      <MetricStrip label="Attack totals" className="sec-phone">
        <Metric
          label="Confirmed"
          value={totals.confirmed}
          hint="someone got in"
          tone={totals.confirmed > 0 ? "bad" : "good"}
        />
        <Metric label="Blocked" value={totals.blocks} hint="in force now" tone="good" />
        <Metric label="Critical" value={totals.critical} hint="incidents" />
        <Metric label="Attackers" value={totals.sources} hint="distinct sources" />
      </MetricStrip>
      <div className="sec-phone sec-phone-controls">
        <ScopePicker value={scope} onChange={setScope} options={scopeOptions} />
        {scanButton}
      </div>

      {error && (
        <MonitorNote tone="bad" role="alert" icon={<AlertTriangle aria-hidden="true" />}>
          <b>Attack detection unavailable.</b> {error}
        </MonitorNote>
      )}

      {incidents.length > 0 && (
        <section
          className="sec-grid sec-phone-late"
          style={{ gridTemplateColumns: "minmax(0,2fr) minmax(0,1fr)" }}
        >
          <MonitorPanel
            title="Attack pressure"
            description="Incidents per day, by how sure we are."
            extra={
              <span className="monitor-legend">
                <span>
                  <i style={{ background: "var(--destructive)" }} />
                  confirmed
                </span>
                <span>
                  <i style={{ background: "var(--warning)" }} />
                  high
                </span>
                <span>
                  <i style={{ background: "var(--brand)" }} />
                  medium / low
                </span>
              </span>
            }
          >
            <PressureBars days={days.pressure} />
          </MonitorPanel>
          <MonitorPanel title="How much is real" description="Incidents by confidence.">
            <div className="sec-donut">
              <Donut
                size={140}
                stroke={14}
                center={incidents.length}
                sub="incidents"
                label="Incidents by confidence"
                parts={CONFIDENCE_ORDER.map((c) => ({
                  label: c,
                  value: incidents.filter((i) => i.confidence === c).length,
                  tone:
                    c === "confirmed"
                      ? "bad"
                      : c === "high"
                        ? "warn"
                        : c === "medium"
                          ? "brand"
                          : "muted",
                }))}
              />
              <ul>
                {CONFIDENCE_ORDER.map((c) => (
                  <li key={c}>
                    <ConfidenceTag confidence={c} />
                    <span className="flex-1" />
                    <span className="sec-num sec-tx2">
                      {incidents.filter((i) => i.confidence === c).length}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </MonitorPanel>
        </section>
      )}

      <MonitorPanel
        title="Incidents"
        description={
          <>
            <span className="sec-wide">
              Newest first. Open a row for the stage, advice and raw log lines.
            </span>
            <span className="sec-phone-i">Newest first.</span>
          </>
        }
        extra={
          <span className="sec-mono sec-mut sec-wide">
            {plural(incidents.length, "incident")} · 7 days
          </span>
        }
        flush
      >
        {skipped.length > 0 && (
          <div className="sec-panel-pad">
            <MonitorNote tone="warn" icon={<AlertTriangle aria-hidden="true" />}>
              Not scanned because the health probe reports {skipped.length === 1 ? "it" : "them"}{" "}
              unreachable: <span className="sec-mono">{skipped.join(", ")}</span>. This result says
              nothing about {skipped.length === 1 ? "it" : "them"}.
            </MonitorNote>
          </div>
        )}
        {incidents.length === 0 ? (
          <MonitorEmpty compact icon={<ShieldCheck />} title="No incidents recorded.">
            Scan now reads every device's recent log and correlates what it finds. It changes
            nothing.
          </MonitorEmpty>
        ) : (
          <div>
            <div className="monitor-thead sec-inc-cols sec-wide">
              <span />
              <span>Severity</span>
              <span>Confidence</span>
              <span>Source</span>
              <span>What happened</span>
              <span>Devices</span>
              <span>Last seen</span>
              <span />
            </div>
            {incidents.map((incident) => (
              <IncidentRow
                key={incident.id}
                incident={incident}
                now={now}
                busy={busy === incident.id}
                onRespond={(id) => void respond(id, false)}
              />
            ))}
          </div>
        )}
      </MonitorPanel>

      <section
        className="sec-grid"
        style={{
          gridTemplateColumns:
            sorted.length > 0 ? "minmax(0,1fr) minmax(0,1.5fr)" : "minmax(0,1fr)",
        }}
      >
        {sorted.length > 0 && (
          <MonitorPanel
            title="Top attackers"
            description="Incidents per source. Blocked sources are greyed."
          >
            <div className="sec-attackers">
              {sorted.map((s) => (
                <div key={s.source} className="sec-attacker" data-blocked={s.blocked || undefined}>
                  <span className="sec-mono sec-tx sec-trunc">{s.source}</span>
                  <span className="monitor-bar">
                    <span
                      data-tone={s.blocked ? "muted" : "bad"}
                      style={{ width: `${(s.incidents / maxIncidents) * 100}%` }}
                    />
                  </span>
                  <span className="sec-mono sec-num text-right">{s.incidents}</span>
                </div>
              ))}
            </div>
          </MonitorPanel>
        )}
        <MonitorPanel
          title="Top sources"
          description="7 days. Location comes from the router geo cache only."
          flush
        >
          {sources.length === 0 ? (
            <MonitorEmpty compact title="No attacker addresses recorded yet." />
          ) : (
            <div>
              <div className="monitor-thead sec-src-cols">
                <span>Source</span>
                <span>Where</span>
                <span>Incidents</span>
                <span>Detectors</span>
                <span>Last seen</span>
                <span />
              </div>
              {sources.map((s) => (
                <div
                  key={s.source}
                  className={cn(
                    "monitor-row sec-src-cols",
                    s.worst === "critical" && !s.blocked && "sec-fail",
                  )}
                  title={s.devices.join(", ")}
                >
                  <span className="sec-mono p">{s.source}</span>
                  {s.geo ? (
                    <span className="sec-tx2">
                      {s.geo.countryCode}
                      {s.geo.city ? ` · ${s.geo.city}` : ""}
                    </span>
                  ) : (
                    <span className="sec-mut">—</span>
                  )}
                  <span className="sec-num">{s.incidents}</span>
                  <span className="sec-chips">
                    {s.detectors.map((d) => (
                      <span key={d} className="monitor-chip">
                        {d}
                      </span>
                    ))}
                  </span>
                  <span className="sec-mut">{relative(s.lastTs, now)}</span>
                  <span>
                    {s.blocked && (
                      <StatusBadge tone="good" dot={false}>
                        blocked
                      </StatusBadge>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </MonitorPanel>
      </section>

      <section
        className="sec-grid"
        style={{ gridTemplateColumns: "minmax(0,1.5fr) minmax(0,1fr)" }}
      >
        <MonitorPanel
          title="Response log"
          description="Every block and quarantine, newest first."
          flush
        >
          {responses.length === 0 ? (
            <MonitorEmpty compact title="Nothing has been blocked." />
          ) : (
            <div>
              {responses.map((r) => (
                <ResponseRow key={r.id} response={r} onUnblock={(a) => void unblock(a)} />
              ))}
            </div>
          )}
        </MonitorPanel>
        <MonitorPanel
          title="Schedule an audit"
          extra={
            <a href="#schedules" className="sec-link">
              {jobCount > 0 ? `${plural(jobCount, "job")} · open Schedules` : "open Schedules"}
            </a>
          }
        >
          <p className="sec-schedule-copy">
            Detection answers <i>is someone attacking me now</i>. A scheduled audit answers{" "}
            <i>did my posture get worse</i>: it runs on its own and reports only what changed since
            the last run.
          </p>
          <div className="sec-schedule-fields">
            <label className="monitor-fl sec-schedule-mono">
              <span className="monitor-label">Auditor</span>
              <MonitorSelect
                label="Which auditor to schedule"
                value={auditTool}
                onChange={setAuditTool}
                options={schedulable.map((a) => ({ value: a.tool, label: a.tool }))}
              />
            </label>
            <label className="monitor-fl">
              <span className="monitor-label">How often</span>
              <MonitorSelect
                label="How often"
                value={auditCron}
                onChange={setAuditCron}
                options={CRON_PRESETS.map((c) => ({ value: c.cron, label: c.label }))}
              />
            </label>
          </div>
          <div className="sec-schedule-foot">
            <span className="monitor-hint">
              Runs on {scopeText}.
              {auditTool && ` ${schedulable.find((a) => a.tool === auditTool)?.summary ?? ""}`}
            </span>
            <span className="sec-sp" />
            <MonitorButton
              variant="primary"
              icon={<Calendar aria-hidden="true" />}
              disabled={schedulable.length === 0 || scheduling}
              aria-busy={scheduling || undefined}
              onClick={() => void scheduleAudit()}
            >
              Schedule it
            </MonitorButton>
          </div>
        </MonitorPanel>
      </section>

      {unavailable.length > 0 && (
        <MonitorPanel
          title="Detectors that could not run"
          description="Silence is not safety. These checks were skipped on the last scan."
          extra={
            <StatusBadge tone="warn" dot={false}>
              {unavailable.length} skipped
            </StatusBadge>
          }
        >
          {unavailable.map((u) => (
            <div key={u.detector} className="sec-detector">
              <span>
                <span className="sec-mono sec-tx">{u.detector}</span>{" "}
                <span className="sec-mut">· {u.reason}</span>
              </span>
              {u.fix && <span className="sec-mono sec-faint">fix: {u.fix}</span>}
            </div>
          ))}
        </MonitorPanel>
      )}

      <BlockDialog
        pending={pending}
        incident={pendingIncident}
        geo={sources.find((s) => s.source === pending?.source)?.geo}
        busy={pending != null && busy === pending.id}
        onConfirm={() => pending && void respond(pending.id, true)}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
