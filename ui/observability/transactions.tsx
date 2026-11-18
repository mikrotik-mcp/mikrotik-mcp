/**
 * Transactions (the Cfg-Txn board): cross-device two-phase commit, made
 * legible.
 *
 * A distributed change is confusing because it is in several places at once,
 * so the page is built around a **swimlane**: one lane per participant,
 * columns PREPARE → VERIFY → COMMIT, each cell resolving green / amber / red as
 * the coordinator moves. A finished transaction opens inline under the KPIs; a
 * live one opens the review dialog (Cfg-Txn-Review), where it can be aborted.
 * Live updates ride the shared `/api/stream` socket (message type `txn`).
 */
import "./transactions.css";
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { RowDrawer, RowMenu, RowMore } from "./kit";
import type { Tone as KitTone } from "./kit";
import { Clock, Copy, RefreshCw, TriangleAlert, X } from "lucide-react";
import { api, postJson } from "./api";
import { onTxnUpdate } from "./hooks";
import { LoadingState } from "./loading-state";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorDialog,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  PageIntro,
  StatusBadge,
  StatusDot,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { toast } from "./toast-action";
import type { TxnEvent, TxnParticipant, TxnRecord, TxnStage, TxnTerminalState } from "./types";

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

const KIT_STATE: Record<TxnTerminalState, KitTone> = {
  COMMITTED: "ok",
  ABORTED: "off",
  PARTIAL: "bad",
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function list(items: string[]): string {
  return items.join(", ");
}

const STATE_TONE: Record<TxnTerminalState, Tone> = {
  COMMITTED: "good",
  ABORTED: "default",
  PARTIAL: "bad",
};

/** What each terminal state means for the fleet, in one line. */
const STATE_MEANING: Record<TxnTerminalState, string> = {
  COMMITTED: "Every participant kept its changes.",
  ABORTED: "Nothing changed on any router. The clean failure: safe to retry.",
  PARTIAL:
    "Some devices committed and could not be undone automatically. Restore each flagged device " +
    "from its pre-change snapshot.",
};

type CellState = "idle" | "running" | "ok" | "warn" | "fail";
const CELL_MARK: Record<CellState, string> = {
  idle: "·",
  running: "…",
  ok: "✓",
  warn: "↺",
  fail: "✕",
};
const PAST: Record<string, string> = {
  prepare: "prepared",
  verify: "verified",
  commit: "committed",
};

/**
 * One swimlane cell from the event timeline, falling back to the participant's
 * stage while a transaction is still live (events arrive from the store a beat
 * later than the socket does). A restore or a failed undo always wins in the
 * commit column: that is the part a human has to act on.
 */
function cellFor(
  column: "prepare" | "verify" | "commit",
  device: string,
  txn: TxnRecord,
  events: TxnEvent[],
  participant: TxnParticipant | undefined,
): { state: CellState; text: string; title: string } {
  const phase = txn.phase;
  const stage: TxnStage = participant?.stage ?? "pending";
  if (column === "commit" && stage === "restored")
    return {
      state: "warn",
      text: "restored",
      title: `committed, then restored from ${participant?.snapshotId ?? "snapshot"}`,
    };
  if (column === "commit" && stage === "rollback-failed")
    return {
      state: "fail",
      text: "undo failed",
      title: participant?.error ?? "undo failed: needs a human",
    };

  const last = events
    .filter((e) => e.kind === column && (column === "verify" || e.device === device))
    .at(-1);
  if (last) {
    const text = last.ok ? PAST[column] : `${column} failed`;
    return {
      state: last.ok ? "ok" : "fail",
      text,
      title: `${text}${last.detail ? `: ${last.detail}` : ""}`,
    };
  }

  if (column === "prepare") {
    if (stage === "pending")
      return phase === "prepare"
        ? { state: "running", text: "preparing", title: "preparing" }
        : { state: "idle", text: "not prepared", title: "not prepared" };
    if (stage === "failed")
      return { state: "fail", text: "failed", title: participant?.error ?? "prepare failed" };
    return { state: "ok", text: "prepared", title: "prepared" };
  }
  if (column === "verify") {
    if (phase === "verify") return { state: "running", text: "verifying", title: "verifying" };
    return stage === "pending"
      ? { state: "idle", text: "not reached", title: "not reached" }
      : { state: "ok", text: "verified", title: "verified" };
  }
  switch (stage) {
    case "committed":
      return { state: "ok", text: "committed", title: "committed" };
    case "rolled-back":
      return { state: "idle", text: "rolled back", title: "rolled back, never committed" };
    default: {
      if (phase === "commit") return { state: "running", text: "committing", title: "committing" };
      // A router later in the commit order is not reached until the ones before it commit.
      const before = txn.commitOrder.slice(0, txn.commitOrder.indexOf(device));
      const waiting = before.some(
        (d) => txn.participants.find((p) => p.device === d)?.stage !== "committed",
      );
      const text = waiting ? "not reached" : "not committed";
      return { state: "idle", text, title: text };
    }
  }
}

function laneTone(txn: TxnRecord, p: TxnParticipant | undefined): Tone {
  if (p?.stage === "failed" || p?.stage === "rollback-failed") return "bad";
  if (txn.state === undefined || p?.stage === "restored") return "warn";
  if (p?.stage === "committed") return "good";
  return "default";
}

// ── Swimlane ────────────────────────────────────────────────────────────────

function Swimlane({ txn, events }: { txn: TxnRecord; events: TxnEvent[] }): ReactNode {
  const columns = ["prepare", "verify", "commit"] as const;
  return (
    <>
      <div className="monitor-thead txn-lane">
        <span>Participant</span>
        <span>Prepare</span>
        <span>Verify</span>
        <span>Commit</span>
        <span>Snapshot</span>
      </div>
      {txn.devices.map((device) => {
        const participant = txn.participants.find((p) => p.device === device);
        return (
          <div key={device} className="monitor-row txn-lane">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-2.5">
                <StatusDot tone={laneTone(txn, participant)} />
                <span className="mono p trunc">{device}</span>
              </span>
              {txn.commitOrder.at(-1) === device && txn.devices.length > 1 && (
                <span className="monitor-hint txn-last">commits last</span>
              )}
            </span>
            {columns.map((column) => {
              const cell = cellFor(column, device, txn, events, participant);
              return (
                <span key={column} className="txn-cell" data-state={cell.state} title={cell.title}>
                  {CELL_MARK[cell.state]} {cell.text}
                </span>
              );
            })}
            <span className="mono trunc text-muted-foreground">
              {participant?.snapshotId ?? "—"}
            </span>
          </div>
        );
      })}
    </>
  );
}

function assertionTarget(r: TxnRecord["results"][number]): string {
  return r.assertion.device ?? r.assertion.from ?? "?";
}

function useTxn(id: string): {
  txn: TxnRecord | null;
  events: TxnEvent[];
  load: () => Promise<void>;
} {
  const [txn, setTxn] = useState<TxnRecord | null>(null);
  const [events, setEvents] = useState<TxnEvent[]>([]);
  const load = useCallback(() => {
    return api<{ transaction: TxnRecord; events: TxnEvent[] }>(`/api/txn/${encodeURIComponent(id)}`)
      .then((res) => {
        setTxn(res.transaction);
        setEvents(res.events);
      })
      .catch((e) => {
        toast.error(`Failed to load transaction: ${e instanceof Error ? e.message : String(e)}`);
      });
  }, [id]);
  useEffect(() => {
    void load();
    // A live transaction pushes updates over the shared socket; re-read on each
    // so the assertions stay in step with the lanes.
    return onTxnUpdate((u) => {
      if (u.txnId === id) void load();
    });
  }, [id, load]);
  return { txn, events, load };
}

// ── Detail (a finished transaction, in its row drawer) ─────────────────────

function Detail({
  id,
  onClose,
  nav,
}: {
  id: string;
  onClose: () => void;
  nav?: { index: number; total: number; onPrev?: () => void; onNext?: () => void };
}): ReactNode {
  const loaded = useTxn(id);
  // After J or K the previous transaction is still loaded for a moment; do not show it.
  const txn = loaded.txn?.id === id ? loaded.txn : null;
  const events = loaded.events;
  const state = txn?.state;
  const needsHand =
    txn?.participants.filter((p) => p.stage === "committed" || p.stage === "rollback-failed") ?? [];
  const restored = txn?.participants.filter((p) => p.stage === "restored") ?? [];
  const lost = txn?.participants.filter((p) => p.sessionLost) ?? [];
  return (
    <RowDrawer
      open
      onClose={onClose}
      label={`Transaction details: ${txn?.label ?? id}`}
      storageKey="transactions"
      rowKey={id}
      nav={nav}
      status={state ? { tone: KIT_STATE[state], label: state } : undefined}
      title={
        <span className="txn-detail-title">
          {txn?.label ?? id} {txn?.label && <span className="mono">· {txn.id}</span>}
        </span>
      }
      meta={
        txn
          ? `Started ${ago(txn.ts)} · ${plural(txn.devices.length, "participant")} · commit order ${list(txn.commitOrder)}`
          : undefined
      }
    >
      {!txn ? (
        <LoadingState label="Loading transaction" layout="cards" />
      ) : (
        <div className="txn-review txn-drawer flex flex-col gap-4">
          {state && (
            <MonitorNote
              tone={state === "PARTIAL" ? "bad" : state === "COMMITTED" ? "good" : undefined}
              icon={state === "PARTIAL" ? <TriangleAlert aria-hidden="true" /> : undefined}
            >
              <b>{state}.</b> {STATE_MEANING[state]}
            </MonitorNote>
          )}
          <div className="glass txn-review-lanes">
            <Swimlane txn={txn} events={events} />
          </div>
          <div className="txn-foot">
            <div className="monitor-fl">
              <span className="monitor-label">Recovery</span>
              {state === "PARTIAL" && needsHand.length > 0 ? (
                <pre className="monitor-pre">
                  {needsHand
                    .map(
                      (p) =>
                        `${p.device}: diff_config_snapshots ${p.snapshotId ?? "<no snapshot>"} live`,
                    )
                    .join("\n")}
                </pre>
              ) : (
                <span className="monitor-hint">Nothing to restore by hand.</span>
              )}
              {restored.map((p) => (
                <span key={p.device} className="monitor-hint">
                  {p.device} was restored from {p.snapshotId ?? "its snapshot"} automatically.
                </span>
              ))}
              {lost.map((p) => (
                <span key={`lost-${p.device}`} className="monitor-hint text-warning">
                  ! {p.device} lost its SSH session during commit.
                </span>
              ))}
              {txn.warnings.map((w) => (
                <span key={w} className="monitor-hint text-warning">
                  ! {w}
                </span>
              ))}
            </div>
            <div className="monitor-fl">
              <span className="monitor-label">Assertions</span>
              {txn.results.length === 0 ? (
                <span className="monitor-hint">
                  None declared. This transaction committed on faith, not on evidence.
                </span>
              ) : (
                txn.results.map((r, i) => (
                  <div key={`${r.assertion.kind}-${i}`} className="txn-assert">
                    <StatusBadge tone={r.ok ? "good" : "bad"} dot={false}>
                      {r.ok ? "PASS" : "FAIL"}
                    </StatusBadge>
                    <span className="trunc" title={r.detail}>
                      <span className="mono">{r.assertion.kind}</span> @ {assertionTarget(r)}{" "}
                      <span className="text-muted-foreground">· {r.detail}</span>
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </RowDrawer>
  );
}

// ── Review (a live transaction) ─────────────────────────────────────────────

function Review({ id, onClose }: { id: string; onClose: () => void }): ReactNode {
  const { txn, events, load } = useTxn(id);
  const [busy, setBusy] = useState(false);

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

  const command = `commit_transaction ${id}`;
  const copy = (): void => {
    void navigator.clipboard
      .writeText(command)
      .then(() => toast.success("Copied"))
      .catch(() => toast.error("Could not copy"));
  };

  const live = txn?.state === undefined;
  const passed = txn?.results.filter((r) => r.ok).length ?? 0;
  const lastDevice = txn?.commitOrder.at(-1);
  const others = txn?.commitOrder.slice(0, -1) ?? [];

  return (
    <MonitorDialog
      open
      onOpenChange={(open) => !open && onClose()}
      width={780}
      title={`Review ${txn?.label ?? id} before commit`}
      description={
        txn
          ? `${txn.id} · ${live ? "in flight" : (txn.state ?? "").toLowerCase()} · phase ${txn.phase} · started ${ago(txn.ts)}`
          : id
      }
      footer={
        <>
          <MonitorButton variant="ghost" onClick={onClose}>
            Close
          </MonitorButton>
          <span className="flex-1" />
          {live && (
            <>
              <span className="monitor-hint">Abort rolls back every participant.</span>
              <MonitorButton
                variant="danger"
                icon={<X aria-hidden="true" />}
                disabled={busy}
                onClick={() => void abort()}
              >
                Abort transaction
              </MonitorButton>
            </>
          )}
        </>
      }
    >
      {!txn ? (
        <LoadingState label="Loading transaction" layout="cards" />
      ) : (
        <div className="txn-review flex flex-col gap-4">
          {live ? (
            <MonitorNote tone="warn" icon={<Clock aria-hidden="true" />}>
              <b>In flight.</b> Changes are staged in Safe Mode on each participant and are not
              committed yet.
            </MonitorNote>
          ) : (
            txn.state && (
              <MonitorNote
                tone={
                  txn.state === "PARTIAL" ? "bad" : txn.state === "COMMITTED" ? "good" : undefined
                }
              >
                <b>{txn.state}.</b> {STATE_MEANING[txn.state]}
              </MonitorNote>
            )
          )}
          <div className="glass txn-review-lanes">
            <Swimlane txn={txn} events={events} />
          </div>
          <div className="monitor-fl">
            <span className="monitor-label">
              Assertions · {passed} of {txn.results.length} pass
            </span>
            {txn.results.length === 0 ? (
              <span className="monitor-hint">None declared.</span>
            ) : (
              txn.results.map((r, i) => (
                <div key={`${r.assertion.kind}-${i}`} className="txn-assert">
                  <StatusBadge tone={r.ok ? "good" : "bad"} dot={false}>
                    {r.ok ? "PASS" : "FAIL"}
                  </StatusBadge>
                  <span className="min-w-0">
                    <span className="mono">{r.assertion.kind}</span> @ {assertionTarget(r)}
                    <div className="text-[12px] text-muted-foreground">{r.detail}</div>
                  </span>
                </div>
              ))
            )}
          </div>
          {live && (
            <div className="monitor-fl">
              <span className="monitor-label">Commit from your MCP client</span>
              <div className="flex items-center gap-2">
                <span className="monitor-chip txn-command">{command}</span>
                <MonitorButton
                  variant="ghost"
                  size="sm"
                  icon={<Copy aria-hidden="true" />}
                  onClick={copy}
                >
                  Copy
                </MonitorButton>
              </div>
              {lastDevice && others.length > 0 && (
                <span className="monitor-hint">
                  {lastDevice} commits last, so a failure there leaves {list(others)} restorable
                  from {others.length === 1 ? "its snapshot" : "their snapshots"}.
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </MonitorDialog>
  );
}

// ── View ────────────────────────────────────────────────────────────────────

export function TransactionsView(): ReactNode {
  const [rows, setRows] = useState<TxnRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [autoOpen] = useState(
    () => !(typeof matchMedia === "function" && matchMedia("(max-width: 640px)").matches),
  );

  const load = useCallback(() => {
    return api<{ transactions: TxnRecord[]; error?: string }>("/api/txn")
      .then((res) => {
        setRows(res.transactions);
        setError(res.error ?? null);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    void load();
    return onTxnUpdate(() => void load());
  }, [load]);

  const live = rows.filter((r) => r.state === undefined);
  const partial = rows.filter((r) => r.state === "PARTIAL");
  const committed = rows.filter((r) => r.state === "COMMITTED");
  // Until someone picks a row, open the newest partial: it is the one that needs a human.
  // On a phone the drawer is a full-screen sheet, so it does not open by itself there.
  const selected = picked === undefined ? (autoOpen ? (partial[0]?.id ?? null) : null) : picked;
  const selectedRow = rows.find((r) => r.id === selected);
  const reviewing = selectedRow !== undefined && selectedRow.state === undefined;
  // The drawer walks the finished transactions; a live one opens its review instead.
  const finished = rows.filter((r) => r.state !== undefined);
  const at = finished.findIndex((r) => r.id === selected);
  const drawerNav =
    at < 0
      ? undefined
      : {
          index: at,
          total: finished.length,
          onPrev: at > 0 ? () => setPicked(finished[at - 1]!.id) : undefined,
          onNext: at < finished.length - 1 ? () => setPicked(finished[at + 1]!.id) : undefined,
        };

  const worst = partial[0];
  const done = worst?.participants.filter((p) => p.stage === "committed" || p.stage === "restored");
  const stuck = worst?.participants.filter((p) => p.stage === "rollback-failed");

  return (
    <section className="txn grid content-start gap-[18px]">
      <PageIntro
        eyebrow="Transactions · prepare, verify, commit everywhere"
        verdict={
          partial.length > 0 ? (
            <>
              {plural(rows.length, "transaction")}. <em>{partial.length} partial</em>{" "}
              {partial.length === 1 ? "needs" : "need"} a human.
            </>
          ) : rows.length === 0 ? (
            "No transactions yet."
          ) : (
            <>
              {plural(rows.length, "transaction")}. <span className="s">None need a human.</span>
            </>
          )
        }
        lead={
          <>
            {worst && done && stuck && stuck.length > 0
              ? `${worst.label ?? worst.id} committed on ${list(done.map((p) => p.device))} but could not be undone on ${list(stuck.map((p) => p.device))}. `
              : ""}
            Each change is staged in Safe Mode until every router passes.
          </>
        }
        actions={
          <MonitorButton
            variant="ghost"
            icon={<RefreshCw aria-hidden="true" />}
            onClick={() => void load()}
          >
            Refresh
          </MonitorButton>
        }
      />

      <MetricStrip label="Transaction counts">
        <Metric label="Transactions" value={String(rows.length)} hint="recorded" />
        <Metric
          label="In flight"
          value={String(live.length)}
          hint="prepared, not committed"
          tone={live.length > 0 ? "warn" : "default"}
        />
        <Metric
          label="Partial"
          value={String(partial.length)}
          hint="need a human"
          tone={partial.length > 0 ? "bad" : "default"}
        />
        <Metric
          label="Committed"
          value={String(committed.length)}
          hint="landed everywhere"
          tone={committed.length > 0 ? "good" : "default"}
        />
      </MetricStrip>

      {error && (
        <MonitorNote tone="warn">
          The log could not be read ({error}). Transactions running right now still show.
        </MonitorNote>
      )}

      {selected && !reviewing && (
        <Detail id={selected} onClose={() => setPicked(null)} nav={drawerNav} />
      )}
      {selected && reviewing && (
        <Review key={selected} id={selected} onClose={() => setPicked(null)} />
      )}

      <MonitorPanel
        title="History"
        description="Newest first. Pick one to see its lanes."
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
          <LoadingState label="Loading transactions" layout="table" />
        ) : rows.length === 0 ? (
          <MonitorEmpty compact title="No transactions yet">
            Use <span className="mono">begin_transaction</span> to change several routers together:
            both ends of a tunnel, a peering, a fleet ACL.
          </MonitorEmpty>
        ) : (
          <>
            <div className="monitor-thead txn-hist">
              <span>State</span>
              <span>Transaction</span>
              <span>Participants</span>
              <span>When</span>
              <span />
            </div>
            {rows.map((r) => (
              <RowMenu
                key={r.id}
                title={r.label ?? r.id}
                sub={`${r.state ?? "LIVE"} · ${ago(r.ts)}`}
                onOpen={() => setPicked(r.id)}
                cells={{
                  state: { value: r.state ?? "LIVE" },
                  txn: { value: r.label ?? r.id, kind: "id" },
                  participants: { value: r.devices.join(" → ") },
                  when: { value: clock(r.ts), kind: "time" },
                }}
                copies={[
                  { label: "Transaction ID", value: r.id },
                  { label: "Participants", value: r.devices.join(", ") },
                ]}
                row={r}
              >
                <div
                  role="button"
                  tabIndex={0}
                  className="monitor-row txn-hist"
                  data-selected={r.id === selected || undefined}
                  aria-pressed={r.id === selected}
                  onClick={() => setPicked(r.id)}
                  onKeyDown={onRowKey(() => setPicked(r.id))}
                >
                  <span data-col="state" className="trunc">
                    {r.state ? (
                      <StatusBadge
                        tone={STATE_TONE[r.state]}
                        dot={false}
                        quiet={r.state === "ABORTED"}
                      >
                        {r.state}
                      </StatusBadge>
                    ) : (
                      <StatusBadge tone="warn">LIVE</StatusBadge>
                    )}
                  </span>
                  <span data-col="txn" className="trunc">
                    <span className="mono p">{r.label ?? r.id}</span>
                  </span>
                  <span data-col="participants" className="trunc">
                    <span className="mono text-fg-secondary">{r.devices.join(" → ")}</span>
                  </span>
                  <span data-col="when" className="trunc" title={clock(r.ts)}>
                    <span className="mono text-muted-foreground">{ago(r.ts)}</span>
                  </span>
                  <RowMore />
                </div>
              </RowMenu>
            ))}
          </>
        )}
      </MonitorPanel>
    </section>
  );
}
