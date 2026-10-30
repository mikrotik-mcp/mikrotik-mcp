---
title: "08 \u2014 Offline config simulator"
description: "Implementation reference and historical evidence."
---

> Historical design or verification record. It is retained for context; use the dashboard guides and generated tool reference for current behavior.

# 08 — Offline config simulator

> **Status:** implemented — all 5 phases complete. **Most speculative task
> in the backlog — do it last.**
> Loop protocol, exit gate and conventions: **[README.md](/docs/archive/implementation-plan-index)**. §9 is the
> source of truth for a `/loop` run.

## 0. Scope in one line

Build a model of a router from its `/export` and trace a hypothetical packet through
firewall and routing **without touching the device**, so the assistant can answer
"would this rule break the VPN?" _before_ Safe Mode is ever opened.

## 1. Why last

The value is obvious; the risk is fidelity. A simulator that is subtly wrong is
**worse than none**, because it produces confident answers people act on. Every
other task in this backlog either reports what is true or changes what is real. This
one predicts, and prediction can be wrong in ways no test catches.

Two mitigations shape the whole design:

1. **Ship a narrow, correct core** rather than a broad, approximate one: IPv4 filter,
   NAT and the routing decision, nothing else. No queues, no mangle side-effects on
   routing marks in v1, no connection-tracking state beyond a declared input state.
2. **Always report confidence and coverage.** If the model met a construct it does
   not implement, it says so in the result rather than silently ignoring it. An
   answer with an unmodelled feature in the path is reported as `UNKNOWN`, never as
   `ACCEPT`.

## 2. Scope boundary (v1)

**In:** `/ip firewall filter` (input/forward/output), `/ip firewall nat`
(srcnat/dstnat/masquerade), `/ip route` selection incl. distance and check-gateway
state, `/ip address` for connected routes, interface lists, address lists,
connection-state as a _declared input_, and basic `/ip firewall mangle` routing-mark
assignment.

**Out (v1):** raw table, queues, layer7, IPv6 (v2), CAPsMAN, PPP dynamic routes,
per-connection classifier, hairpin subtleties beyond simple dstnat, and anything
requiring live connection tracking.

Out-of-scope constructs encountered in the path must surface in the result's
`unmodelled[]` array and downgrade the verdict to `UNKNOWN`.

## 3. Architecture

```
src/sim/model.ts     PURE — device model built from the parsed export
src/sim/routing.ts   PURE — longest-prefix + distance + routing-mark table selection
src/sim/firewall.ts  PURE — chain traversal, rule matching, jump/return, action
src/sim/trace.ts     PURE — orchestrates: packet + model → verdict + step-by-step path
src/tools/simulate.ts  4 tools
```

Consumes `src/policy/parse.ts` from **task 06**. That parser is a hard dependency —
do not write a second export parser here. If 06 is not done, 08 cannot start.

Everything is pure. The simulator never performs I/O. Its only input is a snapshot,
which the tools load.

## 4. Packet spec

```ts
interface SimPacket {
  srcAddress: string;
  dstAddress: string;
  protocol: "tcp" | "udp" | "icmp" | number;
  srcPort?: number;
  dstPort?: number;
  inInterface: string;
  connectionState: "new" | "established" | "related" | "invalid"; // declared
  connectionMark?: string;
}
```

`connectionState` is **declared, not inferred** — the model has no state table. Say
this plainly in the tool description; a user asking about an established connection
must say so.

## 5. Output

Not a verdict — a **traversal**:

```
ACCEPT | DROP | REJECT | UNKNOWN
  step 1  routing decision: dst 8.8.8.8 → gateway 192.168.1.1 via ether1 (dst-address=0.0.0.0/0, distance 1)
  step 2  chain=forward rule #3 (in=bridge out=ether1 conn-state=new) → jump to chain=wan-out
  step 3  chain=wan-out rule #7 action=accept  ← MATCHED
  unmodelled: none
  confidence: high
```

Every step names the **rule index and its source line** so a human can go look. That
traceability is what makes the output trustworthy even when the verdict is
`UNKNOWN`.

## 6. Tools (4)

| Tool                        | Risk | Purpose                                                                                                |
| --------------------------- | ---- | ------------------------------------------------------------------------------------------------------ |
| `simulate_packet`           | READ | Trace one packet against a snapshot or the live config                                                 |
| `simulate_change`           | READ | Apply a proposed change to the model, then diff the verdicts for a set of packets — the killer feature |
| `explain_rule_reachability` | READ | Which rules can never match given the ones above them (static shadow analysis, no packet needed)       |
| `simulate_suite`            | READ | Run a saved set of packets as regression assertions                                                    |

Module `src/tools/simulate.ts`, label **"Simulator"**, group `Security`.

`simulate_change` is the reason to build this: pair it with `Change Plan` so a plan
can be evaluated against a packet suite before it is applied. That combination —
"this change would break your VPN, here is the rule" — is the demo.

`simulate_suite` turns the simulator into a **regression test for your firewall**:
declare the flows that must work, and any change that breaks one is caught in the
plan phase.

