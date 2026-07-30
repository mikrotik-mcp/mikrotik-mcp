/**
 * The device model — a parsed `/export` turned into the structures the
 * simulator reasons over. PURE, no I/O.
 *
 * Built on `src/policy/parse.ts` (task 06) rather than a second export parser:
 * two parsers would drift, and a simulator disagreeing with the linter about
 * what the config says is the worst possible failure mode for a feature whose
 * only product is confidence.
 *
 * **What is NOT modelled is tracked, not ignored.** Every construct the model
 * meets and does not implement is recorded in `unmodelled`, and the trace
 * downgrades any verdict that depended on one to `UNKNOWN`. A simulator that
 * silently skips what it does not understand produces confident wrong answers,
 * which is worse than no simulator (see `docs/tasks/08` §1).
 */
import { parseExport, recordsOf } from "../policy/parse";
import type { ConfigRecord } from "../policy/parse";
import { hostOf, looksIpv6, parseCidr } from "./ip";
import type { Cidr } from "./ip";

/** A construct present in the config that this model does not implement. */
export interface Unmodelled {
  /** Menu path it came from, e.g. `/ip/firewall/filter`. */
  section: string;
  /** The property (or feature) that is not modelled. */
  what: string;
  /** Source line in the export, so a human can go and look. */
  line: number;
  detail?: string;
}

export interface SimAddress {
  /** Host address on the interface. */
  address: number;
  /** The connected network. */
  network: Cidr;
  interface: string;
  disabled: boolean;
  line: number;
}

export type RouteKind = "connected" | "static" | "blackhole" | "unreachable" | "prohibit";

export interface SimRoute {
  dst: Cidr;
  gateway?: string;
  /** Interface the gateway resolves to, when it is directly known. */
  interface?: string;
  distance: number;
  /** Routing table this route lives in; `main` unless `routing-table=` said otherwise. */
  table: string;
  kind: RouteKind;
  disabled: boolean;
  /** `check-gateway=ping|arp`, when set — reported, since it can deactivate a route. */
  checkGateway?: string;
  line: number;
  raw: string;
}

export interface FirewallRule {
  /** 0-based position within its chain, which is what RouterOS calls the rule number. */
  index: number;
  chain: string;
  action: string;
  /** Every matcher property from the export, verbatim. */
  fields: Record<string, string>;
  disabled: boolean;
  comment?: string;
  line: number;
  raw: string;
}

export interface SimModel {
  interfaces: string[];
  addresses: SimAddress[];
  routes: SimRoute[];
  /** Address-list name → member matchers (text form; matched by `ip.matchAddress`). */
  addressLists: Map<string, { matcher: string; line: number }[]>;
  /** Interface-list name → member interface names. */
  interfaceLists: Map<string, string[]>;
  filter: FirewallRule[];
  nat: FirewallRule[];
  mangle: FirewallRule[];
  unmodelled: Unmodelled[];
  /** Lines the export parser itself could not read. */
  unparsedLines: number;
}

/** RouterOS `yes`/`no`/`true`/`false` → boolean. */
function yes(value: string | undefined): boolean {
  return value === "yes" || value === "true";
}

/**
 * Firewall properties this model actually evaluates. Anything else on a rule
 * that could change whether it matches is recorded as unmodelled — which is the
 * mechanism that keeps the verdict honest.
 */
const MODELLED_MATCHERS = new Set([
  "chain",
  "action",
  "src-address",
  "dst-address",
  "src-address-list",
  "dst-address-list",
  "protocol",
  "src-port",
  "dst-port",
  "port",
  "in-interface",
  "out-interface",
  "in-interface-list",
  "out-interface-list",
  "connection-state",
  "connection-mark",
  "connection-nat-state",
  "disabled",
  "comment",
  "log",
  "log-prefix",
  "jump-target",
  "to-addresses",
  "to-ports",
  "new-routing-mark",
  "passthrough",
  "place-before",
  "name",
]);

/**
 * Properties that make a rule's behaviour genuinely unpredictable to a static
 * model — as opposed to merely unimplemented matchers. These are called out
 * with a clearer `detail` because they are the ones most likely to make a
 * simulated verdict diverge from the device.
 */
