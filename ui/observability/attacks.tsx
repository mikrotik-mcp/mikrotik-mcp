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
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, postJson } from "./api";
import { Panel, StatCard } from "./atoms";
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
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [main, src] = await Promise.all([
        api<AttacksPayload>("/api/attacks?hours=168"),
        api<{ sources: AttackSource[] }>("/api/attacks/sources"),
      ]);
      setPayload(main);
      setSources(src.sources ?? []);
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
      const res = await postJson<{ unavailable: AttackUnavailable[]; incidents: AttackIncident[] }>(
        "/api/attacks/scan",
        {},
      );
      setUnavailable(res.unavailable ?? []);
      toast.success(`Scan complete — ${res.incidents?.length ?? 0} incident(s)`);
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

      <Panel
        title="Incidents"
        extra={
          <Button size="sm" loading={scanning} onClick={() => void scan()}>
            Scan now
          </Button>
        }
      >
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
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-1 text-left">Source</th>
                  <th className="py-1 text-left">Where</th>
                  <th className="py-1 text-left">Devices</th>
                  <th className="py-1 text-right">Incidents</th>
                  <th className="py-1 text-left">Detectors</th>
                  <th className="py-1 text-right">Last seen</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s.source} className="border-b border-border/50">
                    <td className="py-1 font-mono text-xs">{s.source}</td>
                    <td className="py-1 text-xs text-muted-foreground">
                      {s.geo ? `${s.geo.country}${s.geo.city ? ` · ${s.geo.city}` : ""}` : "—"}
                    </td>
                    <td className="py-1 text-xs">{s.devices.join(", ")}</td>
                    <td className="py-1 text-right tabular-nums">{s.incidents}</td>
                    <td className="py-1 text-xs text-muted-foreground">{s.detectors.join(", ")}</td>
                    <td className="py-1 text-right text-xs text-muted-foreground">
                      {relative(s.lastTs, now)}
                    </td>
                    <td className="py-1 text-right">
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