## 7. Dashboard — new page **Simulator**

`ui/observability/simulator.tsx`:

- **Packet builder** — a form, with presets ("web from LAN", "SSH from WAN",
  "VPN peer to peer") because typing a 6-field packet spec is friction.
- **Traversal view** — the steps as a vertical flow, each rule expandable to its
  config lines with the matching properties highlighted. Verdict as a large
  unmistakable banner; `UNKNOWN` styled as a warning, never as success.
- **Before/after** — for `simulate_change`, two traversals side by side with the
  divergence step highlighted. On mobile, stacked with the divergence anchored.
- **Suite runner** — saved packet suites, pass/fail per packet, run-on-demand.
- **Reachability map** — the firewall chain as a list with unreachable rules struck
  through. Genuinely useful on its own and needs no packet input.

Routes: `GET /api/sim/suites`, `POST /api/sim/packet`, `POST /api/sim/change`,
`POST /api/sim/suite/:id/run`, `GET /api/sim/reachability`.

## 8. Raycast

**None in v1.** The interaction is form-heavy and traversal output is wide; Raycast
would be a poor fit and the effort is better spent on fidelity. Revisit only if users
ask.

## 9. Implementation progress (loop state — source of truth)

> **Prerequisite:** task 06 Phase 1 (`src/policy/parse.ts`) must be complete. Do not
> start otherwise.

### [x] Phase 1 — Device model + routing

- [x] `src/sim/ip.ts` — IPv4 arithmetic, address/port matchers that return **null**
      (not false) for anything they cannot parse.
- [x] `src/sim/model.ts` — parsed export → interfaces, addresses, derived connected
      routes, static routes, address/interface lists, routing tables, firewall rules,
      and the `unmodelled[]` ledger.
- [x] `src/sim/routing.ts` — longest-prefix, distance tie-break, routing-table
      selection, discard routes, no-route, next-hop → egress resolution.
- [x] `tests/sim/routing.spec.ts` — **28 cases** covering every listed scenario plus
      IPv6 refusal, disabled routes, check-gateway reporting and matcher edge cases.
- **Exit gate:** global gate green (1167 tests).

Decisions carried forward:

- **Connected routes are derived from `/ip address`**, at distance 0. They are not
  in the export, and a model without them routes LAN traffic out of the default
  gateway — the most obvious possible way to be wrong.
- **ECMP is reported, never resolved.** Equal prefix and equal distance means the
  device hashes per connection; `selectRoute` returns `outcome: "ecmp"` with both
  candidates and NO chosen route.
- **A matcher that cannot be parsed returns `null`, not `false`.** "I do not
  understand this" and "this does not match" have to stay distinguishable, or an
  unmodelled matcher silently reads as a non-match and the verdict flips.
- **The `unmodelled` ledger is built during model construction**, not at match time,
  so a rule carrying `layer7-protocol` is known to be unmodelled before any packet
  is traced. Raw-table rules are recorded too — they run _before_ everything the
  simulator models.

### [x] Phase 2 — Firewall traversal

- [x] `src/sim/firewall.ts` — chain traversal with jump/return as a real stack,
      matcher evaluation over the §2 property set, address-list and
      interface-list resolution, `unmodelled` collection, plus
      `unreachableRules()` (static shadow analysis, no packet needed).
- [x] `tests/sim/firewall.spec.ts` — **45 cases** covering every listed scenario
      plus nested jumps, the implicit accept being reported, passthrough actions,
      and six reachability cases.
- **Exit gate:** global gate green (1212 tests).

Decisions carried forward:

- **Three-valued matching.** A matcher returns match / no-match / **unknown**, and
  `unknown` anywhere in a rule stops traversal with verdict `UNKNOWN`. Continuing
  as though an unevaluable rule were absent is exactly how a simulator produces a
  confident wrong ACCEPT.
- **Matcher evaluation order is observable and pinned by a test.** A rule with
  `src-address=10.0.0.0/8 layer7-protocol=x` against a 192.168 packet is a
  _definite_ non-match — the address is checked first and fails — so traversal
  continues. Only a rule that might have matched stops it.
- **`out-interface` before the routing decision is `unknown`, not false.** The
  trace fills it in after routing; evaluating it earlier would be a guess.
- **Action parameters are not matchers.** `new-connection-mark`, `address-list`,
  `reject-with` and friends never decide whether a rule fires. A test caught this:
  treating them as unknown matchers made every mangle rule `UNKNOWN`.
- **Reachability analysis is deliberately conservative** — only an exact-superset
  relation on the modelled matchers counts as shadowing. A false "this rule is
  dead" gets a working rule deleted, which is worse than missing one.

### [x] Phase 3 — Trace + NAT + tools

- [x] `src/sim/trace.ts` — dstnat → mangle `mark-routing` → routing → filter →
      srcnat, with address rewriting between stages, plus `renderTrace` and
      `diffTraces`.
