/**
 * Transactions view — cross-device two-phase commit, made legible.
 *
 * A distributed operation is confusing precisely because it is in several
 * places at once, so the page is built around a **swimlane**: one lane per
 * participant, columns PREPARE → VERIFY → COMMIT, each cell resolving green /
 * amber / red as the coordinator moves. Live updates ride the shared
 * `/api/stream` socket (message type `txn`) — no second socket.
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { api, postJson } from "./api";
import { Panel, StatCard } from "./atoms";
import { Badge, Button, Dot } from "./geist";
import type { GeistType } from "./geist";
import { onTxnUpdate } from "./hooks";
import { toast } from "./toast-action";
import type { TxnEvent, TxnParticipant, TxnRecord, TxnStage, TxnTerminalState } from "./types";
import { cn } from "@/lib/utils";

// ── Helpers ─────────────────────────────────────────────────────────────────

function clock(ms: number): string {
  return new Date(ms).toLocaleString();
}

function ago(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const STATE_TYPE: Record<TxnTerminalState, GeistType> = {
  COMMITTED: "success",
  ABORTED: "secondary",
  PARTIAL: "error",
};

/** What each terminal state actually means for the fleet, in one line. */
const STATE_MEANING: Record<TxnTerminalState, string> = {
  COMMITTED: "Every participant persisted its changes.",
  ABORTED: "Nothing changed on any device — the clean failure. Safe to retry.",
  PARTIAL:
    "Some devices committed and could not be undone automatically. Restore each flagged device " +
    "from its pre-change snapshot.",
};

type CellState = "idle" | "running" | "ok" | "warn" | "fail";

const CELL_CLASS: Record<CellState, string> = {
  idle: "bg-muted/30 text-muted-foreground",
  running: "bg-amber-500/15 text-amber-600 dark:text-amber-400 animate-pulse",
  ok: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  warn: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  fail: "bg-red-500/15 text-red-600 dark:text-red-400",
};

const CELL_LABEL: Record<CellState, string> = {
  idle: "—",
  running: "…",
  ok: "✓",
  warn: "!",
  fail: "✕",
};

/**
 * Resolve one swimlane cell from the event timeline, falling back to the
 * participant's stage while a transaction is still live (events arrive from the
 * store a beat later than the socket does).
 */
function cellFor(
  column: "prepare" | "verify" | "commit",
  device: string,
  events: TxnEvent[],
  participant: TxnParticipant | undefined,
  phase: string,
): { state: CellState; title: string } {
  const relevant = events.filter(
    (e) => e.kind === column && (column === "verify" || e.device === device),
  );
  const last = relevant.at(-1);
  if (last) {
    return {
      state: last.ok ? "ok" : "fail",
      title: `${column}: ${last.ok ? "ok" : "failed"}${last.detail ? ` — ${last.detail}` : ""}`,
    };
  }

  const stage: TxnStage = participant?.stage ?? "pending";
  if (column === "prepare") {
    if (stage === "pending")
      return { state: phase === "prepare" ? "running" : "idle", title: "not prepared" };
    if (stage === "failed") return { state: "fail", title: participant?.error ?? "prepare failed" };
    return { state: "ok", title: "prepared" };
  }
  if (column === "verify") {
    if (phase === "verify") return { state: "running", title: "verifying" };
    return stage === "pending"
      ? { state: "idle", title: "not reached" }
      : { state: "ok", title: "verified" };
  }
  switch (stage) {
    case "committed":
      return { state: "ok", title: "committed" };
    case "restored":
      return {
        state: "warn",
        title: `committed, then restored from ${participant?.snapshotId ?? "snapshot"}`,
      };
    case "rollback-failed":
      return { state: "fail", title: participant?.error ?? "undo failed — needs a human" };
    case "rolled-back":
      return { state: "idle", title: "rolled back, never committed" };
    default:
      return { state: phase === "commit" ? "running" : "idle", title: "not committed" };
  }
}

// ── Swimlane ────────────────────────────────────────────────────────────────

