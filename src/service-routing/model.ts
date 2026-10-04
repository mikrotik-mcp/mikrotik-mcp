import { z } from "zod";
import ipaddr from "ipaddr.js";
import { createHash } from "node:crypto";
import { Cmd, quoteValue } from "../core/routeros";
import { parseRecords } from "../core/routeros-parse";
import { routingDomain, isWildcard, wildcardRegexp, wildcardRegexOverlaps } from "./domain";

const name = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_.-]+$/);
export const routingInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    target: name
      .optional()
      .describe(
        "Optional approved HTTPS probe alias; legacy drafts without domain route this alias's exact host",
      ),
    domain: routingDomain
      .optional()
      .describe(
        "Exact domain or *.example.com (subdomains only, not the apex). Wildcards need client DNS through this router.",
      ),
    dnsLearningConfirmed: z
      .boolean()
      .optional()
      .describe(
        "For wildcard only: confirms clients use this router DNS, shared-IP scope and FWD adlist bypass are understood. Does not enable or intercept DNS.",
      ),
    precedence: z
      .enum(["before-existing"])
      .optional()
      .describe(
        "Explicitly allow this scoped policy before existing routing rules. Preview still binds their full configuration; FastTrack is never bypassed.",
      ),
    family: z.enum(["ipv4", "ipv6"]),
    sources: z
      .array(z.string().refine((v) => ipaddr.isValidCIDR(v), "Use an explicit client subnet CIDR"))
      .min(1)
      .max(8),
    tables: z.array(name).min(1).max(3),
    primary: name,
    maxLatencyMs: z.number().int().min(100).max(15000).default(5000),
    failuresBeforeSwitch: z.number().int().min(2).max(10).default(3),
    cooldownSeconds: z.number().int().min(120).max(3600).default(300),
  })
  .superRefine((v, ctx) => {
    if (!v.domain && !v.target)
      ctx.addIssue({ code: "custom", message: "Enter a domain or choose an approved service" });
    if (v.domain && isWildcard(v.domain) && !v.dnsLearningConfirmed)
      ctx.addIssue({
        code: "custom",
        message: "Confirm client DNS learning and its limitations for wildcard routing",
      });
    if (!v.tables.includes(v.primary) || new Set(v.tables).size !== v.tables.length)
      ctx.addIssue({ code: "custom", message: "Choose one unique candidate table as primary" });
    for (const s of v.sources) {
      const [ip, bits] = ipaddr.parseCIDR(s);
      if (ip.kind() !== v.family || bits === 0)
        ctx.addIssue({
          code: "custom",
          message: "Sources must match the selected IP family and cannot be a default route",
        });
    }
  });
export type RoutingInput = z.infer<typeof routingInput>;
export type Row = Record<string, string>;
export interface RoutingFacts {
  tables: Row[];
  routes: Row[];
  mangle: Row[];
  filters: Row[];
  vrfs: Row[];
  addresses: Row[];
  dns?: Row[];
  dnsRemoteRequests?: boolean;
  version?: string;
}
export interface PathSample {
  table: string;
  at: number;
  state: "pass" | "fail" | "unknown";
  elapsedMs?: number;
  address?: string;
  detail: string;
}
export interface RoutingPlan {
  id: string;
  table: string;
  remove: boolean;
  fingerprint: string;
  expiresAt: number;
  commands: string[];
  warnings?: string[];
}
export interface RoutingPolicy extends RoutingInput {
  id: string;
  device: string;
  updatedAt: number;
  host: string;
  probeHost?: string;
  state: "draft" | "active" | "removed" | "uncertain";
  activeTable?: string;
  lastSwitchAt?: number;
  armedUntil?: number;
  plan?: RoutingPlan;
  samples: PathSample[];
  history: { at: number; message: string }[];
  snapshot?: string;
  error?: string;
}
export const enabled = (r: Row): boolean =>
  !["yes", "true"].includes(r.disabled) && !(r.flags ?? "").includes("X");
export const ownerTag = (id: string): string => `mcp-sr-${id}`;
export const selector = (tag: string): string => `[find where comment=${quoteValue(tag)}]`;
export const routingPath = (family: string): string =>
  family === "ipv4" ? "/ip firewall" : "/ipv6 firewall";
