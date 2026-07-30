# Offline Simulator

Trace a hypothetical packet through NAT, routing and the firewall **without
touching the device** — so "would this rule break the VPN?" can be answered
before Safe Mode is ever opened.

Four tools, in the **Simulator** module (Security group). All four are `READ` and
none of them changes anything, on any device:

| Tool                        | What it does                                                             |
| --------------------------- | ------------------------------------------------------------------------ |
| `simulate_packet`           | Trace one packet against a snapshot, supplied text, or the live config   |
| `simulate_change`           | Apply proposed lines to a copy, re-trace, diff the verdicts              |
| `explain_rule_reachability` | Which rules can never match (static, no packet needed)                   |
| `simulate_suite`            | Run a set of packets with expected verdicts — a firewall regression test |

## What this does NOT model

**This section is the feature, not a disclaimer.** A simulator that is subtly
wrong is worse than none, because it produces confident answers people act on.
So the model states its limits, and anything on a packet's path that falls
outside them downgrades the verdict to `UNKNOWN` — never to `ACCEPT`.

Out of scope in v1:

| Not modelled                                      | Consequence                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| `/ip firewall raw`                                | Runs _before_ everything modelled; its presence is reported              |
| IPv6                                              | An IPv6 address is refused, not coerced                                  |
| Layer-7, `content`, TLS SNI                       | Needs packet payload                                                     |
| `connection-bytes/-rate/-limit`                   | Needs live connection tracking                                           |
| `time`, `random`, `psd`                           | Not a function of the packet alone                                       |
| `tcp-flags`, `fragment`, `dscp`                   | Not tracked on the simulated packet                                      |
| Queues, mangle side-effects beyond `mark-routing` | No effect on the verdict modelled                                        |
| Hairpin NAT subtleties                            | Only simple dstnat/srcnat is traced                                      |
| ECMP next-hop choice                              | A per-connection hash; both candidates are reported, verdict `UNKNOWN`   |
| `check-gateway` liveness                          | An export cannot say whether a route is currently active — it is flagged |

**Connection state is declared, not inferred.** There is no connection-tracking
table here. A question about an established connection has to say
`connection_state=established`; the default is `new`.

## What it does model

`/ip firewall filter` (input/forward/output) with jump/return, `/ip firewall nat`
(dstnat/srcnat/masquerade/redirect), the routing decision including connected
routes, distance, discard routes and routing-table selection, `/ip address`,
address lists, interface lists, and `mangle` `mark-routing` in prerouting.

Order of operations, which is what most hand-written mental models get wrong:

```
dstnat (prerouting) → ROUTING DECISION → filter (input | forward) → srcnat (postrouting)
```

dstnat happens **before** routing, so a port-forwarded packet is routed to its
rewritten destination and the filter chain sees the internal address.

## Reading a traversal

```
ACCEPT  —  ACCEPT by chain=forward rule #1 (line 31)

  step 1  routing (line 25): 8.8.8.8 → 0.0.0.0/0 gateway 203.0.113.1 via ether1 (static, distance 1)
  step 2  forward rule #0 (line 30): connection-state=established,related did not match
  step 3  forward rule #1 (line 31): matched (in-interface-list=LAN out-interface-list=WAN) → ACCEPT

  NAT:
    srcnat rule #0 (line 34): masquerade → source becomes (egress address of ether1)

  unmodelled: none
  confidence: high
```

Every step names the chain, the rule index and the **source line in the export**,
so the model's reasoning can be checked instead of trusted. That traceability is
what makes the output useful even when the verdict is `UNKNOWN`.

`confidence` is `high` only when nothing on the path was unmodelled; it drops to
`medium` or `low` as unmodelled constructs accumulate, and the verdict becomes
`UNKNOWN` at the same time.

## The pairing that makes it worth having

```
plan_changes commands=[...]          # what the change would do to one device
simulate_change changes=[...] \      # what it would do to a packet
  src_address=192.168.88.50 dst_address=10.10.0.2 protocol=udp dst_port=13231 \
  in_interface=bridge
```

…and `simulate_suite` turns the flows you depend on into assertions:

```
simulate_suite packets='[
  {"name":"LAN → internet","src_address":"192.168.88.50","dst_address":"8.8.8.8",
   "in_interface":"bridge","dst_port":443,"expect":"accept"},
  {"name":"WAN → SSH","src_address":"198.51.100.9","dst_address":"203.0.113.10",
   "in_interface":"ether1","dst_port":22,"expect":"drop"}
]'
```

An `UNKNOWN` verdict counts as a **failure** in a suite: a flow whose fate the
model cannot determine is not a flow you have verified.

## Fidelity

See the fidelity report below (added in Phase 4). Until a prediction has been
checked against a real device, treat the simulator as a reading aid rather than
an oracle — which is why the dashboard surface is gated on that measurement.

## Architecture

```
src/sim/ip.ts        PURE — IPv4 arithmetic; matchers return null, not false, when unparseable
src/sim/model.ts     PURE — parsed export → interfaces, routes, lists, rules, unmodelled ledger
src/sim/routing.ts   PURE — longest-prefix + distance + table selection
src/sim/firewall.ts  PURE — chain traversal, three-valued matching, reachability analysis
src/sim/trace.ts     PURE — the full path, NAT rewriting, verdict + confidence
src/tools/simulate.ts  the four tools
```

The export parser is `src/policy/parse.ts` — shared with
[Policy-as-Code](./policy-as-code.md), deliberately not a second one. A simulator
that disagreed with the linter about what the config _says_ would be the worst
possible failure for a feature whose only product is confidence.
