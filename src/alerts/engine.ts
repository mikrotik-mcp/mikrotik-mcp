/**
 * The alert engine: consumes events, drives the rule machines, queues delivery.
 *
 * **Isolation is the design constraint.** `notify()` is called from the recorder,
 * which sits on the tool-call path. So it must be synchronous, must never throw,
 * and must never await a network call. Everything it does is: evaluate in
 * memory, push onto a queue, return. A separate drain loop does the I/O.
 *
 * The consequence is that no misconfigured webhook, hung endpoint, or bug in a
 * channel adapter can slow down or fail a tool call — which
 * `tests/alerts/isolation.spec.ts` asserts directly.
 */
import { logger } from "../logger";
import { deliver } from "./channels";
import type { AlertNotification, ChannelConfig, DeliveryResult } from "./channels";
import {
  absenceMet,
  eventMet,
  initialState,
  isAbsenceTrigger,
  isEventTrigger,
  isMetricTrigger,
  metricMet,
  parseDuration,
  step,
} from "./model";
import type { AbsenceTriggerT, AlertEvent, AlertRule, AlertState, MetricSample } from "./model";
import { openAlertStore, toAlertRecord } from "./store";
import type { AlertRecord, AlertStore } from "./store";

/** Subject used when an event names no device — metric and absence rules. */
export const ANY_SUBJECT = "*";

/**
 * State-map key. `\u0000` separates because it cannot appear in a rule id (Zod
 * takes any string, but a NUL byte in configuration is not a real case) and
 * keeps the split unambiguous for ids containing `:` or `/`.
 */
function stateKey(ruleId: string, subject: string): string {
  return `${ruleId}\u0000${subject}`;
}

function splitKey(key: string): { ruleId: string; subject: string } {
  const i = key.indexOf("\u0000");
  return i === -1
    ? { ruleId: key, subject: ANY_SUBJECT }
    : { ruleId: key.slice(0, i), subject: key.slice(i + 1) };
}

/** A delivery that has been decided but not yet attempted. */
interface QueueItem {
  notification: AlertNotification;
  channels: AlertRule["channels"];
}

export interface EngineOptions {
  rules: AlertRule[];
  channels: ChannelConfig;
  /** Called after each delivery attempt — the dashboard's delivery log. */
  onDelivery?: (r: DeliveryResult, n: AlertNotification) => void;
  /** Called when an alert fires or resolves, before delivery. */
  onAlert?: (n: AlertNotification) => void;
  now?: () => number;
  /** Path to `events.db`. Omit to keep history in memory only. */
  historyDb?: string;
  /** History retention, in records. */
  maxHistory?: number;
}

export class AlertEngine {
  private rules: AlertRule[];
  private channels: ChannelConfig;
  private readonly states = new Map<string, AlertState>();
  private readonly queue: QueueItem[] = [];
  private draining = false;
  private readonly opts: EngineOptions;
  private readonly now: () => number;
  /** Lazily opened on first write — an engine with no alerts opens no database. */
  private storePromise: Promise<AlertStore> | null = null;
  private counter = 0;

  constructor(opts: EngineOptions) {
    this.opts = opts;
    this.rules = opts.rules;
    this.channels = opts.channels;
    this.now = opts.now ?? ((): number => Date.now());
  }

  /** Swap the rule set (config reload) without losing per-rule state. */
  setRules(rules: AlertRule[]): void {
    this.rules = rules;
    // Drop state for rules that no longer exist, so a re-added rule starts clean.
    const ids = new Set(rules.map((r) => r.id));
    for (const key of [...this.states.keys()]) {
      if (!ids.has(splitKey(key).ruleId)) this.states.delete(key);
    }
  }

  /** The configured rules, without their per-subject state. */
  configuredRules(): AlertRule[] {
    return this.rules;
  }

  setChannels(channels: ChannelConfig): void {
    this.channels = channels;
  }

