/**
 * Dashboard sub-router for the Policies page.
 *
 * Uses the same loader, evaluator and report renderer the tools use, so a score
 * on the page and a score from `run_policy_check` cannot disagree.
 *
 *   GET  /api/policies           loaded rule files + rules (the rule browser)
 *   GET  /api/policies/results   stored results per device (+ the trend series)
 *   POST /api/policies/run       evaluate one device or the whole fleet
 *   POST /api/policies/validate  schema-check pasted rule text
 *
 * Results are persisted so the compliance score has a trend line: a score with
 * no history says "we are at 82%", a score with history says "we were at 96%
 * last week", which is the number that actually gets acted on.
 */
import { createContext } from "../core/context";
import { executeMikrotikCommand } from "../core/connector";
import { looksLikeError } from "../core/routeros";
import { getConfig } from "../core/runtime";
import { evaluatePolicies } from "../policy/evaluate";
import { parseExport } from "../policy/parse";
import { renderReport } from "../policy/report";
import { validatePolicyText } from "../policy/schema";
import { rememberReport } from "../policy/session";
import { policyResults, recordPolicyResult } from "../policy/results";
import { currentPolicySet } from "../tools/policy";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function bodyJson<T>(req: Request): Promise<T> {
  return (await req.json().catch(() => ({}))) as T;
}

export async function policyRoutes(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/api/policies")) return null;

  if (p === "/api/policies" && req.method === "GET") {
    const set = currentPolicySet();
    return json({
      files: set.files.map((f) => ({
        path: f.path,
        name: f.name,
        ok: f.ok,
        issues: f.issues,
        // The rule browser doubles as the documentation surface, so it carries
        // the whole rule, not a summary of it.
        policies: f.policies,
      })),
      ruleCount: set.policies.length,
      duplicateIds: set.duplicateIds,
      emptyPatterns: set.emptyPatterns,
      paths: getConfig().policy.paths,
    });
  }

  if (p === "/api/policies/results" && req.method === "GET") {
    const device = url.searchParams.get("device") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? 50);
    let results;
    try {
      results = await policyResults(device, limit);
    } catch (e) {
      return json({ results: [], error: e instanceof Error ? e.message : String(e) });
    }
    return json({ results });
  }

  if (p === "/api/policies/validate" && req.method === "POST") {
    const body = await bodyJson<{ content?: string }>(req);
    if (typeof body.content !== "string") return json({ error: "content is required" }, 400);
    return json(validatePolicyText(body.content));
  }

  if (p === "/api/policies/run" && req.method === "POST") {
    const body = await bodyJson<{ devices?: string[]; format?: string }>(req);
    const set = currentPolicySet();
    if (set.policies.length === 0) {
      return json({ error: "no policy rules are loaded", reports: [] });
    }

    const cfg = getConfig();
    const devices =
      body.devices && body.devices.length > 0
        ? body.devices
        : Object.entries(cfg.devices)
            .filter(([, d]) => !d.disabled)
            .map(([name]) => name);

    const reports = [];
    for (const device of devices) {
      const ctx = createContext(undefined, device);
      try {
        const text = await executeMikrotikCommand("/export terse", ctx);
        if (looksLikeError(text) || text.trim() === "") {
          reports.push({ device, error: text.trim() || "empty export" });
          continue;
        }
        const report = evaluatePolicies(set.policies, parseExport(text), {
          device,
          ts: Date.now(),
        });
        rememberReport(report);
        await recordPolicyResult(report);
        reports.push({
          device,
          summary: report.summary,
          findings: report.findings,
          markdown: renderReport(report, "markdown"),
        });
      } catch (e) {
        // One unreachable router must not abort a fleet sweep.
        reports.push({ device, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return json({ reports });
  }

  return json({ error: "not found" }, 404);
}
