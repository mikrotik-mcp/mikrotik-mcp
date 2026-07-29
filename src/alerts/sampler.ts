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
import type { AbsenceTriggerT, MetricSample } from "./model";
import { percentile } from "../observability/stats";
import { getEventStore } from "../observability/recorder";
import { getDeviceStatus } from "../observability/health";
import { openSnapshotStore } from "../snapshots/store";
import type { SnapshotStore } from "../snapshots/store";
import { DEFAULT_SNAPSHOT_DB } from "../config";
import { getConfig } from "../core/runtime";
import { logger } from "../logger";

/** How often metric rules are re-evaluated. */
export const DEFAULT_ALERT_SAMPLE_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;

/** Opened lazily — a server with no `absence: snapshot` rule never touches it. */
let snapshotStorePromise: Promise<SnapshotStore> | null = null;
function getSnapshotStore(): Promise<SnapshotStore> {
  snapshotStorePromise ??= openSnapshotStore(DEFAULT_SNAPSHOT_DB);
  return snapshotStorePromise;
}

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

/**
 * When did this subject last do anything? `undefined` means never.
 *
 * Every source here is **persistent** — the event store, the snapshot database,
 * the live health cache. That matters more than it looks: an in-memory tally
 * seeded empty would report every subject as absent the instant the process
 * restarts, so every absence rule would fire at once on boot. Reading from
 * durable state means a restart is invisible to these rules.
 */
export async function lastSeen(t: AbsenceTriggerT): Promise<number | undefined> {
  switch (t.absence) {
    case "tool_call": {
      const store = getEventStore();
      if (!store) return undefined;
      // Events are stored newest-first, so one row answers the question.
      // Filters are single-valued in the store, so a multi-value rule falls
      // back to the unfiltered latest — which can only make the rule LESS
      // likely to fire, never more. Erring quiet is the right direction here.
      const rows = store.query({
        limit: 1,
        tool: t.tool?.length === 1 ? t.tool[0] : undefined,
        device: t.device?.length === 1 ? t.device[0] : undefined,
      });
      return rows[0]?.ts;
    }
    case "snapshot": {
      // Queried straight from `snapshots.db` rather than mirrored into a cache.
      // A cache would need seeding at startup and invalidating on write, and a
      // stale one here means a false "no snapshot in 24h" page.
      const devices = t.device?.length ? t.device : Object.keys(getConfig().devices);
      let newest: number | undefined;
      try {
        const store = await getSnapshotStore();
        for (const d of devices) {
          const at = store.latest(d)?.ts;
          if (at !== undefined && (newest === undefined || at > newest)) newest = at;
        }
      } catch (e) {
        // No snapshot database is "no information", NOT "never snapshotted" —
        // returning undefined here would fire the rule.
        logger.debug(`[alerts] snapshot lookup failed: ${e instanceof Error ? e.message : e}`);
        return Date.now();
      }
      return newest;
    }
    case "device_seen": {
      const devices = t.device?.length ? t.device : Object.keys(getConfig().devices);
      let newest: number | undefined;
      for (const d of devices) {
        const st = getDeviceStatus(d);
        // Only a SUCCESSFUL probe counts as "seen" — a failed one is exactly
        // the condition an absence rule is watching for.
        if (st.reachable !== true || st.checkedAt == null) continue;
        if (newest === undefined || st.checkedAt > newest) newest = st.checkedAt;
      }
      return newest;
    }
  }
}

/** Run one evaluation pass. Exported so a test can tick without a timer. */
export async function sampleAlertsOnce(now = Date.now()): Promise<void> {
  const engine = getAlertEngine();
  if (!engine) return;
  // Skip each half independently — the common case is zero rules of a given
  // kind, and this keeps the timer from touching SQLite for nothing.
  if (engine.hasMetricRules()) {
    engine.sample((windowMs) => computeMetricSample(windowMs, now));
  }
  if (engine.hasAbsenceRules()) {
    await engine.sampleAbsence(lastSeen, now);
  }
}

/**
 * Start the metric tick. Safe to call repeatedly — the previous timer is
 * cleared first, so a config reload cannot leave two running.
 */
export function startAlertSampler(intervalMs = DEFAULT_ALERT_SAMPLE_MS): void {
  stopAlertSampler();
  timer = setInterval(() => {
    void sampleAlertsOnce().catch((e: unknown) => {
      // A sampling failure must not kill the interval — it would silently stop
      // every metric and absence rule for the rest of the process's life.
      logger.debug(`[alerts] sampler tick failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  }, intervalMs);
  // Do not hold the process open just to evaluate alert rules.
  timer.unref?.();
  logger.debug(`[alerts] metric sampler started (${intervalMs}ms)`);
}

export function stopAlertSampler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