export function fingerprint(facts: RoutingFacts): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        {
          ...facts,
          addresses: facts.addresses.filter(
            (r) =>
              !(
                r.list?.startsWith("mcp-sr-") &&
                r.list.endsWith("-dst") &&
                (["yes", "true"].includes(r.dynamic) || (r.flags ?? "").includes("D"))
              ),
          ),
        },
        (key, value) =>
          ["#", ".id", "bytes", "packets", "last-handshake", "expires-after"].includes(key)
            ? undefined
            : value,
      ),
    )
    .digest("hex");
}
/** Ownership is exact, matching is forwarded traffic only, and management/private destinations return untouched. */
export function planCommands(
  policy: RoutingPolicy,
  table: string,
  facts: RoutingFacts,
  remove = false,
): string[] {
  const path = routingPath(policy.family),
    tag = ownerTag(policy.id),
    chain = `sr-${policy.id.slice(0, 12)}`;
  if (policy.state === "uncertain")
    throw new Error("Reconcile uncertain router state before another change.");
  const owned = facts.mangle.filter((r) => r.comment === tag);
  const wildcard = isWildcard(policy.host);
  const dns = facts.dns ?? [];
  const ownedDns = dns.filter((r) => r.comment === tag);
  if (wildcard && dns.some((r) => r["address-list"] === `${tag}-dst` && r.comment !== tag))
    throw new Error("A foreign DNS entry uses the owned destination list; reconcile first.");
  if (facts.mangle.some((r) => r.chain === chain && r.comment !== tag))
    throw new Error("Private chain contains foreign rules; review it first.");
  if (owned.some((r) => r.chain !== chain && r.chain !== "prerouting"))
    throw new Error("Owned rules were edited externally; review them first.");
  if (remove)
    return [
      new Cmd(`${path} mangle remove ${selector(tag)}`).build(),
      new Cmd(`${path} address-list remove ${selector(tag)}`).build(),
      ...(wildcard
        ? [
            new Cmd(`/ip dns static remove ${selector(tag)}`).build(),
            ...["/ip firewall", "/ipv6 firewall"].map((base) =>
              new Cmd(
                `${base} address-list remove [find where list=${quoteValue(`${tag}-dst`)} dynamic=yes]`,
              ).build(),
            ),
          ]
        : []),
    ];
  if (wildcard) {
    const version = /^(\d+)\.(\d+)(?:\.(\d+))?(?:\s|$)/.exec(facts.version ?? "");
    if (!version || Number(version[1]) < 7 || (Number(version[1]) === 7 && Number(version[2]) < 17))
      throw new Error(
        "Wildcard workflow requires stable RouterOS 7.17 or newer; version could not be verified.",
      );
    if (!facts.dnsRemoteRequests || !policy.dnsLearningConfirmed)
      throw new Error(
        "Wildcard routing needs confirmed client DNS through this router and allow-remote-requests already enabled. MCP will not expose DNS automatically.",
      );
    const base = policy.host.slice(2);
    if (
      dns.some(
        (r) =>
          enabled(r) &&
          r.comment !== tag &&
          ((r.regexp && wildcardRegexOverlaps(r.regexp, policy.host)) ||
            r.name === base ||
            r.name?.endsWith(`.${base}`) ||
            (["yes", "true"].includes(r["match-subdomain"]) && base.endsWith(`.${r.name}`))),
      )
    )
      throw new Error(
        "Existing DNS entries may overlap this wildcard. Review them first; MCP will not replace them.",
      );
    if (owned.length) {
      if (
        ownedDns.length !== 1 ||
        !enabled(ownedDns[0]) ||
        ownedDns[0].type !== "FWD" ||
        ownedDns[0].regexp !== wildcardRegexp(policy.host) ||
        ownedDns[0]["address-list"] !== `${tag}-dst` ||
        ownedDns[0]["forward-to"] ||
        ownedDns[0].name
      )
        throw new Error("Owned DNS learning scope changed externally.");
    } else if (ownedDns.length)
      throw new Error("Owned DNS entry is partially present; reconcile first.");
  }
  const listRows = facts.addresses.filter((r) => [`${tag}-src`, `${tag}-dst`].includes(r.list));
  const staticRows = listRows.filter(
    (r) => !["yes", "true"].includes(r.dynamic) && !(r.flags ?? "").includes("D"),
  );
  if (owned.length) {
    const expectedLists = [
      ...policy.sources.map((address) => ({ list: `${tag}-src`, address })),
      ...(!wildcard ? [{ list: `${tag}-dst`, address: policy.host }] : []),
    ];
    if (
      staticRows.length !== expectedLists.length ||
      expectedLists.some(
        (e) =>
          !staticRows.some(
            (r) => r.list === e.list && r.address === e.address && r.comment === tag && enabled(r),
          ),
      )
    )
      throw new Error("Owned address-list scope changed externally.");
    if (listRows.some((r) => r.list === `${tag}-src` && !staticRows.includes(r)))
      throw new Error("Unexpected dynamic source scope.");
  } else if (policy.state === "active" || listRows.length) {
    throw new Error("Owned policy is missing or partially present; reconcile first.");
  }
  if (!policy.tables.includes(table)) throw new Error("This exit is not approved by the policy.");
  if (!facts.tables.some((r) => r.name === table && enabled(r) && ["yes", "true"].includes(r.fib)))
    throw new Error("Exit needs an existing enabled FIB table.");
  const dst = policy.family === "ipv4" ? "0.0.0.0/0" : "::/0";
  if (
    !facts.routes.some(
      (r) =>
        r["routing-table"] === table &&
        r["dst-address"] === dst &&
        !!r.gateway &&
        r.blackhole !== "yes" &&
        r.blackhole !== "true" &&
        !["blackhole", "unreachable", "prohibit"].includes(r.type) &&
        enabled(r) &&
        (["yes", "true"].includes(r.active) || (r.flags ?? "").includes("A")),
    )
  )
    throw new Error(
      "Exit has no observed active forwarding default route for this family (discard routes are not exits).",
    );
  if (facts.filters.some((r) => enabled(r) && r.action === "fasttrack-connection"))
    throw new Error(
      "FastTrack may bypass this policy. Configure an explicit exclusion before applying.",
    );
  if (
    policy.precedence !== "before-existing" &&
    facts.mangle.some(
      (r) =>
        enabled(r) && r.comment !== tag && ["mark-routing", "jump", "route"].includes(r.action),
    )
  )
    throw new Error(
      "Existing routing/jump rules need an administrator conflict review. They will not be overridden.",
    );
  const result: string[] = [];
  if (owned.length) {
    if (policy.state !== "active" || !policy.activeTable)
      throw new Error(
        "Unexpected owned rules exist. Reconcile the router before applying a draft.",
      );
    const expected = planCommands({ ...policy, state: "draft" }, policy.activeTable, {
      ...facts,
      mangle: facts.mangle.filter((r) => r.comment !== tag),
      addresses: facts.addresses.filter((r) => ![`${tag}-src`, `${tag}-dst`].includes(r.list)),
      dns: facts.dns?.filter((r) => r.comment !== tag),
    })
      .filter((command) => command.startsWith(`${path} mangle add`))
      .map((command) => parseRecords(`0 ${command}`).rows[0]);
    if (
      owned.length !== expected.length ||
      expected.some(
        (e) =>
          !e ||
          !owned.some(
            (r) =>
              Object.entries(e)
                .filter(([key]) => !["place-before", "#"].includes(key))
                .every(([key, value]) => r[key] === value) && enabled(r),
          ),
      )
    )
      throw new Error("Owned rule scope changed externally. Automatic edits are blocked.");
    if (owned.filter((r) => r.action === "mark-routing").length !== 1)
      throw new Error("Owned routing mark is missing or ambiguous.");
    result.push(
      new Cmd(`${path} mangle set [find where comment=${quoteValue(tag)} action=mark-routing]`)
        .set("new-routing-mark", table)
        .build(),
    );
    return result;
  }
  for (const address of policy.sources)
    result.push(
      new Cmd(`${path} address-list add`)
        .set("list", `${tag}-src`)
        .set("address", address)
        .set("comment", tag)
        .build(),
    );
  if (wildcard)
    result.push(
      new Cmd("/ip dns static add")
        .set("type", "FWD")
        .set("regexp", wildcardRegexp(policy.host))
        .set("address-list", `${tag}-dst`)
        .bool("disabled", false)
        .set("comment", tag)
        .build(),
    );
  else
    result.push(
      new Cmd(`${path} address-list add`)
        .set("list", `${tag}-dst`)
        .set("address", policy.host)
        .set("comment", tag)
        .build(),
    );
  const exclude =
    policy.family === "ipv4"
      ? [
          "0.0.0.0/8",
          "10.0.0.0/8",
          "100.64.0.0/10",
          "127.0.0.0/8",
          "169.254.0.0/16",
          "172.16.0.0/12",
          "192.168.0.0/16",
          "224.0.0.0/3",
        ]
      : ["::/128", "::1/128", "::ffff:0:0/96", "fc00::/7", "fe80::/10", "ff00::/8"];
  for (const subnet of exclude)
    result.push(
      new Cmd(`${path} mangle add`)
        .set("chain", chain)
        .set("dst-address", subnet)
        .set("action", "return")
        .set("comment", tag)
        .build(),
    );
  result.push(
    new Cmd(`${path} mangle add`)
      .set("chain", chain)
      .set("action", "mark-routing")
      .set("new-routing-mark", table)
      .bool("passthrough", false)
      .set("comment", tag)
      .build(),
  );
  result.push(
    new Cmd(`${path} mangle add`)
      .set("chain", "prerouting")
      .set("src-address-list", `${tag}-src`)
      .set("dst-address-list", `${tag}-dst`)
      .set("dst-address-type", "!local")
      .set("action", "jump")
      .set("jump-target", chain)
      .set("comment", tag)
      .raw(facts.mangle.length ? "place-before=0" : "")
      .build(),
  );
  return result;
}
/** Failure-driven failover, not latency chasing. Missing evidence never triggers switching. */
export function chooseExit(policy: RoutingPolicy, now: number): string | undefined {
  if (
    policy.state !== "active" ||
    !policy.activeTable ||
    (policy.armedUntil ?? 0) <= now ||
    now - (policy.lastSwitchAt ?? 0) < policy.cooldownSeconds * 1000
  )
    return;
  const recent = (table: string) =>
    policy.samples
      .filter((s) => s.table === table && s.at <= now && now - s.at < 180_000)
      .sort((a, b) => b.at - a.at);
  const active = recent(policy.activeTable).slice(0, policy.failuresBeforeSwitch);
  if (active.length < policy.failuresBeforeSwitch || active.some((s) => s.state !== "fail")) return;
  return [policy.primary, ...policy.tables.filter((t) => t !== policy.primary)].find(
    (table) =>
      table !== policy.activeTable &&
      recent(table).slice(0, 2).length === 2 &&
      recent(table)
        .slice(0, 2)
        .every((s) => s.state === "pass"),
  );
}
