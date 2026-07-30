/**
 * Dashboard sub-router for attack detection.
 *
 *   GET    /api/attacks                     incidents, newest first
 *   GET    /api/attacks/sources             attacker addresses with their history
 *   GET    /api/attacks/config              policy + the never-block set
 *   POST   /api/attacks/config              change the policy
 *   GET    /api/attacks/:id                 one incident with its evidence
 *   POST   /api/attacks/:id/respond         block / escalate / dismiss
 *   DELETE /api/attacks/responses/:address  unblock
 *
 * The respond route is the only one that can change a device, and it goes
 * through the same `decide()` guards the tool does — the dashboard must not be
 * a way around a refusal.
 */
import { getConfig } from "../core/runtime";
import { logger } from "../logger";
import { executePlan, revokeBlock } from "../attack/execute";
import { decide, isNeverBlock, isPlan, neverBlockSet } from "../attack/respond";
import { buildGuards, policyFromConfig, sweep } from "../attack/session";
import { attackStore } from "../attack/store";
import { getDeviceGeo } from "./geo";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export async function attackRoutes(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/api/attacks")) return null;

  let store;
  try {
    store = await attackStore();
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e), incidents: [] }, 503);
  }

  const cfg = getConfig().attacks;
  const now = Date.now();

  if (p === "/api/attacks" && req.method === "GET") {
    const hours = Number(url.searchParams.get("hours") ?? 24);
    const incidents = store.listIncidents({
      since: now - hours * 3_600_000,
      limit: Number(url.searchParams.get("limit") ?? 200),
    });
    const responses = store.listResponses({ active: true, limit: 500 });
    const blocked = new Set(responses.map((r) => r.source));
    return json({
      incidents: incidents.map((i) => ({ ...i, blocked: blocked.has(i.source) })),
      responses,
      // The banner the page shows so nobody believes they are protected when
      // they are only being watched.
      posture: {
        enabled: cfg.enabled,
        mode: cfg.mode,
        autoRespondTo: cfg.autoRespondTo,
        minConfidence: cfg.minConfidence,
      },
    });
  }

  if (p === "/api/attacks/sources" && req.method === "GET") {
    const hours = Number(url.searchParams.get("hours") ?? 168);
    const incidents = store.listIncidents({ since: now - hours * 3_600_000, limit: 1000 });
    const bySource = new Map<
      string,
      {
        source: string;
        devices: Set<string>;
        firstTs: number;
        lastTs: number;
        incidents: number;
        worst: string;
        detectors: Set<string>;
      }
    >();
    for (const i of incidents) {
      if (i.source === "") continue;
      const seen = bySource.get(i.source);
      if (seen) {
        for (const d of i.devices) seen.devices.add(d);
        for (const d of i.detectors) seen.detectors.add(d);
        seen.firstTs = Math.min(seen.firstTs, i.firstTs);
        seen.lastTs = Math.max(seen.lastTs, i.lastTs);
        seen.incidents++;
      } else {
        bySource.set(i.source, {
          source: i.source,
          devices: new Set(i.devices),
          detectors: new Set(i.detectors),
          firstTs: i.firstTs,
          lastTs: i.lastTs,
          incidents: 1,
          worst: i.severity,
        });
      }
    }
    const active = new Set(store.listResponses({ active: true, limit: 500 }).map((r) => r.source));
    return json({
      sources: [...bySource.values()]
        .map((s) => ({
          source: s.source,
          devices: [...s.devices].sort(),
          detectors: [...s.detectors].sort(),
          firstTs: s.firstTs,
          lastTs: s.lastTs,
          incidents: s.incidents,
          worst: s.worst,
          blocked: active.has(s.source),
          // Country comes from the existing device geo cache when the source
          // happens to be a device we know; otherwise the UI shows none rather
          // than sending an attacker's address to a third-party geo provider.
          geo: getDeviceGeo(s.source),
        }))
        .sort((a, b) => b.incidents - a.incidents || b.lastTs - a.lastTs),
    });
  }

  if (p === "/api/attacks/config" && req.method === "GET") {
    const guards = buildGuards();
    const never = [...neverBlockSet(guards)].sort();
    const check = url.searchParams.get("check");
    return json({
      config: cfg,
      neverBlock: never,
      check: check ? { address: check, protected: isNeverBlock(check, new Set(never)) } : undefined,
    });
  }

  if (p === "/api/attacks/config" && req.method === "POST") {
    // The policy lives in the config file so it survives a restart; this route
    // hands the edit to the existing config admin rather than keeping a second,
    // divergent copy in memory.
    return json(
      {
        error:
          "edit the `attacks` block in Config — the policy has to survive a restart, so it is not held in memory here",
      },
      501,
    );
  }

  if (p === "/api/attacks/scan" && req.method === "POST") {
    logger.info("attack sweep requested from the dashboard");
    const result = await sweep({ respond: false });
    return json({
      incidents: result.incidents,
      unavailable: result.unavailable,
      devices: result.devices,
    });
  }

  const rest = p.slice("/api/attacks/".length).split("/").filter(Boolean);

  if (rest[0] === "responses" && rest[1] && req.method === "DELETE") {
    const address = decodeURIComponent(rest[1]);
    const response = store.responseFor(address);
    const devices = response?.devices ?? [];
    if (devices.length === 0) return json({ error: `no recorded block for ${address}` }, 404);
    const results = await revokeBlock(address, devices, response?.list);
    store.revokeResponse(address, now);
    return json({ address, results });
  }

  if (rest.length === 1 && req.method === "GET") {
    const incident = store.getIncident(decodeURIComponent(rest[0]));
    if (!incident) return json({ error: "not found" }, 404);
    return json({ incident, response: store.responseFor(incident.source) });
  }

  if (rest.length === 2 && rest[1] === "respond" && req.method === "POST") {
    const incident = store.getIncident(decodeURIComponent(rest[0]));
    if (!incident) return json({ error: "not found" }, 404);
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      timeout?: string;
      confirm?: boolean;
    };

    if (body.action === "dismiss") {
      // Dismissal is a UI concern: the incident stays, so the history is intact,
      // but the operator has said they looked at it.
      return json({ dismissed: incident.id });
    }

    const decision = decide({
      incident,
      policy: policyFromConfig(),
      guards: buildGuards(),
      recentBlockCount: store.countRecentBlocks(incident.devices, now - 3_600_000),
      manual: true,
      confirm: body.confirm ?? false,
      timeout: body.timeout,
    });

    if (!isPlan(decision)) {
      return json(
        { refused: true, guard: (decision as { guard: boolean }).guard, reason: decision.reason },
        200,
      );
    }
    if (decision.action === "escalate") {
      return json({ escalated: true, reason: decision.reason });
    }
    if (!body.confirm) {
      return json({ dryRun: true, plan: decision });
    }

    const applied = await executePlan(decision);
    const ok = applied.some((r) => r.ok);
    store.recordResponse({
      incidentId: incident.id,
      action: decision.action,
      source: decision.source,
      devices: decision.devices,
      timeout: decision.timeout,
      list: decision.list,
      reason: decision.reason,
      ts: now,
      ok,
      error: ok ? undefined : applied.map((r) => r.detail).join("; "),
    });
    return json({ applied, ok, plan: decision });
  }

  return json({ error: "not found" }, 404);
}
