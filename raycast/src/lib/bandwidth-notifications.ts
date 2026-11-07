import { createHash } from "node:crypto";
import type { BandwidthRun } from "../../../src/bandwidth/types";

export interface CompletionPage {
  storeId: string;
  events: { sequence: number; run: BandwidthRun }[];
  nextCursor: number;
  hasMore: boolean;
}

interface Dependencies {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  fetch(after: number, limit: number): Promise<CompletionPage>;
  notify(title: string, message: string, group: string): Promise<void>;
}

/** Identify a dashboard without persisting its URL or credentials in storage keys. */
export function bandwidthNotificationNamespace(dashboardUrl: string): string {
  return `bandwidth-notifications:${createHash("sha256").update(dashboardUrl.replace(/\/+$/, "")).digest("hex")}`;
}

/** Dispatch at most 50 completions in order, acknowledging each only after dispatch.
 * At-least-once: a crash between dispatch and persistence retries with the same OS group.
 */
export async function pollBandwidthNotifications(
  namespace: string,
  deps: Dependencies,
): Promise<{ dispatched: number; hasMore: boolean }> {
  const activeKey = `${namespace}:store`;
  const previousStore = await deps.get(activeKey);
  const cursorKey = (store: string) =>
    `${namespace}:${encodeURIComponent(store)}:cursor`;
  const raw = previousStore
    ? await deps.get(cursorKey(previousStore))
    : undefined;
  let cursor = raw === undefined ? 0 : Number(raw);
  if (!Number.isSafeInteger(cursor) || cursor < 0)
    throw new Error("Invalid saved notification cursor");
  let page = await deps.fetch(cursor, 50);
  if (!page.storeId) throw new Error("Missing notification store identity");
  if (page.storeId !== previousStore) {
    const expectedStore = page.storeId;
    const saved = await deps.get(cursorKey(expectedStore));
    cursor = saved === undefined ? 0 : Number(saved);
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new Error("Invalid saved notification cursor");
    // A reset response to the old cursor may be empty: explicitly replay the new store backlog.
    page = await deps.fetch(cursor, 50);
    if (page.storeId !== expectedStore) {
      throw new Error("Notification store changed during polling; retry");
    }
  }
  if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < cursor ||
      page.events.length > 50 || page.events.some(event => event.sequence > page.nextCursor))
    throw new Error("Invalid completion page cursor");
  await deps.set(activeKey, page.storeId);
  let dispatched = 0;
  for (const event of page.events.slice(0, 50)) {
    if (
      !Number.isSafeInteger(event.sequence) ||
      event.sequence <= cursor ||
      event.run.status === "running"
    ) {
      throw new Error("Invalid completion notification sequence or status");
    }
    const run = event.run;
    const speed = (value: number | null) =>
      value === null ? "n/a" : `${(value / 1_000_000).toFixed(2)} Mbps`;
    await deps.notify(
      `Bandwidth test ${run.status}: ${run.job.name}`,
      `${run.job.source} → ${run.job.destination} · ${run.trigger}\nTX ${speed(run.txBps)} · RX ${speed(run.rxBps)}${run.message ? `\n${run.message}` : ""}`,
      `${namespace}:${page.storeId}:${run.id}`,
    );
    await deps.set(cursorKey(page.storeId), String(event.sequence));
    cursor = event.sequence;
    dispatched++;
  }
  // Filtered-out entries still consume sequence numbers; advance only after all visible dispatches succeed.
  await deps.set(cursorKey(page.storeId), String(page.nextCursor));
  return { dispatched, hasMore: page.hasMore || page.events.length > 50 };
}
