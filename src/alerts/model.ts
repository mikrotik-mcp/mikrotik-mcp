/**
 * Alert rules: schema, condition matching, and the fire/resolve state machine.
 *
 * Pure — no I/O, no timers, no imports from `tools/`. `now` is always passed in,
 * so every temporal behaviour (`for`, `cooldown`, flap absorption) is testable
 * without waiting for wall-clock time.
 *
 * **The state machine is the whole feature.** An alerting system that fires 400
 * times for one flapping link is worse than none — people mute it and then miss
 * the real one. So the design goal is not "detect the condition", it is "say it
 * once, and say when it stopped".
 */
import { z } from "zod";

// ── Durations ───────────────────────────────────────────────────────────────

/** `30s` / `5m` / `2h` / `1d` → milliseconds. Returns null when unparseable. */
export function parseDuration(v: string): number | null {
  const m = v.trim().match(/^(\d+)(s|m|h|d)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return n * unit;
}

const Duration = z.string().refine((v) => parseDuration(v) !== null, {
  message: "expected a duration like 30s, 5m, 2h or 1d",
});

// ── Rule schema ─────────────────────────────────────────────────────────────

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CHANNELS = ["slack", "discord", "ntfy", "webhook", "mcp"] as const;
export type ChannelName = (typeof CHANNELS)[number];

/**
 * Threshold over a rolling window. `minCalls` is the guard against a 100% error
 * rate computed from a single call — without it, one failure on an idle server
 * pages someone.
 */
const MetricTrigger = z.object({
  metric: z.enum(["error_rate", "calls", "avg_duration_ms", "p95_duration_ms"]),
  window: Duration,
  above: z.number().optional(),
  below: z.number().optional(),
  minCalls: z.number().int().nonnegative().default(0),
});

/** A state change or occurrence. Matchers are ANDed; an absent one matches all. */
const EventTrigger = z.object({
  event: z.enum([
    "tool_call",
    "device_state",
    "drift",
    "rollout",
    "transaction",
    "policy",
    "audit",
    "attack",
  ]),
  /** For `device_state`: the state entered. For `drift`: `detected`/`resolved`. */
  to: z.string().optional(),
  risk: z.array(z.string()).optional(),
  device: z.array(z.string()).optional(),
  tool: z.array(z.string()).optional(),
  isError: z.boolean().optional(),
});

/** Something expected did not happen — e.g. no snapshot in 24 h. */
const AbsenceTrigger = z.object({
  absence: z.enum(["tool_call", "snapshot", "device_seen"]),
  within: Duration,
  device: z.array(z.string()).optional(),
  tool: z.array(z.string()).optional(),
});

export const TriggerSchema = z.union([MetricTrigger, EventTrigger, AbsenceTrigger]);
export type Trigger = z.infer<typeof TriggerSchema>;

export const AlertRuleSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  when: TriggerSchema,
  severity: z.enum(SEVERITIES).default("medium"),
  channels: z.array(z.enum(CHANNELS)).min(1),
  /** The condition must hold this long before firing. Default 0 (fire at once). */
  for: Duration.optional(),
  /** No re-fire within this long of the last fire. Default 15m. */
  cooldown: Duration.default("15m"),
  /** Muted until this epoch ms — set by `mute_alert_rule`, not hand-authored. */
  mutedUntil: z.number().optional(),
  enabled: z.boolean().default(true),
});
export type AlertRule = z.infer<typeof AlertRuleSchema>;

export type MetricTriggerT = z.infer<typeof MetricTrigger>;
export type EventTriggerT = z.infer<typeof EventTrigger>;
export type AbsenceTriggerT = z.infer<typeof AbsenceTrigger>;

export function isMetricTrigger(t: Trigger): t is MetricTriggerT {
  return "metric" in t;
}
export function isEventTrigger(t: Trigger): t is EventTriggerT {
  return "event" in t;
}
export function isAbsenceTrigger(t: Trigger): t is AbsenceTriggerT {
  return "absence" in t;
}

