/**
 * `/export` → a structured description of what the router IS. PURE, no I/O.
 *
 * The economics are the point. `prompts/backup-and-document.md` already asks a
 * model to describe a router, and it works — by pouring three thousand lines of
 * export into the context window every time, unrepeatably. This pre-digests the
 * config into a compact model of facts, so the model receives an analysed
 * document instead of raw text and the result is deterministic enough to diff
 * between two dates.
 *
 * Division of labour: **this decides what is true and what matters; the model
 * decides how to say it.**
 *
 * The discipline from `docs/tasks/08` carries over: anything the analyser did
 * not recognise lands in `unknowns[]` and is stated in the output. A document
 * about an inherited router that silently omits the part nobody understood is
 * the single most dangerous thing this feature could produce.
 */
import { normalizeSection, parseExport, recordsOf, settingsOf } from "../policy/parse";
import type { ConfigModel, ConfigRecord } from "../policy/parse";
import { formatIp, hostOf, inCidr, parseCidr } from "../sim/ip";
import { inferRoles } from "./roles";
import type { RoleReport } from "./roles";

// ── The model ───────────────────────────────────────────────────────────────

export interface NarrativeIdentity {
  name?: string;
  /** RouterOS version, when the export's header carries one. */
  version?: string;
  model?: string;
  /** When the export was taken, from its header comment. */
  exportedAt?: string;
  roles: RoleReport;
}

export interface NarrativeInterface {
  name: string;
  /** `ethernet`, `bridge`, `vlan`, `wireguard`, `wifi`, … */
  kind: string;
  /** For a VLAN: its id and parent. For a bridge port: its bridge. */
  parent?: string;
  vlanId?: number;
  /** Interface lists this interface belongs to (LAN/WAN and friends). */
  lists: string[];
  addresses: string[];
  comment?: string;
  disabled: boolean;
  /** What this interface appears to be for, in one phrase. */
  purpose?: string;
}

export interface NarrativeSubnet {
  cidr: string;
  interface: string;
  /** The router's own address on this subnet. */
  routerAddress: string;
  /** DHCP scope serving it, if any. */
  dhcp?: { server: string; pool?: string; ranges: string[]; gateway?: string; dns?: string };
  /** Static DHCP reservations on this subnet. */
  reservations: { address: string; macAddress?: string; comment?: string }[];
  vlanId?: number;
}

export interface NarrativeWan {
  interface: string;
  /** `static`, `dhcp`, `pppoe`, or `unknown`. */
  addressing: string;
  address?: string;
  gateway?: string;
  distance?: number;
  /** `masquerade`, `src-nat to <ip>`, or `none`. */
  nat: string;
  checkGateway?: string;
}

export interface NarrativeChain {
  chain: string;
  table: "filter" | "nat" | "mangle";
  /** Rule count, including disabled ones. */
  ruleCount: number;
  disabledCount: number;
  /** What the last matching rule does when nothing above matched. */
  defaultAction: "accept" | "drop" | "reject" | "unknown";
  /** One plain sentence per rule, in evaluation order. */
  summary: string[];
}

export interface NarrativeExposure {
  /** What is reachable: a service name or a forwarded port. */
  what: string;
  /** `service`, `dst-nat`, or `firewall-accept`. */
  kind: string;
  /** Ports/protocol involved. */
  detail: string;
  /** Which addresses may reach it — `anyone` when unrestricted. */
  from: string;
  /** Worse when the whole internet can reach it. */
  severity: "critical" | "high" | "medium" | "low";
  line: number;
}

export interface NarrativeTunnel {
  name: string;
  kind: string;
  /** Remote endpoint(s), where the config names them. */
  peers: string[];
  /** Subnets carried, from allowed-address / policy config. */
  subnets: string[];
  disabled: boolean;
  comment?: string;
}

export interface NarrativeService {
  name: string;
  enabled: boolean;
  port?: string;
  /** `address=` restriction, or undefined when it accepts from anywhere. */
  availableFrom?: string;
}

export interface NarrativeUnknown {
  section: string;
  what: string;
  line: number;
  detail?: string;
}