  /**
   * Every tracked (rule, subject) pair with its state.
   *
   * A rule that has never seen a subject still gets one row, so the UI can list
   * a configured-but-quiet rule. A rule tracking several devices gets one row
   * per device — which is the point of keying state by subject.
   */
  snapshot(): { rule: AlertRule; subject: string; state: AlertState }[] {
    const out: { rule: AlertRule; subject: string; state: AlertState }[] = [];
    for (const rule of this.rules) {
      const subjects = [...this.states.keys()]
        .map(splitKey)
        .filter((k) => k.ruleId === rule.id)
        .map((k) => k.subject);
      if (subjects.length === 0) {
        out.push({ rule, subject: ANY_SUBJECT, state: initialState(0) });
        continue;
      }
      for (const subject of subjects) {
        out.push({
          rule,
          subject,
          state: this.states.get(stateKey(rule.id, subject)) ?? initialState(0),
        });
      }
    }
    return out;
  }

  /** Firing (rule, subject) pairs — what the nav badge counts. */
  active(): { rule: AlertRule; subject: string; state: AlertState }[] {
    return this.snapshot().filter((s) => s.state.status === "firing");
  }

  /**
   * Feed one occurrence in.
   *
   * **Synchronous and total.** Called from the recorder on the tool-call path:
   * it evaluates in memory, enqueues, and returns. It never awaits, never
   * throws, and never touches the network.
   */
  notify(event: AlertEvent): void {
    try {
      for (const rule of this.rules) {
        if (!isEventTrigger(rule.when)) continue;
        this.advance(rule, eventMet(rule.when, event), event);
      }
    } catch (e) {
      // A bug in evaluation must not escape onto the tool-call path.
      logger.debug(`[alerts] notify failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Evaluate every `metric` rule against a freshly computed window aggregate.
   *
   * Takes a FUNCTION, not a single sample: each rule declares its own `window`,
   * so one aggregate cannot serve them all — a `5m` rule and a `1h` rule
   * evaluated against the same numbers would both be wrong. The engine asks for
   * exactly the windows its rules need, computing each at most once.
   *
   * Called on a timer, never from the tool-call path.
   */
  sample(compute: (windowMs: number) => MetricSample): void {
    try {
      const byWindow = new Map<number, MetricSample>();
      for (const rule of this.rules) {
        if (!isMetricTrigger(rule.when)) continue;
        const windowMs = parseDuration(rule.when.window);
        if (windowMs === null) continue; // schema-validated, but be total
        let s = byWindow.get(windowMs);
        if (!s) {
          s = compute(windowMs);
          byWindow.set(windowMs, s);
        }
        this.advance(rule, metricMet(rule.when, s), undefined);
      }
    } catch (e) {
      logger.debug(`[alerts] sample failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** True when any rule needs metric sampling — lets the timer skip the work. */
  hasMetricRules(): boolean {
    return this.rules.some((r) => isMetricTrigger(r.when));
  }

  /**
   * Evaluate every `absence` rule.
   *
   * `lastSeen` answers "when did this last happen", returning `undefined` for
   * never. It must be backed by something **persistent** — an in-memory tally
   * seeded empty would report every subject as absent the moment the process
   * restarts, firing every absence rule at once.
   */
  async sampleAbsence(
    lastSeen: (t: AbsenceTriggerT) => Promise<number | undefined>,
    now = this.now(),
  ): Promise<void> {
    try {
      for (const rule of this.rules) {
        if (!isAbsenceTrigger(rule.when)) continue;
        // Sequential rather than parallel: the lookups hit the same two
        // databases, and a handful of absence rules is not worth the fan-out.
        const seen = await lastSeen(rule.when);
        this.advance(rule, absenceMet(rule.when, seen, now), undefined);
      }
    } catch (e) {
      logger.debug(`[alerts] absence sample failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** True when any rule needs absence sampling. */
  hasAbsenceRules(): boolean {
    return this.rules.some((r) => isAbsenceTrigger(r.when));
  }

  /**
   * Run one rule's machine for one subject and enqueue whatever it decided.
   *
   * State is keyed by `(ruleId, subject)`, not by rule alone. Without the
   * subject, a single "any device offline" rule already firing for `site-a`
   * would stay silent when `site-b` also drops — the second device folded into
   * the first alert. Device is the subject because that is what a network alert
   * is about; metric and absence rules are fleet-wide and use `*`.
   */
  private advance(rule: AlertRule, met: boolean, event: AlertEvent | undefined): void {
    const subject = event?.device ?? ANY_SUBJECT;
    const key = stateKey(rule.id, subject);
    const prev = this.states.get(key) ?? initialState(this.now());
    const { state, action } = step(rule, prev, met, this.now());
    this.states.set(key, state);
    if (action.type === "none") return;

    const n: AlertNotification = {
      ruleId: rule.id,
      severity: rule.severity,
      kind: action.type === "fire" ? "fire" : "resolve",
      title: rule.description ?? rule.id,
      body: event?.detail ?? "",
      device: event?.device,
      at: this.now(),
    };
    this.opts.onAlert?.(n);
    this.queue.push({ notification: n, channels: rule.channels });
    // Deferred, not merely un-awaited. Calling `drain()` directly would run
    // synchronously up to its first `await` — and the `mcp` channel has no
    // await before it, so a sender would execute inline on the tool-call path.
    // A microtask guarantees nothing at all runs before `notify()` returns.
    queueMicrotask(() => void this.drain());
  }

  /**
   * Deliver everything queued, one item at a time.
   *
   * Serial rather than parallel on purpose: a burst of alerts should not open
   * fifty concurrent sockets to the same webhook and get rate-limited.
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (!item) break;
        const results: DeliveryResult[] = [];
        for (const channel of item.channels) {
          // `deliver` never throws; this loop cannot break the queue.
          const result = await deliver(channel, this.channels, item.notification);
          results.push(result);
          this.opts.onDelivery?.(result, item.notification);
          if (!result.ok) {
            logger.debug(
              `[alerts] ${item.notification.ruleId} → ${channel} failed: ${result.error ?? result.status}`,
            );
          }
        }
        await this.persist(item.notification, results);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Past alerts, newest first. Reads from `events.db` when a path was
   * configured; otherwise returns nothing, since there is nowhere to read from.
   */
  async history(
    opts: { sinceMs?: number; ruleId?: string; limit?: number } = {},
  ): Promise<AlertRecord[]> {
    if (!this.opts.historyDb) return [];
    try {
      return (await this.store()).list(opts);
    } catch (e) {
      logger.debug(`[alerts] history unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  private store(): Promise<AlertStore> {
    this.storePromise ??= openAlertStore(this.opts.historyDb as string);
    return this.storePromise;
  }

  /** Persist one delivered alert. Best-effort: history must never break delivery. */
  private async persist(n: AlertNotification, results: DeliveryResult[]): Promise<void> {
    if (!this.opts.historyDb) return;
    try {
      const store = await this.store();
      const id = `${n.at.toString(36)}-${(this.counter++).toString(36)}`;
      store.insert(toAlertRecord(n, results, id));
      if (this.counter % 50 === 0) store.prune(this.opts.maxHistory ?? 5000);
    } catch (e) {
      logger.debug(`[alerts] history write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Await the queue draining — tests only; production never needs to wait. */
  async flush(): Promise<void> {
    while (this.draining || this.queue.length > 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }
}

// ── Process-wide instance ───────────────────────────────────────────────────

let engine: AlertEngine | undefined;

/** Install the engine (or clear it with no argument). */
export function setAlertEngine(e?: AlertEngine): void {
  engine = e;
}

export function getAlertEngine(): AlertEngine | undefined {
  return engine;
}

/**
 * Emit an event to the engine if one is installed.
 *
 * The no-engine case is a plain no-op, so every call site can emit
 * unconditionally without knowing whether alerting is configured.
 */
export function emitAlertEvent(event: AlertEvent): void {
  engine?.notify(event);
}
