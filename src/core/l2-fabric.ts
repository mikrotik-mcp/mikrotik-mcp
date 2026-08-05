/**
 * Port-level Layer-2 fabric: which host sits on which physical port.
 *
 * `src/observability/topology.ts` already stitches `/ip neighbor` into a
 * device↔device map — that answers "what routers are adjacent". It cannot
 * answer the question an operator actually asks at the rack: *"my printer is
 * 192.168.1.40 — which switch port is it plugged into?"*, because MNDP only
 * sees other MikroTik/CDP/LLDP speakers, and an ordinary host announces nothing.
 *
 * The bridge host table does see them. Every frame that crosses a bridge
 * teaches it `MAC → port`, so `/interface bridge host` is a live inventory of
 * every host on the fabric, keyed by MAC. On its own that is a wall of hex; it
 * becomes useful when joined with the tables that give a MAC a *name*:
 *
 *   • ARP (`/ip arp`)            → MAC's IPv4 address
 *   • DHCP leases                → hostname the client asked for
 *   • `/ip neighbor`             → identity/board, if it is a managed device
 *   • the OUI prefix             → hardware vendor, for everything else
 *
 * The result is per-port occupancy: what is on each port, how many hosts, and
 * whether a port is an uplink (many MACs) or an access port (one). That last
 * distinction is derived, not configured, and it is what makes the output
 * readable on a real switch.
 *
 * Pure — no SSH, no Bun, no clock. Collection lives in the tool layer.
 */

// ── Inputs ──────────────────────────────────────────────────────────────────

/** One row of `/interface bridge host print detail`. */
export interface BridgeHost {
  mac: string;
  /** The bridge port the MAC was learned on. */
  onInterface: string;
  bridge?: string;
  /** RouterOS `local=yes` — the bridge's OWN address, not an attached host. */
  local: boolean;
  /** RouterOS `external=yes` — learned by switch hardware offload. */
  external?: boolean;
  /** `D` flag: dynamically learned (the normal case) vs a static entry. */
  dynamic?: boolean;
}

/** One row of `/ip arp print detail`. */
export interface ArpEntry {
  mac: string;
  address: string;
  interface?: string;
  complete?: boolean;
}

/** One row of `/ip dhcp-server lease print detail`. */
export interface DhcpLease {
  mac: string;
  address?: string;
  hostname?: string;
  comment?: string;
  /** `bound` / `waiting` / etc. */
  status?: string;
}

/** The subset of `/ip neighbor` this join needs. */
export interface FabricNeighbor {
  mac?: string;
  identity?: string;
  board?: string;
  platform?: string;
  interface?: string;
}

export interface FabricInput {
  /** Device config key this fabric was read from. */
  device: string;
  hosts: BridgeHost[];
  arp: ArpEntry[];
  leases: DhcpLease[];
  neighbors: FabricNeighbor[];
  /**
   * OUI prefix → vendor. Optional; callers pass {@link DEFAULT_OUI} or a larger
   * table. Keys are the first 6 hex digits, uppercase, no separators.
   */
  ouiTable?: Record<string, string>;
}

// ── Outputs ─────────────────────────────────────────────────────────────────

/** How a host's name was resolved — shown so a guess is never mistaken for fact. */
export type NameSource = "dhcp" | "neighbor" | "arp" | "vendor" | "none";

export interface FabricHost {
  /** Normalised `AA:BB:CC:DD:EE:FF`. */
  mac: string;
  /** Best available label: hostname → identity → IP → vendor → the MAC. */
  label: string;
  nameSource: NameSource;
  ip?: string;
  hostname?: string;
  /** RouterOS identity, when this host is itself a discovered network device. */
  identity?: string;
  board?: string;
  vendor?: string;
  /** True when the MAC matched a `/ip neighbor` entry — a managed device. */
  isNetworkDevice: boolean;
  /** True when DHCP has a lease for it (so it is a known, addressed client). */
  hasLease: boolean;
  dynamic?: boolean;
}

/**
 * A port's role, derived from occupancy rather than configuration.
 *
 * The heuristic is deliberately simple and stated in the output: a port with
 * many MACs behind it is carrying someone else's traffic (an uplink or a
 * downstream switch); a port with exactly one is an access port. `hybrid` is
 * the ambiguous middle where a small unmanaged switch or a VM host lives.
 */
