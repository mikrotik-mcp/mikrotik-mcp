/**
 * Attacks view — who is attacking the fleet right now, and what to do about it.
 *
 *   • **Posture banner** — loud when the feature is watching but not acting, so
 *     nobody believes they are protected when they are only being observed.
 *   • **Incident feed** — worst first, each expanding into the kill-chain stages
 *     and every raw log line behind it. An incident that cannot show its work
 *     should not be acted on, so the evidence is one click away, not buried.
 *   • **Top sources** — the same attacker seen across several routers, which is
 *     the pattern no single device can show.
 *   • **Response log** — every block with why it happened and when it lapses,
 *     each with an Unblock. A firewall entry nobody can explain is worse than no
 *     entry at all.
 *   • **Detector status** — including the ones that could NOT run and the single
 *     thing that would fix each. Silence must never read as safety.
 *   • **Charts** — pressure over time, how much of it is real, and who is behind
 *     it. All three are computed from the incidents already on the page: no extra
 *     request, and no chart that can disagree with the table under it.
 *   • **Schedule an audit** — attack detection answers "is someone attacking me
 *     now"; a scheduled audit answers "did my posture get worse". Someone looking
 *     at an incident is exactly the person who should arm the second one, so the
 *     shortcut lives here and writes to the existing Schedules feature rather than
 *     growing a second scheduler.
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, postJson } from "./api";
import { Panel, StatCard } from "./atoms";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import type { ChartConfig } from "@/components/ui/chart";
import { RiskDonut } from "./charts";
import { Badge, Button, Dot } from "./geist";
import type { GeistType } from "./geist";
import { toast } from "./toast-action";
import type { AttackIncident, AttackSource, AttackUnavailable, AttacksPayload } from "./types";
import { cn } from "@/lib/utils";

const SEVERITY_TYPE: Record<string, GeistType> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "secondary",
  info: "secondary",
};

const CONFIDENCE_TYPE: Record<string, GeistType> = {
  confirmed: "error",
  high: "warning",
  medium: "secondary",
  low: "secondary",
};

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

function stamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function relative(ms: number, now: number): string {
  const minutes = Math.round(Math.abs(now - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

/** The kill chain, with everything reached so far filled in. */
function StageTrack({ stage }: { stage: string }): ReactNode {
  const reached = STAGES.indexOf(stage as (typeof STAGES)[number]);
  return (
    <div className="flex items-center gap-1">
      {STAGES.map((s, i) => (
        <span key={s} className="flex items-center gap-1">
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
              i <= reached ? "bg-red-500/15 text-red-500" : "bg-muted/50 text-muted-foreground",
            )}
          >
            {s}
          </span>
          {i < STAGES.length - 1 && <span className="text-muted-foreground">›</span>}
        </span>
      ))}
    </div>
  );
}

/** Chart palette, keyed to the confidence a finding claims. */
const CONFIDENCE_COLOR: Record<string, string> = {
  confirmed: "var(--destructive)",
  high: "var(--chart-4)",
  medium: "var(--chart-2)",
  low: "var(--chart-3)",
};

const timelineConfig = {
  confirmed: { label: "confirmed", color: "var(--destructive)" },
  high: { label: "high", color: "var(--chart-4)" },
  other: { label: "medium / low", color: "var(--chart-2)" },
} satisfies ChartConfig;

/** `Jul 30` — a day bucket's label. */
const dayLabel = (t: number): string =>
  new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/**
 * Attack pressure per day, stacked by confidence.
 *
 * Bars rather than an area: incidents are counted events on discrete days, and
 * an area between two daily points draws a slope that implies attacks happening
 * at times nothing was observed.
 *
 * Every day in the range gets a bucket, including the empty ones — dropping them
 * would compress a quiet week and a busy one into the same picture.
 */
