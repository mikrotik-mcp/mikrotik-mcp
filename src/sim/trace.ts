/**
 * The full packet path. PURE.
 *
 * Order of operations, which is the part a hand-rolled mental model usually
 * gets wrong:
 *
 *   dstnat (prerouting) → ROUTING DECISION → filter (input | forward) →
 *   srcnat (postrouting)
 *
 * dstnat happens BEFORE routing, so a port-forwarded packet is routed to its
 * rewritten destination, not its original one. Filter rules then see the
 * rewritten address. Getting this backwards produces answers that look right on
 * simple configs and are wrong on exactly the ones people ask about.
 *
 * The output is a traversal, not a verdict: every step names the chain, the rule
 * index and the source line, so a human can go and check. That traceability is
 * what makes the result usable even when the verdict is `UNKNOWN`.
 */
import { ruleMatches, traverseChain } from "./firewall";
import type { SimPacket, TraversalStep, Verdict } from "./firewall";
import { matchAddress, parseIp } from "./ip";
import type { SimModel, Unmodelled } from "./model";
import { isLocalAddress, selectRoute } from "./routing";
import type { RouteDecision } from "./routing";

export type Confidence = "high" | "medium" | "low";

export interface TraceResult {
  verdict: Verdict;
  /** `input` when the router itself is the destination, else `forward`. */
  path: "input" | "forward" | "output";
  steps: TraversalStep[];
  routing?: RouteDecision;
  /** Address/port rewrites applied by NAT, in order. */
  nat: { stage: "dstnat" | "srcnat"; rule: number; line: number; note: string }[];
  unmodelled: Unmodelled[];
  confidence: Confidence;
  /** One-line summary a human reads first. */
  summary: string;
}

/** The packet as it stands at each stage, after any NAT rewriting. */
interface MutablePacket extends SimPacket {
  originalDst: string;
  originalSrc: string;
}

function step(
  chain: string,
  index: number,
  action: string,
  line: number,
  raw: string,
  note: string,
): TraversalStep {
  return { chain, index, action, line, raw, note };
}

/**
 * Apply the first matching dstnat/srcnat rule.
 *
 * NAT is first-match-wins per chain, like filter. Only `dst-nat`, `redirect`,
 * `src-nat` and `masquerade` rewrite anything the model tracks; other actions
 * are recorded and the traversal continues.
 */
function applyNat(
  model: SimModel,
  packet: MutablePacket,
  chain: "dstnat" | "srcnat",
  result: TraceResult,
): void {
  const rules = model.nat.filter((r) => r.chain === chain && !r.disabled);
  const traversal = traverseChain(model, model.nat, chain, packet, "nat");

  // Reuse the filter traversal for MATCHING, then apply the rewrite of whichever
  // rule it stopped on — the matching semantics are identical, and duplicating
  // them would be two implementations to keep in step.
  result.unmodelled.push(...traversal.unmodelled);
  const decided = traversal.decidedBy;
  if (!decided) return;

  const action = decided.action.toLowerCase();
  const to = decided.fields["to-addresses"];
  const toPorts = decided.fields["to-ports"];

  if (chain === "dstnat" && (action === "dst-nat" || action === "netmap")) {
    if (to) {
      packet.dstAddress = to.split("-")[0] ?? to;
      result.nat.push({
        stage: "dstnat",
        rule: decided.index,
        line: decided.line,
        note: `dst-nat → ${packet.dstAddress}${toPorts ? `:${toPorts}` : ""} (was ${packet.originalDst})`,
      });
    }
    if (toPorts) packet.dstPort = Number(toPorts.split("-")[0]) || packet.dstPort;
    result.steps.push(
      step("dstnat", decided.index, action, decided.line, decided.raw, `rewrote destination`),
    );
    return;
  }

  if (chain === "dstnat" && action === "redirect") {
    // Redirect sends the packet to the router itself, which changes the path
    // from forward to input — a detail that decides which filter chain runs.
    packet.dstAddress = "(router)";
    result.nat.push({
      stage: "dstnat",
      rule: decided.index,
      line: decided.line,
      note: `redirect to the router itself${toPorts ? ` port ${toPorts}` : ""}`,
    });
    result.steps.push(
      step(
        "dstnat",
        decided.index,
        "redirect",
        decided.line,
        decided.raw,
        "redirected to the router",
      ),
    );
    return;
  }

  if (chain === "srcnat" && (action === "masquerade" || action === "src-nat")) {
    const newSrc =
      action === "masquerade"
        ? `(egress address of ${packet.outInterface ?? "the egress interface"})`
        : (to ?? "(unspecified)");
    result.nat.push({
      stage: "srcnat",
      rule: decided.index,
      line: decided.line,
      note: `${action} → source becomes ${newSrc} (was ${packet.originalSrc})`,
    });
    result.steps.push(
      step("srcnat", decided.index, action, decided.line, decided.raw, `rewrote source`),
    );
    return;
  }

  if (action === "accept") {
    result.steps.push(
      step(chain, decided.index, "accept", decided.line, decided.raw, "exempted from NAT"),
    );
    return;
  }

  // Some other NAT action — recorded, not guessed at.
  result.unmodelled.push({
    section: "/ip/firewall/nat",
    what: `nat action=${action}`,
    line: decided.line,
    detail: "this NAT action's rewrite is not modelled",
  });
  void rules;
}

