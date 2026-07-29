/**
 * Rollout tab — the wave board for a staged fleet change.
 *
 * A rollout is minutes long and mostly waiting, so the page has to answer
 * "where is it, and can I stop it" at a glance:
 *
 *   • **Wave board** — one card per device, grouped by wave, cycling
 *     pending → applied → failed / reverted. The canary lane is marked, because
 *     it is the one that decides whether the other 49 routers get touched.
 *   • **Gate strip** between waves — health results, plus **Hold** while a run
 *     is live. That button is the difference between a demo and something people
 *     let near a fleet.
 *   • **Failure drawer** — which device, what the device said, and what the
 *     revert did.
 *   • **History** — past rollouts with their outcome.
 *
 * Live updates ride the shared `/api/stream` socket (message type `rollout`).
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { api, postJson } from "./api";
import { Panel } from "./atoms";
import { Badge, Button, Dot } from "./geist";
import type { GeistType } from "./geist";
import { onRolloutUpdate } from "./hooks";
import { toast } from "./toast-action";
import type {
  RolloutDevice,
  RolloutEvent,
  RolloutGate,
  RolloutOutcome,
  RolloutRecord,
} from "./types";
import { cn } from "@/lib/utils";

const OUTCOME_TYPE: Record<RolloutOutcome, GeistType> = {
  completed: "success",
  "completed-with-failures": "warning",
  halted: "warning",
  reverted: "secondary",
  "needs-attention": "error",
  aborted: "secondary",
};

const OUTCOME_MEANING: Record<RolloutOutcome, string> = {
  completed: "Every device applied the change.",
  "completed-with-failures": "The rollout finished, but a gate failed along the way.",
  halted: "Stopped at a failed gate. The devices already changed are still changed.",
  reverted: "Stopped and put back — the fleet is where it started.",
  "needs-attention":
    "A revert itself failed. Restore the flagged device(s) by hand from the snapshot named below.",
  aborted: "A human stopped it; whatever had been applied was reverted.",
};

const STAGE_CLASS: Record<string, string> = {
  pending: "bg-muted/30 text-muted-foreground",
  applied: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  failed: "bg-red-500/15 text-red-600 dark:text-red-400",
  reverted: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  "revert-failed": "bg-red-500/25 text-red-600 dark:text-red-400 font-semibold",
  skipped: "bg-muted/20 text-muted-foreground line-through",
};

function ago(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function WaveBoard({ rollout }: { rollout: RolloutRecord }): ReactNode {
  const gateFor = (wave: number): RolloutGate | undefined =>
    rollout.gates.find((g) => g.wave === wave);

  return (
    <div className="space-y-3">
      {rollout.waves.map((wave) => {
        const gate = gateFor(wave.index);
        const devices = wave.devices
          .map((name) => rollout.devices.find((d) => d.device === name))
          .filter((d): d is RolloutDevice => d !== undefined);
        const active = rollout.outcome === undefined && devices.some((d) => d.stage === "pending");

        return (
          <div key={wave.index} className="rounded-md border p-3">
            <div className="mb-2 flex items-center gap-2 text-sm">
              <span className="font-medium">
                Wave {wave.index + 1}
                {wave.isCanary && (
                  <span className="ml-2 rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-600 dark:text-amber-400">
                    canary
                  </span>
                )}
              </span>
              <span className="text-xs text-muted-foreground">{devices.length} device(s)</span>
              {active && <Dot type="warning" pulse />}
              {gate && (
                <Badge type={gate.ok ? "success" : "error"} className="ml-auto">
                  gate {gate.ok ? "pass" : "fail"}
                </Badge>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {devices.map((d) => (
                <span
                  key={d.device}
                  title={d.error ?? d.stage}
                  className={cn(
                    "rounded-md px-2 py-1 font-mono text-xs",
                    STAGE_CLASS[d.stage] ?? STAGE_CLASS.pending,
                  )}
                >
                  {d.device}
                </span>
              ))}
            </div>

            {gate && !gate.ok && (
              <ul className="mt-2 space-y-1 text-xs text-red-600 dark:text-red-400">
                {gate.collateral && (
                  <li className="font-medium">
                    An UNTOUCHED device went dark — the change affected the wider fleet.
                  </li>
                )}
                {gate.failures.map((f) => (
                  <li key={f.device}>
                    {f.device}: {f.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Detail({ id, onClose }: { id: string; onClose: () => void }): ReactNode {
  const [rollout, setRollout] = useState<RolloutRecord | null>(null);
  const [events, setEvents] = useState<RolloutEvent[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api<{ rollout: RolloutRecord; events: RolloutEvent[] }>(
        `/api/rollout/${encodeURIComponent(id)}`,
      );
      setRollout(res.rollout);
      setEvents(res.events);
    } catch (e) {
      toast.error(`Failed to load rollout: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [id]);

  useEffect(() => {
    void load();
    return onRolloutUpdate((u) => {
      if (u.rolloutId === id) void load();
    });
  }, [id, load]);

  const act = async (verb: "hold" | "resume" | "abort"): Promise<void> => {
    setBusy(true);
    try {
      const res = await postJson<{ error?: string; outcome?: string; held?: boolean }>(
        `/api/rollout/${encodeURIComponent(id)}/${verb}`,
        {},
      );
      if (res.error) toast.error(res.error);
      else toast.success(res.outcome ?? (verb === "hold" ? "Held" : "Done"));
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!rollout) return <Panel title="Rollout">Loading…</Panel>;
  const live = rollout.outcome === undefined;
  const failures = rollout.devices.filter(
    (d) => d.stage === "failed" || d.stage === "revert-failed",
  );

  return (
    <Panel
      title={rollout.label ? `${rollout.label} — ${rollout.id}` : rollout.id}
      extra={
        <div className="flex items-center gap-2">
          {live && (
            <>
              <Button size="sm" type="secondary" disabled={busy} onClick={() => void act("hold")}>
                Hold
              </Button>
              <Button size="sm" type="secondary" disabled={busy} onClick={() => void act("resume")}>
                Resume
              </Button>
              <Button size="sm" type="error" disabled={busy} onClick={() => void act("abort")}>
                Abort
              </Button>
            </>
          )}
          <Button size="sm" type="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      <div
        className={cn(
          "mb-4 rounded-md border p-3 text-sm",
          rollout.outcome === "needs-attention" && "border-red-500/40 bg-red-500/10",
          rollout.outcome === "completed" && "border-emerald-500/40 bg-emerald-500/10",
          live && "border-amber-500/40 bg-amber-500/10",
        )}
      >
        <div className="flex items-center gap-2 font-medium">
          <Dot type={rollout.outcome ? OUTCOME_TYPE[rollout.outcome] : "warning"} pulse={live} />
          {rollout.outcome ?? `IN FLIGHT — wave ${rollout.phase}`}
        </div>
        <p className="mt-1 text-muted-foreground">
          {rollout.outcome
            ? OUTCOME_MEANING[rollout.outcome]
            : "Applying wave by wave; each wave is gated and soaked before the next."}
        </p>
      </div>

      <WaveBoard rollout={rollout} />

      {failures.length > 0 && (
        <div className="mt-4 rounded-md border border-red-500/40 p-3 text-sm">
          <div className="font-medium">Failures</div>
          <ul className="mt-1 space-y-1 font-mono text-xs text-muted-foreground">
            {failures.map((d) => (
              <li key={d.device}>
                {d.device} · {d.stage}
                {d.error ? ` — ${d.error}` : ""}
                {d.stage === "revert-failed" && d.snapshotId
                  ? ` · restore with diff_config_snapshots ${d.snapshotId} live`
                  : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {rollout.notes.length > 0 && (
        <ul className="mt-4 space-y-1 text-sm text-amber-600 dark:text-amber-400">
          {rollout.notes.map((n) => (
            <li key={n}>• {n}</li>
          ))}
        </ul>
      )}

      <h4 className="mt-6 mb-2 text-sm font-medium">Commands</h4>
      <pre className="overflow-x-auto rounded-md bg-muted/30 p-2 font-mono text-xs">
        {rollout.commands.join("\n")}
      </pre>

      <h4 className="mt-6 mb-2 text-sm font-medium">Timeline</h4>
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">No steps recorded yet.</p>
      ) : (
        <ol className="space-y-1 font-mono text-xs">
          {events.map((e) => (
            <li key={e.seq} className="flex gap-2">
              <span className="text-muted-foreground">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className={e.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"}>
                {e.ok ? "✓" : "✕"}
              </span>
              <span>
                {e.kind}
                {e.device ? ` ${e.device}` : ""}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

export function RolloutView(): ReactNode {
  const [rows, setRows] = useState<RolloutRecord[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ rollouts: RolloutRecord[]; error?: string }>("/api/rollout");
      setRows(res.rollouts);
      setError(res.error ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    return onRolloutUpdate(() => void load());
  }, [load]);

  const live = rows.filter((r) => r.outcome === undefined);

  return (
    <div className="space-y-4">
      {selected && <Detail id={selected} onClose={() => setSelected(null)} />}

      {error && (
        <Panel title="Rollout history">
          <p className="text-sm text-muted-foreground">
            The history could not be read ({error}); rollouts running right now are still shown.
          </p>
        </Panel>
      )}

      <Panel
        title="Rollouts"
        extra={
          <div className="flex items-center gap-2">
            {live.length > 0 && <Badge type="warning">{live.length} in flight</Badge>}
            <Button size="sm" type="secondary" onClick={() => void load()}>
              Refresh
            </Button>
          </div>
        }
      >
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No rollouts yet. Preview one with <span className="font-mono">plan_rollout</span>, then
            run it with <span className="font-mono">start_rollout</span> — canary first, with a
            health gate and soak between waves.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSelected(r.id)}
                  className="flex w-full items-center gap-3 py-2 text-left hover:bg-muted/40"
                >
                  <Badge type={r.outcome ? OUTCOME_TYPE[r.outcome] : "warning"}>
                    {r.outcome ?? "LIVE"}
                  </Badge>
                  <span className="flex-1 truncate">
                    {r.label ?? r.id}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {r.devices.length} device(s) · {r.waves.length} wave(s)
                    </span>
                  </span>
                  <span className="whitespace-nowrap text-xs text-muted-foreground">
                    {ago(r.ts)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