const KNOWN_HARD: Record<string, string> = {
  "layer7-protocol": "layer-7 inspection needs packet payload",
  content: "payload inspection is not modelled",
  "connection-bytes": "needs live connection tracking",
  "connection-rate": "needs live connection tracking",
  "connection-limit": "needs live connection tracking",
  "src-address-type": "address types are not modelled",
  "dst-address-type": "address types are not modelled",
  time: "time-of-day matching depends on when the packet arrives",
  psd: "port-scan detection is stateful",
  hotspot: "hotspot state is not modelled",
  "ipsec-policy": "IPsec policy state is not modelled",
  "tls-host": "TLS SNI inspection needs payload",
  dscp: "DSCP is not modelled",
  "packet-mark": "packet marks require the mangle prerouting chain, not modelled in v1",
  "routing-mark": "matching on a routing mark requires mangle side-effects, not modelled in v1",
  "tcp-flags": "TCP flags are not modelled",
  fragment: "fragmentation is not modelled",
  random: "random matching is non-deterministic by design",
};

function ruleFrom(record: ConfigRecord, index: number, unmodelled: Unmodelled[]): FirewallRule {
  for (const [key] of Object.entries(record.fields)) {
    if (MODELLED_MATCHERS.has(key)) continue;
    unmodelled.push({
      section: record.section,
      what: key,
      line: record.line,
      detail: KNOWN_HARD[key],
    });
  }
  return {
    index,
    chain: record.fields.chain ?? "",
    action: record.fields.action ?? "accept",
    fields: record.fields,
    disabled: yes(record.fields.disabled),
    comment: record.fields.comment,
    line: record.line,
    raw: record.raw,
  };
}

/** Number the rules of each chain from 0, as RouterOS does. */
function rulesOf(records: ConfigRecord[], unmodelled: Unmodelled[]): FirewallRule[] {
  const perChain = new Map<string, number>();
  return records
    .filter((r) => r.op === "add")
    .map((record) => {
      const chain = record.fields.chain ?? "";
      const index = perChain.get(chain) ?? 0;
      perChain.set(chain, index + 1);
      return ruleFrom(record, index, unmodelled);
    });
}

/**
 * Build the model from `/export` text.
 *
 * Connected routes are DERIVED from `/ip address`, exactly as the device does:
 * they are not in the export, and a model without them would route LAN traffic
 * out of the default gateway — the single most obvious way to be wrong.
 */
