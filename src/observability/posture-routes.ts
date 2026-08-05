/**
 * Dashboard sub-router for the three posture views.
 *
 * They share a file because they share a shape — each is one read-only GET that
 * runs a pure analyzer over freshly-collected facts and returns its result
 * verbatim, so there is no per-feature state to justify separate modules:
 *
 *   GET /api/fabric?device=      port-level L2 map (which host on which port)
 *   GET /api/advisories[?all=1]  CVE matches ranked by real exposure
 *   GET /api/access              active caller scope + recent denials
 *
 * All three delegate to `src/core/*` so the dashboard and the MCP tools return
 * the same answers from the same code — a divergence here would be a bug the
 * tool tests could never catch.
 */
import { ADVISORIES, ADVISORY_DATASET_DATE, matchAdvisories } from "../core/advisories";
import { getAccessPolicy, recentDenials } from "../core/access";
import { createContext } from "../core/context";
import { buildFabricMap } from "../core/l2-fabric";
import { listDevices } from "../core/runtime";
import { collectFabric } from "../tools/l2-fabric";
import { collectDeviceFacts } from "../tools/advisories";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export async function postureRoutes(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (req.method !== "GET") return null;

  // ── Port-level L2 fabric ────────────────────────────────────────────────
  if (p === "/api/fabric") {
    const device = url.searchParams.get("device") ?? undefined;
    const ctx = createContext(undefined, device);
    try {
      const map = buildFabricMap(await collectFabric(device, ctx));
      return json(map);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  }

  // ── Known-vulnerability audit ───────────────────────────────────────────
  if (p === "/api/advisories") {
    const all = url.searchParams.get("all") === "1";
    const device = url.searchParams.get("device") ?? undefined;
    const targets: (string | undefined)[] = all ? listDevices().names : [device];
    try {
      const facts = await Promise.all(targets.map((d) => collectDeviceFacts(d)));
      const report = matchAdvisories(facts);
      return json({
        ...report,
        datasetDate: ADVISORY_DATASET_DATE,
        datasetSize: ADVISORIES.length,
        // The per-device inventory the header renders — versions and how many
        // services are actually enabled, so a clean result is interpretable.
        devices: facts.map((f) => ({
          device: f.device,
          version: f.version,
          board: f.board,
          enabledServices: f.services.filter((s) => !s.disabled).length,
          unrestrictedServices: f.services.filter((s) => !s.disabled && s.allowedFrom.length === 0)
            .length,
        })),
      });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  }

  // ── Active access scope (no device I/O) ─────────────────────────────────
  if (p === "/api/access") {
    const policy = getAccessPolicy();
    return json({
      enabled: policy.enabled,
      scope: policy.scope,
      denials: recentDenials(50),
    });
  }

  return null;
}
