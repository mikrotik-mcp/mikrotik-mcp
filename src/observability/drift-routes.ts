/**
 * Dashboard sub-router for Config Drift Guardian.
 *
 * Serves the REST API for fleet drift status, per-device drift checks,
 * and baseline management. Shares `snapshots.db` with the snapshot tools
 * and the `featureRoutes` snapshot endpoints — no new database file.
 */
import { executeMikrotikCommand } from "../core/connector";
import { createContext } from "../core/context";
import { diffLines } from "../core/diff";
import { Cmd, isEmpty, looksLikeError } from "../core/routeros";
import { getConfig, resolveDeviceName } from "../core/runtime";
import { DEFAULT_SNAPSHOT_DB } from "../config";
import { noteDriftResult } from "../drift/alert";
import { analyzeDrift, attributeChanges } from "../drift/engine";
import { clientError } from "./http-error";
import { normalizeExport } from "../snapshots/format";
import { openSnapshotStore } from "../snapshots/store";
import type { SnapshotStore } from "../snapshots/store";

// ── Lazy store singleton (same DB as snapshot tools) ────────────────────────

let storePromise: Promise<SnapshotStore> | null = null;
function getStore(): Promise<SnapshotStore> {
  if (!storePromise) storePromise = openSnapshotStore(DEFAULT_SNAPSHOT_DB);
  return storePromise;
}

// ── JSON helpers ────────────────────────────────────────────────────────────

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
async function bodyJson<T>(req: Request): Promise<T> {
  return (await req.json()) as T;
}

// ── Sub-router ──────────────────────────────────────────────────────────────

export async function driftRoutes(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/api/drift")) return null;

  const store = await getStore();

  // ── Fleet drift status (metadata-only, no device I/O) ──────────────────
  if (p === "/api/drift/status" && req.method === "GET") {
    const cfg = getConfig();
    const deviceNames = Object.keys(cfg.devices);
    const devices = deviceNames.map((name) => {
      const baseline = store.getBaseline(name);
      if (!baseline) {
        return { device: name, status: "no-baseline" as const, baseline: null };
      }
      const baselineSnap = store.get(baseline.snapshotId);
      if (!baselineSnap) {
        return {
          device: name,
          status: "unknown" as const,
          baseline,
          error: "baseline snapshot deleted",
        };
      }
      const latest = store.latest(name);
      // Compare the latest snapshot's SHA against the baseline's SHA
      // If the latest IS the baseline, or shares the same SHA, it's in sync
      if (!latest || latest.id === baselineSnap.id) {
        return { device: name, status: "in-sync" as const, baseline };
      }
      const identical = latest.sha === baselineSnap.sha;
      return {
        device: name,
        status: identical ? ("in-sync" as const) : ("drifted" as const),
        baseline,
        latestSnapshotId: latest.id,
        latestSnapshotTs: latest.ts,
      };
    });
    return json({ devices });
  }

  // ── List all baselines ─────────────────────────────────────────────────
  if (p === "/api/drift/baselines" && req.method === "GET") {
    const baselines = store.listBaselines();
    // Enrich with snapshot metadata
    const enriched = baselines.map((b) => {
      const snap = store.get(b.snapshotId);
      return {
        ...b,
        snapshot: snap
          ? { lines: snap.lines, bytes: snap.bytes, sha: snap.sha, rosVersion: snap.rosVersion }
          : null,
      };
    });
    return json({ baselines: enriched });
  }

  // ── Get baseline for a device ──────────────────────────────────────────
  const baselineMatch = p.match(/^\/api\/drift\/baseline\/(.+)$/);
  if (baselineMatch && req.method === "GET") {
    const device = decodeURIComponent(baselineMatch[1] as string);
    const baseline = store.getBaseline(device);
    if (!baseline) return json({ error: "no baseline set" }, 404);
    const snap = store.get(baseline.snapshotId);
    return json({
      ...baseline,
      snapshot: snap
        ? { lines: snap.lines, bytes: snap.bytes, sha: snap.sha, rosVersion: snap.rosVersion }
        : null,
    });
  }

  // ── Set baseline from existing snapshot ─────────────────────────────────
  if (p === "/api/drift/baseline" && req.method === "POST") {
    const b = await bodyJson<{
      device?: string;
      snapshotId?: string;
      label?: string;
      notes?: string;
    }>(req);
    if (!b.device || !b.snapshotId) {
      return json({ error: "device and snapshotId are required" }, 400);
    }
    const snap = store.get(b.snapshotId);
    if (!snap) return json({ error: `snapshot '${b.snapshotId}' not found` }, 404);
    store.setBaseline(b.device, b.snapshotId, "dashboard", b.label, b.notes);
    return json({ ok: true, device: b.device, snapshotId: b.snapshotId });
  }

  // ── Remove baseline ────────────────────────────────────────────────────
  if (baselineMatch && req.method === "DELETE") {
    const device = decodeURIComponent(baselineMatch[1] as string);
    const removed = store.removeBaseline(device);
    return json({ ok: removed, device });
  }

  // ── Recent snapshots for a device ──────────────────────────────────────
  const historyMatch = p.match(/^\/api\/drift\/history\/(.+)$/);
  if (historyMatch && req.method === "GET") {
    const device = decodeURIComponent(historyMatch[1] as string);
    const limit = Number(url.searchParams.get("limit") ?? "20");
    const snapshots = store.list(device, limit, false);
    return json({ device, snapshots });
  }

  // ── Live drift check (runs /export on the device) ──────────────────────
  const checkMatch = p.match(/^\/api\/drift\/check\/(.+)$/);
  if (checkMatch && req.method === "GET") {
    const deviceKey = decodeURIComponent(checkMatch[1] as string);
    let device: string;
    try {
      device = resolveDeviceName(deviceKey);
    } catch {
      return json({ error: `unknown device '${deviceKey}'` }, 404);
    }

    const baseline = store.getBaseline(device);
    if (!baseline) return json({ error: "no baseline set" }, 404);
    const baselineSnap = store.get(baseline.snapshotId);
    if (!baselineSnap) return json({ error: "baseline snapshot deleted" }, 404);

    try {
      const ctx = createContext(undefined, device);
      const exportCmd = new Cmd("/export").raw("terse").build();
      const liveBody = await executeMikrotikCommand(exportCmd, ctx);
      if (isEmpty(liveBody) || looksLikeError(liveBody)) {
        return json({ error: `export failed: ${liveBody.trim() || "(empty)"}` }, 502);
      }

      const diff = diffLines(normalizeExport(baselineSnap.body), normalizeExport(liveBody), {
        contextLines: 3,
        fromLabel: `baseline:${baselineSnap.id}`,
        toLabel: `${device}@live`,
      });

      const report = analyzeDrift(diff, device, baseline.snapshotId, baseline.setAt);

      // Feed alerting. Transition-only, so re-running a check while
      // investigating does not emit a fresh alert each time.
      noteDriftResult(report);

      // Best-effort log attribution
      try {
        const logCmd = `/log print where topics~"system" and time > ([:timestamp] - 7d)`;
        const logText = await executeMikrotikCommand(logCmd, ctx);
        if (!isEmpty(logText) && !looksLikeError(logText)) {
          report.attributions = attributeChanges(report.sections, logText);
        }
      } catch {
        // log fetch is best-effort
      }

      return json(report);
    } catch (e) {
      return json({ error: clientError(e) }, 502);
    }
  }

  return null;
}