/**
 * Event kinds that carry a STATE, and the states they use.
 *
 * These are the kinds where one emission means "it started" and another means
 * "it stopped". A rule that matches both can never resolve — the resolved event
 * re-satisfies the condition — so it fires once and then stays firing forever.
 */
const STATEFUL_EVENTS: Partial<Record<EventTriggerT["event"], string[]>> = {
  device_state: ["online", "offline"],
  drift: ["detected", "resolved"],
};

/**
 * Non-fatal problems with a rule — things that will not stop it loading but will
 * make it behave in a way its author did not intend.
 *
 * The one that matters: an event rule on a stateful kind with no `to` filter
 * matches the "it recovered" event as well as the "it broke" one, so the
 * condition never clears and the alert never resolves. That is a permanently
 * red banner, which is how people learn to ignore banners. Rejecting it outright
 * would break configs that already exist, so it is surfaced as a warning
 * everywhere a rule is listed.
 */
export function ruleWarnings(rule: AlertRule): string[] {
  const warnings: string[] = [];
  if (isEventTrigger(rule.when)) {
    const states = STATEFUL_EVENTS[rule.when.event];
    if (states && rule.when.to === undefined) {
      warnings.push(
        `'${rule.when.event}' events carry a state (${states.join(" / ")}) and this rule has no ` +
          `\`to\` filter, so it also matches the recovery event — it will fire once and never ` +
          `resolve. Add \`to: ${states[states.length - 1] === "resolved" ? "detected" : "offline"}\`.`,
      );
    }
  }
  return warnings;
}

// ── Condition input ─────────────────────────────────────────────────────────

/** A window aggregate, for `metric` rules. */
export interface MetricSample {
  calls: number;
  errors: number;
  avgDurationMs: number;
  p95DurationMs: number;
}

/** One occurrence, for `event` rules. */
export interface AlertEvent {
  kind: EventTriggerT["event"];
  to?: string;
  risk?: string;
  device?: string;
  tool?: string;
  isError?: boolean;
  /** Free-form detail carried into the notification body. */
  detail?: string;
}

/** Does this window sample cross the rule's threshold? */
export function metricMet(t: MetricTriggerT, s: MetricSample): boolean {
  // Below the sample floor there is nothing meaningful to measure — one failed
  // call on an idle server is a 100% error rate, and paging on that is noise.
  if (s.calls < t.minCalls) return false;
  const value =
    t.metric === "error_rate"
      ? s.calls === 0
        ? 0
        : s.errors / s.calls
      : t.metric === "calls"
        ? s.calls
        : t.metric === "avg_duration_ms"
          ? s.avgDurationMs
          : s.p95DurationMs;

  // A rule with neither bound can never fire; treat it as not met rather than
  // silently always-true.
  if (t.above === undefined && t.below === undefined) return false;
  if (t.above !== undefined && !(value > t.above)) return false;
  if (t.below !== undefined && !(value < t.below)) return false;
  return true;
}

/** Does this event match the rule's matchers? Absent matchers match anything. */
export function eventMet(t: EventTriggerT, e: AlertEvent): boolean {
  if (t.event !== e.kind) return false;
  if (t.to !== undefined && t.to !== e.to) return false;
  if (t.isError !== undefined && t.isError !== e.isError) return false;
  if (t.risk && !(e.risk && t.risk.some((r) => r.toLowerCase() === e.risk?.toLowerCase())))
    return false;
  if (t.device && !(e.device && t.device.includes(e.device))) return false;
  if (t.tool && !(e.tool && t.tool.includes(e.tool))) return false;
  return true;
}

/**
 * Has the expected thing been absent for longer than the rule allows?
 * `lastSeenAt` of undefined means "never seen", which counts as absent.
 */
export function absenceMet(
  t: AbsenceTriggerT,
  lastSeenAt: number | undefined,
  now: number,
): boolean {
  const within = parseDuration(t.within) ?? 0;
  if (lastSeenAt === undefined) return true;
  return now - lastSeenAt > within;
}

