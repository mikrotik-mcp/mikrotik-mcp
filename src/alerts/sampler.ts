/**
 * The metric-rule tick.
 *
 * `event` rules are pushed in from the tool-call path; `metric` rules are the
 * other half — they ask a question about a *window* ("error rate over 5m"), so
 * something has to ask it on a schedule. This is that something.
 *
 * Deliberately separate from `usage-sampler.ts`: that one records long-term
 * usage history at a coarse cadence, while alerting needs a short one so a
 * `for: 2m` rule can actually observe two minutes of "still true". Coupling
 * them would force one cadence to be wrong.
 */
import { getAlertEngine } from "./engine";
import type { MetricSample } from "./model";
import { percentile } from "../observability/stats";
import { getEventStore } from "../observability/recorder";
import { logger } from "../logger";

/** How often metric rules are re-evaluated. */
export const DEFAULT_ALERT_SAMPLE_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Aggregate the stored events over the last `windowMs`.
 *
 * Returns an all-zero sample when there is no event store — which
 * `metricMet` reads as "not met" for an `above` rule, so a server with no
 * dashboard does not start firing latency alerts computed from nothing.
 */
export function computeMetricSample(windowMs: number, now = Date.now()): MetricSample {
  const store = getEventStore();
  if (!store) return { calls: 0, errors: 0, avgDurationMs: 0, p95DurationMs: 0 };

  const events = store.query({ since: now - windowMs, limit: 10_000 });
  const calls = events.length;
  if (calls === 0) return { calls: 0, errors: 0, avgDurationMs: 0, p95DurationMs: 0 };

  const durations = events.map((e) => e.durationMs);
  return {
    calls,
    errors: events.reduce((n, e) => n + (e.isError ? 1 : 0), 0),
    avgDurationMs: durations.reduce((a, b) => a + b, 0) / calls,
    p95DurationMs: percentile(durations, 95),
  };
}

/** Run one evaluation pass. Exported so a test can tick without a timer. */
export function sampleAlertsOnce(now = Date.now()): void {
  const engine = getAlertEngine();
  // Skip entirely when no rule needs it — the common case is zero metric rules,
  // and this keeps the timer from touching SQLite thirty times an hour for
  // nothing.
  if (!engine || !engine.hasMetricRules()) return;
  engine.sample((windowMs) => computeMetricSample(windowMs, now));
}

/**
 * Start the metric tick. Safe to call repeatedly — the previous timer is
 * cleared first, so a config reload cannot leave two running.
 */
export function startAlertSampler(intervalMs = DEFAULT_ALERT_SAMPLE_MS): void {
  stopAlertSampler();
  timer = setInterval(() => {
    try {
      sampleAlertsOnce();
    } catch (e) {
      // A sampling failure must not kill the interval — it would silently stop
      // every metric rule for the rest of the process's life.
      logger.debug(`[alerts] sampler tick failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, intervalMs);
  // Do not hold the process open just to evaluate alert rules.
  timer.unref?.();
  logger.debug(`[alerts] metric sampler started (${intervalMs}ms)`);
}

export function stopAlertSampler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
