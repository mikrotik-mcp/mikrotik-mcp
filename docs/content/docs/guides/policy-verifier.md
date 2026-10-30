---
title: "Filter policy verifier"
description: "Practical setup, operations and limits for Filter policy verifier."
---

Use **Diagnostics → Simulator → Policy verifier** or `verify_filter_policy`.
Supply a complete static RouterOS export, IPv4 source/destination CIDRs or ranges,
source/destination port ranges, TCP/UDP, declared ingress/egress and connection
state, the filter chain and required verdict.

Unlike a packet suite, this verifies every address/port combination in that scope:
each matcher boundary partitions the space into equivalence cells. Matching is
constant within each cell; the existing firewall traversal evaluates one
representative per cell, including ordered rules, jumps, returns and negation.
The first violation returns a concrete packet and rule/source-line trace.

`proved` means only that every cell meets the verdict **at IPv4 filter-chain
entry**, assuming the supplied static export is complete and the declared context
is correct. Addresses are post-destination-NAT. It is not proof about NAT,
route selection, IPv6, live conntrack, raw rules, queues, FastTrack or WAN leaks.
Compare actual reachability separately. No router I/O or changes are performed.

Unsupported matchers/actions, non-static or missing referenced lists, unparsed
export lines and excessive complexity return `unknown`. The current limits are
200,000 export characters, 256 filter rules and 4,096 equivalence cells. Narrow
the query to reduce complexity; never interpret Unknown as a successful check.
The UI clears old results when inputs change. Exports are not persisted by this
feature; supply exports without secrets.