function Swimlane({ txn, events }: { txn: TxnRecord; events: TxnEvent[] }): ReactNode {
  const columns = ["prepare", "verify", "commit"] as const;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] border-separate border-spacing-1 text-sm">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-muted-foreground">
            <th className="text-left font-medium">Participant</th>
            {columns.map((c) => (
              <th key={c} className="text-center font-medium">
                {c}
              </th>
            ))}
            <th className="text-left font-medium">Snapshot</th>
          </tr>
        </thead>
        <tbody>
          {txn.devices.map((device) => {
            const participant = txn.participants.find((p) => p.device === device);
            return (
              <tr key={device}>
                <td className="whitespace-nowrap pr-3 font-medium">
                  {device}
                  {txn.commitOrder.at(-1) === device && (
                    <span className="ml-2 text-xs text-muted-foreground">commits last</span>
                  )}
                </td>
                {columns.map((column) => {
                  const cell = cellFor(column, device, events, participant, txn.phase);
                  return (
                    <td key={column} className="text-center">
                      <div
                        title={cell.title}
                        className={cn(
                          "mx-auto flex h-8 w-full max-w-24 items-center justify-center rounded-md font-mono",
                          CELL_CLASS[cell.state],
                        )}
                      >
                        {CELL_LABEL[cell.state]}
                      </div>
                    </td>
                  );
                })}
                <td className="whitespace-nowrap pl-3 font-mono text-xs text-muted-foreground">
                  {participant?.snapshotId ?? "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Detail ──────────────────────────────────────────────────────────────────

function Detail({ id, onClose }: { id: string; onClose: () => void }): ReactNode {
  const [txn, setTxn] = useState<TxnRecord | null>(null);
  const [events, setEvents] = useState<TxnEvent[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api<{ transaction: TxnRecord; events: TxnEvent[] }>(
        `/api/txn/${encodeURIComponent(id)}`,
      );
      setTxn(res.transaction);
      setEvents(res.events);
    } catch (e) {
      toast.error(`Failed to load transaction: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [id]);

  useEffect(() => {
    void load();
    // A live transaction pushes updates over the shared socket; re-read on each
    // so the assertion panel and timeline stay in step with the lanes.
    return onTxnUpdate((u) => {
      if (u.txnId === id) void load();
    });
  }, [id, load]);

  const abort = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await postJson<{ state?: TxnTerminalState; error?: string }>(
        `/api/txn/${encodeURIComponent(id)}/abort`,
        {},
      );
      if (res.error) toast.error(res.error);
      else toast.success(`Transaction ${res.state ?? "aborted"}`);
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!txn) return <Panel title="Transaction">Loading…</Panel>;

  const live = txn.state === undefined;
  return (
    <Panel
      title={txn.label ? `${txn.label} — ${txn.id}` : txn.id}
      extra={
        <div className="flex items-center gap-2">
          {live && (
            <Button size="sm" type="secondary" disabled={busy} onClick={() => void abort()}>
              Abort
            </Button>
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
          txn.state === "PARTIAL" && "border-red-500/40 bg-red-500/10",
          txn.state === "COMMITTED" && "border-emerald-500/40 bg-emerald-500/10",
          txn.state === "ABORTED" && "border-muted bg-muted/30",
          live && "border-amber-500/40 bg-amber-500/10",
        )}
      >
        <div className="flex items-center gap-2 font-medium">
          <Dot type={txn.state ? STATE_TYPE[txn.state] : "warning"} />
          {txn.state ?? `IN FLIGHT — phase ${txn.phase}`}
        </div>
        <p className="mt-1 text-muted-foreground">
          {txn.state
            ? STATE_MEANING[txn.state]
            : "Changes are staged in Safe Mode on each participant and are not committed."}
        </p>
      </div>

      <Swimlane txn={txn} events={events} />

      {txn.warnings.length > 0 && (
        <ul className="mt-4 space-y-1 text-sm text-amber-600 dark:text-amber-400">
          {txn.warnings.map((w) => (
            <li key={w}>! {w}</li>
          ))}
        </ul>
      )}

      {txn.state === "PARTIAL" && (
        <div className="mt-4 rounded-md border border-red-500/40 p-3 text-sm">
          <div className="font-medium">Recovery</div>
          <ul className="mt-1 space-y-1 text-muted-foreground">
            {txn.participants
              .filter((p) => p.stage === "committed" || p.stage === "rollback-failed")
              .map((p) => (
                <li key={p.device} className="font-mono text-xs">
                  {p.device}: diff_config_snapshots {p.snapshotId ?? "<no snapshot>"} live
                </li>
              ))}
          </ul>
        </div>
      )}

      <h4 className="mt-6 mb-2 text-sm font-medium">Assertions</h4>
      {txn.results.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          None declared — this transaction committed on faith rather than on evidence.
        </p>
      ) : (
        <ul className="space-y-1 text-sm">
          {txn.results.map((r, i) => (
            <li key={`${r.assertion.kind}-${i}`} className="flex items-start gap-2">
              <Badge type={r.ok ? "success" : "error"}>{r.ok ? "PASS" : "FAIL"}</Badge>
              <span className="font-mono text-xs">
                {r.assertion.kind} @ {r.assertion.device ?? r.assertion.from ?? "?"}
              </span>
              <span className="text-muted-foreground">{r.detail}</span>
            </li>
          ))}
        </ul>
      )}

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
              {e.detail && <span className="text-muted-foreground">{e.detail}</span>}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

// ── View ────────────────────────────────────────────────────────────────────

export function TransactionsView(): ReactNode {
  const [rows, setRows] = useState<TxnRecord[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ transactions: TxnRecord[]; error?: string }>("/api/txn");
      setRows(res.transactions);
      setError(res.error ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    return onTxnUpdate(() => void load());
  }, [load]);

  const live = rows.filter((r) => r.state === undefined);
  const partial = rows.filter((r) => r.state === "PARTIAL");

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard k="Transactions" v={String(rows.length)} sub="recorded" />
        <StatCard k="In flight" v={String(live.length)} sub="prepared, not committed" />
        <StatCard
          k="Partial"
          v={String(partial.length)}
          sub="need a human"
          cls={partial.length > 0 ? "text-red-500" : undefined}
        />
        <StatCard
          k="Committed"
          v={String(rows.filter((r) => r.state === "COMMITTED").length)}
          sub="landed everywhere"
        />
      </div>

      {error && (
        <Panel title="Transaction log">
          <p className="text-sm text-muted-foreground">
            The log could not be read ({error}); transactions running right now are still shown.
          </p>
        </Panel>
      )}

      {selected && <Detail id={selected} onClose={() => setSelected(null)} />}

      <Panel
        title="History"
        extra={
          <Button size="sm" type="secondary" onClick={() => void load()}>
            Refresh
          </Button>
        }
      >
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No transactions yet. Use <span className="font-mono">begin_transaction</span> to
            coordinate a change across several routers — both ends of a tunnel, a peering, a fleet
            ACL.
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
                  <Badge type={r.state ? STATE_TYPE[r.state] : "warning"}>
                    {r.state ?? "LIVE"}
                  </Badge>
                  <span className="flex-1 truncate">
                    {r.label ?? r.id}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {r.devices.join(" → ")}
                    </span>
                  </span>
                  <span
                    className="whitespace-nowrap text-xs text-muted-foreground"
                    title={clock(r.ts)}
                  >
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
