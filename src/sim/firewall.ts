/**
 * Firewall chain traversal. PURE.
 *
 * First-match-wins down a chain, with `jump`/`return` handled as a stack — the
 * way RouterOS actually evaluates, not an approximation of it.
 *
 * The rule that governs this whole file: **not understanding a rule is a
 * different outcome from the rule not matching.** A matcher this model does not
 * implement makes the traversal `UNKNOWN`, never `ACCEPT`, because the honest
 * answer to "would this packet get through?" when a rule carries
 * `layer7-protocol` is "I cannot tell you", and a confident wrong ACCEPT is the
 * failure mode that makes a simulator worse than none at all.
 */
import { matchAddress, matchPort, parseIp } from "./ip";
import { inInterfaceList } from "./model";
import type { FirewallRule, SimModel, Unmodelled } from "./model";

/** The packet, as declared by the caller. Connection state is DECLARED, not inferred. */
export interface SimPacket {
  srcAddress: string;
  dstAddress: string;
  protocol: string;
  srcPort?: number;
  dstPort?: number;
  inInterface: string;
  /** Declared — this model has no connection-tracking table. */
  connectionState: "new" | "established" | "related" | "invalid";
  connectionMark?: string;
  /** Set by the trace once the routing decision is known. */
  outInterface?: string;
  /**
   * Whether dstnat has already rewritten this packet — set by the trace, which
   * runs the dstnat chain before the filter chain. This makes
   * `connection-nat-state=dstnat` genuinely evaluable rather than unknown, which
   * matters because it is the first rule of many real forward chains.
   */
  dstnatApplied?: boolean;
}

export type Verdict = "accept" | "drop" | "reject" | "unknown";

export interface TraversalStep {
  chain: string;
  /** Rule number within its chain, as RouterOS numbers them. */
  index: number;
  action: string;
  line: number;
  raw: string;
  /** Why this rule matched, or why traversal is uncertain. */
  note: string;
}

export interface ChainResult {
  verdict: Verdict;
  steps: TraversalStep[];
  /** Constructs met on the path that this model does not implement. */
  unmodelled: Unmodelled[];
  /** The rule that decided the verdict, when one did. */
  decidedBy?: FirewallRule;
  /** Set when the chain ran to the end without matching — the implicit accept. */
  fellThrough: boolean;
}

/** One matcher's result: matched, did not match, or could not be evaluated. */
type MatchResult = true | false | "unknown";

/** Matchers this file evaluates. Anything else on a rule makes it `unknown`. */
const EVALUATED = new Set([
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
]);

/**
 * Properties that are not matchers at all — action parameters, bookkeeping and
 * the rule's own identity. They never affect whether a rule fires, so treating
 * them as unknown matchers would make every mangle and address-list rule
 * UNKNOWN and render the simulator useless on a real config.
 */
const NON_MATCHERS = new Set([
  "chain",
  "action",
  "disabled",
  "comment",
  "log",
  "log-prefix",
  "jump-target",
  "to-addresses",
  "to-ports",
  "new-routing-mark",
  "new-connection-mark",
  "new-packet-mark",
  "new-dscp",
  "new-mss",
  "new-ttl",
  "address-list",
  "address-list-timeout",
  "reject-with",
  "route-dst",
  "passthrough",
  "place-before",
  "name",
]);

/** A RouterOS matcher may be negated with a leading `!`. */
function negation(value: string): { negated: boolean; value: string } {
  return value.startsWith("!")
    ? { negated: true, value: value.slice(1) }
    : { negated: false, value };
}

function applyNegation(result: MatchResult, negated: boolean): MatchResult {
  if (result === "unknown") return "unknown";
  return negated ? !result : result;
}

function addressMatch(model: SimModel, address: string, matcher: string): MatchResult {
  const ip = parseIp(address);
  if (ip === null) return "unknown";
  const result = matchAddress(ip, matcher);
  return result === null ? "unknown" : result;
}

function addressListMatch(model: SimModel, address: string, list: string): MatchResult {
  const entries = model.addressLists.get(list);
  // A list that does not exist matches nothing on the device — but saying so
  // confidently requires that the export really did contain every list, which it
  // does. An empty/absent list is a definite non-match, not an unknown.
  if (!entries) return false;
  const ip = parseIp(address);
  if (ip === null) return "unknown";
  for (const entry of entries) {
    const hit = matchAddress(ip, entry.matcher);
    if (hit === null) return "unknown";
    if (hit) return true;
  }
  return false;
}