function AttackTimeline({
  incidents,
  days,
}: {
  incidents: AttackIncident[];
  days: number;
}): ReactNode {
  const data = useMemo(() => {
    const DAY = 86_400_000;
    // LOCAL midnight, not `floor(ms / DAY)`: that floors to UTC, and every bar
    // would sit under the wrong label for anyone whose offset is not zero.
    const startOfDay = (ms: number): number => {
      const d = new Date(ms);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    };
    const today = startOfDay(Date.now());
    const buckets = new Map<
      number,
      { t: number; confirmed: number; high: number; other: number }
    >();
    for (let i = days - 1; i >= 0; i--) {
      const t = startOfDay(today - i * DAY);
      buckets.set(t, { t, confirmed: 0, high: 0, other: 0 });
    }
    for (const incident of incidents) {
      // Bucketed by when it STARTED: that is the day something began, which is
      // the question a trend answers.
      const t = startOfDay(incident.firstTs);
      const bucket = buckets.get(t);
      if (!bucket) continue;
      if (incident.confidence === "confirmed") bucket.confirmed++;
      else if (incident.confidence === "high") bucket.high++;
      else bucket.other++;
    }
    return [...buckets.values()];
  }, [incidents, days]);

  if (incidents.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No incidents to chart.</p>;
  }

  return (
    <ChartContainer config={timelineConfig} className="h-[200px] w-full">
      <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="t"
          tickFormatter={dayLabel}
          tick={{ fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          minTickGap={24}
        />
        <YAxis
          tick={{ fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          width={30}
          allowDecimals={false}
        />
        <ChartTooltip
          content={<ChartTooltipContent labelFormatter={(v) => dayLabel(Number(v))} />}
        />
        <Bar dataKey="confirmed" stackId="a" fill="var(--color-confirmed)" radius={[0, 0, 0, 0]} />
        <Bar dataKey="high" stackId="a" fill="var(--color-high)" radius={[0, 0, 0, 0]} />
        <Bar dataKey="other" stackId="a" fill="var(--color-other)" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ChartContainer>
  );
}

/** Who is doing it — the busiest sources, worst first. */
function TopAttackers({ sources }: { sources: AttackSource[] }): ReactNode {
  const data = useMemo(
    () =>
      [...sources]
        .sort((a, b) => b.incidents - a.incidents)
        .slice(0, 6)
        .map((s) => ({
          source: s.source,
          incidents: s.incidents,
          // A blocked source stays on the chart, greyed: removing it would make
          // the pressure look like it stopped on its own.
          fill: s.blocked ? "var(--muted-foreground)" : "var(--destructive)",
        })),
    [sources],
  );

  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No sources yet.</p>;
  }

  return (
    <ChartContainer
      config={{ incidents: { label: "incidents" } } satisfies ChartConfig}
      className="h-[200px] w-full"
    >
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, left: 4, bottom: 0 }}>
        <CartesianGrid horizontal={false} strokeDasharray="3 3" />
        <XAxis
          type="number"
          tick={{ fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
        />
        <YAxis
          type="category"
          dataKey="source"
          tick={{ fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          width={116}
        />
        <ChartTooltip content={<ChartTooltipContent hideLabel />} />
        <Bar dataKey="incidents" radius={[0, 3, 3, 0]} />
      </BarChart>
    </ChartContainer>
  );
}

function IncidentRow({
  incident,
  onRespond,
  busy,
}: {
  incident: AttackIncident;
  onRespond: (id: string, confirm: boolean) => void;
  busy: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setOpen(!open)}
        >
          <Badge type={SEVERITY_TYPE[incident.severity] ?? "secondary"}>{incident.severity}</Badge>
          <Badge type={CONFIDENCE_TYPE[incident.confidence] ?? "secondary"}>
            {incident.confidence}
          </Badge>
          <span className="font-mono text-sm">{incident.source || "(config change)"}</span>
          <span className="truncate text-sm text-muted-foreground">{incident.narrative}</span>
        </button>
        <span className="text-xs text-muted-foreground">{incident.devices.join(", ")}</span>
        <span className="text-xs text-muted-foreground">{stamp(incident.lastTs)}</span>
        {incident.blocked ? (
          <Badge type="success">blocked</Badge>
        ) : (
          <Button size="sm" loading={busy} onClick={() => onRespond(incident.id, false)}>
            Block…
          </Button>
        )}
      </div>

      {open && (
        <div className="mt-3 space-y-3 pl-2">
          <StageTrack stage={incident.stage} />

          {incident.spoofableOnly && (
            <p className="rounded border border-amber-500/50 bg-amber-500/5 p-2 text-xs">
              Every signal here rests on a source address that can be forged. This incident cannot
              be blocked automatically, and blocking it by hand risks punishing whoever the attacker
              chose to name.
            </p>
          )}

          <div className="text-sm">
            <span className="font-medium">What to do: </span>
            <ul className="mt-1 space-y-0.5">
              {incident.recommendations.map((r) => (
                <li key={r} className="text-muted-foreground">
                  → {r}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="mb-1 text-xs font-medium">
              Evidence ({incident.evidence.length}) · detectors: {incident.detectors.join(", ")}
            </p>
            <div className="max-h-56 overflow-y-auto rounded bg-muted/40 p-2 font-mono text-[11px]">
              {incident.evidence.slice(0, 60).map((e, i) => (
                <div key={`${e.ts ?? 0}-${i}`} className="whitespace-pre-wrap">
                  {e.ts ? stamp(e.ts) : "??"} [{e.device}] {e.message}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

export function AttacksView(): ReactNode {
  const [payload, setPayload] = useState<AttacksPayload | null>(null);
  const [sources, setSources] = useState<AttackSource[]>([]);
  const [unavailable, setUnavailable] = useState<AttackUnavailable[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  /** A dry-run plan awaiting an explicit yes — no modal, and it shows the plan. */
  const [pending, setPending] = useState<{
    id: string;
    source: string;
    devices: string[];
    timeout: string;
  } | null>(null);
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

  const load = useCallback(async (): Promise<void> => {
    try {
      const [main, src, devs, sched] = await Promise.all([
        api<AttacksPayload>("/api/attacks?hours=168"),
        api<{ sources: AttackSource[] }>("/api/attacks/sources"),
        api<{ devices: { name: string; reachable: boolean | null }[] }>("/api/attacks/devices"),
        api<{
          jobs: { id: string }[];
          schedulable: { tool: string; summary: string }[];
        }>("/api/schedules"),
      ]);
      setPayload(main);
      setSources(src.sources ?? []);
      setDeviceList(devs.devices ?? []);
      setSchedulable(sched.schedulable ?? []);
      setJobCount(sched.jobs?.length ?? 0);
      setAuditTool((current) => current || (sched.schedulable?.[0]?.tool ?? ""));
      setError(main.error ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
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
        plan?: { source: string; devices: string[]; timeout: string };
      }>(`/api/attacks/${encodeURIComponent(id)}/respond`, { confirm });

      if (res.refused) {
        // A guard refusal is not a setting — say which one stopped it.
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
      // Writes to the existing Schedules feature — same endpoint, same guards,
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

  const now = Date.now();
  const incidents = payload?.incidents ?? [];
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

  return (
    <div className="space-y-4">
      {payload?.posture && (
        <div
          className={cn(
            "rounded-lg border p-3 text-sm",
            !payload.posture.enabled
              ? "border-border bg-muted/30"
              : payload.posture.mode === "detect"
                ? "border-amber-500/50 bg-amber-500/5"
                : "border-emerald-500/50 bg-emerald-500/5",
          )}
        >
          {!payload.posture.enabled ? (
            <>
              <strong>Attack detection is off.</strong> Nothing is being watched. Enable it in the
              <span className="font-mono"> attacks </span> config block.
            </>
          ) : payload.posture.mode === "detect" ? (
            <>
              <strong>Detect-only.</strong> Attacks are recorded and alerted on, but nothing is
              blocked automatically — you are being watched over, not defended. Set
              <span className="font-mono"> mode: "respond" </span>
              when you have read a week of this and trust it.
            </>
          ) : (
            <>
              <strong>Responding.</strong> Automatic blocks are armed for{" "}
              {payload.posture.autoRespondTo.join(", ")} at {payload.posture.minConfidence}{" "}
              confidence or above. Spoofable evidence is never acted on.
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          k="Confirmed"
          v={String(totals.confirmed)}
          cls={totals.confirmed > 0 ? "text-red-500" : "text-emerald-500"}
          sub="someone got in"
        />
        <StatCard
          k="Critical"
          v={String(totals.critical)}
          cls={totals.critical > 0 ? "text-red-500" : undefined}
          sub="incidents"
        />
        <StatCard k="Attackers" v={String(totals.sources)} sub="distinct sources, 7d" />
        <StatCard k="Blocked" v={String(totals.blocks)} sub="currently in force" />
      </div>

      {error && (
        <Panel title="Attack detection unavailable">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </Panel>
      )}

      {incidents.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Panel
              title="Attack pressure"
              extra={
                <span className="text-xs text-muted-foreground">incidents per day · 7 days</span>
              }
            >
              <AttackTimeline incidents={incidents} days={7} />
            </Panel>
          </div>
          <Panel
            title="How much is real"
            extra={<span className="text-xs text-muted-foreground">by confidence</span>}
          >
            <RiskDonut
              segments={CONFIDENCE_ORDER.map((c) => ({
                label: c,
                value: incidents.filter((i) => i.confidence === c).length,
                color: CONFIDENCE_COLOR[c],
              }))}
              centerLabel="incidents"
            />
          </Panel>
        </div>
      )}

      {sources.length > 0 && (
        <Panel
          title="Top attackers"
          extra={
            <span className="text-xs text-muted-foreground">blocked sources shown greyed</span>
          }
        >
          <TopAttackers sources={sources} />
        </Panel>
      )}

      <Panel
        title="Incidents"
        extra={
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-sm"
              aria-label="Which devices to scan"
            >
              <option value="">All devices ({deviceList.length})</option>
              <option value="__online">Only reachable ({onlineCount})</option>
              {deviceList.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                  {d.reachable === false ? " (offline)" : d.reachable === null ? " (unprobed)" : ""}
                </option>
              ))}
            </select>
            <Button size="sm" loading={scanning} onClick={() => void scan()}>
              Scan now
            </Button>
          </div>
        }
      >
        {skipped.length > 0 && (
          <p className="mb-3 rounded border border-amber-500/50 bg-amber-500/5 p-2 text-xs">
            Not scanned because the health probe reports them unreachable:{" "}
            <span className="font-mono">{skipped.join(", ")}</span>. This result says nothing about
            them.
          </p>
        )}
        {pending && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded border border-red-500/50 bg-red-500/5 p-3 text-sm">
            <span>
              Block <span className="font-mono">{pending.source}</span> on{" "}
              {pending.devices.join(", ")} for{" "}
              <strong>{pending.timeout || "ever — this one does NOT expire"}</strong>?
            </span>
            <span className="ml-auto flex gap-2">
              <Button size="sm" type="error" onClick={() => void respond(pending.id, true)}>
                Block it
              </Button>
              <Button size="sm" type="secondary" onClick={() => setPending(null)}>
                Cancel
              </Button>
            </span>
          </div>
        )}
        {incidents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No incidents recorded. Scan now reads every device's recent log and correlates what it
            finds — it changes nothing.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {incidents.map((incident) => (
              <IncidentRow
                key={incident.id}
                incident={incident}
                busy={busy === incident.id}
                onRespond={(id, confirm) => void respond(id, confirm)}
              />
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Schedule an audit"
        extra={
          <a
            href="#schedules"
            className="text-xs text-muted-foreground underline underline-offset-2"
          >
            {jobCount > 0 ? `${jobCount} job(s) — open Schedules` : "open Schedules"}
          </a>
        }
      >
        <p className="mb-3 text-sm text-muted-foreground">
          Attack detection answers <i>is someone attacking me right now</i>. A scheduled audit
          answers <i>did my posture get worse</i> — it runs on its own and reports only what changed
          since the last run. The device picker above chooses the scope.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={auditTool}
            onChange={(e) => setAuditTool(e.target.value)}
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
            aria-label="Which auditor to schedule"
          >
            {schedulable.map((a) => (
              <option key={a.tool} value={a.tool}>
                {a.tool}
              </option>
            ))}
          </select>
          <select
            value={auditCron}
            onChange={(e) => setAuditCron(e.target.value)}
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
            aria-label="How often"
          >
            {CRON_PRESETS.map((c) => (
              <option key={c.cron} value={c.cron}>
                {c.label}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">
            on {scope === "" || scope === "__online" ? "all devices" : scope}
          </span>
          <Button
            size="sm"
            loading={scheduling}
            onClick={() => void scheduleAudit()}
            disabled={schedulable.length === 0}
          >
            Schedule it
          </Button>
        </div>
        {auditTool && (
          <p className="mt-2 text-xs text-muted-foreground">
            {schedulable.find((a) => a.tool === auditTool)?.summary}
          </p>
        )}
      </Panel>

      {unavailable.length > 0 && (
        <Panel
          title="Detectors that could not run"
          extra={<span className="text-xs text-muted-foreground">silence is not safety</span>}
        >
          <ul className="space-y-2 text-sm">
            {unavailable.map((u) => (
              <li key={u.detector}>
                <span className="font-mono text-xs">{u.detector}</span>
                <span className="text-muted-foreground"> — {u.reason}</span>
                {u.fix && <div className="pl-4 text-xs text-muted-foreground">fix: {u.fix}</div>}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel
        title="Top sources"
        extra={<span className="text-xs text-muted-foreground">7 days</span>}
      >
        {sources.length === 0 ? (
          <p className="text-sm text-muted-foreground">No attacker addresses recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            {/*
              Every cell carries its own horizontal padding and an explicit
              vertical alignment. Without both, the detector list wraps to a
              second line and drags the incident count out of line with its row.
            */}
            <table className="w-full border-separate border-spacing-0 text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="border-b border-border py-1.5 pr-4 text-left font-medium">
                    Source
                  </th>
                  <th className="border-b border-border px-4 py-1.5 text-left font-medium">
                    Where
                  </th>
                  <th className="border-b border-border px-4 py-1.5 text-left font-medium">
                    Devices
                  </th>
                  <th className="w-px whitespace-nowrap border-b border-border px-4 py-1.5 text-right font-medium">
                    Incidents
                  </th>
                  <th className="border-b border-border px-4 py-1.5 text-left font-medium">
                    Detectors
                  </th>
                  <th className="w-px whitespace-nowrap border-b border-border px-4 py-1.5 text-right font-medium">
                    Last seen
                  </th>
                  <th className="w-px border-b border-border py-1.5 pl-4" />
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s.source}>
                    <td className="border-b border-border/50 py-2 pr-4 align-top font-mono text-xs">
                      {s.source}
                    </td>
                    <td className="whitespace-nowrap border-b border-border/50 px-4 py-2 align-top text-xs text-muted-foreground">
                      {s.geo ? `${s.geo.country}${s.geo.city ? ` · ${s.geo.city}` : ""}` : "—"}
                    </td>
                    <td className="border-b border-border/50 px-4 py-2 align-top text-xs">
                      {s.devices.join(", ")}
                    </td>
                    <td className="whitespace-nowrap border-b border-border/50 px-4 py-2 text-right align-top tabular-nums">
                      {s.incidents}
                    </td>
                    <td className="border-b border-border/50 px-4 py-2 align-top">
                      {/* Chips, not a joined string: eight comma-separated
                          detector names wrap into an unreadable paragraph. */}
                      <span className="flex flex-wrap gap-1">
                        {s.detectors.map((d) => (
                          <span
                            key={d}
                            className="whitespace-nowrap rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                          >
                            {d}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td className="whitespace-nowrap border-b border-border/50 px-4 py-2 text-right align-top text-xs text-muted-foreground">
                      {relative(s.lastTs, now)}
                    </td>
                    <td className="border-b border-border/50 py-2 pl-4 text-right align-top">
                      {s.blocked && <Badge type="success">blocked</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Response log">
        {(payload?.responses ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing has been blocked.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {(payload?.responses ?? []).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 py-2">
                <Dot type={r.ok ? (r.revokedAt ? "secondary" : "success") : "error"} />
                <span className="font-mono text-xs">{r.source}</span>
                <span className="text-xs text-muted-foreground">{r.action}</span>
                <span className="flex-1 truncate text-xs text-muted-foreground">{r.reason}</span>
                <span className="text-xs text-muted-foreground">
                  {stamp(r.ts)} · {r.timeout ? `for ${r.timeout}` : "PERMANENT"}
                </span>
                {!r.revokedAt && r.ok && (
                  <Button size="sm" type="secondary" onClick={() => void unblock(r.source)}>
                    Unblock
                  </Button>
                )}
                {r.revokedAt && <Badge type="secondary">revoked</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
