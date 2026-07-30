/**
 * The routing decision. PURE.
 *
 * RouterOS picks a route the way every IP stack does — longest prefix first,
 * then lowest distance — with two wrinkles that matter for a simulator:
 *
 * 1. **Connected routes are derived, not exported.** They come from `/ip
 *    address` and sit at distance 0. A model without them sends LAN traffic out
 *    of the default gateway, which is the most obvious possible way to be wrong.
 * 2. **Equal-cost routes are a hash decision, not a choice.** When two routes
 *    tie on prefix AND distance, which one a flow takes depends on a
 *    per-connection hash the model cannot see. Both are reported and the verdict
 *    is `UNKNOWN` — guessing one would be a confident answer that is right half
 *    the time.
 */
import { formatIp, inCidr, parseIp } from "./ip";
import type { SimModel, SimRoute } from "./model";

export type RouteOutcome =
  | "routed"
  /** Matched a blackhole/unreachable/prohibit route — the packet is discarded. */
  | "discard"
  /** No route at all. */
  | "no-route"
  /** Several equally-good routes; the choice is a per-connection hash. */
  | "ecmp";

export interface RouteDecision {
  outcome: RouteOutcome;
  /** The selected route, when exactly one won. */
  route?: SimRoute;
  /** Every route that tied for the win — length > 1 only for `ecmp`. */
  candidates: SimRoute[];
  /** Egress interface, when it could be determined. */
  outInterface?: string;
  /** Next-hop gateway address, when the route has one. */
  gateway?: string;
  /** Human-readable explanation, for the traversal output. */
  reason: string;
}

/** Routes eligible for selection in one table: enabled, and in that table. */
function eligible(model: SimModel, table: string): SimRoute[] {
  return model.routes.filter((r) => !r.disabled && r.table === table);
}

/**
 * Resolve the egress interface of a route.
 *
 * A gateway that is an interface name resolves directly. A gateway that is an
 * ADDRESS resolves through the connected networks — which is exactly the
 * recursive next-hop lookup the device performs, limited here to one level
 * because a gateway reachable only via another static route is rare and worth
 * reporting rather than guessing.
 */
function egressFor(model: SimModel, route: SimRoute): { iface?: string; note?: string } {
  if (route.kind === "connected") return { iface: route.interface };
  if (route.interface) return { iface: route.interface };
  if (!route.gateway) return {};

  const gatewayIp = parseIp(route.gateway.split(",")[0] ?? "");
  if (gatewayIp === null) {
    // An interface name that is not a known interface, or something exotic.
    return { iface: route.gateway, note: `gateway '${route.gateway}' is not a known address` };
  }
  const connected = model.addresses.find((a) => !a.disabled && inCidr(gatewayIp, a.network));
  if (connected) return { iface: connected.interface };
  return {
    note: `gateway ${formatIp(gatewayIp)} is not on any connected network — it resolves through another route, which v1 does not follow`,
  };
}

/**
 * Select a route for `dstAddress` in `table`.
 *
 * `table` defaults to `main`; a routing mark selects an alternate table, which
 * is how policy routing shows up in a trace.
 */
export function selectRoute(model: SimModel, dstAddress: string, table = "main"): RouteDecision {
  const dst = parseIp(dstAddress);
  if (dst === null) {
    return {
      outcome: "no-route",
      candidates: [],
      reason: `destination '${dstAddress}' is not an IPv4 address (v1 models IPv4 only)`,
    };
  }

  const matching = eligible(model, table).filter((r) => inCidr(dst, r.dst));
  if (matching.length === 0) {
    const hint =
      table === "main"
        ? ""
        : ` in routing table '${table}'${eligible(model, "main").length > 0 ? " (the main table has routes; a routing mark selected this one)" : ""}`;
    return {
      outcome: "no-route",
      candidates: [],
      reason: `no route to ${dstAddress}${hint}`,
    };
  }

  // Longest prefix first, then lowest distance. Both are hard rules in the
  // device; neither is a heuristic.
  const longest = Math.max(...matching.map((r) => r.dst.prefix));
  const byPrefix = matching.filter((r) => r.dst.prefix === longest);
  const bestDistance = Math.min(...byPrefix.map((r) => r.distance));
  const winners = byPrefix.filter((r) => r.distance === bestDistance);

  const first = winners[0];
  if (first.kind !== "static" && first.kind !== "connected") {
    return {
      outcome: "discard",
      route: first,
      candidates: winners,
      reason: `${first.dst.text} is a ${first.kind} route — the packet is discarded by the routing decision`,
    };
  }

  if (winners.length > 1) {
    // Same prefix, same distance: ECMP. The device hashes per connection.
    return {
      outcome: "ecmp",
      candidates: winners,
      reason:
        `${winners.length} equal-cost routes to ${dstAddress} (${first.dst.text}, distance ${bestDistance}) — ` +
        "which one a flow uses is a per-connection hash this model cannot reproduce",
    };
  }

  const { iface, note } = egressFor(model, first);
  const via = iface ? ` via ${iface}` : "";
  const gw = first.gateway ? ` gateway ${first.gateway}` : "";
  const checkGw = first.checkGateway
    ? ` (check-gateway=${first.checkGateway}: the device may have deactivated this route; the export cannot say)`
    : "";
  return {
    outcome: "routed",
    route: first,
    candidates: winners,
    outInterface: iface,
    gateway: first.gateway,
    reason:
      `${dstAddress} → ${first.dst.text}${gw}${via} ` +
      `(${first.kind}, distance ${first.distance}${first.table === "main" ? "" : `, table ${first.table}`})` +
      `${checkGw}${note ? ` — ${note}` : ""}`,
  };
}

/**
 * Which interface would a packet FROM this address arrive on, per the connected
 * networks? Used to sanity-check a declared `inInterface` and to decide whether
 * a destination is local to the router.
 */
export function interfaceForAddress(model: SimModel, address: string): string | undefined {
  const ip = parseIp(address);
  if (ip === null) return undefined;
  return model.addresses.find((a) => !a.disabled && inCidr(ip, a.network))?.interface;
}

/** Is this address one of the router's OWN addresses? (input vs forward chain.) */
export function isLocalAddress(model: SimModel, address: string): boolean {
  const ip = parseIp(address);
  if (ip === null) return false;
  return model.addresses.some((a) => !a.disabled && a.address === ip);
}