/** Protocol names RouterOS uses, mapped to the numbers a packet may declare. */
const PROTOCOL_NUMBERS: Record<string, string> = {
  icmp: "1",
  tcp: "6",
  udp: "17",
  gre: "47",
  esp: "50",
  ah: "51",
  ipsec_esp: "50",
  ipsec_ah: "51",
  ospf: "89",
  vrrp: "112",
};

function protocolMatch(packet: SimPacket, matcher: string): MatchResult {
  const want = matcher.toLowerCase();
  const have = packet.protocol.toLowerCase();
  if (want === have) return true;
  return (PROTOCOL_NUMBERS[want] ?? want) === (PROTOCOL_NUMBERS[have] ?? have);
}

/**
 * Evaluate one rule against the packet.
 *
 * Every matcher present must match (they are ANDed). The first that cannot be
 * evaluated makes the whole rule `unknown` — the traversal cannot continue past
 * a rule that might or might not have matched.
 */
export function ruleMatches(
  model: SimModel,
  rule: FirewallRule,
  packet: SimPacket,
): { result: MatchResult; why: string } {
  const reasons: string[] = [];

  for (const [key, rawValue] of Object.entries(rule.fields)) {
    if (NON_MATCHERS.has(key)) continue;
    if (!EVALUATED.has(key)) {
      return { result: "unknown", why: `matcher '${key}' is not modelled` };
    }

    const { negated, value } = negation(rawValue);
    let result: MatchResult;

    switch (key) {
      case "src-address":
        result = addressMatch(model, packet.srcAddress, value);
        break;
      case "dst-address":
        result = addressMatch(model, packet.dstAddress, value);
        break;
      case "src-address-list":
        result = addressListMatch(model, packet.srcAddress, value);
        break;
      case "dst-address-list":
        result = addressListMatch(model, packet.dstAddress, value);
        break;
      case "protocol":
        result = protocolMatch(packet, value);
        break;
      case "src-port": {
        const hit = matchPort(packet.srcPort, value);
        result = hit === null ? "unknown" : hit;
        break;
      }
      case "dst-port": {
        const hit = matchPort(packet.dstPort, value);
        result = hit === null ? "unknown" : hit;
        break;
      }
      case "port": {
        // RouterOS `port=` matches EITHER side.
        const src = matchPort(packet.srcPort, value);
        const dst = matchPort(packet.dstPort, value);
        result = src === null || dst === null ? "unknown" : src || dst;
        break;
      }
      case "in-interface":
        result = packet.inInterface === value;
        break;
      case "out-interface":
        // Before the routing decision the egress is unknown, and a rule that
        // depends on it cannot be evaluated — saying "no match" would be a guess.
        result = packet.outInterface === undefined ? "unknown" : packet.outInterface === value;
        break;
      case "in-interface-list": {
        const member = inInterfaceList(model, value, packet.inInterface);
        result = member === undefined ? "unknown" : member;
        break;
      }
      case "out-interface-list": {
        if (packet.outInterface === undefined) {
          result = "unknown";
          break;
        }
        const member = inInterfaceList(model, value, packet.outInterface);
        result = member === undefined ? "unknown" : member;
        break;
      }
      case "connection-state": {
        // A comma-separated set; the declared state must be one of them.
        const states = value.split(",").map((s) => s.trim());
        result = states.includes(packet.connectionState);
        break;
      }
      case "connection-mark":
        result = (packet.connectionMark ?? "no-mark") === value;
        break;
      case "connection-nat-state": {
        // The trace runs dstnat BEFORE the filter chain, so dstnat state is
        // known here. srcnat runs after, so it is not — and saying "no" would
        // be a guess about something that has not happened yet.
        const wants = value.split(",").map((v) => v.trim());
        if (wants.includes("srcnat")) {
          result = "unknown";
          break;
        }
        result = wants.includes("dstnat") ? packet.dstnatApplied === true : "unknown";
        break;
      }
      default:
        result = "unknown";
    }

    result = applyNegation(result, negated);
    if (result === "unknown") {
      return { result: "unknown", why: `${key}=${rawValue} could not be evaluated` };
    }
    if (result === false) {
      return { result: false, why: `${key}=${rawValue} did not match` };
    }
    reasons.push(`${key}=${rawValue}`);
  }

  return {
    result: true,
    why: reasons.length > 0 ? reasons.join(" ") : "matches everything (no matchers)",
  };
}

/** Which table a chain belongs to — its actions mean different things. */
export type TableKind = "filter" | "nat" | "mangle";

