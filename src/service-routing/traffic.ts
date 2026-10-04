import { Cmd, quoteValue } from "../core/routeros";
import { executeMikrotikCommand } from "../core/connector";
import type { ToolContext } from "../core/context";
import { ownerTag, routingPath, enabled } from "./model";
import type { RoutingPolicy } from "./model";
import { parseRoutingRows } from "./read";
import type { RoutingTraffic } from "./traffic-model";

/** Exact ownership only. Cast on the router before JSON serialization to avoid 2^53 precision loss. */
export function trafficCommand(policy: RoutingPolicy): string {
  const path = `${routingPath(policy.family)} mangle`;
  const find = new Cmd(`${path} find`)
    .raw(`where comment=${quoteValue(ownerTag(policy.id))} action=mark-routing`)
    .build();
  const get = new Cmd(`${path} get`).raw("$srId").build();
  return `{ :local srIds [${find}]; :if ([:len $srIds] > 1) do={:error "Ambiguous service routing counters"}; :local srItems [:toarray ""]; :foreach srId in=$srIds do={ :local srRow [${get}]; :set ($srRow->".id") $srId; :set ($srRow->"bytes") [:tostr [${get} bytes]]; :set ($srRow->"packets") [:tostr [${get} packets]]; :set ($srItems->[:len $srItems]) $srRow; }; :put [:serialize to=json options=json.no-string-conversion value=$srItems]; }`;
}

export function parsePolicyTraffic(policy: RoutingPolicy, raw: string, at: number): RoutingTraffic {
  if (raw.length > 32_768) throw new Error("Counter response exceeds the bounded read limit.");
  const rows = parseRoutingRows(raw);
  const row = rows[0];
  const base = { policyId: policy.id, device: policy.device, at };
  const encoded = JSON.parse(raw) as { bytes?: unknown; packets?: unknown }[];
  if (
    rows.length !== 1 ||
    !row ||
    !row[".id"] ||
    !enabled(row) ||
    row.comment !== ownerTag(policy.id) ||
    row.action !== "mark-routing" ||
    row.chain !== `sr-${policy.id.slice(0, 12)}` ||
    row["new-routing-mark"] !== policy.activeTable ||
    typeof encoded[0]?.bytes !== "string" ||
    typeof encoded[0]?.packets !== "string" ||
    !/^\d{1,20}$/.test(row.bytes ?? "") ||
    !/^\d{1,20}$/.test(row.packets ?? "")
  ) {
    return {
      ...base,
      state: "unavailable",
      detail:
        "The active owned rule or its counters could not be verified. Inspect router configuration; missing data is not zero.",
    };
  }
  return {
    ...base,
    state: "ready",
    ruleId: row[".id"],
    table: row["new-routing-mark"],
    bytes: row.bytes,
    packets: row.packets,
    detail:
      "Client → service packets matched by this routing mark, since router counter reset. Excludes return/download traffic; not proof of delivery or billing totals.",
  };
}

const cache = new Map<string, { expires: number; value: Promise<RoutingTraffic> }>();
export async function readPolicyTraffic(
  policy: RoutingPolicy,
  ctx: ToolContext,
): Promise<RoutingTraffic> {
  if (policy.state !== "active")
    return {
      policyId: policy.id,
      device: policy.device,
      at: Date.now(),
      state: "inactive",
      detail: "Apply and verify this policy before reading its router counters.",
    };
  const key = JSON.stringify([policy.device, policy.id, policy.activeTable, policy.lastSwitchAt]);
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  const value = (async () => {
    try {
      const raw = await executeMikrotikCommand(trafficCommand(policy), ctx, { maxMs: 6000 });
      return parsePolicyTraffic(policy, raw, Date.now());
    } catch {
      return {
        policyId: policy.id,
        device: policy.device,
        at: Date.now(),
        state: "unavailable" as const,
        detail:
          "Router counters could not be read. Check device connectivity and retry; no zero values were substituted.",
      };
    }
  })();
  cache.set(key, { value, expires: Date.now() + 10_000 });
  void value.finally(() => {
    const entry = cache.get(key);
    if (entry?.value === value) entry.expires = Date.now() + 4000;
  });
  return value;
}
