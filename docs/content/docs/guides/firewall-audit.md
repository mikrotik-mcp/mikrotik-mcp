---
title: "Firewall Audit & Explainer"
description: "Practical setup, operations and limits for Firewall Audit & Explainer."
---

Makes a router's most security-critical and most error-prone subsystem legible.
`firewall_audit` pulls the filter (and optionally NAT/mangle) rulesets and runs a
structured analysis, returning a plain-language report, a risk score, and — in
MCP App hosts — an interactive findings table with one-click fixes.

One tool, in the **Firewall — Audit** module (Security):

```
firewall_audit                    # filter (+ NAT) audit
firewall_audit include_mangle=true
```

## What it detects

| Finding                         | Meaning                                                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unreachable / shadowed rule** | A terminal earlier rule already matches everything this rule would (set-containment over the match conditions, with real CIDR containment for addresses, IPv4 **and** IPv6). |
| **Overly-broad accept**         | An `accept` that matches all traffic in a chain, bypassing every rule after it.                                                                                              |
| **Missing default-drop**        | The `input`/`forward` chain has no catch-all drop — RouterOS's default policy is **accept**, so anything not explicitly handled is allowed.                                  |
| **Duplicate rule**              | Two enabled rules with identical match + action.                                                                                                                             |
| **Dead rule**                   | Enabled but 0 packets since the counters last reset — possibly unused.                                                                                                       |

Each finding carries a plain-language explanation ("Rule 7 can never match — rule
3 already accepts all traffic it would, earlier in the input chain"), a suggested
fix, and a severity. The report includes a **0–100 risk score** and a grade.

The shadowing analysis is **sound** (no false positives): it only treats a rule
as a shadower when its match set provably contains the later rule's, and it
excludes non-deterministic matchers (`limit=`, `random=`, `nth=`,
`connection-bytes=`, …) that only match _sometimes_.

## The interactive table (MCP Apps)

In a host that renders MCP Apps (Claude, ChatGPT), `firewall_audit` also returns
a `firewall-audit` view: a risk gauge, severity counts, and a card per finding
with the offending rule and a **one-click "Disable rule N"** button that calls
`disable_filter_rule` / `disable_nat_rule` and re-audits. Text-only hosts get the
full plain-text report.

## Zone-based firewall

Instead of single rules, describe the network as zones and say what may pass
between them. `design_zone_firewall` compiles that into interface lists and
filter rules.

```json
{
  "zones": [
    { "name": "lan", "interfaces": ["bridge"] },
    { "name": "guest", "interfaces": ["vlan20"] },
    { "name": "wan", "interfaces": ["ether1"] }
  ],
  "policies": [
    { "from": "lan", "to": "wan" },
    { "from": "guest", "to": "wan", "protocol": "tcp", "ports": "80,443" },
    { "from": "lan", "to": "router", "protocol": "tcp", "ports": "22,8291" }
  ],
  "protect_router": true
}
```

What it builds:

- One interface list for each zone (`zone-lan`, `zone-guest`, `zone-wan`).
- Replies to allowed connections are accepted; invalid packets are dropped.
- One rule for each policy.
- A last rule for each zone that drops everything else that enters from it.

The special zone `router` is the router itself. `from: lan, to: router` allows
access _to_ the router. With `protect_router: true` the same default drop is
added for traffic to the router.

The tool shows every command first (`apply=false`). With `apply=true` it takes a
config snapshot and writes in Safe Mode, so a rule that cuts your own connection
is rolled back. `remove_zone_firewall` takes the whole design out again; every
item it made carries a `zone-fw:` comment, and rules you added yourself are not
touched.

A design is refused when it cannot be made safely: an interface in two zones,
an unknown zone or interface, ports without a protocol, or `protect_router`
with no accept policy to the router, which would lock everyone out.

Limits to know:

- The rules go at the **end** of each chain. A rule that is already there and
  matches first still decides. Check the order with `list_filter_rules`.
- IPv4 only. Add the same policy for IPv6 by hand.
- An interface that is in no zone is not affected by the default drop.
- NAT is not part of the design. A `lan` to `wan` policy allows the traffic;
  masquerade still needs its own rule.