/**
 * Apply mangle `mark-routing`, which is what makes policy routing visible: a
 * marked packet is routed from a different table.
 *
 * Only `action=mark-routing` in prerouting is modelled (§2). Anything else in
 * mangle is recorded as unmodelled — mangle can rewrite fields this model does
 * not track, and pretending otherwise is how a trace quietly diverges.
 */
function applyMangleRoutingMark(
  model: SimModel,
  packet: MutablePacket,
  result: TraceResult,
): string {
  const rules = model.mangle.filter((r) => r.chain === "prerouting" && !r.disabled);
  if (rules.length === 0) return "main";

  // Mangle marking actions default to `passthrough=yes`, so traversal does NOT
  // stop at the first match — a later `mark-routing` overwrites an earlier one.
  // That is why this walks the chain itself instead of reusing the traversal's
  // first-match `decidedBy`, which is the right answer for filter and the wrong
  // one here.
  let table = "main";
  for (const rule of rules) {
    const { result: matched, why } = ruleMatches(model, rule, packet);
    if (matched === false) continue;
    if (matched === "unknown") {
      result.unmodelled.push({
        section: "/ip/firewall/mangle",
        what: why,
        line: rule.line,
        detail: `mangle prerouting rule #${rule.index} might apply a routing mark`,
      });
      continue;
    }
    if (rule.action.toLowerCase() !== "mark-routing") continue;

    const mark = rule.fields["new-routing-mark"];
    if (!mark) continue;
    table = mark;
    result.steps.push(
      step(
        "mangle:prerouting",
        rule.index,
        "mark-routing",
        rule.line,
        rule.raw,
        `matched (${why}) → routing mark '${mark}', so the routing table '${mark}' is used`,
      ),
    );
    if (rule.fields.passthrough === "no") break;
  }
  return table;
}

export interface TraceInput {
  model: SimModel;
  packet: SimPacket;
}

/**
 * Trace one packet. Never throws; an input it cannot model produces an `UNKNOWN`
 * verdict with the reason attached.
 */
export function tracePacket(input: TraceInput): TraceResult {
  const { model } = input;
  const packet: MutablePacket = {
    ...input.packet,
    originalDst: input.packet.dstAddress,
    originalSrc: input.packet.srcAddress,
  };

  const result: TraceResult = {
    verdict: "unknown",
    path: "forward",
    steps: [],
    nat: [],
    unmodelled: [],
    confidence: "high",
    summary: "",
  };

  if (parseIp(packet.srcAddress) === null || parseIp(packet.dstAddress) === null) {
    result.summary = "source and destination must both be IPv4 addresses (v1 models IPv4 only)";
    result.confidence = "low";
    return result;
  }
  if (!model.interfaces.includes(packet.inInterface) && model.interfaces.length > 0) {
    result.unmodelled.push({
      section: "(packet)",
      what: `in-interface '${packet.inInterface}'`,
      line: 0,
      detail: `not an interface this export knows about (${model.interfaces.join(", ")})`,
    });
  }

  // 1. dstnat, BEFORE the routing decision.
  applyNat(model, packet, "dstnat", result);

  // 2. mangle prerouting: a routing mark selects an alternate table.
  const table = applyMangleRoutingMark(model, packet, result);

  // 3. The routing decision.
  const routedToSelf = packet.dstAddress === "(router)" || isLocalAddress(model, packet.dstAddress);
  if (!routedToSelf) {
    const routing = selectRoute(model, packet.dstAddress, table);
    result.routing = routing;
    result.steps.push(
      step(
        "routing",
        -1,
        routing.outcome,
        routing.route?.line ?? 0,
        routing.route?.raw ?? "",
        routing.reason,
      ),
    );
    packet.outInterface = routing.outInterface;

    if (routing.outcome === "discard") {
      result.verdict = "drop";
      result.path = "forward";
      result.summary = `dropped by the routing decision — ${routing.reason}`;
      return finish(result);
    }
    if (routing.outcome === "no-route") {
      result.verdict = "drop";
      result.summary = `no route to ${packet.dstAddress} — the packet is dropped (ICMP unreachable)`;
      return finish(result);
    }
    if (routing.outcome === "ecmp") {
      // The egress is genuinely unknowable, and every out-interface rule below
      // would be a guess. Say so rather than picking a path.
      result.unmodelled.push({
        section: "/ip/route",
        what: "equal-cost multipath",
        line: routing.candidates[0]?.line ?? 0,
        detail: routing.reason,
      });
    }
  } else {
    result.path = "input";
    result.steps.push(
      step(
        "routing",
        -1,
        "local",
        0,
        "",
        `${packet.originalDst} is the router itself — chain=input`,
      ),
    );
  }

  // 4. The filter chain.
  const chain = result.path === "input" ? "input" : "forward";
  const filter = traverseChain(model, model.filter, chain, packet);
  result.steps.push(...filter.steps);
  result.unmodelled.push(...filter.unmodelled);
  result.verdict = filter.verdict;

  if (filter.verdict !== "accept") {
    result.summary =
      filter.verdict === "unknown"
        ? `UNKNOWN — traversal stopped in chain=${chain}; the model cannot evaluate a rule on the path`
        : `${filter.verdict.toUpperCase()} by chain=${chain} rule #${filter.decidedBy?.index} (line ${filter.decidedBy?.line})`;
    return finish(result);
  }

  // 5. srcnat, only for a packet that is actually leaving.
  if (result.path === "forward") {
    applyNat(model, packet, "srcnat", result);
  }

  result.summary = filter.fellThrough
    ? `ACCEPT — no rule matched in chain=${chain}; RouterOS's implicit accept applies`
    : `ACCEPT by chain=${chain} rule #${filter.decidedBy?.index} (line ${filter.decidedBy?.line})`;
  return finish(result);
}