/** Terminal actions in the FILTER table — traversal stops when one matches. */
const TERMINAL: Record<string, Verdict> = {
  accept: "accept",
  drop: "drop",
  reject: "reject",
  tarpit: "drop",
  fasttrack: "accept",
  "fasttrack-connection": "accept",
};

/**
 * Terminal actions in the NAT table. These are not verdicts — the packet
 * continues either way — but they end traversal of the NAT chain, and the rule
 * they stop on is the one whose rewrite applies. Modelling them as "unknown
 * actions" made every masquerading config report UNKNOWN, which a test caught.
 */
const NAT_TERMINAL: Record<string, Verdict> = {
  accept: "accept",
  masquerade: "accept",
  "src-nat": "accept",
  "dst-nat": "accept",
  netmap: "accept",
  redirect: "accept",
  same: "accept",
};

/**
 * Mangle actions this model recognises. `mark-routing` is the only one whose
 * effect is modelled (§2); the others are recognised so they do not poison a
 * verdict, but their marks are not tracked.
 */
const MANGLE_TERMINAL: Record<string, Verdict> = {
  accept: "accept",
  "mark-routing": "accept",
  "mark-connection": "accept",
  "mark-packet": "accept",
  "change-mss": "accept",
  "change-ttl": "accept",
  "change-dscp": "accept",
  route: "accept",
  "strip-ipv4-options": "accept",
};

function terminalFor(kind: TableKind): Record<string, Verdict> {
  if (kind === "nat") return NAT_TERMINAL;
  if (kind === "mangle") return MANGLE_TERMINAL;
  return TERMINAL;
}

/** Actions that record something and continue down the chain. */
const PASSTHROUGH = new Set([
  "log",
  "passthrough",
  "add-src-to-address-list",
  "add-dst-to-address-list",
  "mark-connection",
  "mark-packet",
  "mark-routing",
  "sniff-tzsp",
]);

const MAX_STEPS = 500;

/**
 * Walk a chain. `rules` is the whole table; the chain is selected by name so
 * `jump` can recurse into another one.
 *
 * Falling off the end of a chain is an implicit ACCEPT in RouterOS — which is
 * exactly why "the input chain must end in an explicit drop" is a policy rule.
 * The traversal reports `fellThrough` so the caller can say so.
 */