- [x] `tests/sim/trace.spec.ts` — **21 cases**: dstnat before routing, the filter
      chain seeing the rewritten destination, a dropped packet never reaching
      srcnat, redirect switching the chain to input, blackhole/no-route/ECMP, and
      the unmodelled-forces-UNKNOWN property.
- [x] `src/tools/simulate.ts` (4 tools, all READ) + catalog entry (**Simulator**,
      group Security) + 4 schemas.
- [x] `docs/simulator.md` with the "what this does NOT model" table first.
- **Exit gate:** global gate + `bun run gen` (4 new schemas only) — 1233 tests.

Two bugs the tests caught, both worth recording:

- **NAT actions were being reported as unmodelled.** `traverseChain` only knew
  filter verdicts, so `masquerade` looked like an unknown action and every
  masquerading config traced as `UNKNOWN`. Traversal now takes the table kind and
  has a terminal-action set per table.
- **Mangle marking is passthrough by default**, so the first-match `decidedBy`
  used for filter is the wrong answer there — a later `mark-routing` overwrites
  an earlier one. `applyMangleRoutingMark` walks the chain itself and takes the
  last match (stopping early only on `passthrough=no`).

### [x] Phase 4 — Fidelity validation

- [x] Measured against **two live RouterOS 7.x devices** (home router with DHCP WAN,
      policy routing and a 24-rule firewall; hosted VPS with an on-link /32). A
      third was unreachable — the blueprint asked for five varied exports and this
      is two, recorded as a shortfall rather than glossed over.
- [x] Ground truth is the device's OWN active routing table and `check_route_path`
      (both read-only). **12 route decisions: 10 exact matches, 2 correctly
      declined, 0 confidently wrong.**
- [x] Every divergence became a fix or an explicit `unmodelled` entry — none left
      silent.
- [x] `tests/sim/fidelity.spec.ts` (13 cases) + anonymised fixtures reproducing the
      real config structures. **The real exports are NOT committed**: they are the
      user's live network topology, and the lesson is preserved by the fixture, not
      by the raw config.
- **Exit gate:** global gate + the fidelity report in `docs/simulator.md`.

Four findings, all from the live comparison:

1. **A DHCP-learned default route is absent from `/export`.** The simulator said
   "dropped, no route" for every internet-bound packet on the commonest setup
   there is. It now detects DHCP/PPPoE/OSPF/BGP sources and reports `UNKNOWN`.
2. **`/ip address … network=`** declares an on-link gateway outside the address's
   own subnet (standard on hosted VPSes). Ignoring it left the egress unresolved
   for the only route that mattered.
3. **Route liveness is unknowable from an export.** A static route with an
   unresolvable next-hop, or with `check-gateway`, now downgrades the verdict
   instead of being taken at face value — the device had deactivated exactly such
   a route.
4. **`connection-nat-state` is evaluable after all**, because the trace runs
   dstnat before the filter chain. It was the first rule of the real forward
   chain, so leaving it unknown made every trace on that device `UNKNOWN`.

Honest limit: routing has a real oracle (the device's FIB); the filter chain does
not, short of injecting packets in a lab. Firewall expectations were derived by
reading the rules.

### [x] Phase 5 — Dashboard

- [x] `src/observability/sim-routes.ts` — `GET /api/sim/suites`, `POST /api/sim/suites`,
      `POST /api/sim/packet`, `POST /api/sim/change`, `POST /api/sim/suite/:id/run`,
      `GET /api/sim/reachability`.
- [x] `ui/observability/simulator.tsx` (packet builder with presets, traversal flow,
      before/after with the divergence step marked, reachability list with dead rules
      struck through) + `main.tsx` wiring + `types.ts`.
- [x] `src/sim/suites.ts` — suite persistence in `snapshots.db`.
- [x] **`UNKNOWN` is styled as a warning and captioned "This is not a pass"**, never
      as success — the one UI requirement the blueprint made explicit.
- **Exit gate:** global gate + `bun run build:ui` (observability.html 1.31 MB).

### Blockers / notes

- ~~Hard dependency on task 06 Phase 1.~~ Satisfied — `src/policy/parse.ts` is the
  only export parser, shared by both features.
- ~~Fidelity is the real risk.~~ Measured in Phase 4: **0 confidently-wrong answers
  out of 12 route decisions against live devices.** Scope was NOT narrowed, because
  the divergences were fixable model gaps rather than approximation error — but two
  of the twelve are answered with `UNKNOWN`, and that is the honest ceiling of what
  an export can support.

**All phases complete.** Known gaps, none blocking:

- **Firewall fidelity has no oracle.** Routing was checked against the device's own
  FIB; filter expectations were derived by reading rules. Injecting real packets in
  a lab is the only way to do better.
- **Two devices, not five.** A third was unreachable, and the varied set the
  blueprint wanted (CHR, multi-WAN, switch) was not obtained.
- `output` chain is typed but never traversed — the trace models ingress paths
  (`input`/`forward`) only.
- Suites are persisted and runnable through the API, but the dashboard page does not
  yet expose a suite editor; `simulate_suite` is the way to run one today.