/**
 * Downgrade the verdict and confidence in light of what was not modelled.
 *
 * This is the single most important function in the simulator: it is what stops
 * an `unmodelled` entry on the path from being reported as a clean ACCEPT.
 */
function finish(result: TraceResult): TraceResult {
  if (result.unmodelled.length === 0) {
    result.confidence = "high";
    return result;
  }
  // Anything unmodelled on the path means the verdict cannot be trusted.
  result.confidence = result.unmodelled.length > 2 ? "low" : "medium";
  if (result.verdict !== "unknown") {
    result.verdict = "unknown";
    result.summary =
      `UNKNOWN — the path crossed ${result.unmodelled.length} construct(s) this model does not implement ` +
      `(${result.unmodelled.map((u) => u.what).join(", ")}). ` +
      `Without them the verdict would have been ${resultVerdictText(result)}.`;
  }
  return result;
}

function resultVerdictText(result: TraceResult): string {
  const decisive = result.steps.filter((s) => s.action === "accept" || s.action === "drop");
  return decisive.length > 0 ? decisive[decisive.length - 1].action.toUpperCase() : "ACCEPT";
}

/** Render a traversal the way the blueprint's §5 example does. */
export function renderTrace(result: TraceResult): string {
  const lines = [`${result.verdict.toUpperCase()}  —  ${result.summary}`, ""];
  for (const [i, s] of result.steps.entries()) {
    const where = s.index >= 0 ? ` rule #${s.index}` : "";
    const at = s.line > 0 ? ` (line ${s.line})` : "";
    lines.push(`  step ${i + 1}  ${s.chain}${where}${at}: ${s.note}`);
  }
  if (result.nat.length > 0) {
    lines.push("", "  NAT:");
    for (const n of result.nat)
      lines.push(`    ${n.stage} rule #${n.rule} (line ${n.line}): ${n.note}`);
  }
  lines.push(
    "",
    result.unmodelled.length === 0
      ? "  unmodelled: none"
      : `  unmodelled: ${result.unmodelled.map((u) => `${u.what}${u.line ? ` (line ${u.line})` : ""}`).join("; ")}`,
    `  confidence: ${result.confidence}`,
  );
  return lines.join("\n");
}

/** Compare two traces of the same packet — the `simulate_change` primitive. */
export function diffTraces(
  before: TraceResult,
  after: TraceResult,
): { changed: boolean; divergedAt?: number; summary: string } {
  const changed = before.verdict !== after.verdict;
  const limit = Math.min(before.steps.length, after.steps.length);
  let divergedAt: number | undefined;
  for (let i = 0; i < limit; i++) {
    const a = before.steps[i];
    const b = after.steps[i];
    if (a.chain !== b.chain || a.index !== b.index || a.action !== b.action) {
      divergedAt = i;
      break;
    }
  }
  if (divergedAt === undefined && before.steps.length !== after.steps.length) {
    divergedAt = limit;
  }
  return {
    changed,
    divergedAt,
    summary: changed
      ? `VERDICT CHANGED: ${before.verdict.toUpperCase()} → ${after.verdict.toUpperCase()}${
          divergedAt !== undefined ? ` (diverges at step ${divergedAt + 1})` : ""
        }`
      : divergedAt !== undefined
        ? `same verdict (${after.verdict.toUpperCase()}) but a different path from step ${divergedAt + 1}`
        : `no change (${after.verdict.toUpperCase()})`,
  };
}

/** True when `matcher` would match `address` — used by the suite runner's docs. */
export function addressMatches(address: string, matcher: string): boolean {
  const ip = parseIp(address);
  if (ip === null) return false;
  return matchAddress(ip, matcher) === true;
}
