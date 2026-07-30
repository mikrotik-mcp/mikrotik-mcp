/**
 * Dashboard sub-router for Alerting.
 *
 * Serves the rule list with live state, the history, channel status and the
 * rule-preview endpoint. Mirrors `drift-routes.ts`.
 *
 * **Nothing here ever returns a webhook URL.** Channels are reported through
 * `redactChannels`, which keeps scheme and host and drops the path — the path is
 * the credential.
 */
import { getAlertEngine } from "../alerts/engine";
import { deliver, redactChannels } from "../alerts/channels";
import {
  ruleWarnings,
  AlertRuleSchema,
  isMuted,
  parseDuration,
  step,
  initialState,
  eventMet,
  isEventTrigger,
} from "../alerts/model";
import type { AlertEvent, AlertRule } from "../alerts/model";
import { getConfig } from "../core/runtime";
import { clientError, logError } from "./http-error";
import { logger } from "../logger";
import type { EventStore } from "./store";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** A rule plus its live state, in the shape the UI consumes. */
function ruleRow(
  rule: AlertRule,
  subject: string,
  status: string,
  since: number,
): Record<string, unknown> {
  return {
    id: rule.id,
    /** Which device this row is about; `*` for fleet-wide rules. */
    subject,
    description: rule.description,
    when: rule.when,
    severity: rule.severity,
    channels: rule.channels,
    for: rule.for,
    cooldown: rule.cooldown,
    enabled: rule.enabled,
    mutedUntil: rule.mutedUntil,
    status,
    since,
    /** Non-fatal authoring problems — chiefly "this rule can never resolve". */
    warnings: ruleWarnings(rule),
  };
}

/**
 * "This rule would have fired N times over the stored events."
 *
 * The single most useful thing the editor can tell someone: a rule that would
 * have fired 400 times yesterday is a rule nobody will read tomorrow. Replays
 * the real state machine over real history, so `for`/`cooldown`/flap absorption
 * are all accounted for rather than counting raw matches.
 */
export function previewRule(
  rule: AlertRule,
  events: { ts: number; tool: string; device?: string; risk: string; isError: boolean }[],
): { fires: number; resolves: number; matched: number } {
  if (!isEventTrigger(rule.when)) return { fires: 0, resolves: 0, matched: 0 };
  let state = initialState(events[0]?.ts ?? 0);
  let fires = 0;
  let resolves = 0;
  let matched = 0;

  // Oldest first — the machine is a timeline, not a set.
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    const ev: AlertEvent = {
      kind: "tool_call",
      tool: e.tool,
      device: e.device,
      risk: e.risk,
      isError: e.isError,
    };
    const met = eventMet(rule.when, ev);
    if (met) matched++;
    const res = step(rule, state, met, e.ts);
    state = res.state;
    if (res.action.type === "fire") fires++;
    if (res.action.type === "resolve") resolves++;
  }
  return { fires, resolves, matched };
}

