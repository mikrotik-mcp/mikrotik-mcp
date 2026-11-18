/**
 * Rollout (the Cfg-Plan-Rollout board): the wave board for a staged fleet
 * change. A rollout is minutes long and mostly waiting, so the page answers
 * "where is it, and can I stop it" at a glance:
 *
 *   • **Waves** left to right, the canary first, with the health gate between
 *     each pair. **Hold** and **Abort** sit on the panel while a run is live.
 *   • **Commands** sent to every router, with the rollout's notes.
 *   • **Timeline** of each step, live from the server.
 *   • **Rollouts**: past and running rollouts. Pick one to see it above.
 *
 * Live updates ride the shared `/api/stream` socket (message type `rollout`).
 */
import "./plan.css";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Pause, Play, RefreshCw, TriangleAlert, X } from "lucide-react";
import { api, postJson } from "./api";
import { onRolloutUpdate } from "./hooks";
import { LoadingState } from "./loading-state";
import {
  MonitorButton,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  PageIntro,
  StatusBadge,
  StatusDot,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { toast } from "./toast-action";
import type {
  RolloutDevice,
  RolloutEvent,
  RolloutGate,
  RolloutOutcome,
  RolloutRecord,
} from "./types";

/** The server sends a few more fields than the shared type names. */
type Rollout = RolloutRecord & { soakSeconds?: number; currentWave?: number };

const OUTCOME_TONE: Record<RolloutOutcome, Tone> = {
  completed: "good",
  "completed-with-failures": "warn",
  halted: "warn",
  reverted: "default",
  "needs-attention": "bad",
  aborted: "default",
};

const OUTCOME_LABEL: Record<RolloutOutcome, string> = {
  completed: "completed",
  "completed-with-failures": "completed with failures",
  halted: "halted",
  reverted: "reverted",
  "needs-attention": "needs attention",
  aborted: "aborted",
};

const OUTCOME_MEANING: Record<RolloutOutcome, string> = {
  completed: "Every router applied the change.",
  "completed-with-failures": "The rollout finished, but a gate failed along the way.",
  halted: "Stopped at a failed gate. The routers already changed are still changed.",
  reverted: "Stopped and put back. The fleet is where it started.",
  "needs-attention":
    "A revert failed. Restore the flagged routers by hand from the snapshot named below.",
  aborted: "Someone stopped it. Whatever had been applied was reverted.",
};

const STAGE_TONE: Record<string, Tone | undefined> = {
  applied: "good",
  failed: "bad",
  "revert-failed": "bad",
  reverted: "warn",
};
const STAGE_TEXT: Record<string, string> = {
  applied: "text-success",
  failed: "text-destructive",
  "revert-failed": "text-destructive",
  reverted: "text-warning",
};

function ago(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The wave the rollout is on: the first one with a router still pending. */
function currentWave(r: Rollout): number {
  if (typeof r.currentWave === "number") return r.currentWave;
  const pending = r.waves.find((w) =>
    r.devices.some((d) => d.wave === w.index && d.stage === "pending"),
  );
  return pending?.index ?? r.waves.at(-1)?.index ?? 0;
}

function DeviceCard({ device }: { device: RolloutDevice }): ReactNode {
  return (
    <div className="glass plan-device" title={device.error ?? device.stage}>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <StatusDot tone={STAGE_TONE[device.stage]} />
        <span className="mono trunc">{device.device}</span>
      </span>
      <span className={`text-[11px] ${STAGE_TEXT[device.stage] ?? "text-faint"}`}>
        {device.stage}
      </span>
    </div>
  );
}

function Gate({
  gate,
  rollout,
  wave,
}: {
  gate: RolloutGate | undefined;
  rollout: Rollout;
  wave: number;
}): ReactNode {
  const live = rollout.outcome === undefined;
  let text = "waiting";
  let cls = "text-muted-foreground";
  if (gate?.ok) {
    text = rollout.soakSeconds ? `gate passed · soaked ${rollout.soakSeconds}s` : "gate passed";
    cls = "text-success";
  } else if (gate) {
    text = gate.collateral ? "gate failed · an untouched router went dark" : "gate failed";
    cls = "text-destructive";
  } else if (live && currentWave(rollout) === wave) {
    text = "checking health";
  }
  return (
    <div className="plan-gate">
      <span className={gate ? cls : "text-faint"}>
        <ArrowRight aria-hidden="true" />
      </span>
      <span className={cls}>{text}</span>
    </div>
  );
}

function Waves({ rollout }: { rollout: Rollout }): ReactNode {
  const parts: ReactNode[] = [];
  rollout.waves.forEach((wave, i) => {
    const devices = wave.devices
      .map((name) => rollout.devices.find((d) => d.device === name))
      .filter((d): d is RolloutDevice => d !== undefined);
    parts.push(
      <div key={`w${wave.index}`} className="plan-wave">
        <div className="flex items-center gap-2">
          <span className="monitor-label">Wave {wave.index}</span>
          {wave.isCanary && <span className="monitor-chip">canary</span>}
        </div>
        {devices.map((d) => (
          <DeviceCard key={d.device} device={d} />
        ))}
      </div>,
    );
    if (i < rollout.waves.length - 1)
      parts.push(
        <Gate
          key={`g${wave.index}`}
          gate={rollout.gates.find((g) => g.wave === wave.index)}
          rollout={rollout}
          wave={wave.index}
        />,
      );
  });
  return <div className="plan-waves">{parts}</div>;
}

function Detail({
  rollout,
  events,
  busy,
  onAct,
}: {
  rollout: Rollout;
  events: RolloutEvent[];
  busy: boolean;
  onAct: (verb: "hold" | "resume" | "abort") => void;
}): ReactNode {
  const live = rollout.outcome === undefined;
  const held = rollout.phase === "held";
  const failures = rollout.devices.filter(
    (d) => d.stage === "failed" || d.stage === "revert-failed",
  );
  const failedGates = rollout.gates.filter((g) => !g.ok);
  const tone: Tone = rollout.outcome ? OUTCOME_TONE[rollout.outcome] : "warn";
  return (
    <>
      <MonitorPanel
        title={
          <span className="flex items-center gap-2">
            <StatusDot tone={tone} pulse={live} />
            {rollout.label ? `${rollout.label} · ${rollout.id}` : rollout.id}
          </span>
        }
        description={
          rollout.outcome
            ? OUTCOME_MEANING[rollout.outcome]
            : "The canary decides whether the other routers get touched."
        }
        extra={
          live && (
            <div className="flex flex-wrap items-center gap-2">
              {held ? (
                <MonitorButton
                  variant="ghost"
                  size="sm"
                  icon={<Play aria-hidden="true" />}
                  disabled={busy}
                  onClick={() => onAct("resume")}
                >
                  Resume
                </MonitorButton>
              ) : (
                <MonitorButton
                  variant="ghost"
                  size="sm"
                  icon={<Pause aria-hidden="true" />}
                  disabled={busy}
                  onClick={() => onAct("hold")}
                >
                  Hold
                </MonitorButton>
              )}
              <MonitorButton
                variant="danger"
                size="sm"
                icon={<X aria-hidden="true" />}
                disabled={busy}
                onClick={() => onAct("abort")}
              >
                Abort
              </MonitorButton>
            </div>
          )
        }
        bodyClassName="flex flex-col gap-4"
      >
        <Waves rollout={rollout} />
        {failedGates.map((g) => (
          <MonitorNote key={g.wave} tone="bad" icon={<TriangleAlert aria-hidden="true" />}>
            <b>Gate after wave {g.wave} failed.</b>{" "}
            {g.collateral && "A router outside the rollout went dark. "}
            {g.failures.map((f) => `${f.device}: ${f.reason}`).join(" · ")}
          </MonitorNote>
        ))}
        {failures.length > 0 && (
          <MonitorNote tone="bad" icon={<TriangleAlert aria-hidden="true" />}>
            {failures.map((d) => (
              <div key={d.device} className="mono">
                {d.device} · {d.stage}
                {d.error ? `: ${d.error}` : ""}
                {d.stage === "revert-failed" && d.snapshotId
                  ? ` · restore with diff_config_snapshots ${d.snapshotId} live`
                  : ""}
              </div>
            ))}
          </MonitorNote>
        )}
      </MonitorPanel>

      <div className="plan-cols" data-even="">
        <MonitorPanel title="Commands" description="Sent to every router in the rollout.">
          <div className="flex min-w-0 flex-col gap-2.5">
            <pre className="monitor-pre overflow-x-auto whitespace-pre">
              {rollout.commands.join("\n")}
            </pre>
            {rollout.notes.length > 0 && (
              <>
                <span className="monitor-label">Notes</span>
                <ul className="plan-notes">
                  {rollout.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </MonitorPanel>
        <MonitorPanel
          title="Timeline"
          description="Live from the MCP server."
          extra={live && <StatusBadge tone="good">LIVE</StatusBadge>}
        >
          {events.length === 0 ? (
            <p className="monitor-hint">No steps recorded yet.</p>
          ) : (
            events.map((e) => (
              <div key={e.seq} className="plan-event" title={e.detail}>
                <span className="mono text-faint">
                  {new Date(e.ts).toLocaleTimeString([], { hour12: false })}
                </span>
                <span className={e.ok ? "text-success" : "text-destructive"}>
                  {e.ok ? "✓" : "✕"}
                </span>
                <span className="mono text-fg-secondary">
                  {e.kind}
                  {e.device ? ` ${e.device}` : ""}
                </span>
              </div>
            ))
          )}
        </MonitorPanel>
      </div>
    </>
  );
}

export function RolloutView({ switcher }: { switcher?: ReactNode }): ReactNode {
  const [rows, setRows] = useState<Rollout[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [loadedDetail, setDetail] = useState<{ rollout: Rollout; events: RolloutEvent[] } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    return api<{ rollouts: Rollout[]; error?: string }>("/api/rollout")
      .then((res) => {
        setRows(res.rollouts);
        setError(res.error ?? null);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    void load();
    return onRolloutUpdate(() => void load());
  }, [load]);

  // Show the rollout picked in the list, else the first one in flight.
  const selected = picked ?? rows.find((r) => r.outcome === undefined)?.id ?? null;

  const loadDetail = useCallback(() => {
    if (!selected) return Promise.resolve();
    return api<{ rollout: Rollout; events: RolloutEvent[] }>(
      `/api/rollout/${encodeURIComponent(selected)}`,
    )
      .then((res) => setDetail(res))
      .catch((e) => {
        toast.error(`Failed to load rollout: ${e instanceof Error ? e.message : String(e)}`);
      });
  }, [selected]);

  // A detail loaded for another rollout is stale once the selection moves.
  const detail = loadedDetail?.rollout.id === selected ? loadedDetail : null;

  useEffect(() => {
    if (!selected) return;
    void loadDetail();
    return onRolloutUpdate((u) => {
      if (u.rolloutId === selected) void loadDetail();
    });
  }, [selected, loadDetail]);

  const act = async (verb: "hold" | "resume" | "abort"): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    try {
      const res = await postJson<{ error?: string; outcome?: string; held?: boolean }>(
        `/api/rollout/${encodeURIComponent(selected)}/${verb}`,
        {},
      );
      if (res.error) toast.error(res.error);
      else toast.success(res.outcome ?? (verb === "hold" ? "Held" : "Done"));
      await loadDetail();
    } finally {
      setBusy(false);
    }
  };

  const r = detail?.rollout;
  const name = r ? (r.label ?? r.id) : "";
  const verdict = r ? (
    r.outcome === undefined ? (
      <>
        {name} is <span className="w">{r.phase === "held" ? "on hold" : "in flight"}</span>, wave{" "}
        {currentWave(r)} of {r.waves.length}.
      </>
    ) : r.outcome === "completed" ? (
      <>
        {name} <span className="s">completed</span>.
      </>
    ) : r.outcome === "needs-attention" ? (
      <>
        {name} <em>needs attention</em>.
      </>
    ) : r.outcome === "completed-with-failures" || r.outcome === "halted" ? (
      <>
        {name} <span className="w">{OUTCOME_LABEL[r.outcome]}</span>.
      </>
    ) : (
      <>
        {name} was {OUTCOME_LABEL[r.outcome]}.
      </>
    )
  ) : rows.length === 0 ? (
    "No rollouts yet."
  ) : (
    <>
      {plural(rows.length, "rollout")}. <span className="s">None in flight.</span>
    </>
  );

  return (
    <section className="plan grid content-start gap-[18px]">
      <PageIntro
        eyebrow="Change plan · rollout"
        verdict={verdict}
        lead={
          <>
            Applying wave by wave. Each wave is gated and soaked before the next. Started with{" "}
            <span className="mono">start_rollout</span>.
          </>
        }
        aside={switcher}
      />

      {selected && !detail && <LoadingState label="Loading rollout" layout="cards" />}
      {detail && (
        <Detail
          rollout={detail.rollout}
          events={detail.events}
          busy={busy}
          onAct={(verb) => void act(verb)}
        />
      )}

      {error && (
        <MonitorNote tone="warn">
          The history could not be read ({error}). Rollouts running right now still show.
        </MonitorNote>
      )}

      <MonitorPanel
        title="Rollouts"
        description="Past and running rollouts with their outcome."
        flush
        extra={
          <MonitorButton
            variant="ghost"
            size="sm"
            icon={<RefreshCw aria-hidden="true" />}
            onClick={() => void load()}
          >
            Refresh
          </MonitorButton>
        }
      >
        {!loaded ? (
          <LoadingState label="Loading rollouts" layout="table" />
        ) : rows.length === 0 ? (
          <MonitorEmpty compact title="No rollouts yet">
            Preview one with <span className="mono">plan_rollout</span>, then run it with{" "}
            <span className="mono">start_rollout</span>: canary first, with a health gate and a soak
            between waves.
          </MonitorEmpty>
        ) : (
          <>
            <div className="monitor-thead plan-hist">
              <span>Outcome</span>
              <span>Rollout</span>
              <span>Devices</span>
              <span>Started</span>
            </div>
            {rows.map((row) => (
              <button
                key={row.id}
                type="button"
                className="monitor-row plan-hist"
                data-selected={row.id === selected || undefined}
                data-failed={row.outcome === "needs-attention" || undefined}
                aria-pressed={row.id === selected}
                onClick={() => setPicked(row.id)}
              >
                <span className="trunc">
                  {row.outcome ? (
                    <StatusBadge
                      tone={OUTCOME_TONE[row.outcome]}
                      dot={false}
                      quiet={OUTCOME_TONE[row.outcome] === "default"}
                    >
                      {OUTCOME_LABEL[row.outcome]}
                    </StatusBadge>
                  ) : (
                    <StatusBadge tone="warn">LIVE</StatusBadge>
                  )}
                </span>
                <span className="trunc">
                  <span className="mono p">{row.label ?? row.id}</span>
                </span>
                <span className="trunc">
                  {row.devices.length} · {plural(row.waves.length, "wave")}
                </span>
                <span className="trunc">
                  <span className="mono text-muted-foreground">{ago(row.ts)}</span>
                </span>
              </button>
            ))}
          </>
        )}
      </MonitorPanel>
    </section>
  );
}
