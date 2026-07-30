/**
 * Monitor Devices — a `no-view` background command (scheduled via the manifest
 * `interval`) that polls the dashboard's `/api/devices` health and fires a
 * Notification Center alert whenever a router flips reachable ↔ unreachable.
 *
 * It also runs on demand (LaunchType.UserInitiated) and refreshes its root-search
 * subtitle with the live online/offline tally either way.
 *
 * State (the last-seen reachability per device) lives in LocalStorage so
 * successive background launches can diff against it. Design choices that avoid
 * notification spam:
 *   • First ever run seeds state silently — no alerts for devices we've never seen.
 *   • `reachable === null` (not yet probed) is treated as "unknown": we don't
 *     alert and we carry the prior known value forward, so a real flip is still
 *     caught on the next run once the probe resolves.
 *   • If the dashboard itself is unreachable we leave stored state untouched and
 *     only update the subtitle — a dashboard restart must not read as "everything
 *     went offline".
 *
 * It also announces AUDIT REGRESSIONS from the scheduled audits, on the same
 * schedule and with the same seed-silently rule. Regressions belong here rather
 * than in a command of their own: the whole point of a scheduled audit is that
 * nobody goes looking for it, so the notification has to arrive on its own.
 */
import { LocalStorage, updateCommandMetadata } from "@raycast/api";
import { api } from "./lib/api";
import { notify } from "./lib/notify";
import type { DevicesPayload, ScheduleRegression } from "./lib/types";

const STATE_KEY = "monitor-devices:reachability";
/** Newest regression already announced, so each one is reported exactly once. */
const REGRESSION_KEY = "monitor-devices:last-regression";

type State = Record<string, boolean>;

/**
 * Announce audit regressions newer than the last one we announced.
 *
 * Only NEW and WORSENED raise a notification here; a resolved finding is good
 * news and the dashboard is where you go to enjoy it. Never throws — a
 * dashboard without the schedules feature must not break device monitoring.
 */
async function announceRegressions(): Promise<void> {
  let regressions: ScheduleRegression[];
  try {
    const res = await api<{ regressions: ScheduleRegression[] }>(
      "/api/schedules/regressions?limit=10",
    );
    regressions = res.regressions ?? [];
  } catch {
    return;
  }
  if (regressions.length === 0) return;

  const raw = await LocalStorage.getItem<string>(REGRESSION_KEY);
  const since = raw ? Number(raw) : 0;
  const newest = Math.max(...regressions.map((r) => r.at));
  await LocalStorage.setItem(REGRESSION_KEY, String(newest));
  // First ever run seeds silently — a month of history must not arrive at once.
  if (!raw) return;

  const fresh = regressions
    .filter((r) => r.at > since && r.added.length + r.worsened.length > 0)
    .slice(0, 3);
  await Promise.all(
    fresh.map((r) =>
      notify(`Audit regression on ${r.device}`, `${r.jobId}: ${r.summary}`),
    ),
  );
}

export default async function Command(): Promise<void> {
  let payload: DevicesPayload;
  try {
    payload = await api<DevicesPayload>("/api/devices");
  } catch {
    await updateCommandMetadata({ subtitle: "Dashboard unreachable" });
    return;
  }

  const raw = await LocalStorage.getItem<string>(STATE_KEY);
  let prev: State = {};
  try {
    if (raw) prev = JSON.parse(raw) as State;
  } catch {
    prev = {};
  }
  const seeded = raw != null; // first run seeds silently

  const next: State = {};
  const flips: Array<Promise<void>> = [];
  let online = 0;
  let offline = 0;

  for (const d of payload.devices) {
    const reachable = d.status.reachable;
    if (reachable == null) {
      // Unknown this cycle — keep the last known value so a later flip is caught.
      if (d.name in prev) next[d.name] = prev[d.name];
      continue;
    }
    next[d.name] = reachable;
    if (reachable) online++;
    else offline++;

    const was = prev[d.name];
    if (seeded && was !== undefined && was !== reachable) {
      const label = d.status.identity ?? d.name;
      // Fire them concurrently: Raycast kills a background run on a timeout keyed
      // to `interval`, and awaiting each alert in turn burns that budget for no
      // reason — a lost run means the flip is never announced at all.
      flips.push(
        notify(
          reachable ? "Device online" : "Device offline",
          reachable ? `${label} is reachable again` : `${label} is unreachable`,
        ),
      );
    }
  }

  await Promise.all([...flips, announceRegressions()]);
  await LocalStorage.setItem(STATE_KEY, JSON.stringify(next));
  await updateCommandMetadata({
    subtitle:
      offline > 0
        ? `${online} online · ${offline} offline`
        : `${online} online`,
  });
}
