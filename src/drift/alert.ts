/**
 * Turn a completed drift check into an alert event.
 *
 * Kept out of `engine.ts`, which is pure analysis and must stay importable
 * without dragging in the alert engine. Both places that run a check — the
 * `config_check_drift` tool and the dashboard's `/api/drift/check` route — call
 * this, so the transition logic lives once instead of twice.
 *
 * **Emits only on a transition.** A drift check is run on demand, sometimes
 * repeatedly while someone investigates. Emitting on every check would make a
 * `for` window trivially satisfied and turn one drifted device into a stream of
 * identical alerts — the same mistake the health probe avoids.
 */
import { emitAlertEvent } from "../alerts/engine";
import type { DriftReport } from "./engine";

/** Last known drift state per device: true = drifted, false = clean. */
const drifted = new Map<string, boolean>();

/**
 * Record a drift result and emit when the state changed.
 *
 * The first check of a device DOES emit if it finds drift — unlike the health
 * probe, where an unknown-to-offline transition is ambiguous. Here "we just
 * looked and the config does not match its baseline" is worth saying the first
 * time, not only the second.
 */
export function noteDriftResult(report: DriftReport): void {
  const isDrifted = !report.identical;
  const previous = drifted.get(report.device);
  drifted.set(report.device, isDrifted);

  // Unchanged state — nothing new to say.
  if (previous === isDrifted) return;
  // First-ever check that came back clean is not news.
  if (previous === undefined && !isDrifted) return;

  emitAlertEvent({
    kind: "drift",
    to: isDrifted ? "detected" : "resolved",
    device: report.device,
    detail: isDrifted
      ? `${report.summary.added} added, ${report.summary.removed} removed across ` +
        `${report.sections.length} section${report.sections.length === 1 ? "" : "s"} ` +
        `(score ${report.score})`
      : "Configuration matches its baseline again",
  });
}

/** Forget every tracked device (tests, and after a config reload). */
export function resetDriftAlertState(): void {
  drifted.clear();
}