export function traverseChain(
  model: SimModel,
  rules: FirewallRule[],
  chain: string,
  packet: SimPacket,
  kind: TableKind = "filter",
): ChainResult {
  const steps: TraversalStep[] = [];
  const unmodelled: Unmodelled[] = [];
  const terminal = terminalFor(kind);
  const section = `/ip/firewall/${kind}`;
  let budget = MAX_STEPS;

  const walk = (name: string, depth: number): { verdict: Verdict; decidedBy?: FirewallRule } => {
    if (depth > 16) {
      // A jump loop. RouterOS rejects most of these at config time, but a model
      // must not hang on one.
      unmodelled.push({
        section: "/ip/firewall/filter",
        what: "jump depth",
        line: 0,
        detail: `chain '${name}' nests more than 16 deep — possible jump loop`,
      });
      return { verdict: "unknown" };
    }

    for (const rule of rules.filter((r) => r.chain === name)) {
      if (budget-- <= 0) return { verdict: "unknown" };
      if (rule.disabled) continue;

      const { result, why } = ruleMatches(model, rule, packet);
      if (result === false) continue;

      if (result === "unknown") {
        // The packet MIGHT match this rule. Whatever the rule would do, the
        // outcome is no longer knowable — so stop and say so, rather than
        // continuing as if the rule were absent.
        unmodelled.push({
          section,
          what: why,
          line: rule.line,
          detail: `chain ${name} rule #${rule.index} (action=${rule.action})`,
        });
        steps.push({
          chain: name,
          index: rule.index,
          action: rule.action,
          line: rule.line,
          raw: rule.raw,
          note: `MIGHT match — ${why}; the verdict past this rule is unknown`,
        });
        return { verdict: "unknown", decidedBy: rule };
      }

      const action = rule.action.toLowerCase();

      if (action === "jump") {
        const target = rule.fields["jump-target"];
        steps.push({
          chain: name,
          index: rule.index,
          action: "jump",
          line: rule.line,
          raw: rule.raw,
          note: `matched (${why}) → jump to chain=${target ?? "(missing)"}`,
        });
        if (!target || !rules.some((r) => r.chain === target)) {
          // Jumping to a chain that does not exist: RouterOS treats the empty
          // chain as an immediate return, so traversal continues here.
          steps.push({
            chain: target ?? "(missing)",
            index: -1,
            action: "return",
            line: rule.line,
            raw: rule.raw,
            note: "target chain has no rules — returns immediately",
          });
          continue;
        }
        const inner = walk(target, depth + 1);
        // A terminal verdict inside the jumped-to chain is the final answer; a
        // plain return continues the parent chain.
        if (inner.verdict !== "accept" || inner.decidedBy) {
          if (inner.decidedBy || inner.verdict === "unknown") return inner;
        }
        continue;
      }

      if (action === "return") {
        steps.push({
          chain: name,
          index: rule.index,
          action: "return",
          line: rule.line,
          raw: rule.raw,
          note: `matched (${why}) → return to the calling chain`,
        });
        return { verdict: "accept" };
      }

      if (PASSTHROUGH.has(action)) {
        steps.push({
          chain: name,
          index: rule.index,
          action,
          line: rule.line,
          raw: rule.raw,
          note: `matched (${why}) → ${action}, traversal continues`,
        });
        continue;
      }

      const verdict = terminal[action];
      if (verdict) {
        steps.push({
          chain: name,
          index: rule.index,
          action,
          line: rule.line,
          raw: rule.raw,
          note: `matched (${why}) → ${action.toUpperCase()}`,
        });
        return { verdict, decidedBy: rule };
      }

      // An action this model does not know. It might be terminal.
      unmodelled.push({
        section,
        what: `action=${action}`,
        line: rule.line,
        detail: "unknown action; it may or may not be terminal",
      });
      steps.push({
        chain: name,
        index: rule.index,
        action,
        line: rule.line,
        raw: rule.raw,
        note: `matched (${why}) → action '${action}' is not modelled`,
      });
      return { verdict: "unknown", decidedBy: rule };
    }

    return { verdict: "accept" };
  };

  const outcome = walk(chain, 0);
  const fellThrough = outcome.decidedBy === undefined && outcome.verdict === "accept";
  if (fellThrough) {
    steps.push({
      chain,
      index: -1,
      action: "implicit-accept",
      line: 0,
      raw: "",
      note: `no rule matched in chain=${chain} — RouterOS's implicit accept applies`,
    });
  }
  return {
    verdict: outcome.verdict,
    steps,
    unmodelled,
    decidedBy: outcome.decidedBy,
    fellThrough,
  };
}

/**
 * Static shadow analysis: which rules can never match, because an earlier rule
 * in the same chain matches a superset of what they match?
 *
 * Deliberately conservative — only exact-or-superset relations on the modelled
 * matchers are reported. A false "this rule is dead" would get a working rule
 * deleted, which is a far worse error than missing one.
 */
export function unreachableRules(
  rules: FirewallRule[],
): { rule: FirewallRule; shadowedBy: FirewallRule; why: string }[] {
  const findings: { rule: FirewallRule; shadowedBy: FirewallRule; why: string }[] = [];
  const chains = [...new Set(rules.map((r) => r.chain))];

  for (const chain of chains) {
    const inChain = rules.filter((r) => r.chain === chain && !r.disabled);
    for (let i = 0; i < inChain.length; i++) {
      const later = inChain[i];
      for (let j = 0; j < i; j++) {
        const earlier = inChain[j];
        const action = earlier.action.toLowerCase();
        // Only a TERMINAL earlier rule can shadow: a passthrough one lets the
        // packet carry on.
        if (!TERMINAL[action]) continue;

        const earlierMatchers = Object.entries(earlier.fields).filter(
          ([k]) => !NON_MATCHERS.has(k),
        );
        // An earlier rule with no matchers at all catches everything after it.
        if (earlierMatchers.length === 0) {
          findings.push({
            rule: later,
            shadowedBy: earlier,
            why: `rule #${earlier.index} matches every packet in chain=${chain} and is terminal (${action})`,
          });
          break;
        }
        // Otherwise: every matcher on the earlier rule must be present on the
        // later rule with an identical value. That makes the earlier rule's
        // match set a superset, so the later rule can never be reached.
        const superset = earlierMatchers.every(([k, v]) => later.fields[k] === v);
        if (superset && earlierMatchers.length < Object.keys(later.fields).length) {
          findings.push({
            rule: later,
            shadowedBy: earlier,
            why: `rule #${earlier.index} matches a superset (${earlierMatchers
              .map(([k, v]) => `${k}=${v}`)
              .join(" ")}) and is terminal (${action})`,
          });
          break;
        }
      }
    }
  }
  return findings;
}
