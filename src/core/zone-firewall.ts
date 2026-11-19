/**
 * Zone-based firewall: describe the network as zones and the traffic allowed
 * between them, and get the RouterOS rules. PURE.
 *
 * A zone is a set of interfaces (an interface list). A policy says what may go
 * from one zone to another. Everything between zones that no policy allows is
 * dropped by one last rule. The special zone `router` is the router itself: a
 * policy `from: lan, to: router` is an input rule.
 *
 * Every item the compiler creates carries a `zone-fw:` comment, so the whole
 * design can be found and removed again.
 */
import { Cmd } from "./routeros";

export const ZONE_TAG = "zone-fw";
/** The zone name that means the router itself. */
export const ROUTER = "router";

export interface Zone {
  name: string;
  interfaces: string[];
}

export interface ZonePolicy {
  from: string;
  to: string;
  action: "accept" | "drop" | "reject";
  protocol?: "tcp" | "udp" | "icmp";
  /** Destination ports, as RouterOS takes them: `443`, `80,443`, `8000-8100`. */
  ports?: string;
  note?: string;
}

export interface ZoneDesign {
  zones: Zone[];
  policies: ZonePolicy[];
  /** Also drop what reaches the router itself and no policy allows. */
  protectRouter?: boolean;
}

const NAME = /^[a-z][a-z0-9-]{0,23}$/;
const PORTS = /^\d{1,5}(?:-\d{1,5})?(?:,\d{1,5}(?:-\d{1,5})?){0,14}$/;

const listName = (zone: string): string => `zone-${zone}`;

/** Every reason the design cannot be compiled. Empty when it is sound. */
export function checkZoneDesign(design: ZoneDesign): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  const owner = new Map<string, string>();
  if (design.zones.length === 0) problems.push("Define at least one zone.");
  for (const zone of design.zones) {
    if (!NAME.test(zone.name))
      problems.push(`Zone name '${zone.name}': use lowercase letters, digits and '-'.`);
    if (zone.name === ROUTER)
      problems.push(`'${ROUTER}' is the router itself, not a zone you define.`);
    if (names.has(zone.name)) problems.push(`Zone '${zone.name}' is defined twice.`);
    names.add(zone.name);
    if (zone.interfaces.length === 0) problems.push(`Zone '${zone.name}' has no interface.`);
    for (const iface of zone.interfaces) {
      const other = owner.get(iface);
      if (other && other !== zone.name)
        problems.push(`Interface '${iface}' is in two zones: '${other}' and '${zone.name}'.`);
      owner.set(iface, zone.name);
    }
  }
  for (const policy of design.policies) {
    for (const end of [policy.from, policy.to])
      if (end !== ROUTER && !names.has(end)) problems.push(`Policy uses unknown zone '${end}'.`);
    if (policy.from === ROUTER && policy.to === ROUTER)
      problems.push("A policy from the router to the router means nothing.");
    if (policy.ports && !policy.protocol)
      problems.push(`Policy ${policy.from} to ${policy.to}: ports need a protocol (tcp or udp).`);
    if (policy.ports && policy.protocol === "icmp")
      problems.push(`Policy ${policy.from} to ${policy.to}: icmp has no ports.`);
    if (policy.ports && !PORTS.test(policy.ports))
      problems.push(`Policy ${policy.from} to ${policy.to}: '${policy.ports}' is not a port list.`);
  }
  // Turning on router protection with no way in would cut off management.
  if (
    design.protectRouter &&
    !design.policies.some((p) => p.to === ROUTER && p.action === "accept")
  )
    problems.push(
      "protect_router needs at least one accept policy to 'router' (for example your " +
        "management zone on tcp 22,8291). Without it the router would refuse every connection.",
    );
  return problems;
}

export interface ZonePlan {
  /** Groups in the order they are applied. */
  groups: { label: string; commands: string[] }[];
  /** What a person should know before applying. */
  notes: string[];
}