export async function alertRoutes(
  req: Request,
  url: URL,
  db: EventStore | null,
): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/api/alerts")) return null;

  const engine = getAlertEngine();
  const channels = getConfig().alerts?.channels;

  // ── Everything at once: what the page loads first ──────────────────────
  if (p === "/api/alerts" && req.method === "GET") {
    if (!engine) {
      return json({ configured: false, rules: [], active: [], channels: {} });
    }
    const now = Date.now();
    const rows = engine
      .snapshot()
      .map(({ rule, subject, state }) =>
        ruleRow(
          rule,
          subject,
          isMuted(rule, now) ? "muted" : !rule.enabled ? "disabled" : state.status,
          state.since,
        ),
      );
    return json({
      configured: true,
      rules: rows,
      active: rows.filter((r) => r.status === "firing"),
      channels: redactChannels(channels),
    });
  }

  if (p === "/api/alerts/history" && req.method === "GET") {
    if (!engine) return json({ history: [] });
    const hours = Number(url.searchParams.get("hours") ?? 24);
    const history = await engine.history({
      sinceMs: Date.now() - hours * 3_600_000,
      ruleId: url.searchParams.get("rule") ?? undefined,
      limit: Number(url.searchParams.get("limit") ?? 200),
    });
    return json({ history });
  }

  // ── Rule CRUD ───────────────────────────────────────────────────────────
  if (p === "/api/alerts/rules" && req.method === "POST") {
    if (!engine) return json({ error: "alerting is not configured" }, 400);
    const parsed = AlertRuleSchema.safeParse(await req.json());
    if (!parsed.success) {
      return json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
    }
    const rules = engine.configuredRules();
    if (rules.some((r) => r.id === parsed.data.id)) {
      return json({ error: `rule '${parsed.data.id}' already exists` }, 409);
    }
    engine.setRules([...rules, parsed.data]);
    return json({ ok: true, id: parsed.data.id });
  }

  const idMatch = p.match(/^\/api\/alerts\/rules\/([^/]+)$/);
  if (idMatch) {
    if (!engine) return json({ error: "alerting is not configured" }, 400);
    const id = decodeURIComponent(idMatch[1]);
    const rules = engine.configuredRules();
    const existing = rules.find((r) => r.id === id);
    if (!existing) return json({ error: `unknown rule: ${id}` }, 404);

    if (req.method === "DELETE") {
      engine.setRules(rules.filter((r) => r.id !== id));
      return json({ ok: true });
    }
    if (req.method === "PATCH") {
      const body = (await req.json()) as Record<string, unknown>;
      // `mute` is expressed as a duration so the client never has to compute an
      // absolute timestamp against a possibly-skewed clock.
      let mutedUntil = existing.mutedUntil;
      if (typeof body.mute === "string") {
        const ms = parseDuration(body.mute);
        if (ms === null) return json({ error: `invalid duration: ${body.mute}` }, 400);
        mutedUntil = ms === 0 ? undefined : Date.now() + ms;
        delete body.mute;
      }
      const merged = AlertRuleSchema.safeParse({ ...existing, ...body, mutedUntil });
      if (!merged.success) {
        return json({ error: merged.error.issues.map((i) => i.message).join("; ") }, 400);
      }
      engine.setRules(rules.map((r) => (r.id === id ? merged.data : r)));
      return json({ ok: true, rule: merged.data });
    }
  }

  // ── Channel test ────────────────────────────────────────────────────────
  if (p === "/api/alerts/test" && req.method === "POST") {
    const body = (await req.json()) as { channel?: string };
    if (!channels || !body?.channel) return json({ error: "channel is required" }, 400);
    try {
      const result = await deliver(body.channel as Parameters<typeof deliver>[0], channels, {
        ruleId: "test",
        severity: "low",
        kind: "fire",
        title: "Test notification from mikrotik-mcp",
        body: "If you can read this, this channel is configured correctly.",
        at: Date.now(),
      });
      return json(result);
    } catch (e) {
      logger.error(`Alert channel test failed: ${logError(e)}`);
      return json({ error: clientError(e) }, 502);
    }
  }

  // ── Rule preview: "would have fired N times" ────────────────────────────
  if (p === "/api/alerts/preview" && req.method === "POST") {
    const parsed = AlertRuleSchema.safeParse(await req.json());
    if (!parsed.success) {
      return json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
    }
    const hours = Number(url.searchParams.get("hours") ?? 24);
    // No event store means no history to replay. Say so rather than reporting a
    // confident "would have fired 0 times", which reads as "this rule is quiet".
    if (!db) {
      return json({ hours, sampled: 0, fires: 0, resolves: 0, matched: 0, noHistory: true });
    }
    const events = db.query({ since: Date.now() - hours * 3_600_000, limit: 5000 }).map((e) => ({
      ts: e.ts,
      tool: e.tool,
      device: e.device,
      risk: e.risk,
      isError: e.isError,
    }));
    return json({ hours, sampled: events.length, ...previewRule(parsed.data, events) });
  }

  return null;
}