export function buildModel(exportText: string): SimModel {
  const config = parseExport(exportText);
  const unmodelled: Unmodelled[] = [];

  const interfaces = new Set<string>();
  const addresses: SimAddress[] = [];
  for (const record of recordsOf(config, "/ip/address")) {
    if (record.op !== "add") continue;
    const raw = record.fields.address ?? "";
    if (looksIpv6(raw)) {
      unmodelled.push({
        section: record.section,
        what: "IPv6 address",
        line: record.line,
        detail: "IPv6 is out of scope in v1",
      });
      continue;
    }
    const network = parseCidr(raw);
    const host = hostOf(raw);
    const iface = record.fields.interface ?? "";
    if (!network || host === null || iface === "") continue;
    interfaces.add(iface);
    addresses.push({
      address: host,
      network,
      interface: iface,
      disabled: yes(record.fields.disabled),
      line: record.line,
    });
  }

  // Interfaces from every menu that names one, so `in-interface=ether1` can be
  // validated even when that interface has no address.
  for (const section of [
    "/interface/bridge",
    "/interface/vlan",
    "/interface/ethernet",
    "/interface/wireguard",
    "/interface/list/member",
  ]) {
    for (const record of recordsOf(config, section)) {
      const name = record.fields.name ?? record.fields.interface;
      if (name) interfaces.add(name);
    }
  }

  const routes: SimRoute[] = [];
  // Connected routes first: they are what makes a LAN destination stay local.
  for (const addr of addresses) {
    if (addr.disabled) continue;
    routes.push({
      dst: addr.network,
      interface: addr.interface,
      distance: 0,
      table: "main",
      kind: "connected",
      disabled: false,
      line: addr.line,
      raw: `(connected via ${addr.interface})`,
    });
  }

  for (const record of recordsOf(config, "/ip/route")) {
    if (record.op !== "add") continue;
    const dstText = record.fields["dst-address"] ?? "0.0.0.0/0";
    if (looksIpv6(dstText)) {
      unmodelled.push({
        section: record.section,
        what: "IPv6 route",
        line: record.line,
        detail: "IPv6 is out of scope in v1",
      });
      continue;
    }
    const dst = parseCidr(dstText);
    if (!dst) continue;

    // RouterOS v7 discard routes are bare keywords, which the parser surfaces as
    // `flag = "yes"` (see src/policy/parse.ts).
    const kind: RouteKind = yes(record.fields.blackhole)
      ? "blackhole"
      : yes(record.fields.unreachable)
        ? "unreachable"
        : yes(record.fields.prohibit)
          ? "prohibit"
          : "static";

    const gateway = record.fields.gateway;
    if (gateway && gateway.includes(",")) {
      // ECMP: several next-hops on one route. Modelled as present but reported,
      // because which one a flow takes is a per-connection hash decision.
      unmodelled.push({
        section: record.section,
        what: "ECMP gateway",
        line: record.line,
        detail: "several next-hops; the chosen one is a per-connection hash",
      });
    }

    routes.push({
      dst,
      gateway,
      interface: interfaces.has(gateway ?? "") ? gateway : undefined,
      distance: Number(record.fields.distance ?? "1") || 1,
      table: record.fields["routing-table"] ?? record.fields["routing-mark"] ?? "main",
      kind,
      disabled: yes(record.fields.disabled),
      checkGateway: record.fields["check-gateway"],
      line: record.line,
      raw: record.raw,
    });
  }

  const addressLists = new Map<string, { matcher: string; line: number }[]>();
  for (const record of recordsOf(config, "/ip/firewall/address-list")) {
    if (record.op !== "add") continue;
    const list = record.fields.list;
    const address = record.fields.address;
    if (!list || !address) continue;
    if (yes(record.fields.disabled)) continue;
    const entries = addressLists.get(list) ?? [];
    entries.push({ matcher: address, line: record.line });
    addressLists.set(list, entries);
  }

  const interfaceLists = new Map<string, string[]>();
  for (const record of recordsOf(config, "/interface/list/member")) {
    if (record.op !== "add") continue;
    const list = record.fields.list;
    const iface = record.fields.interface;
    if (!list || !iface) continue;
    interfaceLists.set(list, [...(interfaceLists.get(list) ?? []), iface]);
  }

  const filter = rulesOf(recordsOf(config, "/ip/firewall/filter"), unmodelled);
  const nat = rulesOf(recordsOf(config, "/ip/firewall/nat"), unmodelled);
  const mangle = rulesOf(recordsOf(config, "/ip/firewall/mangle"), unmodelled);

  // The raw table is explicitly out of scope, and it runs BEFORE everything the
  // simulator models — so its presence has to be visible, not merely absent.
  for (const record of recordsOf(config, "/ip/firewall/raw")) {
    if (record.op !== "add") continue;
    unmodelled.push({
      section: record.section,
      what: "raw table rule",
      line: record.line,
      detail: "the raw table runs before connection tracking and is not modelled",
    });
  }

  return {
    interfaces: [...interfaces].sort(),
    addresses,
    routes,
    addressLists,
    interfaceLists,
    filter,
    nat,
    mangle,
    unmodelled,
    unparsedLines: config.unparsed.length,
  };
}

/** Members of an address list, or `undefined` when the list does not exist. */
export function addressList(
  model: SimModel,
  name: string,
): { matcher: string; line: number }[] | undefined {
  return model.addressLists.get(name);
}

/** Is `iface` a member of interface list `name`? `undefined` when the list is unknown. */
export function inInterfaceList(model: SimModel, name: string, iface: string): boolean | undefined {
  const members = model.interfaceLists.get(name);
  if (!members) return undefined;
  return members.includes(iface);
}
