/**
 * Alerting — rules that watch this server and reach out when something changes.
 *
 * Every tool here is **server-side**: no RouterOS device is contacted, so they
 * all set `noDevice`. Rules live in the `alerts` config block and are evaluated
 * by `src/alerts/engine.ts` against tool calls, device health and drift.
 *
 * Webhook URLs are credentials and are never returned by any tool here — the
 * channel list reports scheme, host and configured-or-not, nothing more.
 */
import { z } from "zod";
import { DESTRUCTIVE, READ, WRITE, WRITE_IDEMPOTENT, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { ANY_SUBJECT, getAlertEngine } from "../alerts/engine";
import {
  AlertRuleSchema,
  CHANNELS,
  isMuted,
  parseDuration,
  ruleWarnings,
  SEVERITIES,
} from "../alerts/model";
import type { AlertRule } from "../alerts/model";
import { deliver, redactChannels } from "../alerts/channels";
import { getConfig } from "../core/runtime";

const NO_ENGINE =
  "Alerting is not configured. Add an `alerts` block to your config file with at least one " +
  "channel, then reload — see docs/alerting.md.";

/** Rules as configured, with the engine's live state folded in. */
function renderRules(): string {
  const engine = getAlertEngine();
  if (!engine) return NO_ENGINE;
  const rows = engine.snapshot();
  if (rows.length === 0) return "No alert rules configured.";

  const now = Date.now();
  const lines = rows.map(({ rule, subject, state }) => {
    const status = isMuted(rule, now)
      ? `muted until ${new Date(rule.mutedUntil ?? 0).toISOString()}`
      : !rule.enabled
        ? "disabled"
        : state.status;
    const trigger = JSON.stringify(rule.when);
    // A rule tracking several devices shows one line per device — state is keyed
    // by (rule, subject), so "firing" always names what it is firing about.
    const on = subject === ANY_SUBJECT ? "" : `  on ${subject}`;
    // A rule that can never resolve is worth saying out loud wherever rules are
    // listed — it looks identical to a healthy one until it has been stuck red
    // for a week.
    const warnings = ruleWarnings(rule)
      .map((w) => `\n  WARNING:  ${w}`)
      .join("");
    return (
      `${rule.id}${on}  [${rule.severity}]  ${status}\n` +
      `  when:     ${trigger}\n` +
      `  channels: ${rule.channels.join(", ")}\n` +
      `  for:      ${rule.for ?? "0 (fire immediately)"}   cooldown: ${rule.cooldown}${
        rule.description ? `\n  note:     ${rule.description}` : ""
      }${warnings}`
    );
  });
  const firing = rows.filter((r) => r.state.status === "firing").length;
  return `ALERT RULES (${rows.length}, ${firing} firing)\n\n${lines.join("\n\n")}`;
}

/** Mutate the in-memory rule set. Returns an error string, or null on success. */
function withRules(fn: (rules: AlertRule[]) => AlertRule[] | string): string | null {
  const engine = getAlertEngine();
  if (!engine) return NO_ENGINE;
  const current = engine.configuredRules();
  const next = fn(current);
  if (typeof next === "string") return next;
  engine.setRules(next);
  return null;
}

export const alertTools: ToolModule = [
  defineTool({
    name: "list_alert_rules",
    title: "List Alert Rules",
    annotations: READ,
    noDevice: true,
    description:
      "Lists every configured alert rule with its trigger, severity, channels, timing (`for` /" +
      " `cooldown`) and current live state (clear / pending / firing / suppressed / muted)." +
      " Also reports the configured delivery channels — with webhook URLs masked to scheme and" +
      " host, since the URL path is itself the credential. Use this to see what is being watched" +
      " and what is firing right now. Contacts no RouterOS device.",
    inputSchema: {},
    handler(_a, ctx) {
      ctx.info("Listing alert rules");
      const channels = redactChannels(getConfig().alerts?.channels);
      const chanLine =
        Object.keys(channels).length > 0
          ? `\n\nCHANNELS\n${JSON.stringify(channels, null, 2)}`
          : "\n\nCHANNELS: none configured — no alert can be delivered.";
      return `${renderRules()}${chanLine}`;
    },
  }),

  defineTool({
    name: "get_alert_history",
    title: "Get Alert History",
    annotations: READ,
    noDevice: true,
    description:
      "Returns alerts that fired or resolved over a time window, newest first, with the" +
      " per-channel delivery outcome for each. Use this to check whether an alert actually" +
      " reached its destination, or to review what has been noisy. Contacts no RouterOS device.",
    inputSchema: {
      hours: z.coerce.number().positive().max(720).default(24).describe("Window in hours."),
      rule_id: z.string().optional().describe("Restrict to a single rule id."),
      limit: z.coerce.number().int().positive().max(1000).default(100),
    },
    async handler(a, ctx) {
      ctx.info(`Reading alert history: ${a.hours}h`);
      const engine = getAlertEngine();
      if (!engine) return NO_ENGINE;
      const history = await engine.history({
        sinceMs: Date.now() - a.hours * 3_600_000,
        ruleId: a.rule_id,
        limit: a.limit,
      });
      if (history.length === 0) return `No alerts in the last ${a.hours}h.`;
      const lines = history.map((h) => {
        const delivery = h.deliveries
          .map((d) => `${d.channel}${d.ok ? " ok" : ` FAILED (${d.error ?? d.status})`}`)
          .join(", ");
        return (
          `${new Date(h.ts).toISOString()}  ${h.kind.toUpperCase()}  ${h.ruleId} [${h.severity}]` +
          `${h.device ? ` · ${h.device}` : ""}\n  ${h.title}` +
          `${h.body ? `\n  ${h.body}` : ""}\n  delivery: ${delivery || "none"}`
        );
      });
      return `ALERT HISTORY (${history.length} in ${a.hours}h)\n\n${lines.join("\n\n")}`;
    },
  }),

  defineTool({
    name: "test_alert_channel",
    title: "Test Alert Channel",
    annotations: WRITE,
    noDevice: true,
    description:
      "Sends a test notification on one configured channel and reports the delivery outcome" +
      " (HTTP status, attempts, duration). Use this to prove a webhook is reachable and" +
      " correctly configured BEFORE relying on it for real alerts — a silently broken channel" +
      " is worse than none. Sends a real message to the destination. Contacts no RouterOS device.",
    inputSchema: {
      channel: z.enum(CHANNELS).describe("Which configured channel to test."),
    },
    async handler(a, ctx) {
      ctx.info(`Testing alert channel: ${a.channel}`);
      const channels = getConfig().alerts?.channels;
      if (!channels) return NO_ENGINE;
      const result = await deliver(a.channel, channels, {
        ruleId: "test",
        severity: "low",
        kind: "fire",
        title: "Test notification from mikrotik-mcp",
        body: "If you can read this, this channel is configured correctly.",
        at: Date.now(),
      });
      return result.ok
        ? `✅ ${a.channel}: delivered in ${result.durationMs}ms (${result.attempts} attempt${result.attempts === 1 ? "" : "s"}).`
        : `❌ ${a.channel}: ${result.error ?? `HTTP ${result.status}`} after ${result.attempts} attempt${result.attempts === 1 ? "" : "s"} (${result.durationMs}ms).`;
    },
  }),

  defineTool({
    name: "add_alert_rule",
    title: "Add Alert Rule",
    annotations: WRITE,
    noDevice: true,
    description:
      "Adds an alert rule at runtime. `trigger` is a JSON object of exactly one kind:" +
      ' a metric threshold `{"metric":"error_rate","window":"5m","above":0.15,"minCalls":20}`,' +
      ' an event `{"event":"tool_call","risk":["destructive"],"device":["core-rtr"]}`, or an' +
      ' absence `{"absence":"snapshot","within":"24h"}`. Set `for` so a condition must hold' +
      " before firing, and `cooldown` (default 15m) to bound re-fires. The rule is added to the" +
      " running engine; persist it in the config file to survive a restart.",
    inputSchema: {
      id: z.string().min(1).describe("Unique id — keys muting and history, so make it stable."),
      trigger: z.string().describe("The trigger as a JSON object (see the description)."),
      channels: z.array(z.enum(CHANNELS)).min(1).describe("Where to deliver."),
      severity: z.enum(SEVERITIES).default("medium"),
      description: z.string().optional().describe("Human-readable title used in the message."),
      for: z.string().optional().describe("Hold time before firing, e.g. '2m'."),
      cooldown: z.string().default("15m").describe("Minimum gap between fires."),
    },
    handler(a, ctx) {
      ctx.info(`Adding alert rule: ${a.id}`);
      let when: unknown;
      try {
        when = JSON.parse(a.trigger);
      } catch {
        return `\`trigger\` is not valid JSON. Received: ${a.trigger}`;
      }
      const parsed = AlertRuleSchema.safeParse({
        id: a.id,
        when,
        channels: a.channels,
        severity: a.severity,
        description: a.description,
        for: a.for,
        cooldown: a.cooldown,
      });
      if (!parsed.success) {
        return `Invalid rule: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
      }
      const err = withRules((rules) =>
        rules.some((r) => r.id === a.id)
          ? `A rule with id '${a.id}' already exists — use update_alert_rule.`
          : [...rules, parsed.data],
      );
      return err ?? `Alert rule '${a.id}' added.\n\n${renderRules()}`;
    },
  }),

  defineTool({
    name: "update_alert_rule",
    title: "Update Alert Rule",
    annotations: WRITE_IDEMPOTENT,
    noDevice: true,
    description:
      "Changes an existing alert rule in place. Only the fields you pass are modified; the rest" +
      " are left as they are. Use to retune a noisy threshold, widen the cooldown, change" +
      " channels, or enable/disable a rule without deleting it.",
    inputSchema: {
      id: z.string().min(1),
      trigger: z.string().optional().describe("Replacement trigger, as a JSON object."),
      channels: z.array(z.enum(CHANNELS)).min(1).optional(),
      severity: z.enum(SEVERITIES).optional(),
      description: z.string().optional(),
      for: z.string().optional(),
      cooldown: z.string().optional(),
      enabled: z.boolean().optional(),
    },
    handler(a, ctx) {
      ctx.info(`Updating alert rule: ${a.id}`);
      let when: unknown;
      if (a.trigger !== undefined) {
        try {
          when = JSON.parse(a.trigger);
        } catch {
          return `\`trigger\` is not valid JSON. Received: ${a.trigger}`;
        }
      }
      let failure: string | undefined;
      const err = withRules((rules) => {
        const existing = rules.find((r) => r.id === a.id);
        if (!existing) return `No alert rule with id '${a.id}'.`;
        const merged = AlertRuleSchema.safeParse({
          ...existing,
          ...(when !== undefined ? { when } : {}),
          ...(a.channels ? { channels: a.channels } : {}),
          ...(a.severity ? { severity: a.severity } : {}),
          ...(a.description !== undefined ? { description: a.description } : {}),
          ...(a.for !== undefined ? { for: a.for } : {}),
          ...(a.cooldown !== undefined ? { cooldown: a.cooldown } : {}),
          ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
        });
        if (!merged.success) {
          failure = `Invalid rule: ${merged.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
          return rules;
        }
        return rules.map((r) => (r.id === a.id ? merged.data : r));
      });
      return failure ?? err ?? `Alert rule '${a.id}' updated.\n\n${renderRules()}`;
    },
  }),

  defineTool({
    name: "remove_alert_rule",
    title: "Remove Alert Rule",
    annotations: DESTRUCTIVE,
    noDevice: true,
    description:
      "Deletes an alert rule from the running engine. Its live state is discarded, so a rule" +
      " re-added with the same id starts clean rather than resuming a stale firing state." +
      " Consider mute_alert_rule instead if you only want quiet for a while.",
    inputSchema: { id: z.string().min(1) },
    handler(a, ctx) {
      ctx.info(`Removing alert rule: ${a.id}`);
      let found = false;
      const err = withRules((rules) => {
        found = rules.some((r) => r.id === a.id);
        return rules.filter((r) => r.id !== a.id);
      });
      if (err) return err;
      return found ? `Alert rule '${a.id}' removed.` : `No alert rule with id '${a.id}'.`;
    },
  }),

  defineTool({
    name: "mute_alert_rule",
    title: "Mute Alert Rule",
    annotations: WRITE_IDEMPOTENT,
    noDevice: true,
    description:
      "Silences one rule for a duration (e.g. '1h', '30m') without deleting it. A muted rule" +
      " keeps tracking its condition but emits nothing — and un-muting does NOT replay alerts" +
      " that fired and resolved while it was quiet. Use during planned maintenance, or to stop" +
      " a known-noisy rule while you retune it. Pass duration '0s' to un-mute immediately.",
    inputSchema: {
      id: z.string().min(1),
      duration: z
        .string()
        .default("1h")
        .describe("How long to stay quiet, e.g. '1h', '30m', '0s'."),
    },
    handler(a, ctx) {
      const ms = parseDuration(a.duration);
      if (ms === null) return `Invalid duration '${a.duration}'. Use a form like 30s, 15m, 2h, 1d.`;
      ctx.info(`Muting alert rule ${a.id} for ${a.duration}`);
      let found = false;
      const until = ms === 0 ? undefined : Date.now() + ms;
      const err = withRules((rules) => {
        found = rules.some((r) => r.id === a.id);
        return rules.map((r) => (r.id === a.id ? { ...r, mutedUntil: until } : r));
      });
      if (err) return err;
      if (!found) return `No alert rule with id '${a.id}'.`;
      return until === undefined
        ? `Alert rule '${a.id}' un-muted.`
        : `Alert rule '${a.id}' muted until ${new Date(until).toISOString()}.`;
    },
  }),
];
