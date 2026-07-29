/**
 * Dashboard sub-router for cross-device transactions.
 *
 * Reads the transaction log (shared `snapshots.db` — no new database file) and
 * exposes the live ones from the in-process registry, so the Transactions page
 * can show a run that is still in flight next to the history.
 *
 *   GET  /api/txn            transactions, newest first (live ones merged in)
 *   GET  /api/txn/:id        one transaction + its event timeline
 *   POST /api/txn/:id/abort  roll a live transaction back
 */
import { createContext } from "../core/context";
import { runTransaction, createDeviceExecutor } from "../txn/coordinator";
import { requestAbort } from "../txn/model";
import { dropTxn, getTxn, listTxns, persistTxn, txnStore } from "../txn/session";
import { toRecord } from "../txn/store";
import type { TxnRecord } from "../txn/store";
import { liveTxnUpdates } from "./txn-hub";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** A live transaction rendered in the same shape as a stored one. */
function liveRecord(id: string): TxnRecord | null {
  const entry = getTxn(id);
  return entry ? { ...toRecord(entry.txn, entry.ts, entry.label), updated: Date.now() } : null;
}

export async function txnRoutes(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/api/txn")) return null;

  // The log is best-effort everywhere else, so a store that cannot open must
  // not 500 the page — live transactions are still worth showing.
  let storeError: string | undefined;
  const store = await txnStore().catch((e: unknown) => {
    storeError = e instanceof Error ? e.message : String(e);
    return null;
  });

  if (p === "/api/txn" && req.method === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const stored = store?.list(limit) ?? [];
    // A live transaction is authoritative over its persisted row.
    const live = listTxns().map((e) => ({
      ...toRecord(e.txn, e.ts, e.label),
      updated: Date.now(),
    }));
    const byId = new Map(stored.map((r) => [r.id, r]));
    for (const r of live) byId.set(r.id, r);
    const transactions = [...byId.values()].sort((a, b) => b.ts - a.ts).slice(0, limit);
    return json({ transactions, live: liveTxnUpdates(), error: storeError });
  }

  // `/api/txn/<id>` and `/api/txn/<id>/abort`
  const parts = p.slice("/api/txn/".length).split("/").filter(Boolean);
  if (parts.length === 0 || parts.length > 2) return json({ error: "not found" }, 404);
  const id = decodeURIComponent(parts[0]);

  if (parts[1] === "abort" && req.method === "POST") {
    const entry = getTxn(id);
    if (!entry) return json({ error: `no open transaction '${id}'` }, 404);

    entry.txn = requestAbort(entry.txn, "aborted from the dashboard");
    const run = await runTransaction({
      txn: entry.txn,
      steps: entry.steps,
      executor: createDeviceExecutor(createContext(), entry.txn.id),
    });
    entry.txn = run.txn;
    await persistTxn(entry);
    if (run.state !== undefined) dropTxn(id);
    return json({
      state: run.state,
      summary: run.summary,
      transaction: toRecord(run.txn, entry.ts),
    });
  }

  if (parts.length === 1 && req.method === "GET") {
    const record = liveRecord(id) ?? store?.get(id) ?? null;
    if (!record) return json({ error: `unknown transaction '${id}'` }, 404);
    return json({ transaction: record, events: store?.events(id) ?? [] });
  }

  return json({ error: "method not allowed" }, 405);
}