export type PortRole = "access" | "uplink" | "hybrid" | "empty";

export interface FabricPort {
  /** Bridge port / interface name, e.g. `ether5`. */
  interface: string;
  bridge?: string;
  role: PortRole;
  hostCount: number;
  hosts: FabricHost[];
  /** Set when a discovered network device sits on this port (a real uplink). */
  peerIdentity?: string;
}

export interface FabricMap {
  device: string;
  ports: FabricPort[];
  stats: {
    ports: number;
    hosts: number;
    accessPorts: number;
    uplinks: number;
    /** Hosts with no DHCP lease and no ARP entry — seen, but unidentified. */
    unidentified: number;
  };
  /** MACs the bridge reported as its own (`local=yes`), excluded from ports. */
  localMacs: string[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Uppercase hex, no separators — the join key for every table. */
export function macKey(mac: string | undefined): string | undefined {
  if (!mac) return undefined;
  const hex = mac.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  return hex.length === 12 ? hex : undefined;
}

/** Render a join key back as `AA:BB:CC:DD:EE:FF`. */
function formatMac(key: string): string {
  return (key.match(/../g) ?? []).join(":");
}

/**
 * A small OUI table covering the vendors that dominate a typical MikroTik
 * fabric. Intentionally not the full IEEE registry — that is a 30 000-line
 * dataset to ship for a cosmetic label. Unknown prefixes simply yield no
 * vendor, which the UI renders as the bare MAC.
 */
export const DEFAULT_OUI: Record<string, string> = {
  "4C5E0C": "MikroTik",
  "6C3B6B": "MikroTik",
  "48A98A": "MikroTik",
  "2CC81B": "MikroTik",
  DC2C6E: "MikroTik",
  "18FD74": "MikroTik",
  E48D8C: "Routerboard",
  "000C42": "Routerboard",
  "001122": "CIMSYS",
  F09FC2: "Ubiquiti",
  "24A43C": "Ubiquiti",
  "788A20": "Ubiquiti",
  "002590": "Supermicro",
  "3C0754": "Apple",
  A45E60: "Apple",
  F0189E: "Apple",
  "001C42": "Parallels",
  "080027": "VirtualBox",
  "005056": "VMware",
  "000C29": "VMware",
  "0242AC": "Docker",
  B827EB: "Raspberry Pi",
  DCA632: "Raspberry Pi",
  E45F01: "Raspberry Pi",
  "001B63": "Apple",
  "3CD92B": "HP",
  "9C8ECD": "HP",
  "00155D": "Microsoft Hyper-V",
};

function vendorOf(key: string, table: Record<string, string>): string | undefined {
  return table[key.slice(0, 6)];
}

/**
 * Classify a port from its host count.
 *
 * The uplink threshold is 4 rather than 2 because a single access port
 * legitimately shows a handful of MACs — a laptop with a VM, a phone tethering,
 * a desk switch under someone's monitor. Calling those uplinks would mislabel
 * most of a real access layer.
 */
function classify(hostCount: number, hasPeerDevice: boolean): PortRole {
  if (hostCount === 0) return "empty";
  if (hasPeerDevice || hostCount > 4) return "uplink";
  if (hostCount === 1) return "access";
  return "hybrid";
}

// ── Build ───────────────────────────────────────────────────────────────────

/**
 * Join the bridge host table with ARP, DHCP and neighbour data into per-port
 * occupancy.
 *
 * Total and order-independent: rows that cannot be keyed to a MAC are dropped
 * rather than throwing, and a MAC seen on two ports (mid-roam, or a flapping
 * link) lands on the LAST port reported, matching how the bridge itself
 * resolves the ambiguity.
 */
export function buildFabricMap(input: FabricInput): FabricMap {
  const oui = input.ouiTable ?? DEFAULT_OUI;

  // ── 1. Index the naming tables by MAC ──
  const ipByMac = new Map<string, string>();
  for (const a of input.arp) {
    const k = macKey(a.mac);
    if (k && a.address) ipByMac.set(k, a.address);
  }
  const leaseByMac = new Map<string, DhcpLease>();
  for (const l of input.leases) {
    const k = macKey(l.mac);
    if (k) leaseByMac.set(k, l);
  }
  const neighborByMac = new Map<string, FabricNeighbor>();
  for (const n of input.neighbors) {
    const k = macKey(n.mac);
    if (k) neighborByMac.set(k, n);
  }

  // ── 2. Walk the bridge host table into per-port buckets ──
  const byPort = new Map<string, { bridge?: string; hosts: Map<string, FabricHost> }>();
  const localMacs: string[] = [];
  let unidentified = 0;

  for (const h of input.hosts) {
    const key = macKey(h.mac);
    if (!key) continue;
    if (h.local) {
      // The bridge's own MAC is not a host ON a port — listing it would put a
      // phantom device on every port of every switch.
      localMacs.push(formatMac(key));
      continue;
    }
    if (!h.onInterface) continue;

    const lease = leaseByMac.get(key);
    const neighbor = neighborByMac.get(key);
    const ip = lease?.address ?? ipByMac.get(key);
    const vendor = vendorOf(key, oui);
    const hostname = lease?.hostname?.trim() || undefined;

    let label: string;
    let nameSource: NameSource;
    if (hostname) {
      label = hostname;
      nameSource = "dhcp";
    } else if (neighbor?.identity) {
      label = neighbor.identity;
      nameSource = "neighbor";
    } else if (ip) {
      label = ip;
      nameSource = "arp";
    } else if (vendor) {
      label = `${vendor} device`;
      nameSource = "vendor";
    } else {
      label = formatMac(key);
      nameSource = "none";
    }
    if (!hostname && !ip && !neighbor) unidentified++;

    const port = byPort.get(h.onInterface) ?? { bridge: h.bridge, hosts: new Map() };
    port.bridge ??= h.bridge;
    port.hosts.set(key, {
      mac: formatMac(key),
      label,
      nameSource,
      ip,
      hostname,
      identity: neighbor?.identity,
      board: neighbor?.board,
      vendor,
      isNetworkDevice: neighbor !== undefined,
      hasLease: lease !== undefined,
      dynamic: h.dynamic,
    });
    byPort.set(h.onInterface, port);
  }

  // ── 3. Classify and sort ──
  const ports: FabricPort[] = [];
  for (const [iface, bucket] of byPort) {
    const hosts = [...bucket.hosts.values()].sort((a, b) => a.label.localeCompare(b.label));
    const peer = hosts.find((h) => h.isNetworkDevice);
    ports.push({
      interface: iface,
      bridge: bucket.bridge,
      role: classify(hosts.length, peer !== undefined),
      hostCount: hosts.length,
      hosts,
      peerIdentity: peer?.identity,
    });
  }
  // Busiest ports first — an uplink carrying 40 hosts is what you look at.
  ports.sort((a, b) => b.hostCount - a.hostCount || a.interface.localeCompare(b.interface));

  return {
    device: input.device,
    ports,
    stats: {
      ports: ports.length,
      hosts: ports.reduce((n, p) => n + p.hostCount, 0),
      accessPorts: ports.filter((p) => p.role === "access").length,
      uplinks: ports.filter((p) => p.role === "uplink").length,
      unidentified,
    },
    localMacs,
  };
}

/**
 * Locate one host on the fabric by MAC, IP or hostname substring.
 *
 * This is the "which port is it plugged into" lookup, and it is a separate
 * entry point because the answer is a single row rather than a map — the caller
 * wants a sentence, not a table.
 */
export function findHost(map: FabricMap, query: string): { port: FabricPort; host: FabricHost }[] {
  const q = query.trim().toLowerCase();
  const asMac = macKey(query);
  const hits: { port: FabricPort; host: FabricHost }[] = [];
  for (const port of map.ports) {
    for (const host of port.hosts) {
      const macMatches = asMac !== undefined && macKey(host.mac) === asMac;
      const matches =
        macMatches ||
        host.mac.toLowerCase().includes(q) ||
        (host.ip?.toLowerCase().includes(q) ?? false) ||
        (host.hostname?.toLowerCase().includes(q) ?? false) ||
        (host.identity?.toLowerCase().includes(q) ?? false) ||
        host.label.toLowerCase().includes(q);
      if (matches) hits.push({ port, host });
    }
  }
  return hits;
}
