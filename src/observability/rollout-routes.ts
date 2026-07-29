/**
 * Dashboard sub-router for staged fleet rollouts.
 *
 * Reads the rollout history from `snapshots.db` and merges in whatever is
 * currently in flight, so the wave board shows a live run next to the past ones.
 *
 *   GET  /api/rollout             rollouts, newest first (live merged in)
 *   GET  /api/rollout/:id         one rollout + its event timeline
 *   POST /api/rollout/:id/hold    freeze at the next decision point
 *   POST /api/rollout/:id/resume  release the hold and continue
 *   POST /api/rollout/:id/abort   halt now and revert what was applied
 *
 * Hold/resume/abort are the buttons that make this trustworthy rather than a
 * demo: a human watching a fleet change must be able to stop it without finding
 * a terminal.
 */
import { createContext } from "../core/context";
import { requestAbort, requestHold, resume, summarize } from "../rollout/model";
import { createDeviceExecutor, runRollout } from "../rollout/runner";
import {
  dropRollout,
  getRollout,
  listRollouts,
  persistRollout,
  rolloutStore,
} from "../rollout/session";
import { toRecord } from "../rollout/store";
import type { RolloutRecord } from "../rollout/store";
import { liveRolloutUpdates, publishRollout } from "./rollout-hub";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** A live rollout rendered in the same shape as a stored one. */
function liveRecord(id: string): RolloutRecord | null {
  const entry = getRollout(id);
  return entry
    ? {
        ...toRecord(entry.state, entry.ts, { label: entry.label, commands: entry.commands }),
        updated: Date.now(),
      }
    : null;
}

export async function rolloutRoutes(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/api/rollout")) return null;

  let storeError: string | undefined;
  const store = await rolloutStore().catch((e: unknown) => {
    storeError = e instanceof Error ? e.message : String(e);
    return null;
  });

  if (p === "/api/rollout" && req.method === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const stored = store?.list(limit) ?? [];
    const live = listRollouts().map((e) => ({
      ...toRecord(e.state, e.ts, { label: e.label, commands: e.commands }),
      updated: Date.now(),
    }));
    // A live rollout is authoritative over its persisted row.
    const byId = new Map(stored.map((r) => [r.id, r]));
    for (const r of live) byId.set(r.id, r);
    const rollouts = [...byId.values()].sort((a, b) => b.ts - a.ts).slice(0, limit);
    return json({ rollouts, live: liveRolloutUpdates(), error: storeError });
  }

  const parts = p.slice("/api/rollout/".length).split("/").filter(Boolean);
  if (parts.length === 0 || parts.length > 2) return json({ error: "not found" }, 404);
  const id = decodeURIComponent(parts[0]);
  const verb = parts[1];

  if (verb && req.method === "POST") {
    const entry = getRollout(id);
    if (!entry) return json({ error: `no active rollout '${id}'` }, 404);

    switch (verb) {
      case "hold": {
        entry.state = requestHold(entry.state);
        await persistRollout(entry);
        publishRollout({
          rolloutId: id,
          ts: Date.now(),
          phase: entry.state.phase,
          currentWave: entry.state.currentWave,
          action: "hold",
          ok: true,
          devices: entry.state.devices,
          gates: entry.state.gates,
        });
        return json({ held: true, summary: summarize(entry.state) });
      }

      case "resume": {
        entry.state = resume(entry.state);
        // Resuming continues the run in this request; the socket keeps the page
        // updated while it does.
        const run = await runRollout({
          state: entry.state,
          commands: entry.commands,
          executor: createDeviceExecutor(createContext(), id),
          onEvent: ({ action, state }) => {
            entry.state = state;
            publishRollout({
              rolloutId: id,
              ts: Date.now(),
              phase: state.phase,
              currentWave: state.currentWave,
              action: action.kind,
              device: "device" in action ? action.device : undefined,
              ok: true,
              outcome: state.outcome,
              devices: state.devices,
              gates: state.gates,
            });
          },
        });
        entry.state = run.state;
        await persistRollout(entry);
        if (run.outcome) dropRollout(id);
        return json({ outcome: run.outcome, summary: run.summary });
      }

      case "abort": {
        entry.state = requestAbort(entry.state, "aborted from the dashboard");
        const run = await runRollout({
          state: entry.state,
          commands: entry.commands,
          executor: createDeviceExecutor(createContext(), id),
        });
        entry.state = run.state;
        await persistRollout(entry);
        if (run.outcome) dropRollout(id);
        return json({ outcome: run.outcome, summary: run.summary });
      }

      default:
        return json({ error: `unknown action '${verb}'` }, 404);
    }
  }

  if (parts.length === 1 && req.method === "GET") {
    const record = liveRecord(id) ?? store?.get(id) ?? null;
    if (!record) return json({ error: `unknown rollout '${id}'` }, 404);
    return json({ rollout: record, events: store?.events(id) ?? [] });
  }

  return json({ error: "method not allowed" }, 405);
}
