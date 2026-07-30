/**
 * What is this box FOR? PURE.
 *
 * The first question anyone asks about an inherited router, and the one the
 * config answers only indirectly. So this is an explicit, inspectable scored
 * signal table rather than a heuristic buried in prose: every role reports the
 * signals that produced it, because a wrong inference the reader can see the
 * reasoning for is debuggable, and a wrong inference they cannot is just wrong.
 *
 * Multiple roles are normal and expected — a home router is edge + wireless +
 * switch at once, and forcing a single answer would be less true, not simpler.
 */
import { recordsOf, settingsOf } from "../policy/parse";
import type { ConfigModel } from "../policy/parse";

export type DeviceRole =
  | "edge-router"
  | "wireless-controller"
  | "switch"
  | "vpn-concentrator"
  | "border-router"
  | "application-host";

export const ROLE_LABEL: Record<DeviceRole, string> = {
  "edge-router": "Edge router",
  "wireless-controller": "Wireless controller",
  switch: "Switch",
  "vpn-concentrator": "VPN concentrator",
  "border-router": "Border router",
  "application-host": "Application host",
};

export interface RoleSignal {
  /** What was found in the config, in the reader's words. */
  signal: string;
  role: DeviceRole;
  /** How strongly this one signal argues for the role. */
  weight: number;
  /** Where it was found, so the claim can be checked. */
  section: string;
}

export interface ScoredRole {
  role: DeviceRole;
  label: string;
  score: number;
  signals: RoleSignal[];
}

export interface RoleReport {
  /** Highest-scoring role, or `null` when nothing recognisable was found. */
  primary: ScoredRole | null;
  /** Every other role that scored, strongest first. */
  secondary: ScoredRole[];
  /** Every signal considered, including those for roles that did not win. */
  signals: RoleSignal[];
}

function isDefaultRoute(dst: string | undefined): boolean {
  return dst === "0.0.0.0/0" || dst === "0.0.0.0/1" || dst === "128.0.0.0/1";
}

/**
 * Private ASNs are 64512–65534 and 4200000000–4294967294; anything else on a
 * BGP peer means the box talks to somebody else's network, which is the whole
 * distinction between a border router and an internal one.
 */
function isExternalAsn(value: string | undefined): boolean {
  const asn = Number(value);
  if (!Number.isFinite(asn) || asn <= 0) return false;
  if (asn >= 64512 && asn <= 65534) return false;
  if (asn >= 4_200_000_000 && asn <= 4_294_967_294) return false;
  return true;
}

