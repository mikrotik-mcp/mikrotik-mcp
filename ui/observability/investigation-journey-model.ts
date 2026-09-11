/** Interpret saved records only. Route ranking is conditional, never proof of a captured flow. */
import type { Investigation } from "../../src/investigations/model";
import { inCidr, parseCidr, parseIp } from "../../src/sim/ip";
import { tunnelInventory } from "./investigation-visual-model";

export interface JourneyRoute {
  key: string;
  row: Record<string, string>;
  table: string;
  prefix: number | null;
  distance: number | null;
  match: "yes" | "no" | "unknown";
  availability: "active" | "inactive" | "unknown";
  interfaces: string[];
  resolution: "explicit" | "subnet" | "unknown";
  tunnelNames: string[];
  best: boolean;
}
const yes = (v?: string) => v === "yes" || v === "true";
function cidr(raw: string) {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}(?:\/(?:\d|[12]\d|3[0-2]))?$/.test(raw)) return null;
  return parseCidr(raw);
}
function rows(c: Investigation, source: string) {
  return c.evidence
    .filter((e) => e.device === c.device && e.source === source && e.state === "observed")
    .flatMap((e) => e.rows);
}
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

export function journeyModel(c: Investigation, destination: string, assumedTable: string) {
  const ip = parseIp(destination);
  const bridgeRows = rows(c, "bridge-host");
  const physical = unique(bridgeRows.map((r) => r["on-interface"]));
  const logical = unique([
    ...bridgeRows.map((r) => r.bridge),
    ...rows(c, "arp").map((r) => r.interface),
  ]);
  const interfaces = rows(c, "interfaces");
  const completeAddresses = c.evidence.some(
    (e) =>
      e.device === c.device &&
      e.source === "ip-addresses" &&
      e.state === "observed" &&
      !e.truncated,
  );
  const addresses = (completeAddresses ? rows(c, "ip-addresses") : []).filter(
    (r) => !yes(r.disabled) && !(r.flags ?? "").includes("X"),
  );
  const tunnels = tunnelInventory(c).filter((t) => t.device === c.device);
  const routeRows = rows(c, "routes");
  const tables = unique(routeRows.map((r) => r["routing-table"] || "main")).sort();
  const routes: JourneyRoute[] = routeRows.map((r, i) => {
    const network = cidr(r["dst-address"] ?? "");
    const distance = r.distance?.trim() && /^\d+$/.test(r.distance) ? Number(r.distance) : null;
    const availability =
      yes(r.disabled) ||
      (r.flags ?? "").includes("X") ||
      r.active === "no" ||
      r.active === "false" ||
      (r.flags ?? "").includes("I")
        ? "inactive"
        : yes(r.active) || (r.flags ?? "").includes("A")
          ? "active"
          : "unknown";
    // Prefer a resolved immediate gateway. IP-only gateways may be linked by a unique connected subnet.
    const gateways = (r["immediate-gw"] || r.gateway || "")
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean);
    const exits: string[] = [];
    let inferred = false;
    let unresolved = !gateways.length;
    for (const gateway of gateways) {
      const scoped = gateway.includes("%") ? gateway.split("%")[1] : gateway;
      if (interfaces.some((iface) => iface.name === scoped)) {
        exits.push(scoped);
        continue;
      }
      const gw = parseIp(gateway);
      if (gw === null) {
        unresolved = true;
        continue;
      }
      const possible = addresses
        .map((a) => ({ a, network: cidr(a.address ?? "") }))
        .filter(
          ({ a, network }) =>
            network &&
            (inCidr(gw, network) || (network.prefix === 32 && parseIp(a.network ?? "") === gw)),
        );
      const longest = Math.max(-1, ...possible.map((p) => p.network!.prefix));
      const names = unique(
        possible.filter((p) => p.network!.prefix === longest).map((p) => p.a.interface),
      );
      if (names.length === 1 && interfaces.some((iface) => iface.name === names[0])) {
        exits.push(names[0]);
        inferred = true;
      } else unresolved = true;
    }
    return {
      key: `${c.device}:${i}`,
      row: r,
      table: r["routing-table"] || "main",
      prefix: network?.prefix ?? null,
      distance,
      match: ip === null || !network ? "unknown" : inCidr(ip, network) ? "yes" : "no",
      availability,
      interfaces: unique(exits),
      resolution: unresolved ? "unknown" : inferred ? "subnet" : "explicit",
      tunnelNames: unique(exits).filter((name) => tunnels.some((t) => t.name === name)),
      best: false,
    };
  });
  const matching = routes.filter(
    (r) => r.table === assumedTable && r.match === "yes" && r.availability !== "inactive",
  );
  const longest = Math.max(-1, ...matching.map((r) => r.prefix ?? -1));
  const longestMatches = matching.filter((r) => r.prefix === longest);
  // Missing distance, unsupported rows or truncated evidence invalidate ranking, not just presentation.
  const incomplete =
    c.evidence.some(
      (e) =>
        e.device === c.device && e.source === "routes" && (e.truncated || e.state !== "observed"),
    ) || routes.some((r) => r.table === assumedTable && r.match === "unknown");
  const canRank =
    !incomplete && longestMatches.length > 0 && longestMatches.every((r) => r.distance !== null);
  if (canRank) {
    const distance = Math.min(...longestMatches.map((r) => r.distance!));
    for (const r of longestMatches) r.best = r.distance === distance;
  }
  const policySources = ["mangle", "routing-rules"].map((source) => ({
    source,
    captured: c.evidence.some(
      (e) => e.device === c.device && e.source === source && e.state === "observed" && !e.truncated,
    ),
    rows: rows(c, source),
  }));
  return {
    physical,
    logical,
    routes,
    tables,
    tunnels,
    interfaces,
    policySources,
    destinationValid: ip !== null,
    routesIncomplete: incomplete,
    best: routes.filter((r) => r.best),
    addressEvidence: c.evidence.some(
      (e) =>
        e.device === c.device &&
        e.source === "ip-addresses" &&
        e.state === "observed" &&
        !e.truncated,
    ),
  };
}