// ── Fire / resolve state machine ────────────────────────────────────────────

/**
 * - `clear` — nothing happening.
 * - `pending` — condition met, waiting out `for`.
 * - `firing` — fired; a subsequent clear emits a resolve.
 * - `suppressed` — condition met again inside the cooldown. Deliberately NOT
 *   `firing`: it must not emit a second resolve when it clears, or a flapping
 *   link produces an endless resolve stream.
 */
export type AlertStatus = "clear" | "pending" | "firing" | "suppressed";

export interface AlertState {
  status: AlertStatus;
  /** When the current status began. */
  since: number;
  /** When this rule last actually fired — the cooldown anchor. */
  lastFiredAt?: number;
}

export type AlertAction = { type: "none" } | { type: "fire" } | { type: "resolve" };

export function initialState(now = 0): AlertState {
  return { status: "clear", since: now };
}

/**
 * Advance the machine one tick.
 *
 * Flap behaviour, which is the reason this is a machine and not an `if`: once a
 * rule fires it enters cooldown. A re-met condition inside that window moves to
 * `suppressed`, which emits nothing on the way in OR the way out. So a link
 * bouncing ten times inside the cooldown yields exactly one fire and one
 * resolve, not ten of each.
 */
export function step(
  rule: AlertRule,
  state: AlertState,
  met: boolean,
  now: number,
): { state: AlertState; action: AlertAction } {
  const none = (s: AlertState): { state: AlertState; action: AlertAction } => ({
    state: s,
    action: { type: "none" },
  });

  // A disabled or muted rule holds its state but never emits — so un-muting does
  // not immediately dump a backlog of alerts that resolved while it was quiet.
  if (!rule.enabled || isMuted(rule, now)) return none(state);

  const forMs = rule.for ? (parseDuration(rule.for) ?? 0) : 0;
  const cooldownMs = parseDuration(rule.cooldown) ?? 0;
  const inCooldown = state.lastFiredAt !== undefined && now - state.lastFiredAt < cooldownMs;

  switch (state.status) {
    case "clear": {
      if (!met) return none(state);
      const next: AlertState = { ...state, status: "pending", since: now };
      // `for: 0` still routes through pending so the cooldown check lives in
      // exactly one place.
      return forMs === 0 ? promote(next, now, inCooldown) : none(next);
    }
    case "pending": {
      if (!met) return none({ ...state, status: "clear", since: now });
      if (now - state.since < forMs) return none(state);
      return promote(state, now, inCooldown);
    }
    case "firing": {
      if (met) return none(state);
      return { state: { ...state, status: "clear", since: now }, action: { type: "resolve" } };
    }
    case "suppressed": {
      // Neither entering nor leaving suppression emits anything — that is what
      // absorbs a flap.
      if (met) return none(state);
      return none({ ...state, status: "clear", since: now });
    }
  }
}

/** `for` is satisfied — fire, unless the cooldown says otherwise. */
function promote(
  state: AlertState,
  now: number,
  inCooldown: boolean,
): { state: AlertState; action: AlertAction } {
  if (inCooldown) {
    return { state: { ...state, status: "suppressed", since: now }, action: { type: "none" } };
  }
  return { state: { status: "firing", since: now, lastFiredAt: now }, action: { type: "fire" } };
}

/** True when a rule is currently muted. */
export function isMuted(rule: AlertRule, now: number): boolean {
  return rule.mutedUntil !== undefined && now < rule.mutedUntil;
}

/**
 * Parse a rule list, rejecting duplicate ids.
 *
 * Ids are how an alert is muted, acknowledged and tracked across fires; two
 * rules sharing one makes that history meaningless.
 */
export function parseRules(input: unknown): AlertRule[] {
  const rules = z.array(AlertRuleSchema).parse(input);
  const seen = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.id)) throw new Error(`Duplicate alert rule id: ${r.id}`);
    seen.add(r.id);
  }
  return rules;
}
