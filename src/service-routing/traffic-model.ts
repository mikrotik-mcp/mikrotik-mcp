export interface RoutingTraffic {
  policyId: string;
  device: string;
  at: number;
  state: "ready" | "unavailable" | "inactive";
  detail: string;
  ruleId?: string;
  table?: string;
  /** Decimal strings preserve RouterOS 64-bit counters in JSON. */
  bytes?: string;
  packets?: string;
}
export interface RoutingRate {
  at: number;
  bps: number | null;
  reset: boolean;
}
/** A gap, new rule/table, reset or non-monotonic clock starts a new baseline. */
export function routingRate(
  previous: RoutingTraffic | undefined,
  next: RoutingTraffic,
): RoutingRate {
  const result: RoutingRate = { at: next.at, bps: null, reset: false };
  if (
    !previous ||
    previous.state !== "ready" ||
    next.state !== "ready" ||
    previous.policyId !== next.policyId ||
    previous.device !== next.device ||
    previous.ruleId !== next.ruleId ||
    previous.table !== next.table ||
    !/^\d+$/.test(previous.bytes ?? "") ||
    !/^\d+$/.test(next.bytes ?? "") ||
    !/^\d+$/.test(previous.packets ?? "") ||
    !/^\d+$/.test(next.packets ?? "")
  )
    return result;
  const elapsed = next.at - previous.at;
  if (elapsed <= 0 || elapsed > 30_000) return result;
  const delta = BigInt(next.bytes!) - BigInt(previous.bytes!);
  if (delta < 0n || BigInt(next.packets!) < BigInt(previous.packets!))
    return { ...result, reset: true };
  const bps = (Number(delta) * 8000) / elapsed;
  return { ...result, bps: Number.isFinite(bps) ? bps : null };
}