/** Collect every role signal the config supports. */
export function roleSignals(model: ConfigModel): RoleSignal[] {
  const signals: RoleSignal[] = [];
  const add = (signal: string, role: DeviceRole, weight: number, section: string): void => {
    signals.push({ signal, role, weight, section });
  };

  // ── Edge router ─────────────────────────────────────────────────────────
  const routes = recordsOf(model, "/ip/route").filter((r) => r.op === "add");
  const defaultRoutes = routes.filter((r) => isDefaultRoute(r.fields["dst-address"]));
  const nat = recordsOf(model, "/ip/firewall/nat").filter((r) => r.op === "add");
  const masquerade = nat.filter(
    (r) =>
      r.fields.chain === "srcnat" &&
      (r.fields.action === "masquerade" || r.fields.action === "src-nat"),
  );
  if (defaultRoutes.length > 0 && masquerade.length > 0) {
    add(
      `${defaultRoutes.length} default route(s) plus source NAT — traffic leaves through this box`,
      "edge-router",
      5,
      "/ip/route",
    );
  } else if (masquerade.length > 0) {
    // NAT with no default route in the export is the DHCP-WAN case: the route
    // is learned at runtime and simply is not in the file.
    add(
      "source NAT with no static default route (a DHCP/PPPoE WAN would learn one at runtime)",
      "edge-router",
      3,
      "/ip/firewall/nat",
    );
  } else if (defaultRoutes.length > 0) {
    add("a default route, but no source NAT", "edge-router", 2, "/ip/route");
  }
  if (defaultRoutes.length > 1) {
    add(
      `${defaultRoutes.length} default routes — multi-WAN or failover`,
      "edge-router",
      2,
      "/ip/route",
    );
  }
  const dhcpClients = recordsOf(model, "/ip/dhcp-client").filter((r) => r.op === "add");
  if (dhcpClients.length > 0) {
    add(
      `${dhcpClients.length} DHCP client(s) — an upstream hands this box an address`,
      "edge-router",
      2,
      "/ip/dhcp-client",
    );
  }

  // ── Wireless controller ─────────────────────────────────────────────────
  for (const path of ["/interface/wifi/capsman", "/caps-man/manager"]) {
    const manager = settingsOf(model, path);
    if (manager && manager.fields.enabled !== "no") {
      add(
        "CAPsMAN manager is enabled — it configures other access points",
        "wireless-controller",
        5,
        path,
      );
    }
  }
  for (const path of ["/interface/wifi/configuration", "/caps-man/configuration"]) {
    const configs = recordsOf(model, path).filter((r) => r.op === "add");
    if (configs.length > 0) {
      add(`${configs.length} CAPsMAN wireless configuration(s)`, "wireless-controller", 3, path);
    }
  }
  const localWireless = [
    ...recordsOf(model, "/interface/wireless"),
    ...recordsOf(model, "/interface/wifi"),
  ].filter((r) => r.op === "add" || r.op === "set");
  if (localWireless.length > 0) {
    // Its own radios make it an AP, which is weaker evidence than managing
    // other people's radios.
    add(
      `${localWireless.length} local wireless interface(s)`,
      "wireless-controller",
      2,
      "/interface/wireless",
    );
  }

  // ── Switch ──────────────────────────────────────────────────────────────
  const bridgePorts = recordsOf(model, "/interface/bridge/port").filter((r) => r.op === "add");
  if (bridgePorts.length >= 3) {
    add(
      `${bridgePorts.length} bridge ports — it switches traffic between them`,
      "switch",
      3,
      "/interface/bridge/port",
    );
  }
  if (bridgePorts.length >= 3 && defaultRoutes.length === 0 && masquerade.length === 0) {
    add(
      "bridge ports with no routing or NAT at all — a pure layer-2 device",
      "switch",
      5,
      "/interface/bridge/port",
    );
  }
  const bridgeVlans = recordsOf(model, "/interface/bridge/vlan").filter((r) => r.op === "add");
  if (bridgeVlans.length > 0) {
    add(
      `${bridgeVlans.length} bridge VLAN(s) — 802.1Q switching`,
      "switch",
      2,
      "/interface/bridge/vlan",
    );
  }

  // ── VPN concentrator ────────────────────────────────────────────────────
  const pools = recordsOf(model, "/ip/pool").filter((r) => r.op === "add");
  const pppSecrets = recordsOf(model, "/ppp/secret").filter((r) => r.op === "add");
  const pppServers = ["l2tp-server", "pptp-server", "sstp-server", "ovpn-server"].filter((s) => {
    const server = settingsOf(model, `/interface/${s}/server`);
    return server?.fields.enabled === "yes";
  });
  if (pppServers.length > 0) {
    add(
      `${pppServers.join(", ")} enabled — remote users dial in`,
      "vpn-concentrator",
      4,
      "/interface",
    );
  }
  if (pppServers.length > 0 && pools.length > 0) {
    add("a PPP server with an address pool to hand out", "vpn-concentrator", 2, "/ip/pool");
  }
  if (pppSecrets.length > 0) {
    add(
      `${pppSecrets.length} PPP secret(s) — named VPN users`,
      "vpn-concentrator",
      2,
      "/ppp/secret",
    );
  }
  const wgPeers = recordsOf(model, "/interface/wireguard/peers").filter((r) => r.op === "add");
  if (wgPeers.length >= 3) {
    add(
      `${wgPeers.length} WireGuard peers — it is a hub, not a spoke`,
      "vpn-concentrator",
      3,
      "/interface/wireguard/peers",
    );
  }

  // ── Border router ───────────────────────────────────────────────────────
  const bgp = [
    ...recordsOf(model, "/routing/bgp/connection"),
    ...recordsOf(model, "/routing/bgp/peer"),
  ].filter((r) => r.op === "add");
  const externalPeers = bgp.filter((r) =>
    isExternalAsn(r.fields["remote.as"] ?? r.fields["remote-as"]),
  );
  if (externalPeers.length > 0) {
    add(
      `${externalPeers.length} BGP peer(s) with public ASNs — it exchanges routes with other networks`,
      "border-router",
      5,
      "/routing/bgp/connection",
    );
  } else if (bgp.length > 0) {
    add(
      `${bgp.length} BGP peer(s), private ASNs only — internal routing`,
      "border-router",
      2,
      "/routing/bgp/connection",
    );
  }
  const ospf = recordsOf(model, "/routing/ospf/instance").filter((r) => r.op === "add");
  if (ospf.length > 0) {
    add(
      `${ospf.length} OSPF instance(s) — dynamic interior routing`,
      "border-router",
      2,
      "/routing/ospf/instance",
    );
  }

  // ── Application host ────────────────────────────────────────────────────
  const containers = recordsOf(model, "/container").filter((r) => r.op === "add");
  if (containers.length > 0) {
    add(
      `${containers.length} container(s) — it runs software, not just packets`,
      "application-host",
      5,
      "/container",
    );
  }
  const disks = recordsOf(model, "/disk").filter((r) => r.op === "add" || r.op === "set");
  if (containers.length > 0 && disks.length > 0) {
    add("container storage on an attached disk", "application-host", 1, "/disk");
  }

  return signals;
}

/**
 * Score the signals into roles.
 *
 * The primary role is simply the highest total. Ties break toward the role with
 * the strongest single signal, so "CAPsMAN manager enabled" (5) beats three weak
 * two-pointers — a definitive fact should outrank an accumulation of hints.
 */
export function inferRoles(model: ConfigModel): RoleReport {
  const signals = roleSignals(model);
  const byRole = new Map<DeviceRole, RoleSignal[]>();
  for (const signal of signals) {
    const list = byRole.get(signal.role);
    if (list) list.push(signal);
    else byRole.set(signal.role, [signal]);
  }

  const scored: ScoredRole[] = [...byRole.entries()]
    .map(([role, roleSignalList]) => ({
      role,
      label: ROLE_LABEL[role],
      score: roleSignalList.reduce((n, s) => n + s.weight, 0),
      signals: roleSignalList,
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        Math.max(...b.signals.map((s) => s.weight)) - Math.max(...a.signals.map((s) => s.weight)) ||
        a.role.localeCompare(b.role),
    );

  return { primary: scored[0] ?? null, secondary: scored.slice(1), signals };
}
