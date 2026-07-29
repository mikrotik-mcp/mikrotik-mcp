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
import { eventMet, initialState, isEventTrigger, isMetricTrigger, metricMet, step } from "./model";
import type { AlertEvent, AlertRule, AlertState, MetricSample } from "./model";

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
}

export class AlertEngine {
  private rules: AlertRule[];
  private channels: ChannelConfig;
  private readonly states = new Map<string, AlertState>();
  private readonly queue: QueueItem[] = [];
  private draining = false;
  private readonly opts: EngineOptions;
  private readonly now: () => number;

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
    for (const id of [...this.states.keys()]) if (!ids.has(id)) this.states.delete(id);
  }

  setChannels(channels: ChannelConfig): void {
    this.channels = channels;
  }

  /** Current status of every rule, for `list_alert_rules` and the dashboard. */
  snapshot(): { rule: AlertRule; state: AlertState }[] {
    return this.rules.map((rule) => ({
      rule,
      state: this.states.get(rule.id) ?? initialState(0),
    }));
  }

  /** Rules currently firing — what the nav badge counts. */
  active(): { rule: AlertRule; state: AlertState }[] {
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
   * Feed a window aggregate in, for `metric` rules. Called on a timer by the
   * dashboard sampler, never from the tool-call path.
   */
  sample(s: MetricSample): void {
    try {
      for (const rule of this.rules) {
        if (!isMetricTrigger(rule.when)) continue;
        this.advance(rule, metricMet(rule.when, s), undefined);
      }
    } catch (e) {
      logger.debug(`[alerts] sample failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Run one rule's machine and enqueue whatever it decided. */
  private advance(rule: AlertRule, met: boolean, event: AlertEvent | undefined): void {
    const prev = this.states.get(rule.id) ?? initialState(this.now());
    const { state, action } = step(rule, prev, met, this.now());
    this.states.set(rule.id, state);
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
        for (const channel of item.channels) {
          // `deliver` never throws; this loop cannot break the queue.
          const result = await deliver(channel, this.channels, item.notification);
          this.opts.onDelivery?.(result, item.notification);
          if (!result.ok) {
            logger.debug(
              `[alerts] ${item.notification.ruleId} → ${channel} failed: ${result.error ?? result.status}`,
            );
          }
        }
      }
    } finally {
      this.draining = false;
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
