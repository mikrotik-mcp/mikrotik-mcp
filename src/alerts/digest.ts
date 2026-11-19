/**
 * The daily digest: one message a day that sums up the alerts of the last 24
 * hours, sent on the channels the operator chose. PURE except `runDigest`.
 */
import type { AlertNotification } from "./channels";
import type { ChannelName } from "./model";
import type { AlertRecord } from "./store";

export interface DigestConfig {
  enabled?: boolean;
  /** Local hour of the day (0-23) at which the digest is sent. */
  hour?: number;
  channels?: ChannelName[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const day = (at: number): string => {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/** True once a day: at or after `hour`, when no digest was sent on this day yet. */
export function digestDue(lastSentAt: number | undefined, now: number, hour: number): boolean {
  if (new Date(now).getHours() < hour) return false;
  return lastSentAt === undefined || day(lastSentAt) !== day(now);
}

/** The digest of the alerts in `records` (newest first, as the store lists them). */
export function buildDigest(records: AlertRecord[], now: number): AlertNotification {
  const fired = records.filter((r) => r.kind === "fire");
  const byRule = new Map<string, { title: string; count: number; devices: Set<string> }>();
  for (const record of fired) {
    const entry = byRule.get(record.ruleId) ?? {
      title: record.title,
      count: 0,
      devices: new Set<string>(),
    };
    entry.count += 1;
    if (record.device) entry.devices.add(record.device);
    byRule.set(record.ruleId, entry);
  }
  const failed = records.filter((r) => r.deliveries.some((d) => !d.ok)).length;
  const lines = Array.from(byRule.values())
    .sort((a, b) => b.count - a.count)
    .map(
      (e) =>
        `${e.count}× ${e.title}${e.devices.size > 0 ? ` (${Array.from(e.devices).join(", ")})` : ""}`,
    );
  const worst = (["critical", "high", "medium", "low"] as const).find((severity) =>
    fired.some((r) => r.severity === severity),
  );
  return {
    ruleId: "daily-digest",
    severity: worst ?? "low",
    kind: "resolve",
    title:
      fired.length === 0
        ? "Daily digest: no alerts in the last 24 hours"
        : `Daily digest: ${fired.length} alert(s) from ${byRule.size} rule(s)`,
    body: [
      ...lines,
      ...(failed > 0 ? [`${failed} alert(s) had a delivery that failed.`] : []),
    ].join("\n"),
    at: now,
  };
}

let lastSentAt: number | undefined;

/** Forget when the last digest went out (tests only). */
export function resetDigest(): void {
  lastSentAt = undefined;
}

/**
 * Send the digest when it is due. `history` and `send` come from the engine, so
 * this file stays free of the store and the network.
 */
export async function runDigest(
  cfg: DigestConfig | undefined,
  now: number,
  history: (sinceMs: number) => Promise<AlertRecord[]>,
  send: (channels: ChannelName[], n: AlertNotification) => void,
): Promise<boolean> {
  if (!cfg?.enabled || !cfg.channels?.length) return false;
  if (!digestDue(lastSentAt, now, cfg.hour ?? 8)) return false;
  // Marked before the read: a failing history read must not retry every tick.
  lastSentAt = now;
  const records = (await history(now - DAY_MS)).filter((r) => r.ruleId !== "daily-digest");
  send(cfg.channels, buildDigest(records, now));
  return true;
}