function ruleFor(policy: ZonePolicy): string {
  const chain = policy.to === ROUTER ? "input" : policy.from === ROUTER ? "output" : "forward";
  const cmd = new Cmd("/ip firewall filter add").set("chain", chain).set("action", policy.action);
  if (policy.from !== ROUTER) cmd.set("in-interface-list", listName(policy.from));
  if (policy.to !== ROUTER) cmd.set("out-interface-list", listName(policy.to));
  if (policy.protocol) cmd.set("protocol", policy.protocol);
  if (policy.ports) cmd.set("dst-port", policy.ports);
  if (policy.action === "accept") cmd.set("connection-state", "new");
  cmd.set(
    "comment",
    `${ZONE_TAG}: ${policy.from} to ${policy.to}${policy.note ? ` (${policy.note.replace(/[\r\n]+/g, " ")})` : ""}`,
  );
  return cmd.build();
}

/** The commands for a design that {@link checkZoneDesign} accepted. */
export function compileZones(design: ZoneDesign): ZonePlan {
  const lists = design.zones.map((zone) =>
    new Cmd("/interface list add")
      .set("name", listName(zone.name))
      .set("comment", `${ZONE_TAG}: zone ${zone.name}`)
      .build(),
  );
  const members = design.zones.flatMap((zone) =>
    zone.interfaces.map((iface) =>
      new Cmd("/interface list member add")
        .set("list", listName(zone.name))
        .set("interface", iface)
        .set("comment", `${ZONE_TAG}: zone ${zone.name}`)
        .build(),
    ),
  );
  const state = (chain: string): string[] => [
    new Cmd("/ip firewall filter add")
      .set("chain", chain)
      .set("action", "accept")
      .set("connection-state", "established,related,untracked")
      .set("comment", `${ZONE_TAG}: ${chain} replies`)
      .build(),
    new Cmd("/ip firewall filter add")
      .set("chain", chain)
      .set("action", "drop")
      .set("connection-state", "invalid")
      .set("comment", `${ZONE_TAG}: ${chain} invalid`)
      .build(),
  ];
  const forward = design.policies.filter((p) => p.from !== ROUTER && p.to !== ROUTER);
  const toRouter = design.policies.filter((p) => p.to === ROUTER);
  const fromRouter = design.policies.filter((p) => p.from === ROUTER);

  const groups: ZonePlan["groups"] = [
    { label: "zones (interface lists)", commands: [...lists, ...members] },
    {
      label: "traffic between zones (forward)",
      commands: [
        ...state("forward"),
        ...forward.map(ruleFor),
        // Only traffic that enters from a zone: an interface in no zone is left alone.
        ...design.zones.map((zone) =>
          new Cmd("/ip firewall filter add")
            .set("chain", "forward")
            .set("action", "drop")
            .set("in-interface-list", listName(zone.name))
            .set("comment", `${ZONE_TAG}: default drop from ${zone.name}`)
            .build(),
        ),
      ],
    },
  ];
  if (toRouter.length > 0 || design.protectRouter)
    groups.push({
      label: "traffic to the router (input)",
      commands: [
        ...state("input"),
        ...toRouter.map(ruleFor),
        ...(design.protectRouter
          ? design.zones.map((zone) =>
              new Cmd("/ip firewall filter add")
                .set("chain", "input")
                .set("action", "drop")
                .set("in-interface-list", listName(zone.name))
                .set("comment", `${ZONE_TAG}: default drop to router from ${zone.name}`)
                .build(),
            )
          : []),
      ],
    });
  if (fromRouter.length > 0)
    groups.push({ label: "traffic from the router (output)", commands: fromRouter.map(ruleFor) });

  return {
    groups,
    notes: [
      "The rules are added at the END of each chain. A rule that is already there and matches " +
        "first still decides: check the chain order after applying (list_filter_rules).",
      "An interface that is in no zone is not affected by the default drop.",
      ...(design.protectRouter
        ? []
        : [
            "The router itself is not protected by this design (protect_router=false): its input " +
              "chain keeps whatever rules it has.",
          ]),
    ],
  };
}