export interface DeviceNarrative {
  device?: string;
  /** When the analysis ran, stamped by the caller (kept out of the pure core). */
  generatedAt?: number;
  identity: NarrativeIdentity;
  interfaces: NarrativeInterface[];
  subnets: NarrativeSubnet[];
  wans: NarrativeWan[];
  chains: NarrativeChain[];
  exposure: NarrativeExposure[];
  tunnels: NarrativeTunnel[];
  services: NarrativeService[];
  unknowns: NarrativeUnknown[];
  stats: {
    recordCount: number;
    unparsedLines: number;
    sections: number;
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const yes = (v: string | undefined): boolean => v === "yes" || v === "true";

/** Interface-producing menus, mapped to the kind word a human would use. */
const INTERFACE_SECTIONS: { path: string; kind: string }[] = [
  { path: "/interface/bridge", kind: "bridge" },
  { path: "/interface/vlan", kind: "vlan" },
  { path: "/interface/wireguard", kind: "wireguard" },
  { path: "/interface/wireless", kind: "wireless" },
  { path: "/interface/wifi", kind: "wifi" },
  { path: "/interface/eoip", kind: "eoip" },
  { path: "/interface/gre", kind: "gre" },
  { path: "/interface/ipip", kind: "ipip" },
  { path: "/interface/vxlan", kind: "vxlan" },
  { path: "/interface/l2tp-client", kind: "l2tp-client" },
  { path: "/interface/pptp-client", kind: "pptp-client" },
  { path: "/interface/sstp-client", kind: "sstp-client" },
  { path: "/interface/ovpn-client", kind: "ovpn-client" },
  { path: "/interface/pppoe-client", kind: "pppoe-client" },
  { path: "/interface/bonding", kind: "bonding" },
  { path: "/interface/veth", kind: "veth" },
  { path: "/interface/list", kind: "list" },
];

/**
 * Menus the analyser reads. Anything else with records is reported as an
 * unknown — not because it is wrong, but because the reader deserves to know
 * this document does not describe it.
 */
const UNDERSTOOD = new Set(
  [
    "/interface",
    "/interface/ethernet",
    "/interface/bridge/port",
    "/interface/bridge/vlan",
    "/interface/list/member",
    "/interface/wireguard/peers",
    "/ip/address",
    "/ip/route",
    "/ip/pool",
    "/ip/dhcp-client",
    "/ip/dhcp-server",
    "/ip/dhcp-server/network",
    "/ip/dhcp-server/lease",
    "/ip/firewall/filter",
    "/ip/firewall/nat",
    "/ip/firewall/mangle",
    "/ip/firewall/address-list",
    "/ip/service",
    "/ip/dns",
    "/system/identity",
    "/system/note",
    "/system/clock",
    "/system/ntp/client",
    "/ppp/secret",
    "/ppp/profile",
    "/routing/bgp/connection",
    "/routing/ospf/instance",
    "/container",
    "/disk",
    "/ip/ipsec/peer",
    "/ip/ipsec/policy",
    "/ip/ipsec/identity",
    ...INTERFACE_SECTIONS.map((s) => s.path),
  ].map(normalizeSection),
);

/** Sections that exist purely as containers of other menus — never "unknown". */
const IGNORED_PREFIXES = ["/interface/ethernet/switch", "/certificate", "/user", "/snmp"].map(
  normalizeSection,
);

/** Well-known management ports → the service they belong to. */
const KNOWN_PORTS: Record<string, string> = {
  "21": "FTP",
  "22": "SSH",
  "23": "Telnet",
  "53": "DNS",
  "80": "HTTP (WebFig)",
  "443": "HTTPS (WebFig)",
  "8291": "Winbox",
  "8728": "API",
  "8729": "API-SSL",
  "1723": "PPTP",
  "1701": "L2TP",
  "500": "IKE",
  "4500": "IPsec NAT-T",
  "3389": "RDP",
  "5900": "VNC",
};

function first<T>(list: T[]): T | undefined {
  return list.length > 0 ? list[0] : undefined;
}

/** `192.168.88.1/24` → `192.168.88.0/24`, the network the address sits on. */
function networkOf(address: string): string | null {
  return parseCidr(address)?.text ?? null;
}

// ── Section analysers ───────────────────────────────────────────────────────

function analyzeIdentity(model: ConfigModel, header: string[]): NarrativeIdentity {
  const identity = settingsOf(model, "/system/identity");
  // A RouterOS export opens with `# jul/30/2026 03:00:00 by RouterOS 7.16.2`
  // and, on newer versions, a `# model = ...` line.
  const dateLine = header.find((l) => /by RouterOS/i.test(l));
  const modelLine = header.find((l) => /^#\s*model\s*=/i.test(l));
  return {
    name: identity?.fields.name,
    version: dateLine?.match(/by RouterOS\s+(\S+)/i)?.[1],
    model: modelLine?.split("=")[1]?.trim(),
    exportedAt:
      dateLine
        ?.replace(/^#\s*/, "")
        .replace(/\s*by RouterOS.*$/i, "")
        .trim() || undefined,
    roles: inferRoles(model),
  };
}

function analyzeInterfaces(model: ConfigModel): NarrativeInterface[] {
  const byName = new Map<string, NarrativeInterface>();
  const ensure = (name: string, kind: string): NarrativeInterface => {
    const existing = byName.get(name);
    if (existing) {
      // A later, more specific menu wins: `ether1` seen as a bridge port is
      // still an ethernet port.
      if (existing.kind === "unknown") existing.kind = kind;
      return existing;
    }
    const created: NarrativeInterface = { name, kind, lists: [], addresses: [], disabled: false };
    byName.set(name, created);
    return created;
  };

  for (const { path, kind } of INTERFACE_SECTIONS) {
    if (kind === "list") continue;
    for (const record of recordsOf(model, path)) {
      if (record.op !== "add" && record.op !== "set") continue;
      const name = record.fields.name;
      if (!name) continue;
      const iface = ensure(name, kind);
      iface.comment = record.fields.comment ?? iface.comment;
      iface.disabled = yes(record.fields.disabled) || iface.disabled;
      if (kind === "vlan") {
        iface.vlanId = Number(record.fields["vlan-id"]) || undefined;
        iface.parent = record.fields.interface;
      }
    }
  }

  // Ethernet ports are usually only visible as `set` lines renaming or
  // commenting them, plus wherever else they are referenced.
  for (const record of recordsOf(model, "/interface/ethernet")) {
    const name = record.fields.name ?? record.fields["default-name"];
    if (!name) continue;
    const iface = ensure(name, "ethernet");
    iface.comment = record.fields.comment ?? iface.comment;
    iface.disabled = yes(record.fields.disabled) || iface.disabled;
  }

  for (const record of recordsOf(model, "/interface/bridge/port")) {
    if (record.op !== "add") continue;
    const name = record.fields.interface;
    if (!name) continue;
    const iface = ensure(name, "ethernet");
    iface.parent = record.fields.bridge;
    iface.purpose ??= `switched into ${record.fields.bridge ?? "a bridge"}`;
  }

  for (const record of recordsOf(model, "/interface/list/member")) {
    if (record.op !== "add") continue;
    const name = record.fields.interface;
    const list = record.fields.list;
    if (!name || !list) continue;
    ensure(name, "unknown").lists.push(list);
  }

  for (const record of recordsOf(model, "/ip/address")) {
    if (record.op !== "add") continue;
    const name = record.fields.interface;
    const address = record.fields.address;
    if (!name || !address) continue;
    ensure(name, "unknown").addresses.push(address);
  }

  for (const record of recordsOf(model, "/ip/dhcp-client")) {
    if (record.op !== "add") continue;
    const name = record.fields.interface;
    if (!name) continue;
    const iface = ensure(name, "unknown");
    iface.addresses.push("(from DHCP)");
    iface.purpose ??= "gets its address from an upstream DHCP server";
  }

  // Purpose from the interface lists, which is what an operator named them for.
  for (const iface of byName.values()) {
    if (iface.purpose) continue;
    if (iface.lists.some((l) => /wan/i.test(l))) iface.purpose = "upstream / internet-facing";
    else if (iface.lists.some((l) => /lan/i.test(l))) iface.purpose = "local network";
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function analyzeSubnets(model: ConfigModel): NarrativeSubnet[] {
  const vlanIds = new Map<string, number>();
  for (const record of recordsOf(model, "/interface/vlan")) {
    const name = record.fields.name;
    const id = Number(record.fields["vlan-id"]);
    if (name && Number.isFinite(id)) vlanIds.set(name, id);
  }

  const pools = new Map<string, string[]>();
  for (const record of recordsOf(model, "/ip/pool")) {
    if (record.op !== "add") continue;
    const name = record.fields.name;
    if (!name) continue;
    pools.set(name, (record.fields.ranges ?? "").split(",").filter(Boolean));
  }

  const dhcpServers = recordsOf(model, "/ip/dhcp-server").filter((r) => r.op === "add");
  const dhcpNetworks = recordsOf(model, "/ip/dhcp-server/network").filter((r) => r.op === "add");
  const leases = recordsOf(model, "/ip/dhcp-server/lease").filter((r) => r.op === "add");

  const subnets: NarrativeSubnet[] = [];
  for (const record of recordsOf(model, "/ip/address")) {
    if (record.op !== "add") continue;
    const address = record.fields.address;
    const iface = record.fields.interface;
    if (!address || !iface) continue;
    const cidr = networkOf(address);
    if (!cidr) continue;
    const host = hostOf(address);

    const server = dhcpServers.find((s) => s.fields.interface === iface);
    const network = dhcpNetworks.find((n) => n.fields.address === cidr);
    const poolName = server?.fields["address-pool"];
    const subnetCidr = parseCidr(cidr);

    subnets.push({
      cidr,
      interface: iface,
      routerAddress: host === null ? address : formatIp(host),
      vlanId: vlanIds.get(iface),
      dhcp:
        server || network
          ? {
              server: server?.fields.name ?? "(unnamed)",
              pool: poolName,
              ranges: poolName ? (pools.get(poolName) ?? []) : [],
              gateway: network?.fields.gateway,
              dns: network?.fields["dns-server"],
            }
          : undefined,
      reservations: leases
        .filter((l) => {
          const leaseIp = l.fields.address ? hostOf(l.fields.address) : null;
          return leaseIp !== null && subnetCidr !== null && inCidr(leaseIp, subnetCidr);
        })
        .map((l) => ({
          address: l.fields.address ?? "",
          macAddress: l.fields["mac-address"],
          comment: l.fields.comment,
        })),
    });
  }
  return subnets.sort((a, b) => a.cidr.localeCompare(b.cidr));
}

function analyzeWans(model: ConfigModel): NarrativeWan[] {
  const nat = recordsOf(model, "/ip/firewall/nat").filter(
    (r) => r.op === "add" && r.fields.chain === "srcnat" && !yes(r.fields.disabled),
  );
  const natFor = (iface: string | undefined): string => {
    const rule = nat.find(
      (r) =>
        r.fields["out-interface"] === iface || (iface && r.fields["out-interface-list"] === "WAN"),
    );
    if (!rule) return nat.length > 0 ? "masquerade (matched by interface list)" : "none";
    if (rule.fields.action === "masquerade") return "masquerade";
    if (rule.fields.action === "src-nat") return `src-nat to ${rule.fields["to-addresses"] ?? "?"}`;
    return rule.fields.action ?? "none";
  };

  const wans: NarrativeWan[] = [];
  const seen = new Set<string>();

  for (const record of recordsOf(model, "/ip/dhcp-client")) {
    if (record.op !== "add" || yes(record.fields.disabled)) continue;
    const iface = record.fields.interface;
    if (!iface) continue;
    seen.add(iface);
    wans.push({ interface: iface, addressing: "dhcp", nat: natFor(iface) });
  }

  for (const path of [
    "/interface/pppoe-client",
    "/interface/l2tp-client",
    "/interface/sstp-client",
  ]) {
    for (const record of recordsOf(model, path)) {
      if (record.op !== "add" || yes(record.fields.disabled)) continue;
      const name = record.fields.name;
      if (!name) continue;
      seen.add(name);
      wans.push({
        interface: name,
        addressing: path.includes("pppoe") ? "pppoe" : "tunnel",
        gateway: record.fields["connect-to"],
        nat: natFor(name),
      });
    }
  }

  // Static default routes name their own upstream.
  for (const record of recordsOf(model, "/ip/route")) {
    if (record.op !== "add") continue;
    const dst = record.fields["dst-address"];
    if (dst !== "0.0.0.0/0" && dst !== "0.0.0.0/1" && dst !== "128.0.0.0/1") continue;
    const iface = record.fields.gateway ?? "";
    if (seen.has(iface)) continue;
    wans.push({
      interface: iface,
      addressing: "static",
      gateway: record.fields.gateway,
      distance: Number(record.fields.distance) || undefined,
      checkGateway: record.fields["check-gateway"],
      nat: natFor(record.fields.gateway),
    });
  }

  return wans;
}

/** One plain sentence for a firewall rule. */
function describeRule(record: ConfigRecord): string {
  const f = record.fields;
  const parts: string[] = [];
  const action = f.action ?? "(no action)";
  parts.push(action);

  const bits: string[] = [];
  if (f.protocol) bits.push(f.protocol);
  if (f["dst-port"]) bits.push(`port ${f["dst-port"]}`);
  if (f["src-address"]) bits.push(`from ${f["src-address"]}`);
  if (f["src-address-list"]) bits.push(`from list ${f["src-address-list"]}`);
  if (f["dst-address"]) bits.push(`to ${f["dst-address"]}`);
  if (f["dst-address-list"]) bits.push(`to list ${f["dst-address-list"]}`);
  if (f["in-interface"]) bits.push(`in via ${f["in-interface"]}`);
  if (f["in-interface-list"]) bits.push(`in via ${f["in-interface-list"]}`);
  if (f["out-interface"]) bits.push(`out via ${f["out-interface"]}`);
  if (f["out-interface-list"]) bits.push(`out via ${f["out-interface-list"]}`);
  if (f["connection-state"]) bits.push(`state ${f["connection-state"]}`);
  if (f["connection-nat-state"]) bits.push(`nat-state ${f["connection-nat-state"]}`);

  const body = bits.length > 0 ? `${action} ${bits.join(", ")}` : `${action} everything`;
  const suffix = yes(f.disabled) ? " [disabled]" : "";
  const comment = f.comment ? ` — ${f.comment}` : "";
  return `${body}${suffix}${comment}`;
}

function analyzeChains(model: ConfigModel): NarrativeChain[] {
  const tables: { table: NarrativeChain["table"]; path: string }[] = [
    { table: "filter", path: "/ip/firewall/filter" },
    { table: "nat", path: "/ip/firewall/nat" },
    { table: "mangle", path: "/ip/firewall/mangle" },
  ];

  const chains: NarrativeChain[] = [];
  for (const { table, path } of tables) {
    const records = recordsOf(model, path).filter((r) => r.op === "add");
    const byChain = new Map<string, ConfigRecord[]>();
    for (const record of records) {
      const chain = record.fields.chain ?? "(none)";
      const list = byChain.get(chain);
      if (list) list.push(record);
      else byChain.set(chain, [record]);
    }
    for (const [chain, rules] of byChain) {
      const enabled = rules.filter((r) => !yes(r.fields.disabled));
      // RouterOS's own default is accept-if-nothing-matched. A trailing
      // catch-all drop is what changes that, and it is the single most
      // important fact about a chain.
      const last = enabled[enabled.length - 1];
      const isCatchAll =
        last !== undefined &&
        !last.fields["src-address"] &&
        !last.fields["dst-address"] &&
        !last.fields.protocol &&
        !last.fields["dst-port"] &&
        !last.fields["src-address-list"] &&
        !last.fields["connection-state"];
      const action = isCatchAll ? last.fields.action : undefined;
      chains.push({
        chain,
        table,
        ruleCount: rules.length,
        disabledCount: rules.length - enabled.length,
        defaultAction:
          action === "drop" || action === "reject"
            ? action
            : table === "filter"
              ? "accept"
              : "unknown",
        summary: rules.map(describeRule),
      });
    }
  }
  return chains.sort((a, b) => a.table.localeCompare(b.table) || a.chain.localeCompare(b.chain));
}

/**
 * What can reach this router, and what it forwards inward.
 *
 * The section people actually read, so it is deliberately pessimistic: a
 * management service with no `address=` restriction is reported as reachable by
 * anyone, because from the config alone it is — whether a firewall rule happens
 * to save it is a separate question the firewall section answers.
 */
function analyzeExposure(model: ConfigModel): NarrativeExposure[] {
  const exposure: NarrativeExposure[] = [];

  for (const record of recordsOf(model, "/ip/service")) {
    if (record.op !== "set") continue;
    // An export lists services as `set <name> ...`; the name is the first bare
    // token, which the parser surfaces as a flag.
    const name = record.flags[0] ?? record.fields.name ?? "(unnamed)";
    if (yes(record.fields.disabled)) continue;
    const from = record.fields.address;
    if (
      record.fields.disabled === undefined &&
      from === undefined &&
      record.fields.port === undefined
    ) {
      continue; // a `set` that changed nothing interesting
    }
    exposure.push({
      what: name,
      kind: "service",
      detail: record.fields.port ? `port ${record.fields.port}` : "default port",
      from: from ?? "anyone",
      severity: from ? "low" : /telnet|ftp|www$|api$/i.test(name) ? "critical" : "high",
      line: record.line,
    });
  }

  for (const record of recordsOf(model, "/ip/firewall/nat")) {
    if (record.op !== "add" || yes(record.fields.disabled)) continue;
    if (record.fields.chain !== "dstnat") continue;
    if (record.fields.action !== "dst-nat" && record.fields.action !== "netmap") continue;
    const port = record.fields["dst-port"] ?? record.fields.port ?? "any";
    const service = KNOWN_PORTS[port.split(",")[0]];
    exposure.push({
      what: `${record.fields["to-addresses"] ?? "an internal host"}${
        record.fields["to-ports"] ? `:${record.fields["to-ports"]}` : ""
      }${service ? ` (${service})` : ""}`,
      kind: "dst-nat",
      detail: `${record.fields.protocol ?? "any"} port ${port}`,
      from: record.fields["src-address"] ?? record.fields["src-address-list"] ?? "anyone",
      severity:
        record.fields["src-address"] || record.fields["src-address-list"] ? "medium" : "high",
      line: record.line,
    });
  }

  // An input-chain accept from the WAN side is a hole whether or not anyone
  // remembers putting it there.
  for (const record of recordsOf(model, "/ip/firewall/filter")) {
    if (record.op !== "add" || yes(record.fields.disabled)) continue;
    if (record.fields.chain !== "input" || record.fields.action !== "accept") continue;
    const inList = record.fields["in-interface-list"] ?? record.fields["in-interface"];
    if (!inList || !/wan/i.test(inList)) continue;
    if (record.fields["connection-state"]?.includes("established")) continue;
    exposure.push({
      what: record.fields.comment ?? "an input accept from the WAN",
      kind: "firewall-accept",
      detail: `${record.fields.protocol ?? "any"} ${
        record.fields["dst-port"] ? `port ${record.fields["dst-port"]}` : "any port"
      }`,
      from: record.fields["src-address"] ?? record.fields["src-address-list"] ?? "anyone",
      severity:
        record.fields["src-address"] || record.fields["src-address-list"] ? "medium" : "critical",
      line: record.line,
    });
  }

  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  return exposure.sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line);
}

function analyzeTunnels(model: ConfigModel): NarrativeTunnel[] {
  const tunnels: NarrativeTunnel[] = [];

  for (const record of recordsOf(model, "/interface/wireguard")) {
    if (record.op !== "add") continue;
    const name = record.fields.name;
    if (!name) continue;
    const peers = recordsOf(model, "/interface/wireguard/peers").filter(
      (p) => p.op === "add" && p.fields.interface === name,
    );
    tunnels.push({
      name,
      kind: "wireguard",
      // A peer with no `endpoint-address` cannot be dialled — it dials in. Say
      // so alongside its name rather than instead of it: the reader needs both
      // who it is and which end initiates.
      peers: peers.map((p) => {
        const name = p.fields.name ?? "(unnamed peer)";
        const endpoint = p.fields["endpoint-address"];
        return endpoint ? `${name} at ${endpoint}` : `${name} (no endpoint — it dials in)`;
      }),
      subnets: peers.flatMap((p) => (p.fields["allowed-address"] ?? "").split(",").filter(Boolean)),
      disabled: yes(record.fields.disabled),
      comment: record.fields.comment,
    });
  }

  const tunnelSections: { path: string; kind: string; peerField: string }[] = [
    { path: "/interface/gre", kind: "gre", peerField: "remote-address" },
    { path: "/interface/ipip", kind: "ipip", peerField: "remote-address" },
    { path: "/interface/eoip", kind: "eoip", peerField: "remote-address" },
    { path: "/interface/vxlan", kind: "vxlan", peerField: "remote-address" },
    { path: "/interface/l2tp-client", kind: "l2tp", peerField: "connect-to" },
    { path: "/interface/pptp-client", kind: "pptp", peerField: "connect-to" },
    { path: "/interface/sstp-client", kind: "sstp", peerField: "connect-to" },
    { path: "/interface/ovpn-client", kind: "ovpn", peerField: "connect-to" },
  ];
  for (const { path, kind, peerField } of tunnelSections) {
    for (const record of recordsOf(model, path)) {
      if (record.op !== "add") continue;
      const name = record.fields.name;
      if (!name) continue;
      tunnels.push({
        name,
        kind,
        peers: [record.fields[peerField]].filter((p): p is string => !!p),
        subnets: [],
        disabled: yes(record.fields.disabled),
        comment: record.fields.comment,
      });
    }
  }

  for (const record of recordsOf(model, "/ip/ipsec/peer")) {
    if (record.op !== "add") continue;
    const name = record.fields.name ?? record.fields.address ?? "(unnamed)";
    const policies = recordsOf(model, "/ip/ipsec/policy").filter((p) => p.op === "add");
    tunnels.push({
      name,
      kind: "ipsec",
      peers: [record.fields.address].filter((p): p is string => !!p),
      subnets: policies.flatMap((p) =>
        [p.fields["src-address"], p.fields["dst-address"]].filter((s): s is string => !!s),
      ),
      disabled: yes(record.fields.disabled),
      comment: record.fields.comment,
    });
  }

  return tunnels.sort((a, b) => a.name.localeCompare(b.name));
}

function analyzeServices(model: ConfigModel): NarrativeService[] {
  const services: NarrativeService[] = [];
  for (const record of recordsOf(model, "/ip/service")) {
    if (record.op !== "set") continue;
    const name = record.flags[0] ?? record.fields.name;
    if (!name) continue;
    services.push({
      name,
      enabled: !yes(record.fields.disabled),
      port: record.fields.port,
      availableFrom: record.fields.address,
    });
  }
  return services.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Everything the analyser did not read.
 *
 * Task 08's discipline: a document about an inherited router that quietly omits
 * the one menu nobody understood is worse than no document, because the reader
 * believes they have the whole picture.
 */
function findUnknowns(model: ConfigModel): NarrativeUnknown[] {
  const unknowns: NarrativeUnknown[] = [];
  for (const section of model.sections) {
    if (section.records.length === 0) continue;
    if (UNDERSTOOD.has(section.path)) continue;
    if (IGNORED_PREFIXES.some((prefix) => section.path.startsWith(prefix))) continue;
    unknowns.push({
      section: section.path,
      what: `${section.records.length} record(s) in a menu this analyser does not describe`,
      line: section.lines[0] ?? 0,
      detail: first(section.records)?.raw.slice(0, 120),
    });
  }
  for (const { line, text } of model.unparsed) {
    unknowns.push({
      section: "(unparsed)",
      what: "a line the export parser could not read",
      line,
      detail: text.slice(0, 120),
    });
  }
  return unknowns.sort((a, b) => a.line - b.line);
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Analyse an `/export` into a `DeviceNarrative`.
 *
 * Pure: no clock, no device, no config lookup. The caller stamps `device` and
 * `generatedAt`, which is what keeps two runs over the same export byte-identical
 * and therefore diffable.
 */
export function analyzeDevice(exportText: string, device?: string): DeviceNarrative {
  const model = parseExport(exportText);
  const header = exportText
    .split("\n")
    .slice(0, 8)
    .filter((l) => l.startsWith("#"));

  return {
    device,
    identity: analyzeIdentity(model, header),
    interfaces: analyzeInterfaces(model),
    subnets: analyzeSubnets(model),
    wans: analyzeWans(model),
    chains: analyzeChains(model),
    exposure: analyzeExposure(model),
    tunnels: analyzeTunnels(model),
    services: analyzeServices(model),
    unknowns: findUnknowns(model),
    stats: {
      recordCount: model.recordCount,
      unparsedLines: model.unparsed.length,
      sections: model.sections.length,
    },
  };
}
